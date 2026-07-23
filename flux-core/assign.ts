// flux-core/assign.ts — the watched-inbox engine (canonical impl behind the CLI + MCP; the GUI
// has a renderer twin sharing the same pure pdfIdentify core). Scans <FluxLib>/pdfs_to_assign/,
// identifies each PDF from its own content (DOI-first, cross-validated — see pdfIdentify.ts), and
// files it: attach to an existing reference that lacks a PDF, keep as a supplement if that
// reference already has a (different) PDF, or add the reference then attach. Anything not
// identified with confidence is moved to pdfs_to_assign/_unresolved/ with a sidecar note (never
// guessed) — EXCEPT when the failure was transient (offline/429/timeout): those files are LEFT IN
// PLACE ("deferred") so a network blink can never quarantine a good paper. `dryRun` mutates NOTHING.
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveFluxLibPath, loadLibrary, addToFluxLib, getPreferences, getSecret } from "./fluxlib";
import { extractPdfSignals, extractFulltext } from "./fulltext";
import { writePdf, writeFulltext, hasPdf, readSource } from "./items";
import { withHeartbeatLockAt, fluxlibLockDir, getLockClient } from "./locks";
import { assignInboxDir, supplementsDir, safeSupplementName } from "../src/lib/references/items";
import { isPdfBytes, bareDoi } from "../src/lib/references/pdfFinder";
import { lightEntry } from "../src/lib/references/bibtex";
import { identify, reconcile, type PaperMeta, type SearchHit, type IdResult, type IdentifyDeps } from "../src/lib/references/pdfIdentify";
import { searchWorld } from "./enrich";

const UA = "Flux/0.1 (pdf assign; +https://github.com/kortdriessen/flux)";
/** Politeness gap between successive DOI resolutions (Crossref/doi.org are limiter-exempt). */
const RESOLVE_GAP_MS = 200;
/** This many consecutive transient (network) results aborts the scan — we're offline. */
const OFFLINE_BREAKER = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function politeMailto(): Promise<string | undefined> {
  return (await getSecret("mailto")) || ((await getPreferences()).fluxMailto as string) || undefined;
}

/** DOI → canonical metadata. Crossref first (rich metadata), then doi.org content negotiation
 *  (registrar-agnostic — rescues DataCite DOIs: arXiv 10.48550/*, Zenodo, theses…). Returns null
 *  only when the DOI DEFINITIVELY does not resolve (404/410 at both); THROWS on transient
 *  failures per the IdentifyDeps contract, so identify() defers instead of quarantining.
 *  (Deliberately stricter than pdfFinderBridge.isTransientErr, where any HTTP status counts as
 *  definitive — for DOI resolution a 429/5xx must never condemn a PDF.) */
