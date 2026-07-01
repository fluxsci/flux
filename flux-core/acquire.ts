// flux-core/acquire.ts — the PDF-acquisition engine (Node side: CLI/MCP/agents).
// Runs the OA resolver waterfall (src/lib/references/pdfFinder.ts) over a FluxLib
// entry's identifiers (from enrich.json + the .bib), downloads the first magic-byte-
// valid PDF, and files it into items/<citekey>/ with provenance. Proxy/paywall is a
// later phase (GUI/Electron-only). The renderer twin lives in pdfFinderBridge.ts.
import { loadLibrary, loadEnrich, getSecret } from "./fluxlib";
import { hasPdf, writePdf, writeFulltext } from "./items";
import { extractFulltext } from "./fulltext";
import { runWaterfall, isPdfBytes, type PdfInputs, type FetchDeps } from "../src/lib/references/pdfFinder";
import { readFile } from "node:fs/promises";

const UA = "Flux/0.1 (PDF acquisition; mailto:flux)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */

async function dl(url: string): Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string } | null> {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA, Accept: "application/pdf,*/*" } });
    if (!r.ok) return null;
    return {
      bytes: new Uint8Array(await r.arrayBuffer()),
      finalUrl: r.url || url,
      contentType: r.headers.get("content-type") || "",
    };
  } catch {
    return null;
  }
}
async function getJson(url: string): Promise<any> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** Node-side fetchers for the shared waterfall (global fetch — no CORS). */
const nodeDeps = (email?: string): FetchDeps => ({ getJson, getText, getBytes: dl, email });

export type FetchStatus = "have" | "got" | "no-oa" | "no-id";
export interface FetchOneResult {
  key: string;
  status: FetchStatus;
  source?: string;
  url?: string;
}

function inputsFor(key: string, lib: any[], enrich: Record<string, any>): PdfInputs {
  const e = lib.find((r) => r.key === key);
  const en = enrich[key];
  return {
    doi: e?.doi || en?.doi,
    openAccessUrl: en?.openAccess?.url,
    isOa: en?.openAccess?.isOa,
    pmid: en?.ids?.pmid,
    pmcid: en?.ids?.pmcid,
  };
}

/** Acquire the OA PDF for one citekey (skips if present unless refresh). */
export async function fetchPdfForKey(
  key: string,
  opts: { refresh?: boolean; libPath?: string } = {},
): Promise<FetchOneResult> {
  if (!opts.refresh && (await hasPdf(key, opts.libPath))) return { key, status: "have" };
  const [lib, enrich] = await Promise.all([loadLibrary(opts.libPath), loadEnrich(opts.libPath)]);
  const x = inputsFor(key, lib, enrich);
  if (!x.doi && !x.openAccessUrl && !x.pmcid) return { key, status: "no-id" };
  const email = (await getSecret("mailto")) || undefined;
  const r = await runWaterfall(x, nodeDeps(email));
  if (r) {
    await writePdf(
      key,
      r.bytes,
      { source: r.source, url: r.url, finalUrl: r.finalUrl, isOa: r.source !== "crossref" ? true : x.isOa },
      opts.libPath,
    );
    // Extract full text (search + agent reading context). Non-fatal: a scanned/image
    // PDF just yields little text; the fetch still succeeds.
    try {
      const ft = await extractFulltext(r.bytes);
      if (ft.chars > 0) await writeFulltext(key, ft.text, opts.libPath);
    } catch {
      /* extraction failed — PDF is still stored */
    }
    return { key, status: "got", source: r.source, url: r.url };
  }
  return { key, status: "no-oa" };
}

/** Manually ingest a hand-downloaded PDF into items/<key>/ (the fallback for paywalled
 *  papers with no OA copy). Validates the %PDF- header, files it with source "ingest",
 *  and extracts fulltext.txt. Throws on a missing/invalid file. */
export async function ingestPdf(filePath: string, opts: { key: string; libPath?: string }): Promise<FetchOneResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(filePath));
  } catch {
    throw new Error(`cannot read ${filePath}`);
  }
  if (!isPdfBytes(bytes)) throw new Error(`${filePath} is not a PDF (missing %PDF- header)`);
  await writePdf(opts.key, bytes, { source: "ingest", url: filePath, finalUrl: filePath }, opts.libPath);
  try {
    const ft = await extractFulltext(bytes);
    if (ft.chars > 0) await writeFulltext(opts.key, ft.text, opts.libPath);
  } catch {
    /* unextractable — PDF still stored */
  }
  return { key: opts.key, status: "got", source: "ingest" };
}

export interface FetchSummary {
  total: number;
  got: number;
  have: number;
  noOa: number;
  noId: number;
  results: FetchOneResult[];
}

/** Acquire OA PDFs for many keys (or the whole library). Polite + sequential. */
export async function fetchPdfs(
  opts: { keys?: string[]; refresh?: boolean; libPath?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<FetchSummary> {
  const keys = opts.keys ?? (await loadLibrary(opts.libPath)).map((e) => e.key);
  const results: FetchOneResult[] = [];
  let done = 0;
  for (const key of keys) {
    results.push(await fetchPdfForKey(key, { refresh: opts.refresh, libPath: opts.libPath }));
    opts.onProgress?.(++done, keys.length);
    await sleep(120);
  }
  return {
    total: keys.length,
    got: results.filter((r) => r.status === "got").length,
    have: results.filter((r) => r.status === "have").length,
    noOa: results.filter((r) => r.status === "no-oa").length,
    noId: results.filter((r) => r.status === "no-id").length,
    results,
  };
}
