// Renderer twin of flux-core/acquire.ts — runs the SHARED resolver waterfall
// (pdfFinder.runWaterfall) with every fetch routed through main (fb.netGet, which
// dodges renderer CORS), then files the first magic-byte-valid PDF into items/<key>/
// via itemsBridge. Powers the Library "Get PDF" (per-row) + "Get PDFs" (bulk) actions.
// Same waterfall as the CLI/MCP path → the two engines can't drift.
import { fileBridge } from "../project/types";
import { runWaterfall, isPdfBytes, bareDoi, type PdfInputs, type FetchDeps } from "./pdfFinder";
import { writePdfItem, readerHasPdf } from "./itemsBridge";
import type { RefEntry, EnrichEntry } from "./types";

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** FetchDeps backed by main's pdf:netGet (no CORS); errors collapse to null/`` so the
 *  waterfall just moves to the next resolver. */
function bridgeDeps(email?: string): FetchDeps {
  const fb = fileBridge();
  const ng = (url: string, mode: "json" | "text" | "bytes") => fb!.netGet!(url, mode);
  return {
    email,
    getJson: async (url) => {
      const r = await ng(url, "json");
      return r && !r.error ? r.json : null;
    },
    getText: async (url) => {
      const r = await ng(url, "text");
      return r && !r.error ? (r.text ?? null) : null;
    },
    getBytes: async (url) => {
      const r = await ng(url, "bytes");
      if (!r || r.error || !r.bytesB64) return null;
      return { bytes: b64ToU8(r.bytesB64), finalUrl: r.finalUrl ?? url, contentType: r.contentType ?? "" };
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
}

/** Acquire the OA PDF for one entry (skips if present unless refresh). */
export async function fetchPdfForEntry(
  entry: RefEntry,
  en: EnrichEntry | undefined,
  opts: { refresh?: boolean; email?: string } = {},
): Promise<GuiFetchResult> {
  const fb = fileBridge();
  if (!fb?.netGet) return { key: entry.key, status: "error", error: "The desktop app is required to fetch PDFs." };
  if (!opts.refresh && (await readerHasPdf(entry.key))) return { key: entry.key, status: "have" };
  const x = inputsFor(entry, en);
  if (!x.doi && !x.openAccessUrl && !x.pmcid) return { key: entry.key, status: "no-id" };
  const email = opts.email ?? (await readEmail());
  try {
    const r = await runWaterfall(x, bridgeDeps(email));
    if (!r) return { key: entry.key, status: "no-oa" };
    await writePdfItem(entry.key, r.bytes, {
      source: r.source,
      url: r.url,
      finalUrl: r.finalUrl,
      isOa: r.source !== "crossref" ? true : x.isOa,
    });
    return { key: entry.key, status: "got", source: r.source, url: r.url };
  } catch (e) {
    return { key: entry.key, status: "error", error: String((e as Error)?.message || e) };
  }
}

/** Acquire a paywalled PDF via the library proxy (EZProxy) — user-initiated, only after
 *  OA has failed. Files it with source "proxy" (version-of-record, isOa:false). */
export async function fetchViaProxyForEntry(entry: RefEntry, en?: EnrichEntry): Promise<GuiFetchResult> {
  const fb = fileBridge();
  if (!fb?.fetchViaProxy) return { key: entry.key, status: "error", error: "The desktop app is required." };
  const doi = bareDoi(entry.doi || en?.doi);
  const target = doi ? `https://doi.org/${doi}` : en?.openAccess?.url || entry.url;
  if (!target) return { key: entry.key, status: "no-id" };
  try {
    const r = await fb.fetchViaProxy(target);
    if (!r || r.error || !r.bytesB64) return { key: entry.key, status: "no-oa", error: r?.error };
    const bytes = b64ToU8(r.bytesB64);
    if (!isPdfBytes(bytes)) return { key: entry.key, status: "no-oa", error: "not a PDF" };
    await writePdfItem(entry.key, bytes, { source: "proxy", url: target, finalUrl: r.finalUrl, isOa: false });
    return { key: entry.key, status: "got", source: "proxy" };
  } catch (e) {
    return { key: entry.key, status: "error", error: String((e as Error)?.message || e) };
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
}

/** Acquire OA PDFs for many entries — polite + sequential, with progress. */
export async function fetchPdfsForEntries(
  items: { entry: RefEntry; enrich?: EnrichEntry }[],
  opts: { refresh?: boolean; onProgress?: (done: number, total: number, last: GuiFetchResult) => void } = {},
): Promise<GuiFetchSummary> {
  const email = await readEmail();
  const results: GuiFetchResult[] = [];
  let done = 0;
  for (const it of items) {
    const r = await fetchPdfForEntry(it.entry, it.enrich, { refresh: opts.refresh, email });
    results.push(r);
    opts.onProgress?.(++done, items.length, r);
    await new Promise((res) => setTimeout(res, 120));
  }
  return {
    total: items.length,
    got: results.filter((r) => r.status === "got").length,
    have: results.filter((r) => r.status === "have").length,
    noOa: results.filter((r) => r.status === "no-oa").length,
    noId: results.filter((r) => r.status === "no-id").length,
    error: results.filter((r) => r.status === "error").length,
    results,
  };
}
