// Background PDF-fetch job — a MODULE-LEVEL Svelte-5 runes singleton so a bulk "Get all
// PDFs" run survives the user navigating away from the Library view (mode switches swap
// components inside one live renderer; a component-scoped job would be torn down). The heavy
// work lives in the Electron main process (per-paper IPC), so this loop just awaits IPC
// calls sequentially and stays responsive in any mode. A global shell chip subscribes to it.
//
// Two phases per run: (A) the open-access waterfall, then (B) — for anything still missing —
// the institutional library proxy. Files each PDF to disk immediately, so the run is bounded
// in memory and RESUMABLE across restarts (re-running rebuilds the todo from what's on disk).
// Genuine both-routes-failed papers get a Part C failure record so the next run skips them.
import { fetchPdfsForEntries, fetchViaProxyForEntries, ENV_REASONS, type GuiFetchResult } from "./pdfFinderBridge";
import {
  listPdfKeys,
  hasPdfIn,
  listFailedKeys,
  writeFetchFailure,
  clearFetchFailure,
  loadOaMisses,
  saveOaMisses,
} from "./itemsBridge";
import { safeKey, oaSig, isFreshOaMiss, type OaMissMap } from "./items";
import { mergeEnrich, type EnrichMap, type EnrichedEntry } from "./enrich";
import type { RefEntry } from "./types";
import { fileBridge } from "../project/types";

/** Has a fetchable identifier for the OA waterfall (DOI / OA url / PMCID). */
const canFetch = (r: EnrichedEntry) => !!(r.doi || r.enrich?.openAccess?.url || r.enrich?.ids?.pmcid);
/** Has something the proxy can navigate to (DOI / OA url / landing url). */
const hasProxyTarget = (r: EnrichedEntry) => !!(r.doi || r.enrich?.openAccess?.url || r.url);

export interface FetchGate {
  proxyConfigured: boolean;
  proxySignedIn: boolean;
}

class PdfFetchJob {
  running = $state(false);
  phase = $state<"" | "oa" | "proxy">("");
  done = $state(0);
  total = $state(0);
  oaGot = $state(0);
  proxyGot = $state(0);
  errors = $state(0);
  failedNew = $state(0); // papers newly recorded as both-routes-failed this run
  needSignIn = $state(0); // still-missing papers we couldn't proxy because not signed in
  oaSkipped = $state(0); // papers skipped by the OA-miss ledger (known no-OA, fresh)
  blockedSkipped = $state(0); // papers skipped because their publisher's circuit breaker tripped
  publisherOnly = $state(0); // papers whose OA copies are all publisher-hosted (left to the proxy route)
  note = $state("");
  cancelled = $state(false);

  // LR-7: the summary of the most-recently FINISHED run, retained after completion so a Library
  // that was unmounted mid-run (mode switch) can surface it when it next mounts. `runSeq` bumps
  // once per finished run so a consumer can tell a fresh completion from a stale one it already
  // showed. Neither is cleared by #reset() — only overwritten by the next #finish().
  runSeq = $state(0);
  lastSummary = $state<GuiFetchSummaryLite | null>(null);

  #ctrl: AbortController | null = null;
  #token = "";

  /** True while a run is active (for button/chip state). */
  get active() {
    return this.running;
  }

