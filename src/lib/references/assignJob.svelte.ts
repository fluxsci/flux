// Background "assign PDFs" job — the GUI twin of flux-core/assign.ts. A MODULE-LEVEL Svelte-5
// runes singleton (like pdfFetchJob) so a scan survives mode switches. Scans <FluxLib>/
// pdfs_to_assign/, identifies each PDF from its content via the SHARED pure core (pdfIdentify.ts),
// and files it: attach to an existing reference lacking a PDF, keep as a supplement if it already
// has a (different) PDF, or add the reference then attach. Unidentified PDFs move to _unresolved/
// with a sidecar note — EXCEPT transient (network) failures, which leave the file in place
// ("deferred") so an offline launch can never quarantine a good paper. Auto-scans when the
// watcher sees a PDF land in the inbox (assignInboxRevision). A real scan holds the FluxLib
// "assign" lock so a concurrent CLI/MCP run defers instead of racing the same files.
import { fileBridge, joinPath } from "../project/types";
import { resolveFluxLibPath, loadFluxLib } from "./fluxlibBridge";
import { searchWorld } from "./enrichBridge";
import { writePdfItem, readerHasPdf, readerSource } from "./itemsBridge";
import { bumpFluxLib, assignInboxRevision } from "./revision";
import { isPdfBytes, bareDoi } from "./pdfFinder";
import { assignInboxDir, supplementsDir, supplementFilePath, safeSupplementName } from "./items";
import { lightEntry } from "./bibtex";
import { identify, reconcile, type IdResult, type PaperMeta, type SearchHit } from "./pdfIdentify";
// (pdfSignals pulls pdf.js — dynamic-imported at the call site for the same
// W15 reason as bibLoad below: this module is eager via Shell.svelte.)
// NOTE deliberately NOT imported statically: Shell.svelte (eager at Home) uses
// this module for the assign-progress pill, and a static edge here chained the
// entire paper/scholar stack into the Home bundle (W15 startup gate). The one
// call site below dynamic-imports it when a PDF actually needs adding.
import { pushToast } from "../toast";

export type AssignAction = "attached" | "added-attached" | "discarded" | "unresolved" | "deferred";
export interface AssignItemResult {
  file: string;
  action: AssignAction;
  key?: string;
  doi?: string;
  title?: string;
  method?: string;
  reason?: string;
  keptAs?: string; // discard path: supplements/ filename the duplicate was kept under
}

/** Politeness gap between successive DOI resolutions. */
const RESOLVE_GAP_MS = 200;
/** This many consecutive transient (network) results aborts the scan — we're offline. */
const OFFLINE_BREAKER = 3;

/** Count the PDFs currently waiting in the inbox (for the Library button label). Ignores the
 *  _unresolved/ quarantine (its files are done, not pending). */
export async function countInbox(): Promise<number> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib || !fb.readdir) return 0;
  try {
    const ents = await fb.readdir(assignInboxDir(lib));
    return ents.filter((e) => !e.dir && /\.pdf$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}

let lastResolve = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastResolve + RESOLVE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastResolve = Date.now();
  return fn();
}

/** DOI → canonical metadata. Crossref first (through main, CORS-free); a definitive 404/410
 *  falls back to doi.org content negotiation (rescues DataCite DOIs: arXiv 10.48550/*, Zenodo).
 *  Returns null only when the DOI definitively does not resolve; THROWS on transient failures
 *  (offline/429/5xx) per the IdentifyDeps contract so identify() defers instead of condemning. */
async function resolveDoiFn(doi: string): Promise<PaperMeta | null> {
  const fb = fileBridge();
  if (!fb?.fetchDoi) throw new Error("no bridge");
  const r = (await fb.fetchDoi(doi)) as { message?: any; error?: string } | null;
  if (r?.message) {
    const m = r.message;
    const title = Array.isArray(m?.title) ? m.title[0] : m?.title;
    if (title) {
      const authors = Array.isArray(m.author)
        ? m.author.map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name || a.family || "").filter(Boolean)
        : [];
      const dp = m.issued?.["date-parts"]?.[0]?.[0] ?? m["published-print"]?.["date-parts"]?.[0]?.[0] ?? m["published-online"]?.["date-parts"]?.[0]?.[0];
      const container = Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined;
      return { doi, title: String(title), authors, year: dp != null ? String(dp) : undefined, container };
    }
    // Resolved at Crossref but without a usable title — fall through to doi.org.
  } else {
    const err = r?.error ?? "empty response";
    if (!/^HTTP (404|410)$/.test(err)) throw new Error(err); // 429/5xx/network → transient
  }
  if (fb.fetchDoiBibtex) {
    const alt = await fb.fetchDoiBibtex(doi);
    if (alt?.bibtex) {
      const e = lightEntry(alt.bibtex);
      if (e.title) return { doi, title: e.title, authors: e.authors, year: e.year || undefined, container: e.container };
      return null;
    }
    const aerr = alt?.error ?? "";
    if (aerr && !/^HTTP (404|410)$/.test(aerr) && aerr !== "DOI did not return BibTeX" && aerr !== "not a DOI") {
      throw new Error(aerr); // transient at doi.org
    }
  }
  return null;
}

