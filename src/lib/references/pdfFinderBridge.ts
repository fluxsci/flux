// Renderer twin of flux-core/acquire.ts — runs the SHARED resolver waterfall
// (pdfFinder.runWaterfall) with every fetch routed through main (fb.netGet, which
// dodges renderer CORS), then files the first magic-byte-valid PDF into items/<key>/
// via itemsBridge. Powers the Library "Get PDF" (per-row) + "Get PDFs" (bulk) actions.
// Same waterfall as the CLI/MCP path → the two engines can't drift.
import { fileBridge } from "../project/types";
import { runWaterfall, isPdfBytes, bareDoi, resolvePmcid, type PdfInputs, type FetchDeps } from "./pdfFinder";
import { fetchEuropePmcSupplements } from "./supplementFinder";
import { writePdfItem, readerHasPdf, fileSupplementBytes } from "./itemsBridge";
import { sharedLimiter, getLimiter, hostGroup, doiGroup, interleaveByGroup, abortableSleep, GET_COST, CAPTURE_COST } from "./hostLimiter";
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
const isTransientErr = (err?: string): boolean => !!err && !/^HTTP \d/.test(err);

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
      // as the load-bearing ban backstop). Proxy captures below still use sharedLimiter.
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
  // Proxy-only: the engine's failure classification (feeds the Part C failure log). `reason`
  // ∈ "no-affordances" | "not-a-pdf" | "error" (genuine, loggable) vs "session-expired" |
  // "cancelled" | "not-configured" (environment — never logged as a paper failure).
  reason?: string;
  diag?: { landedUrl?: string; host?: string; affordancesFound?: string[]; detail?: string };
  via?: string;
  target?: string; // the URL we attempted (for the failure record)
  group?: string; // publisher rate-limit group (proxy phase — feeds the circuit breaker)
  /** A candidate fetch failed at the transport level (timeout/network), so a null waterfall
   *  result is NOT a reliable "no-OA" — the bulk job must not record it as a miss. */
  transient?: boolean;
  /** Supplementary files captured alongside the article (proxy phase, when requested). */
  supplements?: number;
}

/** Environment/session failures that must NOT be recorded as a paper's fetch failure.
 *  "publisher-blocked" = the per-publisher circuit breaker tripped this run (looks like a
 *  temporary IP block / wall) — those papers stay merely "missing" and retry next run. */
export const ENV_REASONS = new Set(["session-expired", "cancelled", "not-configured", "publisher-blocked"]);

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
      url: r.url,
      finalUrl: r.finalUrl,
      isOa: r.source !== "crossref" ? true : x.isOa,
    });
    // The resolver handed back supplementary material, not the article. It's been filed under
    // supplements/, but the paper is still missing — report that honestly so the proxy phase
    // still runs and the OA-miss ledger doesn't record a success.
    if (!w.ok) return { key: entry.key, status: "no-oa", error: w.reason === "supplement" ? `resolved to supplementary material (${w.signal})` : "could not file the PDF", reason: w.reason };
    return { key: entry.key, status: "got", source: r.source, url: r.url };
  } catch (e) {
    return { key: entry.key, status: "error", error: String((e as Error)?.message || e) };
  }
}

/**
 * Acquire a paper's SUPPLEMENTARY files without re-fetching its article.
 *
 * Repository first: Europe PMC's archive is one request to EBI and carries no publisher
 * ban risk. The publisher page is the fallback, and only when explicitly allowed — it costs
 * a full authenticated browser capture, which is the expensive half of a PDF fetch.
 */
export async function fetchSupplementsForEntry(
  entry: RefEntry,
  en?: EnrichEntry,
  opts: { email?: string; signal?: AbortSignal; token?: string; allowProxy?: boolean } = {},
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
  if (added || !opts.allowProxy || !fb.fetchViaProxy) return { key: entry.key, added };
  // Nothing in the repository — go to the publisher's page. This deliberately re-runs the
  // full capture (the supplement links only exist on that page); the main PDF it returns is
  // simply discarded when the paper already has one.
  const r = await fetchViaProxyForEntry(entry, en, { token: opts.token, withSupplements: true });
  return { key: entry.key, added: added + (r.supplements ?? 0), error: r.status === "got" ? undefined : r.error };
}

/**
 * Backfill supplements across many papers. Sequential and rate-limited like the proxy phase,
 * because the fallback leg IS a publisher capture — this library has been IP-blocked twice
 * for request volume, so the sweep is deliberately unhurried and cancellable.
 */
