import { isTransientNetworkError } from "./httpOutcome";
// Renderer twin of flux-core/acquire.ts — runs the SHARED resolver waterfall
// (pdfFinder.runWaterfall) with every fetch routed through main (fb.netGet, which
// dodges renderer CORS), then files the first magic-byte-valid PDF into items/<key>/
// via itemsBridge. Powers the Library "Get PDF" (per-row) + "Get PDFs" (bulk) actions.
// Same waterfall as the CLI/MCP path → the two engines can't drift.
import { fileBridge } from "../project/types";
import { runWaterfall, bareDoi, resolvePmcid, type PdfInputs, type FetchDeps } from "./pdfFinder";
import { fetchEuropePmcSupplements } from "./supplementFinder";
import { writePdfItem, readerHasPdf, fileSupplementBytes } from "./itemsBridge";
import { getLimiter, hostGroup, doiGroup, interleaveByGroup, abortableSleep, GET_COST } from "./hostLimiter";
import type { RefEntry, EnrichEntry } from "./types";

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** A netGet error is TRANSIENT (timeout / network / aborted — retry later) vs DEFINITIVE
 *  (an `HTTP <status>` — the server answered, so it's a real no-OA). Only definitive failures
 *  should ever become a recorded "no-OA" miss; a transient one must not (it would falsely
 *  suppress the paper for the ledger's 30-day TTL). Mirrors scripts/oa-bulk-run.ts. */
const isTransientErr = isTransientNetworkError;

/** FetchDeps backed by main's pdf:netGet (no CORS); errors collapse to null/`` so the
 *  waterfall just moves to the next resolver. Candidate-PDF GETs go through the shared
 *  per-publisher limiter — these are the session-creating hits that got the IP blocked at
 *  Cell Press (">90 sessions in 5 minutes"). An abort during the wait throws AbortError,
 *  which the waterfall swallows to null — callers must re-check the signal (see
 *  fetchPdfForEntry) so a cancel isn't misread as "no OA copy". `onTransient` fires when a
 *  candidate fetch fails at the transport level, so the caller can avoid recording a false miss. */
function bridgeDeps(email?: string, signal?: AbortSignal, onTransient?: () => void): FetchDeps {
  const fb = fileBridge();
  const ng = (url: string, mode: "json" | "text" | "bytes") => fb!.netGet!(url, mode);
  return {
    email,
    getJson: async (url) => {
      const r = await ng(url, "json");
      if (r && !r.error) return r.json;
      if (isTransientErr(r?.error)) onTransient?.();
      return null;
    },
    getText: async (url) => {
      const r = await ng(url, "text");
      if (r && !r.error) return r.text ?? null;
      if (isTransientErr(r?.error)) onTransient?.();
      return null;
    },
    getBytes: async (url) => {
      // Cookie-jar GETs → getLimiter (generous default; the elsevier group is capped at 45/5min
      // as the load-bearing ban backstop).
      const group = hostGroup(url);
      if (group) await getLimiter.acquire(group, GET_COST, signal);
      const r = await ng(url, "bytes");
      if (!r || r.error || !r.bytesB64) {
        if (isTransientErr(r?.error)) onTransient?.();
        return null;
      }
      const finalUrl = r.finalUrl ?? url;
      // A redirect that landed on a DIFFERENT publisher spent a session there too.
      const landed = hostGroup(finalUrl);
      if (landed && landed !== group) getLimiter.record(landed, GET_COST);
      return { bytes: b64ToU8(r.bytesB64), finalUrl, contentType: r.contentType ?? "" };
    },
  };
}

function inputsFor(entry: RefEntry, en?: EnrichEntry): PdfInputs {
  return {
    doi: entry.doi || en?.doi,
    openAccessUrl: en?.openAccess?.url,
    isOa: en?.openAccess?.isOa,
    pmid: en?.ids?.pmid,
    pmcid: en?.ids?.pmcid,
  };
}

async function readEmail(): Promise<string | undefined> {
  const fb = fileBridge();
  try {
    const k = await fb?.keysGet?.();
    return (k?.mailto as string) || undefined;
  } catch {
    return undefined;
  }
}

export type GuiFetchStatus = "have" | "got" | "no-oa" | "no-id" | "error";
export interface GuiFetchResult {
  key: string;
  status: GuiFetchStatus;
  source?: string;
  url?: string;
  error?: string;
  /** Why a fetch ended without a filed article: "cancelled" (the user stopped the run — not an
   *  error of the paper), or the writer's refusal ("supplement", …) when the resolver handed
   *  back something other than the article. */
  reason?: string;
  /** A candidate fetch failed at the transport level (timeout/network), so a null waterfall
   *  result is NOT a reliable "no-OA" — the bulk job must not record it as a miss. */
  transient?: boolean;
}

/** Acquire the OA PDF for one entry (skips if present unless refresh). */
export async function fetchPdfForEntry(
  entry: RefEntry,
  en: EnrichEntry | undefined,
  opts: { refresh?: boolean; email?: string; signal?: AbortSignal; bulkMode?: boolean } = {},
): Promise<GuiFetchResult> {
  const fb = fileBridge();
  if (!fb?.netGet) return { key: entry.key, status: "error", error: "The desktop app is required to fetch PDFs." };
  if (!opts.refresh && (await readerHasPdf(entry.key))) return { key: entry.key, status: "have" };
  const x = inputsFor(entry, en);
  if (!x.doi && !x.openAccessUrl && !x.pmcid) return { key: entry.key, status: "no-id" };
  const email = opts.email ?? (await readEmail());
  try {
    let transient = false;
    const r = await runWaterfall(
      x,
      bridgeDeps(email, opts.signal, () => {
        transient = true;
      }),
      { bulkMode: opts.bulkMode },
    );
    if (!r) {
      // The waterfall collapses an abort (thrown mid-rate-limit-wait) to null — don't let a
      // cancel masquerade as a genuine "no OA copy" (it would poison the OA-miss ledger).
      if (opts.signal?.aborted) return { key: entry.key, status: "error", error: "cancelled", reason: "cancelled" };
      // A transport-level failure (timeout/network) makes "no-oa" unreliable — flag it so the
      // bulk job doesn't record a false miss; the paper stays missing and retries next run.
      return { key: entry.key, status: "no-oa", transient: transient || undefined };
    }
    const w = await writePdfItem(entry.key, r.bytes, {
      source: r.source,
      replaceExisting: opts.refresh,
      url: r.url,
      finalUrl: r.finalUrl,
      isOa: r.source !== "crossref" ? true : x.isOa,
    });
    if (!w.ok && w.reason === "already-present") return {key: entry.key, status: "have"};
    // The resolver handed back supplementary material, not the article. It's been filed under
    // supplements/, but the paper is still missing — report that honestly so the OA-miss
    // ledger doesn't record a success.
    if (!w.ok) return { key: entry.key, status: "no-oa", error: w.reason === "supplement" ? `resolved to supplementary material (${w.signal})` : "could not file the PDF", reason: w.reason };
    return { key: entry.key, status: "got", source: r.source, url: r.url };
  } catch (e) {
    return { key: entry.key, status: "error", error: String((e as Error)?.message || e) };
  }
}

/**
 * Acquire a paper's SUPPLEMENTARY files without re-fetching its article, from Europe PMC's
 * open-access archive (one request to EBI, no publisher contact). Twin of flux-core
 * `fetchSupplements`; supplements of other papers come in through the browser extension or
 * by hand.
 */
export async function fetchSupplementsForEntry(
  entry: RefEntry,
  en?: EnrichEntry,
  opts: { email?: string; signal?: AbortSignal } = {},
): Promise<{ key: string; added: number; error?: string }> {
  const fb = fileBridge();
  if (!fb?.netGet) return { key: entry.key, added: 0, error: "The desktop app is required." };
  const email = opts.email ?? (await readEmail());
  const deps = bridgeDeps(email, opts.signal);
  let added = 0;
  try {
    const pmcid = await resolvePmcid(inputsFor(entry, en), deps);
    if (pmcid) {
      for (const s of await fetchEuropePmcSupplements(pmcid, deps)) {
        if (await fileSupplementBytes(entry.key, s.name, s.bytes, { label: s.label, url: s.url, source: s.source })) added++;
      }
    }
  } catch (e) {
    return { key: entry.key, added, error: String((e as Error)?.message || e) };
  }
  return { key: entry.key, added };
}

/** Backfill supplements across many papers, sequentially and cancellably. */
export async function fetchSupplementsForEntries(
  items: { entry: RefEntry; enrich?: EnrichEntry }[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number, last: { key: string; added: number; error?: string }) => void } = {},
): Promise<{ total: number; papers: number; files: number; errors: number }> {
  const email = await readEmail();
  let done = 0;
  let papers = 0;
  let files = 0;
  let errors = 0;
  for (const it of items) {
    if (opts.signal?.aborted) break;
    const r = await fetchSupplementsForEntry(it.entry, it.enrich, { email, signal: opts.signal });
    if (r.added) {
      papers++;
      files += r.added;
    }
    if (r.error) errors++;
    opts.onProgress?.(++done, items.length, r);
  }
  return { total: items.length, papers, files, errors };
}

export interface GuiFetchSummary {
  total: number;
  got: number;
  have: number;
  noOa: number;
  noId: number;
  error: number;
  results: GuiFetchResult[];
}

const summarize = (results: GuiFetchResult[], total: number): GuiFetchSummary => ({
  total,
  got: results.filter((r) => r.status === "got").length,
  have: results.filter((r) => r.status === "have").length,
  noOa: results.filter((r) => r.status === "no-oa").length,
  noId: results.filter((r) => r.status === "no-id").length,
  error: results.filter((r) => r.status === "error").length,
  results,
});

/** Acquire OA PDFs for many entries — polite + sequential, with progress. Stops promptly
 *  when `signal` aborts (checked at the loop top + during the delay). Items are interleaved
 *  across publishers so the per-publisher rate limiter throttles only its own papers.
 *  BULK downloads from repositories AND ordinary/gold-OA publishers (MDPI, Frontiers, PLOS,
 *  Wiley-OA, institutional repos, …) AND the volume-sensitive publishers (Elsevier/Cell
 *  Press, the source of the "90 sessions in 5 minutes" blocks) — there is no candidate
 *  filtering; ban-safety is the cookie-jar netGet (one session per host) + the
 *  per-publisher GET caps (elsevier ≤45/5min). The per-row single
 *  fetch (user-initiated, one paper) runs the same candidate set. */
export async function fetchPdfsForEntries(
  items: { entry: RefEntry; enrich?: EnrichEntry }[],
  opts: {
    refresh?: boolean;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, last: GuiFetchResult) => void;
  } = {},
): Promise<GuiFetchSummary> {
  const email = await readEmail();
  const ordered = interleaveByGroup(items, (it) => doiGroup(bareDoi(it.entry.doi || it.enrich?.doi)));
  const results: GuiFetchResult[] = [];
  let done = 0;
  for (const it of ordered) {
    if (opts.signal?.aborted) break;
    const r = await fetchPdfForEntry(it.entry, it.enrich, {
      refresh: opts.refresh,
      email,
      signal: opts.signal,
      bulkMode: true,
    });
    results.push(r);
    opts.onProgress?.(++done, items.length, r);
    if (done === ordered.length) break; // no politeness delay after the last item
    try {
      await abortableSleep(120, opts.signal);
    } catch {
      break; // aborted during the delay
    }
  }
  return summarize(results, items.length);
}
