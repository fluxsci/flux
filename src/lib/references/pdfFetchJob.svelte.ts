// Background PDF-fetch job — a MODULE-LEVEL Svelte-5 runes singleton so a bulk "Get all
// PDFs" run survives the user navigating away from the Library view (mode switches swap
// components inside one live renderer; a component-scoped job would be torn down). The heavy
// work lives in the Electron main process (per-paper IPC), so this loop just awaits IPC
// calls sequentially and stays responsive in any mode. A global shell chip subscribes to it.
//
// One phase: the open-access waterfall. Files each PDF to disk immediately, so the run is
// bounded in memory and RESUMABLE across restarts (re-running rebuilds the todo from what's on
// disk). Papers with no open-access copy go into the shared OA-miss ledger, so the next run
// only re-checks new, changed or expired ones.
import { fetchPdfsForEntries, type GuiFetchResult } from "./pdfFinderBridge";
import { listPdfKeys, hasPdfIn, loadOaMisses, saveOaMisses } from "./itemsBridge";
import { safeKey, oaSig, isFreshOaMiss, type OaMissMap } from "./items";
import { mergeEnrich, type EnrichMap, type EnrichedEntry } from "./enrich";
import type { RefEntry } from "./types";

/** Has a fetchable identifier for the OA waterfall (DOI / OA url / PMCID). */
const canFetch = (r: EnrichedEntry) => !!(r.doi || r.enrich?.openAccess?.url || r.enrich?.ids?.pmcid);

class PdfFetchJob {
  running = $state(false);
  done = $state(0);
  total = $state(0);
  got = $state(0);
  errors = $state(0);
  oaSkipped = $state(0); // papers skipped by the OA-miss ledger (known no-OA, fresh)
  note = $state("");
  cancelled = $state(false);

  // LR-7: the summary of the most-recently FINISHED run, retained after completion so a Library
  // that was unmounted mid-run (mode switch) can surface it when it next mounts. `runSeq` bumps
  // once per finished run so a consumer can tell a fresh completion from a stale one it already
  // showed. Neither is cleared by #reset() — only overwritten by the next #finish().
  runSeq = $state(0);
  lastSummary = $state<GuiFetchSummaryLite | null>(null);

  #ctrl: AbortController | null = null;

  /** True while a run is active (for button/chip state). */
  get active() {
    return this.running;
  }

  cancel() {
    this.cancelled = true;
    this.note = "Cancelling…";
    this.#ctrl?.abort();
  }