  cancel() {
    this.cancelled = true;
    this.note = "Cancelling…";
    this.#ctrl?.abort();
    // Kill the in-flight main-process proxy window so the current fetch returns in ~1s.
    if (this.#token) void fileBridge()?.proxyCancel?.(this.#token);
  }

  /**
   * Run the two-phase fetch over the whole library.
   * @param entries   the raw .bib entries
   * @param enrichMap the OpenAlex enrichment sidecar
   * @param gate      proxy availability (from proxyStatus)
   * @param opts.retryFailed  ignore the Part C skip-list for this run (the "Retry failed" action)
   * @param onTick    optional callback after each item (lets a mounted Library tick its coverage)
   */
  async start(
    entries: RefEntry[],
    enrichMap: EnrichMap,
    gate: FetchGate,
    opts: { retryFailed?: boolean; onTick?: (key: string, got: boolean) => void } = {},
  ): Promise<GuiFetchSummaryLite | null> {
    if (this.running) return null;
    this.#reset();
    this.running = true;

    const enriched = mergeEnrich(entries, enrichMap) as EnrichedEntry[];
    const failedSkip = opts.retryFailed ? new Set<string>() : await listFailedKeys();
    const skip = (r: EnrichedEntry) => hasPdfIn(failedSkip, r.key);

    // OA-miss ledger: one aggregated file remembering which papers had NO open-access copy
    // (and under which identifiers), so Phase A only re-checks new/changed/expired papers
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
    // `record` = this result came from an actual OA attempt (Phase A). Phase B results reuse
    // status "no-oa" for proxy failures — those must only CLEAR a miss (on success), never
    // record/refresh one (the OA route wasn't re-checked, so the TTL must keep aging).
    const noteOaMiss = (r: GuiFetchResult, aborted: boolean, record: boolean) => {
      const mk = missKey(r.key);
      // `!r.transient`: a transport-level failure (timeout/network) is not a reliable "no-OA",
      // so it must never be recorded as a miss (it would falsely suppress the paper for 30 days).
      if (record && r.status === "no-oa" && !r.transient && !aborted && !this.cancelled) {
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
      this.#token = `pdfjob-${genToken()}`;

      // --- Phase A: open access ---------------------------------------------------------
      const pdfKeys0 = await listPdfKeys();
      const fetchable = enriched.filter((r) => !hasPdfIn(pdfKeys0, r.key) && canFetch(r) && !skip(r));
      const todoA = fetchable
        .filter((r) => opts.retryFailed || !isFreshOaMiss(misses[missKey(r.key)], sigByKey.get(r.key) ?? ""))
        .map((r) => ({ entry: r as RefEntry, enrich: enrichMap[r.key] }));
      this.oaSkipped = fetchable.length - todoA.length;

      this.phase = "oa";
      this.total = todoA.length;
      this.done = 0;
      const oaByKey = new Map<string, GuiFetchResult>();
      if (todoA.length) {
        const sumA = await fetchPdfsForEntries(todoA, {
          signal: ctrl.signal,
          onProgress: (done, _t, last) => {
            this.done = done;
            if (last.status === "got") this.oaGot++;
            if (last.publisherOnly) this.publisherOnly++;
            oaByKey.set(last.key, last);
            noteOaMiss(last, ctrl.signal.aborted, true);
            opts.onTick?.(last.key, last.status === "got" || last.status === "have");
          },
        });
        for (const r of sumA.results) oaByKey.set(r.key, r);
      }
      await flushMisses();
      if (ctrl.signal.aborted) return this.#finish(true);

      // --- Phase B: library proxy (only for what's still missing) ------------------------
      const pdfKeys1 = await listPdfKeys();
      const missing = enriched.filter((r) => !hasPdfIn(pdfKeys1, r.key) && hasProxyTarget(r) && !skip(r));

      // Run the library phase whenever the proxy is CONFIGURED — the engine is the ground
      // truth for auth (IP-based autologin works even when the status probe can't confirm it),
      // and it self-reports "session-expired" + early-stops after 2 in a row if truly signed
      // out. We deliberately don't hard-gate on the (sometimes-false-negative) signed-in probe.
      let proxyByKey = new Map<string, GuiFetchResult>();
      let blockedGroups = new Set<string>();
      if (gate.proxyConfigured && missing.length) {
        const todoB = missing.map((r) => ({ entry: r as RefEntry, enrich: enrichMap[r.key] }));
        this.phase = "proxy";
        this.total = todoB.length;
        this.done = 0;
        const sumB = await fetchViaProxyForEntries(todoB, {
          signal: ctrl.signal,
          token: this.#token,
          onProgress: (done, _t, last) => {
            this.done = done;
            if (last.status === "got") this.proxyGot++;
            proxyByKey.set(last.key, last);
            noteOaMiss(last, ctrl.signal.aborted, false); // clear-on-success only — no recording
            opts.onTick?.(last.key, last.status === "got");
          },
        });
        for (const r of sumB.results) proxyByKey.set(r.key, r);
        blockedGroups = new Set(sumB.blockedGroups ?? []);
        this.blockedSkipped = [...proxyByKey.values()].filter((r) => r.reason === "publisher-blocked").length;
        // If the session is genuinely down, the phase bails after 2 session-expired results;
        // count how many still-missing papers were blocked that way so the toast can say so.
        const sessionDead = [...proxyByKey.values()].some((r) => r.reason === "session-expired");
        if (sessionDead && this.proxyGot === 0) {
          const pdfKeys2 = await listPdfKeys();
          this.needSignIn = missing.filter((r) => !hasPdfIn(pdfKeys2, r.key)).length;
        }
      } else if (missing.length && !gate.proxyConfigured) {
        // No EZProxy prefix set: those papers stay merely "missing" (set one in ⚙ Keys).
        this.needSignIn = missing.length;
      }

      // --- Part C: record / clear per-paper failure history -----------------------------
      await this.#reconcileFailures(enriched, oaByKey, proxyByKey, blockedGroups);

      // ENV failures (cancelled mid-item, publisher breaker) aren't errors of the paper.
      this.errors = [...oaByKey.values(), ...proxyByKey.values()].filter(
        (r) => r.status === "error" && !(r.reason && ENV_REASONS.has(r.reason)),
      ).length;
      return this.#finish(ctrl.signal.aborted);
    } catch (e) {
      this.note = (e as Error)?.message || "PDF fetch failed.";
      return this.#finish(true);
    } finally {
      await flushMisses(); // persist ledger progress even on cancel/throw (best-effort)
    }
  }

  /** Write a failure record for papers that genuinely exhausted BOTH routes; clear records
   *  for papers that succeeded. Never records environment failures (session/cancel), and
   *  never for papers whose publisher circuit breaker tripped this run — including the few
   *  failures that TRIPPED it (a temporary publisher block must not skip-list papers). */
  async #reconcileFailures(
    enriched: EnrichedEntry[],
    oaByKey: Map<string, GuiFetchResult>,
    proxyByKey: Map<string, GuiFetchResult>,
    blockedGroups: Set<string>,
  ) {
    const pdfKeys = await listPdfKeys();
    for (const r of enriched) {
      const key = r.key;
      const proxy = proxyByKey.get(key);
      const oa = oaByKey.get(key);
      if (hasPdfIn(pdfKeys, key)) {
        // Got it (this run or earlier) → drop any stale failure record.
        if (oa || proxy) await clearFetchFailure(key);
        continue;
      }
      // Only record a genuine both-routes-failure: we attempted the proxy AND it wasn't an
      // environment failure (session-expired / cancelled / not-configured).
      if (!proxy || proxy.status === "got") continue;
      if (proxy.reason && ENV_REASONS.has(proxy.reason)) continue;
      if (proxy.group && blockedGroups.has(proxy.group)) continue; // publisher wall, likely temporary
      if (this.cancelled) continue; // a cancelled run didn't truly exhaust routes
      this.failedNew++;
      await writeFetchFailure(key, {
        target: proxy.target || oa?.url || "",
        host: proxy.diag?.host,
        oa: oa ? (oa.status === "no-oa" ? "no-oa" : oa.error || oa.status) : undefined,
        proxy: {
          reason: proxy.reason,
          landedUrl: proxy.diag?.landedUrl,
          affordancesFound: proxy.diag?.affordancesFound,
          detail: proxy.diag?.detail,
        },
        lastError: proxy.error || oa?.error,
      });
    }
  }

  #finish(aborted: boolean): GuiFetchSummaryLite {
    const summary: GuiFetchSummaryLite = {
      oaGot: this.oaGot,
      proxyGot: this.proxyGot,
      errors: this.errors,
      failedNew: this.failedNew,
      needSignIn: this.needSignIn,
      oaSkipped: this.oaSkipped,
      blockedSkipped: this.blockedSkipped,
      publisherOnly: this.publisherOnly,
      cancelled: aborted || this.cancelled,
    };
    this.lastSummary = summary;
    this.runSeq++;
    this.running = false;
    this.phase = "";
    this.#ctrl = null;
    this.#token = "";
    return summary;
  }

  #reset() {
    this.done = 0;
    this.total = 0;
    this.oaGot = 0;
    this.proxyGot = 0;
    this.errors = 0;
    this.failedNew = 0;
    this.needSignIn = 0;
    this.oaSkipped = 0;
    this.blockedSkipped = 0;
    this.publisherOnly = 0;
    this.note = "";
    this.cancelled = false;
  }
}

export interface GuiFetchSummaryLite {
  oaGot: number;
  proxyGot: number;
  errors: number;
  failedNew: number;
  needSignIn: number;
  oaSkipped: number; // skipped by the OA-miss ledger (known no-OA, fresh)
  blockedSkipped: number; // skipped because their publisher's circuit breaker tripped
  publisherOnly: number; // OA exists but publisher-hosted only (deferred to the proxy route)
  cancelled: boolean;
}

/** Non-crypto token generator (renderer runtime — Date.now/Math.random are fine here). */
function genToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// The one shared job instance for the whole app session.
export const pdfFetchJob = new PdfFetchJob();