/** Title search — throws on network failure (transient per the IdentifyDeps contract). */
async function searchTitleFn(query: string): Promise<SearchHit[]> {
  const briefs = await searchWorld(query, { perPage: 5 });
  return briefs.map((b) => ({ doi: b.doi, title: b.title, authors: b.authors, year: b.year || undefined, score: b.relevanceScore }));
}

const DEPS = { resolveDoi: (doi: string) => paced(() => resolveDoiFn(doi)), searchTitle: searchTitleFn };

class AssignJob {
  running = $state(false);
  done = $state(0);
  total = $state(0);
  attached = $state(0);
  added = $state(0);
  discarded = $state(0);
  unresolved = $state(0);
  deferred = $state(0); // transient (network) — left in the inbox to retry
  offline = $state(false); // the offline breaker tripped this run
  cancelled = $state(false);
  runSeq = $state(0); // bumps once per finished run (Library keys its refresh on this)
  lastResults = $state<AssignItemResult[]>([]);

  get active() {
    return this.running;
  }
  cancel() {
    this.cancelled = true;
  }

  #reset() {
    this.done = 0;
    this.total = 0;
    this.attached = 0;
    this.added = 0;
    this.discarded = 0;
    this.unresolved = 0;
    this.deferred = 0;
    this.offline = false;
    this.cancelled = false;
  }

  /** Scan the inbox and file each PDF. Returns the per-file results. */
  async start(): Promise<AssignItemResult[]> {
    if (this.running) return [];
    const fb = fileBridge();
    const lib = await resolveFluxLibPath();
    if (!fb || !lib || !fb.readdir) return [];
    // Cross-engine coordination: refuse to race a CLI/MCP scan; hold a heartbeat lock ourselves.
    const got = await fb.lockAcquire?.("fluxlib", "assign");
    if (got && !got.ok) {
      pushToast("info", "Assign scan deferred", { detail: `the inbox is being processed by ${got.heldBy ?? "another session"}` });
      return [];
    }
    await fb.lockSet?.("assign", true, "fluxlib");
    this.running = true;
    this.#reset();
    const dir = assignInboxDir(lib);
    const results: AssignItemResult[] = [];
    try {
      const names = (await fb.readdir(dir).catch(() => []))
        .filter((e) => !e.dir && /\.pdf$/i.test(e.name))
        .map((e) => e.name)
        .sort();
      this.total = names.length;

      // DOI → citekey index over the current library (updated as we add within the batch).
      const doiIndex = new Map<string, string>();
      for (const e of await loadFluxLib()) {
        const d = bareDoi(e.doi);
        if (d) doiIndex.set(d, e.key);
      }

      let consecutiveTransient = 0;
      for (const name of names) {
        if (this.cancelled) break;
        const rec = await this.#process(fb, lib, dir, name, doiIndex);
        results.push(rec);
        if (rec.action === "attached") this.attached++;
        else if (rec.action === "added-attached") this.added++;
        else if (rec.action === "discarded") this.discarded++;
        else if (rec.action === "deferred") this.deferred++;
        else this.unresolved++;
        this.done++;
        consecutiveTransient = rec.action === "deferred" ? consecutiveTransient + 1 : 0;
        if (consecutiveTransient >= OFFLINE_BREAKER && this.done < this.total) {
          this.offline = true; // network is down — stop grinding; everything stays in the inbox
          break;
        }
      }
    } finally {
      await fb.lockSet?.("assign", false, "fluxlib").catch(() => {});
      this.lastResults = results;
      this.runSeq++;
      this.running = false;
      if (results.some((r) => r.action !== "unresolved" && r.action !== "deferred")) bumpFluxLib(); // refresh Library/reader
    }
    return results;
  }

  async #process(
    fb: NonNullable<ReturnType<typeof fileBridge>>,
    lib: string,
    dir: string,
    name: string,
    doiIndex: Map<string, string>,
  ): Promise<AssignItemResult> {
    const src = joinPath(dir, name);
    const rec: AssignItemResult = { file: name, action: "unresolved" };
    try {
      const buf = await fb.readFile(src);
      const bytes = new Uint8Array(buf);
      if (!isPdfBytes(bytes)) {
        rec.reason = "not a PDF (bad magic bytes)";
        await this.#quarantine(fb, dir, name, bytes, null, rec.reason);
        return rec;
      }
      const { extractPdfSignals } = await import("../pdf/pdfSignals");
      const sig = await extractPdfSignals(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
      const id = await identify(sig, DEPS);
      if (id.status !== "identified") {
        rec.reason = id.reason;
        if (id.retryable) {
          rec.action = "deferred"; // network blink — leave the file for the next scan
          return rec;
        }
        await this.#quarantine(fb, dir, name, bytes, id, id.reason);
        return rec;
      }
      rec.doi = id.doi;
      rec.title = id.meta.title;
      rec.method = id.method;
      const existingKey = doiIndex.get(bareDoi(id.doi)!) ?? null;
      const already = existingKey ? await readerHasPdf(existingKey) : false;
      const action = reconcile(id, existingKey, already);
      if (action.kind === "discard") {
        rec.action = "discarded";
        rec.key = action.key;
        rec.keptAs = (await this.#keepAsSupplement(fb, lib, action.key, src, name, bytes)) ?? undefined;
      } else if (action.kind === "attach") {
        rec.action = "attached";
        rec.key = action.key;
        await writePdfItem(action.key, bytes, { source: "assigned", url: name, isOa: false });
        await fb.remove?.(src);
      } else {
        const { addDoiToLibrary } = await import("../../shell/modes/paper/scholar/bibLoad");
        const added = await addDoiToLibrary(id.doi);
        if ("error" in added) {
          rec.action = "deferred";
          rec.reason = "couldn't create library entry: " + added.error;
          return rec; // leave the file in place to retry (identity was fine)
        }
        rec.action = "added-attached";
        rec.key = added.key;
        doiIndex.set(bareDoi(id.doi)!, added.key);
        await writePdfItem(added.key, bytes, { source: "assigned", url: name, isOa: false });
        await fb.remove?.(src);
      }
    } catch (e) {
      // Unexpected failure (fs hiccup, pdf.js crash): NEVER destructive — leave the file in
      // place and report it; a definitive "can't identify" is the only road to _unresolved/.
      rec.action = "deferred";
      rec.reason = "error: " + String((e as Error)?.message || e);
    }
    return rec;
  }

  /** The reference already has a paper.pdf: NEVER delete the incoming bytes — keep them in
   *  items/<key>/supplements/ (the reader's "Switch PDF" menu lists them), unless byte-identical
   *  to the stored PDF. Returns the kept filename, or null when deleted-as-identical. */
  async #keepAsSupplement(
    fb: NonNullable<ReturnType<typeof fileBridge>>,
    lib: string,
    key: string,
    src: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<string | null> {
    try {
      const stored = await readerSource(key);
      if (stored?.sha256) {
        const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
        const incoming = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (incoming === stored.sha256) {
          await fb.remove?.(src);
          return null;
        }
      }
    } catch {
      /* hash unavailable → keep the bytes (safe default) */
    }
    if (fb.mkdir) await fb.mkdir(supplementsDir(lib, key));
    let dst = safeSupplementName(`duplicate-${name}`);
    if (!/\.pdf$/i.test(dst)) dst += ".pdf";
    const base = dst.replace(/\.pdf$/i, "");
    for (let i = 2; await fb.exists(supplementFilePath(lib, key, dst)); i++) dst = `${base}-${i}.pdf`;
    await fb.writeFile(supplementFilePath(lib, key, dst), bytes);
    await fb.remove?.(src);
    return dst;
  }

  async #quarantine(
    fb: NonNullable<ReturnType<typeof fileBridge>>,
    dir: string,
    name: string,
    bytes: Uint8Array,
    id: IdResult | null,
    note: string,
  ): Promise<void> {
    try {
      const udir = joinPath(dir, "_unresolved");
      if (fb.mkdir) await fb.mkdir(udir);
      let dst = joinPath(udir, name);
      for (let i = 2; await fb.exists(dst); i++) dst = joinPath(udir, name.replace(/\.pdf$/i, `-${i}.pdf`));
      await fb.writeFile(dst, bytes);
      await fb.remove?.(joinPath(dir, name));
      const lines = [`Could not identify "${name}" with confidence.`, `Reason: ${note}`, ""];
      if (id && id.status === "unresolved") {
        const d = id.diagnostics;
        if (d.candidates.length) lines.push("DOI candidates seen:", ...d.candidates.map((c) => `  ${c.doi} (${c.source})`));
        if (d.rejected.length) lines.push("Rejected:", ...d.rejected.map((r) => `  ${r}`));
        if (d.query) lines.push(`Title query: ${d.query}`);
        if (d.topHits?.length) lines.push("Top search hits:", ...d.topHits.map((h) => `  ${h.sim.toFixed(2)}  ${h.title}${h.doi ? `  (${h.doi})` : ""}`));
      }
      await fb.writeText(`${dst}.txt`, lines.join("\n") + "\n");
    } catch {
      /* best-effort quarantine */
    }
  }
}

export const assignJob = new AssignJob();

// Watcher-driven auto-scan: a PDF landing in the inbox (with a project open, so the
// chokidar watcher is running) kicks a scan ~1.5s later — the "watched drop-folder"
// promise for real. Guarded: never while a scan runs, never when offline (the mount-time
// auto-scan in LibraryMode has the same guard).
let inboxDebounce: ReturnType<typeof setTimeout> | null = null;
let seenInboxRev = 0;
assignInboxRevision.subscribe((n) => {
  if (n === 0 || n === seenInboxRev) return; // skip the subscribe replay
  seenInboxRev = n;
  if (inboxDebounce) clearTimeout(inboxDebounce);
  inboxDebounce = setTimeout(() => {
    inboxDebounce = null;
    if (!assignJob.running && navigator.onLine !== false) void assignJob.start();
  }, 1500);
});