  /**
   * Run the open-access fetch over `entries`.
   * @param entries   the raw .bib entries
   * @param enrichMap the OpenAlex enrichment sidecar
   * @param opts.recheckMisses  ignore the OA-miss ledger for this run (explicitly picked papers)
   * @param opts.onTick    optional callback after each item (lets a mounted Library tick its coverage)
   */
  async start(
    entries: RefEntry[],
    enrichMap: EnrichMap,
    opts: { recheckMisses?: boolean; onTick?: (key: string, got: boolean) => void } = {},
  ): Promise<GuiFetchSummaryLite | null> {
    if (this.running) return null;
    this.#reset();
    this.running = true;

    const enriched = mergeEnrich(entries, enrichMap) as EnrichedEntry[];

    // OA-miss ledger: one aggregated file remembering which papers had NO open-access copy
    // (and under which identifiers), so a run only re-checks new/changed/expired papers
    // instead of grinding the whole library's OA waterfall every run. Updated in memory as
    // results land and throttle-saved, so even a cancelled run keeps its progress.
    const misses: OaMissMap = await loadOaMisses();
    const missKey = (key: string) => safeKey(key).normalize("NFC");
    const sigOf = (r: EnrichedEntry) =>
      oaSig({ doi: r.doi || r.enrich?.doi, openAccessUrl: r.enrich?.openAccess?.url, pmcid: r.enrich?.ids?.pmcid });
    const sigByKey = new Map(enriched.map((r) => [r.key, sigOf(r)]));
    let missDirty = 0; // ledger changes since the last save
    let saveChain: Promise<void> = Promise.resolve(); // serialize snapshot writes
    const flushMisses = () => {
      if (!missDirty) return saveChain;
      missDirty = 0;
      const snapshot = { ...misses };
      return (saveChain = saveChain.then(() => saveOaMisses(snapshot)));
    };
    const noteOaMiss = (r: GuiFetchResult, aborted: boolean) => {
      const mk = missKey(r.key);
      // `!r.transient`: a transport-level failure (timeout/network) is not a reliable "no-OA",
      // so it must never be recorded as a miss (it would falsely suppress the paper for 30 days).
      if (r.status === "no-oa" && !r.transient && !aborted && !this.cancelled) {
        misses[mk] = { at: new Date().toISOString(), attempts: (misses[mk]?.attempts ?? 0) + 1, sig: sigByKey.get(r.key) ?? "" };
        missDirty++;
      } else if ((r.status === "got" || r.status === "have") && misses[mk]) {
        delete misses[mk];
        missDirty++;
      }
      if (missDirty >= 12) void flushMisses();
    };

    try {
      const ctrl = new AbortController();
      this.#ctrl = ctrl;

      const pdfKeys0 = await listPdfKeys();
      const fetchable = enriched.filter((r) => !hasPdfIn(pdfKeys0, r.key) && canFetch(r));
      const todo = fetchable
        .filter((r) => opts.recheckMisses || !isFreshOaMiss(misses[missKey(r.key)], sigByKey.get(r.key) ?? ""))
        .map((r) => ({ entry: r as RefEntry, enrich: enrichMap[r.key] }));
      this.oaSkipped = fetchable.length - todo.length;

      this.total = todo.length;
      this.done = 0;
      const results = new Map<string, GuiFetchResult>();
      if (todo.length) {
        const sum = await fetchPdfsForEntries(todo, {
          signal: ctrl.signal,
          onProgress: (done, _t, last) => {
            this.done = done;
            if (last.status === "got") this.got++;
            results.set(last.key, last);
            noteOaMiss(last, ctrl.signal.aborted);
            opts.onTick?.(last.key, last.status === "got" || last.status === "have");
          },
        });
        for (const r of sum.results) results.set(r.key, r);
      }

      // A cancel mid-item is the user's doing, not an error of the paper.
      this.errors = [...results.values()].filter((r) => r.status === "error" && r.reason !== "cancelled").length;
      return this.#finish(ctrl.signal.aborted);
    } catch (e) {
      const msg = (e as Error)?.message || "PDF fetch failed.";
      this.note = msg;
      // A crash is NOT a user cancel — carry the note so the summary can toast it.
      return this.#finish(true, msg);
    } finally {
      await flushMisses(); // persist ledger progress even on cancel/throw (best-effort)
    }
  }

  #finish(aborted: boolean, errorNote?: string): GuiFetchSummaryLite {
    const summary: GuiFetchSummaryLite = {
      got: this.got,
      errors: this.errors,
      oaSkipped: this.oaSkipped,
      cancelled: aborted || this.cancelled,
      errorNote,
    };
    this.lastSummary = summary;
    this.runSeq++;
    this.running = false;
    this.#ctrl = null;
    return summary;
  }

  #reset() {
    this.done = 0;
    this.total = 0;
    this.got = 0;
    this.errors = 0;
    this.oaSkipped = 0;
    this.note = "";
    this.cancelled = false;
  }
}

export interface GuiFetchSummaryLite {
  got: number; // open-access PDFs filed this run
  errors: number;
  oaSkipped: number; // skipped by the OA-miss ledger (known no-OA, fresh)
  cancelled: boolean;
  errorNote?: string; // set when the run threw (vs. a user cancel) — surfaced as an error toast
}

// The one shared job instance for the whole app session.
export const pdfFetchJob = new PdfFetchJob();
