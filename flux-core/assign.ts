// flux-core/assign.ts — the watched-inbox engine (canonical impl behind the CLI + MCP; the GUI
// has a renderer twin sharing the same pure pdfIdentify core). Scans ~/FluxLib/pdfs_to_assign/,
// identifies each PDF from its own content (DOI-first, cross-validated — see pdfIdentify.ts), and
// files it: attach to an existing reference that lacks a PDF, discard if that reference already
// has one, or add the reference then attach. Anything not identified with confidence is moved to
// pdfs_to_assign/_unresolved/ with a sidecar note (never guessed). `dryRun` mutates NOTHING.
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFluxLibPath, loadLibrary, addToFluxLib, getPreferences, getSecret } from "./fluxlib";
import { extractPdfSignals, extractFulltext } from "./fulltext";
import { writePdf, writeFulltext, hasPdf } from "./items";
import { assignInboxDir } from "../src/lib/references/items";
import { isPdfBytes, bareDoi } from "../src/lib/references/pdfFinder";
import { identify, reconcile, type PaperMeta, type SearchHit, type IdResult } from "../src/lib/references/pdfIdentify";
import { searchWorld } from "./enrich";

const UA = "Flux/0.1 (pdf assign; +https://github.com/kortdriessen/flux)";

async function politeMailto(): Promise<string | undefined> {
  return (await getSecret("mailto")) || ((await getPreferences()).fluxMailto as string) || undefined;
}

/** DOI → canonical metadata via Crossref (authoritative title for the cross-check). */
async function crossrefResolve(doi: string, mailto?: string): Promise<PaperMeta | null> {
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}` + (mailto ? `?mailto=${encodeURIComponent(mailto)}` : "");
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return null;
    const m = (await res.json())?.message;
    const title = Array.isArray(m?.title) ? m.title[0] : m?.title;
    if (!m || !title) return null;
    const authors = Array.isArray(m.author)
      ? m.author.map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name || a.family || "").filter(Boolean)
      : [];
    const dp = m.issued?.["date-parts"]?.[0]?.[0] ?? m["published-print"]?.["date-parts"]?.[0]?.[0] ?? m["published-online"]?.["date-parts"]?.[0]?.[0];
    const container = Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined;
    return { doi, title: String(title), authors, year: dp != null ? String(dp) : undefined, container };
  } catch {
    return null;
  }
}

/** Title → ranked hits via OpenAlex full-text search. */
async function searchTitleFn(query: string): Promise<SearchHit[]> {
  try {
    const briefs = await searchWorld(query, { perPage: 5 });
    return briefs.map((b) => ({ doi: b.doi, title: b.title, authors: b.authors, year: b.year || undefined, score: b.relevanceScore }));
  } catch {
    return [];
  }
}

/** Fetch a DOI's BibTeX via DOI content negotiation (to create a new library entry). */
async function fetchDoiBibtex(doi: string): Promise<string> {
  const res = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, { headers: { Accept: "application/x-bibtex" }, redirect: "follow" });
  if (!res.ok) throw new Error(`DOI fetch ${res.status}`);
  const b = (await res.text()).trim();
  if (!b.startsWith("@")) throw new Error("DOI did not return BibTeX");
  return b;
}

export type AssignAction = "attached" | "added-attached" | "discarded" | "unresolved";
export interface AssignItemResult {
  file: string;
  action: AssignAction;
  key?: string;
  doi?: string;
  title?: string;
  method?: string; // how it was identified (doi:embedded / doi:masthead / search / …)
  reason?: string; // why unresolved
}
export interface AssignSummary {
  dir: string;
  dryRun: boolean;
  total: number;
  attached: number;
  addedAttached: number;
  discarded: number;
  unresolved: number;
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

/** Move an unidentified PDF to _unresolved/ + a sidecar note (idempotent, collision-safe). */
async function quarantine(dir: string, src: string, name: string, id: IdResult | null, note: string): Promise<void> {
  const udir = path.join(dir, "_unresolved");
  await fs.promises.mkdir(udir, { recursive: true });
  let dst = path.join(udir, name);
  for (let i = 2; fs.existsSync(dst); i++) dst = path.join(udir, name.replace(/\.pdf$/i, `-${i}.pdf`));
  await fs.promises.rename(src, dst).catch(async () => {
    await fs.promises.copyFile(src, dst);
    await fs.promises.rm(src, { force: true });
  });
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

/**
 * Scan the inbox and file each PDF. `dryRun` reports the planned action per file, mutating
 * nothing (no writes, no library changes, no file moves) — use it to confirm identification is
 * trustworthy on real inputs before running for real.
 */
export async function assignPdfs(
  opts: { dir?: string; dryRun?: boolean; libPath?: string; onProgress?: (done: number, total: number, file: string) => void } = {},
): Promise<AssignSummary> {
  const L = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const dir = opts.dir ? path.resolve(opts.dir) : assignInboxDir(L);
  const dryRun = !!opts.dryRun;
  const results: AssignItemResult[] = [];
  if (!fs.existsSync(dir)) return { dir, dryRun, total: 0, attached: 0, addedAttached: 0, discarded: 0, unresolved: 0, results };

  const names = (await fs.promises.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.pdf$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const total = names.length;

  // DOI → citekey index over the current library (updated as we add within the batch).
  const doiIndex = new Map<string, string>();
  for (const e of await loadLibrary(L)) {
    const d = bareDoi(e.doi);
    if (d) doiIndex.set(d, e.key);
  }
  const mailto = await politeMailto();
  const deps = { resolveDoi: (doi: string) => crossrefResolve(doi, mailto), searchTitle: searchTitleFn };

  let done = 0;
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
          if (!dryRun) await quarantine(dir, src, name, id, id.reason);
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
            if (!dryRun) await fs.promises.rm(src, { force: true });
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
                const res = await addToFluxLib(await fetchDoiBibtex(id.doi), { source: "doi" });
                const key = res.keys[0];
                if (!key) throw new Error("no key returned");
                doiIndex.set(bareDoi(id.doi)!, key);
                rec.key = key;
                await attach(key, new Uint8Array(bytes), name, L);
                await fs.promises.rm(src, { force: true });
              } catch (e) {
                rec.action = "unresolved";
                rec.reason = "couldn't create library entry: " + String((e as Error)?.message || e);
                // leave the file in place to retry next run (do NOT quarantine — identity was fine)
              }
            }
          }
        }
      }
    } catch (e) {
      rec.action = "unresolved";
      rec.reason = "error: " + String((e as Error)?.message || e);
      if (!dryRun) await quarantine(dir, src, name, null, rec.reason).catch(() => {});
    }
    results.push(rec);
    opts.onProgress?.(++done, total, name);
  }

  return {
    dir,
    dryRun,
    total,
    attached: results.filter((r) => r.action === "attached").length,
    addedAttached: results.filter((r) => r.action === "added-attached").length,
    discarded: results.filter((r) => r.action === "discarded").length,
    unresolved: results.filter((r) => r.action === "unresolved").length,
    results,
  };
}