export async function fetchSupplementsForEntries(
  items: { entry: RefEntry; enrich?: EnrichEntry }[],
  opts: { signal?: AbortSignal; token?: string; allowProxy?: boolean; delayMs?: number; onProgress?: (done: number, total: number, last: { key: string; added: number; error?: string }) => void } = {},
): Promise<{ total: number; papers: number; files: number; errors: number }> {
  const groupOf = (it: { entry: RefEntry; enrich?: EnrichEntry }): string | null => {
    const doi = bareDoi(it.entry.doi || it.enrich?.doi);
    return doiGroup(doi) ?? hostGroup(it.enrich?.openAccess?.url || it.entry.url);
  };
  const ordered = interleaveByGroup(items, groupOf);
  const email = await readEmail();
  let done = 0;
  let papers = 0;
  let files = 0;
  let errors = 0;
  for (const it of ordered) {
    if (opts.signal?.aborted) break;
    const group = groupOf(it);
    if (group && opts.allowProxy) {
      try {
        await sharedLimiter.acquire(group, CAPTURE_COST, opts.signal);
      } catch {
        break;
      }
    }
    const r = await fetchSupplementsForEntry(it.entry, it.enrich, { email, signal: opts.signal, token: opts.token, allowProxy: opts.allowProxy });
    if (r.added) {
      papers++;
      files += r.added;
    }
    if (r.error) errors++;
    opts.onProgress?.(++done, items.length, r);
    if (opts.allowProxy) await abortableSleep(opts.delayMs ?? 1500, opts.signal).catch(() => {});
  }
  return { total: items.length, papers, files, errors };
}

/** Acquire a paywalled PDF via the library proxy (EZProxy), only after OA has failed. Files
 *  it with source "proxy" (version-of-record, isOa:false). `token` lets a bulk run cancel the
 *  in-flight main-process fetch; failures carry the engine's `reason`/`diag` for the Part C
 *  failure log. A non-PDF/failed result is reported as "no-oa" (proxy didn't yield). */
export async function fetchViaProxyForEntry(
  entry: RefEntry,
  en?: EnrichEntry,
  opts: { token?: string; withSupplements?: boolean } = {},
): Promise<GuiFetchResult> {
  const fb = fileBridge();
  if (!fb?.fetchViaProxy) return { key: entry.key, status: "error", error: "The desktop app is required." };
  const doi = bareDoi(entry.doi || en?.doi);
  const target = doi ? `https://doi.org/${doi}` : en?.openAccess?.url || entry.url;
  if (!target) return { key: entry.key, status: "no-id" };
  try {
    const r = await fb.fetchViaProxy(target, opts.token, { withSupplements: opts.withSupplements });
    if (!r || r.error || !r.bytesB64) {
      return { key: entry.key, status: "no-oa", error: r?.error, reason: r?.reason, diag: r?.diag, target };
    }
    const bytes = b64ToU8(r.bytesB64);
    if (!isPdfBytes(bytes)) return { key: entry.key, status: "no-oa", error: "not a PDF", reason: "not-a-pdf", target };
    const w = await writePdfItem(entry.key, bytes, { source: "proxy", url: target, finalUrl: r.finalUrl, isOa: false });
    if (!w.ok) return { key: entry.key, status: "no-oa", error: w.reason === "supplement" ? `captured supplementary material, not the article (${w.signal})` : "could not file the PDF", reason: w.reason, target };
    // The engine captured the paper's supplementary files on the same authenticated page —
    // file them beside it. Best-effort: a supplement failure never demotes a good main text.
    let supplements = 0;
    for (const s of r.supplements ?? []) {
      try {
        if (await fileSupplementBytes(entry.key, s.name, b64ToU8(s.bytesB64), { label: s.label, url: s.url, source: "proxy" })) supplements++;
      } catch {
        /* keep going — the article is already filed */
      }
    }
    return { key: entry.key, status: "got", source: "proxy", via: r.via, target, supplements: supplements || undefined };
  } catch (e) {
    return { key: entry.key, status: "error", error: String((e as Error)?.message || e), reason: "error", target };
  }
}

