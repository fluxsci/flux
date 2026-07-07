// flux-core/acquire.ts — the PDF-acquisition engine (Node side: CLI/MCP/agents).
// Runs the OA resolver waterfall (src/lib/references/pdfFinder.ts) over a FluxLib
// entry's identifiers (from enrich.json + the .bib), downloads the first magic-byte-
// valid PDF, and files it into items/<citekey>/ with provenance. Proxy/paywall is a
// later phase (GUI/Electron-only). The renderer twin lives in pdfFinderBridge.ts.
import { loadLibrary, loadEnrich, getSecret } from "./fluxlib";
import { hasPdf, writePdf, writeFulltext, loadOaMisses, saveOaMisses } from "./items";
import { extractFulltext } from "./fulltext";
import { runWaterfall, isPdfBytes, bareDoi, type PdfInputs, type FetchDeps } from "../src/lib/references/pdfFinder";
import { safeKey, oaSig, isFreshOaMiss, type OaMissMap } from "../src/lib/references/items";
import { HostLimiter, hostGroup, doiGroup, interleaveByGroup, GET_COST } from "../src/lib/references/hostLimiter";
import { readFile } from "node:fs/promises";

const UA = "Flux/0.1 (PDF acquisition; mailto:flux)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Process-wide per-publisher rate limiter (twin of the renderer's sharedLimiter) — candidate
// PDF GETs at publisher hosts create server-side sessions; unthrottled bulk runs got the IP
// temporarily blocked (Cell Press: ">90 sessions created in 5 minutes").
const limiter = new HostLimiter();

/* eslint-disable @typescript-eslint/no-explicit-any */

// A thrown fetch (network/timeout/abort) is TRANSIENT — the caller must not record a false
// "no-OA" miss for it. A non-ok HTTP response is DEFINITIVE (the server answered). `onTransient`
// fires only on the thrown case. Mirrors the renderer's isTransientErr classification.
async function dl(url: string, onTransient?: () => void): Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string } | null> {
  try {
    const group = hostGroup(url);
    if (group) await limiter.acquire(group, GET_COST);
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "application/pdf,*/*" },
      signal: AbortSignal.timeout(120_000), // a hung publisher server must not stall the run
    });
    if (!r.ok) return null;
    const out = {
      bytes: new Uint8Array(await r.arrayBuffer()),
      finalUrl: r.url || url,
      contentType: r.headers.get("content-type") || "",
    };
    const landed = hostGroup(out.finalUrl); // a redirect onto another publisher spent a session there
    if (landed && landed !== group) limiter.record(landed, GET_COST);
    return out;
  } catch {
    onTransient?.();
    return null;
  }
}
async function getJson(url: string, onTransient?: () => void): Promise<any> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    onTransient?.();
    return null;
  }
}
async function getText(url: string, onTransient?: () => void): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
    return r.ok ? await r.text() : null;
  } catch {
    onTransient?.();
    return null;
  }
}

/** Node-side fetchers for the shared waterfall (global fetch — no CORS). */
const nodeDeps = (email?: string, onTransient?: () => void): FetchDeps => ({
  getJson: (u) => getJson(u, onTransient),
  getText: (u) => getText(u, onTransient),
  getBytes: (u) => dl(u, onTransient),
  email,
});