async function resolveDoiMeta(doi: string, mailto?: string): Promise<PaperMeta | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}` + (mailto ? `?mailto=${encodeURIComponent(mailto)}` : "");
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); // network error → throw = transient
  if (res.ok) {
    const m = (await res.json().catch(() => null))?.message;
    const title = Array.isArray(m?.title) ? m.title[0] : m?.title;
    if (m && title) {
      const authors = Array.isArray(m.author)
        ? m.author.map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name || a.family || "").filter(Boolean)
        : [];
      const dp = m.issued?.["date-parts"]?.[0]?.[0] ?? m["published-print"]?.["date-parts"]?.[0]?.[0] ?? m["published-online"]?.["date-parts"]?.[0]?.[0];
      const container = Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined;
      return { doi, title: String(title), authors, year: dp != null ? String(dp) : undefined, container };
    }
    // Resolved at Crossref but without a usable title — fall through to doi.org.
  } else if (res.status !== 404 && res.status !== 410) {
    throw new Error(`crossref HTTP ${res.status}`);
  }
  const r2 = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
    headers: { Accept: "application/x-bibtex", "User-Agent": UA },
    redirect: "follow",
  });
  if (r2.status === 404 || r2.status === 410) return null;
  if (!r2.ok) throw new Error(`doi.org HTTP ${r2.status}`);
  const bib = (await r2.text()).trim();
  if (!bib.startsWith("@")) return null; // resolved to something non-bibliographic
  const e = lightEntry(bib);
  if (!e.title) return null;
  return { doi, title: e.title, authors: e.authors, year: e.year || undefined, container: e.container };
}

/** Title → ranked hits via OpenAlex full-text search. Throws on network failure (transient). */
async function searchTitleFn(query: string): Promise<SearchHit[]> {
  const briefs = await searchWorld(query, { perPage: 5 });
  return briefs.map((b) => ({ doi: b.doi, title: b.title, authors: b.authors, year: b.year || undefined, score: b.relevanceScore }));
}

/** Fetch a DOI's BibTeX via DOI content negotiation (to create a new library entry). */
async function fetchDoiBibtex(doi: string): Promise<string> {
  const res = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, { headers: { Accept: "application/x-bibtex" }, redirect: "follow" });
  if (!res.ok) throw new Error(`DOI fetch ${res.status}`);
  const b = (await res.text()).trim();
  if (!b.startsWith("@")) throw new Error("DOI did not return BibTeX");
  return b;
}

export type AssignAction = "attached" | "added-attached" | "discarded" | "unresolved" | "deferred";
export interface AssignItemResult {
  file: string;
  action: AssignAction;
  key?: string;
  doi?: string;
  title?: string;
  method?: string; // how it was identified (doi:embedded / doi:page1 / search / …)
  reason?: string; // why unresolved/deferred
  keptAs?: string; // discard path: the supplements/ filename the duplicate was kept under
}
export interface AssignSummary {
  dir: string;
  dryRun: boolean;
  total: number;
  attached: number;
  addedAttached: number;
  discarded: number;
  unresolved: number;
  deferred: number; // transient (network) — left in the inbox to retry
  abortedOffline?: boolean; // the offline breaker tripped; remaining files untouched
  results: AssignItemResult[];
}

/** Write the PDF as items/<key>/paper.pdf (provenance "assigned") + extract fulltext. */
async function attach(key: string, bytes: Uint8Array, filename: string, libPath: string): Promise<void> {
  await writePdf(key, bytes, { source: "assigned", url: filename, isOa: false }, libPath);
  try {
    const ft = await extractFulltext(new Uint8Array(bytes));
    if (ft.chars > 0) await writeFulltext(key, ft.text, libPath);
  } catch {
    /* scanned/unextractable — paper.pdf is still filed */
  }
}

/** Move `src` to `dst`, falling back to copy+rm across devices. */
async function moveFile(src: string, dst: string): Promise<void> {
  await fs.promises.rename(src, dst).catch(async () => {
    await fs.promises.copyFile(src, dst);
    await fs.promises.rm(src, { force: true });
  });
}

/** The reference already has a paper.pdf: NEVER delete the incoming bytes — keep them in
 *  items/<key>/supplements/ (the reader's "Switch PDF" menu lists them), unless they are
 *  byte-identical to the stored PDF (then dropping the copy loses nothing). Returns the
 *  supplements/ filename it was kept under, or null when deleted-as-identical. */
async function keepAsSupplement(key: string, src: string, name: string, bytes: Uint8Array, libPath: string): Promise<string | null> {
  const incoming = crypto.createHash("sha256").update(bytes).digest("hex");
  const stored = await readSource(key, libPath);
  if (stored?.sha256 && stored.sha256 === incoming) {
    await fs.promises.rm(src, { force: true });
    return null;
  }
  const dir = supplementsDir(libPath, key);
  await fs.promises.mkdir(dir, { recursive: true });
  let dst = safeSupplementName(`duplicate-${name}`);
  if (!/\.pdf$/i.test(dst)) dst += ".pdf";
  const base = dst.replace(/\.pdf$/i, "");
  for (let i = 2; fs.existsSync(path.join(dir, dst)); i++) dst = `${base}-${i}.pdf`;
  await moveFile(src, path.join(dir, dst));
  return dst;
}

/** Move an unidentified PDF to _unresolved/ + a sidecar note (idempotent, collision-safe). */
async function quarantine(dir: string, src: string, name: string, id: IdResult | null, note: string): Promise<void> {
  const udir = path.join(dir, "_unresolved");
  await fs.promises.mkdir(udir, { recursive: true });
  let dst = path.join(udir, name);
  for (let i = 2; fs.existsSync(dst); i++) dst = path.join(udir, name.replace(/\.pdf$/i, `-${i}.pdf`));
  await moveFile(src, dst);
  const lines = [`Could not identify "${name}" with confidence.`, `Reason: ${note}`, ""];
  if (id && id.status === "unresolved") {
    const d = id.diagnostics;
    if (d.candidates.length) lines.push("DOI candidates seen:", ...d.candidates.map((c) => `  ${c.doi} (${c.source})`));
    if (d.rejected.length) lines.push("Rejected:", ...d.rejected.map((r) => `  ${r}`));
    if (d.query) lines.push(`Title query: ${d.query}`);
    if (d.topHits?.length) lines.push("Top search hits:", ...d.topHits.map((h) => `  ${h.sim.toFixed(2)}  ${h.title}${h.doi ? `  (${h.doi})` : ""}`));
  }
  await fs.promises.writeFile(`${dst}.txt`, lines.join("\n") + "\n", "utf8");
}

/** Dep overrides for tests (network injection). */
export interface AssignDeps extends IdentifyDeps {
  fetchBibtex?: (doi: string) => Promise<string>;
}

/**
 * Scan the inbox and file each PDF. `dryRun` reports the planned action per file, mutating
 * nothing (no writes, no library changes, no file moves) — use it to confirm identification is
 * trustworthy on real inputs before running for real. A real run holds the FluxLib "assign"
 * heartbeat lock so a concurrent GUI/CLI scan defers instead of racing the same files.
 */
export async function assignPdfs(
  opts: {
    dir?: string;
    dryRun?: boolean;
    libPath?: string;
    onProgress?: (done: number, total: number, file: string) => void;
    /** Test seam: inject resolveDoi/searchTitle/fetchBibtex (skips politeness pacing). */
    deps?: AssignDeps;
  } = {},
): Promise<AssignSummary> {
  const L = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const dir = opts.dir ? path.resolve(opts.dir) : assignInboxDir(L);
  const dryRun = !!opts.dryRun;
  const results: AssignItemResult[] = [];
  const empty = { dir, dryRun, total: 0, attached: 0, addedAttached: 0, discarded: 0, unresolved: 0, deferred: 0, results };
  if (!fs.existsSync(dir)) return empty;

  const names = (await fs.promises.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.pdf$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const total = names.length;
  if (!total) return empty;

  const run = async (): Promise<AssignSummary> => {
    // DOI → citekey index over the current library (updated as we add within the batch).
    const doiIndex = new Map<string, string>();
    for (const e of await loadLibrary(L)) {
      const d = bareDoi(e.doi);
      if (d) doiIndex.set(d, e.key);
    }
    const mailto = await politeMailto();
    let lastResolve = 0;
    const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
      const wait = lastResolve + RESOLVE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastResolve = Date.now();
      return fn();
    };
    const deps: IdentifyDeps = opts.deps ?? {
      resolveDoi: (doi: string) => paced(() => resolveDoiMeta(doi, mailto)),
      searchTitle: searchTitleFn,
    };
    const fetchBib = opts.deps?.fetchBibtex ?? fetchDoiBibtex;

    let done = 0;
    let consecutiveTransient = 0;
    let abortedOffline = false;
    for (const name of names) {
      const src = path.join(dir, name);
      const rec: AssignItemResult = { file: name, action: "unresolved" };
      try {
        const raw = await fs.promises.readFile(src);
        const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (!isPdfBytes(bytes)) {
          rec.reason = "not a PDF (bad magic bytes)";
          if (!dryRun) await quarantine(dir, src, name, null, rec.reason);
        } else {
          const sig = await extractPdfSignals(new Uint8Array(bytes));
          const id = await identify(sig, deps);
          if (id.status !== "identified") {
            rec.reason = id.reason;
            if (id.retryable) {
              rec.action = "deferred"; // network blink — leave the file for the next scan
            } else if (!dryRun) {
              await quarantine(dir, src, name, id, id.reason);
            }
          } else {
            rec.doi = id.doi;
            rec.title = id.meta.title;
            rec.method = id.method;
            const existingKey = doiIndex.get(bareDoi(id.doi)!) ?? null;
            const already = existingKey ? await hasPdf(existingKey, L) : false;
            const action = reconcile(id, existingKey, already);
            if (action.kind === "discard") {
              rec.action = "discarded";
              rec.key = action.key;
              if (!dryRun) rec.keptAs = (await keepAsSupplement(action.key, src, name, bytes, L)) ?? undefined;
            } else if (action.kind === "attach") {
              rec.action = "attached";
              rec.key = action.key;
              if (!dryRun) {
                await attach(action.key, new Uint8Array(bytes), name, L);
                await fs.promises.rm(src, { force: true });
              }
            } else {
              // add-then-attach (case 3). In dry-run we report the plan without touching the library.
              rec.action = "added-attached";
              if (!dryRun) {
                try {
                  const res = await addToFluxLib(await fetchBib(id.doi), { source: "doi", libPath: L });
                  const key = res.keys[0];
                  if (!key) throw new Error("no key returned");
                  doiIndex.set(bareDoi(id.doi)!, key);
                  rec.key = key;
                  await attach(key, new Uint8Array(bytes), name, L);
                  await fs.promises.rm(src, { force: true });
                } catch (e) {
                  rec.action = "deferred";
                  rec.reason = "couldn't create library entry: " + String((e as Error)?.message || e);
                  // leave the file in place to retry next run (do NOT quarantine — identity was fine)
                }
              }
            }
          }
        }
      } catch (e) {
        // Unexpected failure (fs hiccup, pdf.js crash): NEVER destructive — leave the file in
        // place and report it; a definitive "can't identify" is the only road to _unresolved/.
        rec.action = "deferred";
        rec.reason = "error: " + String((e as Error)?.message || e);
      }
      results.push(rec);
      consecutiveTransient = rec.action === "deferred" ? consecutiveTransient + 1 : 0;
      opts.onProgress?.(++done, total, name);
      if (consecutiveTransient >= OFFLINE_BREAKER && done < total) {
        abortedOffline = true; // network is down — stop grinding; everything stays in the inbox
        break;
      }
    }

    return {
      dir,
      dryRun,
      total,
      attached: results.filter((r) => r.action === "attached").length,
      addedAttached: results.filter((r) => r.action === "added-attached").length,
      discarded: results.filter((r) => r.action === "discarded").length,
      unresolved: results.filter((r) => r.action === "unresolved").length,
      deferred: results.filter((r) => r.action === "deferred").length,
      abortedOffline: abortedOffline || undefined,
      results,
    };
  };

  // Dry runs read only — no lock. Real runs hold the FluxLib "assign" heartbeat lock for the
  // whole scan (it can outlive the 30s TTL) so GUI auto-scan and CLI/MCP runs never race.
  return dryRun ? run() : withHeartbeatLockAt(fluxlibLockDir(L), "assign", getLockClient(), run);
}