export interface GuiFetchSummary {
  total: number;
  got: number;
  have: number;
  noOa: number;
  noId: number;
  error: number;
  results: GuiFetchResult[];
  /** Publisher groups whose circuit breaker tripped this run (proxy phase) — papers in
   *  these groups must NOT get a durable failure record (the wall is likely temporary). */
  blockedGroups?: string[];
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
 *  per-publisher GET caps (elsevier ≤45/5min) + the circuit breaker. The per-row single
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

/** Consecutive genuine failures for one publisher group before we stop attempting that
 *  group for the rest of the run. A publisher that has (temporarily) walled/blocked us
 *  fails every paper the same way — grinding on burns rate budget, risks extending the
 *  block, and would wrongly skip-list every paper behind a transient wall. */
const PUBLISHER_TRIP_COUNT = 3;

/** Acquire paywalled PDFs via the library proxy for many entries — sequential (the main
 *  process serializes proxy windows anyway), interleaved across publishers, rate-limited
 *  per publisher (a capture is a multi-navigation session burst), politely throttled with
 *  adaptive backoff on errors, cancellable, self-halting if the library session drops, and
 *  per-publisher circuit-broken after repeated failures. Only call after OA has failed for
 *  these entries. `onProgress(done,total,last)` ticks per item. */
export async function fetchViaProxyForEntries(
  items: { entry: RefEntry; enrich?: EnrichEntry }[],
  opts: {
    signal?: AbortSignal;
    token?: string;
    delayMs?: number;
    /** Also capture each paper's supplementary files. OFF by default in bulk: it multiplies
     *  the GETs per paper, and this library has already been IP-blocked twice for publisher
     *  request volume. The dedicated supplements sweep opts in explicitly. */
    withSupplements?: boolean;
    onProgress?: (done: number, total: number, last: GuiFetchResult) => void;
  } = {},
): Promise<GuiFetchSummary> {
  const groupOf = (it: { entry: RefEntry; enrich?: EnrichEntry }): string | null => {
    const doi = bareDoi(it.entry.doi || it.enrich?.doi);
    return doiGroup(doi) ?? hostGroup(it.enrich?.openAccess?.url || it.entry.url);
  };
  const ordered = interleaveByGroup(items, groupOf);
  const results: GuiFetchResult[] = [];
  const consecFail = new Map<string, number>(); // group → consecutive genuine failures
  const blockedGroups = new Set<string>();
  let done = 0;
  let delay = opts.delayMs ?? 1500; // politeness; grows on errors so we don't hammer a publisher
  let sessionDead = 0; // consecutive "session isn't active" → bail (re-auth needed)
  for (const it of ordered) {
    if (opts.signal?.aborted) break;
    const group = groupOf(it) ?? undefined;

    // Circuit breaker: this publisher failed PUBLISHER_TRIP_COUNT papers in a row — skip
    // its remaining papers (env-reason, never recorded; they retry next run).
    if (group && blockedGroups.has(group)) {
      const r: GuiFetchResult = { key: it.entry.key, status: "no-oa", reason: "publisher-blocked", group };
      results.push(r);
      opts.onProgress?.(++done, items.length, r);
      continue; // no network touched — no delay needed
    }

    // A capture is a burst of publisher navigations — budget it against the group's window.
    if (group) {
      try {
        await sharedLimiter.acquire(group, CAPTURE_COST, opts.signal);
      } catch {
        break; // aborted while waiting for rate-limit room
      }
    }
    const r = await fetchViaProxyForEntry(it.entry, it.enrich, { token: opts.token, withSupplements: opts.withSupplements });
    if (group) r.group = group;
    results.push(r);
    opts.onProgress?.(++done, items.length, r);

    if (r.reason === "session-expired") {
      if (++sessionDead >= 2) break; // library session dropped — stop; the rest just stay "missing"
    } else {
      sessionDead = 0;
    }
    if (group) {
      const genuineFail = r.status !== "got" && r.status !== "have" && !(r.reason && ENV_REASONS.has(r.reason));
      const n = genuineFail ? (consecFail.get(group) ?? 0) + 1 : 0;
      consecFail.set(group, n);
      if (n >= PUBLISHER_TRIP_COUNT) blockedGroups.add(group);
    }
    // Adaptive backoff: slow down after a genuine failure, speed back up after a success.
    if (r.status === "got") delay = Math.max(opts.delayMs ?? 1500, delay / 1.5);
    else if (r.status === "error" || r.status === "no-oa") delay = Math.min(8000, delay * 1.5);

    if (done === ordered.length) break; // no politeness delay after the last item
    try {
      await abortableSleep(delay, opts.signal);
    } catch {
      break;
    }
  }
  return { ...summarize(results, items.length), blockedGroups: [...blockedGroups] };
}