export type FetchStatus = "have" | "got" | "no-oa" | "no-id";
export interface FetchOneResult {
  key: string;
  status: FetchStatus;
  source?: string;
  url?: string;
  /** A candidate fetch failed at the transport level (timeout/network) — a null result is not
   *  a reliable "no-OA", so the bulk sweep must not record it as a miss. */
  transient?: boolean;
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

/** Acquire the OA PDF for one citekey (skips if present unless refresh). `preloaded` lets a
 *  bulk caller share one library/enrich load instead of re-reading both files per key.
 *  `bulkMode` tunes the resolver set for a polite sweep (ban-safety = per-publisher caps
 *  + circuit breaker, not candidate filtering); a single-key fetch leaves it off. */
export async function fetchPdfForKey(
  key: string,
  opts: {
    refresh?: boolean;
    libPath?: string;
    bulkMode?: boolean;
    preloaded?: { lib: any[]; enrich: Record<string, any> };
  } = {},
): Promise<FetchOneResult> {
  if (!opts.refresh && (await hasPdf(key, opts.libPath))) return { key, status: "have" };
  const { lib, enrich } =
    opts.preloaded ??
    (await Promise.all([loadLibrary(opts.libPath), loadEnrich(opts.libPath)]).then(([lib, enrich]) => ({ lib, enrich })));
  const x = inputsFor(key, lib, enrich);
  if (!x.doi && !x.openAccessUrl && !x.pmcid) return { key, status: "no-id" };
  const email = (await getSecret("mailto")) || undefined;
  let transient = false;
  const r = await runWaterfall(
    x,
    nodeDeps(email, () => {
      transient = true;
    }),
    { bulkMode: opts.bulkMode },
  );
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
  return { key, status: "no-oa", transient: transient || undefined };
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
  /** Skipped by the OA-miss ledger: known no-OA under unchanged identifiers, re-checked
   *  after the TTL or when enrichment changes. `refresh` bypasses the ledger. */
  skipped: number;
  results: FetchOneResult[];
}

/** Acquire OA PDFs for many keys (or the whole library). Polite + sequential, interleaved
 *  across publishers (per-publisher rate limiter), and skipping papers the OA-miss ledger
 *  already knows have no open-access copy (Node twin of the GUI bulk job's Phase A). */
export async function fetchPdfs(
  opts: { keys?: string[]; refresh?: boolean; libPath?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<FetchSummary> {
  const [lib, enrich] = await Promise.all([loadLibrary(opts.libPath), loadEnrich(opts.libPath)]);
  const keys = opts.keys ?? lib.map((e) => e.key);
  const misses: OaMissMap = await loadOaMisses(opts.libPath);
  const missKey = (key: string) => safeKey(key).normalize("NFC");
  const sigOf = (key: string) => oaSig(inputsFor(key, lib, enrich));

  const todo = opts.refresh ? keys.slice() : keys.filter((k) => !isFreshOaMiss(misses[missKey(k)], sigOf(k)));
  const ordered = interleaveByGroup(todo, (k) => doiGroup(bareDoi(inputsFor(k, lib, enrich).doi)));
  const results: FetchOneResult[] = [];
  let done = 0;
  let missDirty = 0;
  for (const key of ordered) {
    const r = await fetchPdfForKey(key, {
      refresh: opts.refresh,
      libPath: opts.libPath,
      bulkMode: true, // bulk only drops the crossref resolver now (the publisher filter is gone)
      preloaded: { lib, enrich },
    });
    results.push(r);
    const mk = missKey(key);
    if (r.status === "no-oa" && !r.transient) {
      // A transient (timeout/network) failure is not a reliable no-OA — don't record it.
      misses[mk] = { at: new Date().toISOString(), attempts: (misses[mk]?.attempts ?? 0) + 1, sig: sigOf(key) };
      missDirty++;
    } else if ((r.status === "got" || r.status === "have") && misses[mk]) {
      delete misses[mk];
      missDirty++;
    }
    if (missDirty >= 12) {
      missDirty = 0;
      await saveOaMisses(misses, opts.libPath); // incremental — an interrupted run keeps its progress
    }
    opts.onProgress?.(++done, ordered.length);
    if (done < ordered.length) await sleep(120);
  }
  if (missDirty) await saveOaMisses(misses, opts.libPath);
  return {
    total: keys.length,
    got: results.filter((r) => r.status === "got").length,
    have: results.filter((r) => r.status === "have").length,
    noOa: results.filter((r) => r.status === "no-oa").length,
    noId: results.filter((r) => r.status === "no-id").length,
    skipped: keys.length - todo.length,
    results,
  };
}
