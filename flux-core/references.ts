// flux-core/references.ts — reference + config verbs over FluxLib (split out
// of index.ts; WS-6.2): add/cite/import references, DOI lookup, the
// annotations Markdown digest, library/config info, and project reconcile.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as fluxlib from "./fluxlib";
import { journal } from "./journal";
import { buildInfo, type BuildInfo } from "./buildInfo";
import { writePdf, writeFulltext } from "./items";
import { extractFulltext } from "./fulltext";
import { sniffFormat, risToBibtex } from "../src/lib/references/ris";
import { bibPdfAttachments } from "../src/lib/references/zoteroFiles";
import { mergeEnrich } from "../src/lib/references/enrich";
import { listAnnotations as _listAnnotations } from "./annotate";
import { annotationsToMarkdown } from "../src/lib/references/annotationsMarkdown";

/** 3.2: one paper's highlights/notes as a Markdown digest (citekey/title header, page-
 *  grouped blockquotes + notes + colours). Backs `flux annotations --md`, the MCP
 *  list_annotations `markdown` param, and (via the bridge twin) the GUI "Export notes…". */
export async function annotationsMarkdown(key: string): Promise<string> {
  const [anns, entries] = await Promise.all([_listAnnotations(key), fluxlib.loadLibrary()]);
  const e = entries.find((x) => x.key === key);
  return annotationsToMarkdown(key, anns, {
    title: e?.title,
    authors: e?.authors,
    year: e?.year,
    doi: e?.doi,
    exportedAt: new Date().toISOString().slice(0, 10),
  });
}

/** add-reference / cite: add a BibTeX entry to FluxLib (the machine-global
 *  library, deduped by DOI) and materialize it into this project's cited-subset
 *  library.bib. The project copy stays canonical-within-project (self-contained). */
export async function addReference(root: string, bibtex: string): Promise<void> {
  const res = await fluxlib.addToFluxLib(bibtex, { source: "bibtex" });
  await fluxlib.materializeIntoProject(root, res.keys);
}

/** Add a BibTeX entry to FluxLib only (no project cite). Backs `lib add` /
 *  the add_to_library MCP tool / the "Add DOI to FluxLib" command. */
export async function addToLibrary(bibtex: string): Promise<fluxlib.AddResult> {
  return fluxlib.addToFluxLib(bibtex, { source: "bibtex" });
}

export interface ImportReport {
  format: "bibtex" | "ris" | "unknown";
  added: string[]; // new citekeys
  deduped: string[]; // merged onto existing keys
  attached: { key: string; path: string }[]; // PDFs copied into items/<key>/
  attachFailed: { key: string; path: string; error: string }[];
}

/** Resolve a Better-BibTeX `file` path to something on disk: absolute as-is, else tried
 *  under baseDir (the .bib's own folder) then zoteroDir (+ its `storage/`). First hit wins. */
async function resolveAttachPath(p: string, baseDir?: string, zoteroDir?: string): Promise<string | null> {
  const candidates: string[] = [];
  if (path.isAbsolute(p)) candidates.push(p);
  else {
    if (baseDir) candidates.push(path.resolve(baseDir, p));
    if (zoteroDir) {
      candidates.push(path.resolve(zoteroDir, p));
      candidates.push(path.resolve(zoteroDir, "storage", p));
    }
  }
  for (const c of candidates) {
    try {
      if ((await fs.stat(c)).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Bulk-import a .bib or .ris file's references into FluxLib. RIS is normalized to BibTeX
 *  up front so it shares the ONE dedupe/rekey path (planAdds). With `attachFiles`, the PDF
 *  named in each new entry's Better-BibTeX `file` field is copied into items/<key>/ and
 *  text-extracted (the Zotero "bring the PDFs in too" path) — paths resolved against baseDir
 *  then zoteroDir. Only NEW entries are attached (merged dups keep their existing PDF). */
export async function importReferences(
  text: string,
  opts: { attachFiles?: boolean; baseDir?: string; zoteroDir?: string; libPath?: string } = {},
): Promise<ImportReport> {
  const format = sniffFormat(text);
  const bib = format === "ris" ? risToBibtex(text) : text;
  const res = await fluxlib.addToFluxLib(bib, { source: "bibtex" });
  const report: ImportReport = {
    format,
    added: res.added.map((e) => e.key),
    deduped: res.deduped.map((e) => e.key),
    attached: [],
    attachFailed: [],
  };
  if (!opts.attachFiles) return report;
  for (const entry of res.added) {
    if (!entry.raw) continue;
    const atts = bibPdfAttachments(entry.raw);
    if (!atts.length) continue;
    // Attach the first resolvable PDF as the main paper.pdf (Zotero entries carry one full
    // text almost always); extra PDFs are reported but not filed, keeping import lossless-ish.
    const att = atts[0];
    const resolved = await resolveAttachPath(att.path, opts.baseDir, opts.zoteroDir);
    if (!resolved) {
      report.attachFailed.push({ key: entry.key, path: att.path, error: "file not found" });
      continue;
    }
    try {
      const buf = await fs.readFile(resolved);
      // pdf.js rejects a Node Buffer; hand extractFulltext a standalone Uint8Array (a
      // fresh copy, so a fake-worker transfer can't touch Node's pooled buffer memory).
      const bytes = new Uint8Array(buf.byteLength);
      bytes.set(buf);
      await writePdf(entry.key, bytes, { source: "ingest", url: resolved }, opts.libPath);
      const ft = await extractFulltext(bytes);
      if (ft.text) await writeFulltext(entry.key, ft.text, opts.libPath);
      report.attached.push({ key: entry.key, path: resolved });
    } catch (e) {
      report.attachFailed.push({ key: entry.key, path: resolved, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/** Fetch a DOI's BibTeX via DOI content negotiation. */
async function fetchDoiBibtex(doi: string): Promise<{ clean: string; bibtex: string }> {
  const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  const res = await fetch(`https://doi.org/${encodeURIComponent(clean)}`, {
    headers: { Accept: "application/x-bibtex" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`DOI fetch failed (${res.status})`);
  const bibtex = (await res.text()).trim();
  if (!bibtex.startsWith("@")) throw new Error("DOI did not return BibTeX");
  return { clean, bibtex };
}

/** cite-doi: fetch a DOI's BibTeX, add it to FluxLib (deterministic citekey,
 *  deduped by DOI), and materialize it into this project's library.bib. */
/** One-line author (year). title digest of a BibTeX entry — shown IN FULL on
 *  cite success so junk registry metadata ("Robot, Open Data" on automated
 *  deposits) is visible immediately instead of hiding behind a 60-char slice. */
export function bibtexSummary(bibtex: string): string {
  const field = (name: string) => {
    const m = bibtex.match(new RegExp(name + String.raw`\s*=\s*[{"]([\s\S]*?)[}"]\s*,?\s*\n`, "i"));
    return m ? m[1].replace(/[{}]/g, "").replace(/\s+/g, " ").trim() : null;
  };
  return `${field("author") ?? "(no author)"} (${field("year") ?? "n.d."}). ${field("title") ?? "(no title)"}`;
}

export async function citeDoi(root: string, doi: string): Promise<{ bibtex: string; keys: string[]; summary: string }> {
  const { clean, bibtex } = await fetchDoiBibtex(doi);
  const res = await fluxlib.addToFluxLib(bibtex, { source: "doi" });
  await fluxlib.materializeIntoProject(root, res.keys);
  await journal(root, { action: "cite_doi", doi: clean, keys: res.keys });
  return { bibtex, keys: res.keys, summary: bibtexSummary(bibtex) };
}

/** Fetch a DOI's BibTeX and add it to FluxLib only (no project cite). */
export async function addDoiToLibrary(doi: string): Promise<{ bibtex: string; result: fluxlib.AddResult }> {
  const { bibtex } = await fetchDoiBibtex(doi);
  const result = await fluxlib.addToFluxLib(bibtex, { source: "doi" });
  return { bibtex, result };
}

/** Re-export FluxLib query for the CLI/MCP search surface. */
export async function searchReferences(query: string): Promise<import("../src/lib/references/types").RefEntry[]> {
  return fluxlib.searchReferences(query);
}

/** Like searchReferences but joins each hit with its enrichment (abstract, topics,
 *  citation count) when hydrated — the richer surface for the MCP search tool. */
export async function searchReferencesEnriched(query: string) {
  const hits = await fluxlib.searchReferences(query);
  return mergeEnrich(hits, await fluxlib.loadEnrich());
}

/** FluxLib location + size + hydration coverage, for `flux lib`. */
export async function libraryInfo(): Promise<{
  path: string;
  entries: number;
  hydrated: number;
  withAbstract: number;
}> {
  return fluxlib.fluxLibInfo();
}

// One-time machine init/migration (FluxConfig, lowercase config dir, FluxLib
// move, Guidelines seed) — idempotent + fast after the first run.
export { ensureFluxConfig } from "./fluxlib";

/** Machine-level paths for `flux config` / MCP config_paths. Runs
 *  ensureFluxConfig first, so the first call on a machine initializes
 *  ~/FluxConfig (and migrates the legacy layout). Locked JSON shape. */
export async function configInfo(): Promise<{
  fluxConfigPath: string;
  fluxLibPath: string;
  guidelinesPath: string;
  userDataDir: string;
  build: BuildInfo;
}> {
  const info = await fluxlib.ensureFluxConfig();
  return {
    fluxConfigPath: info.fluxConfigPath,
    fluxLibPath: info.fluxLibPath,
    guidelinesPath: info.guidelinesPath,
    userDataDir: info.userDataDir,
    build: buildInfo(),
  };
}

/** Reconcile a project's cited-subset library.bib against FluxLib (on open / on
 *  demand): promote project-local-only cited entries up, materialize the rest,
 *  report orphans. Non-destructive. */
export async function reconcile(
  root: string,
): Promise<{ materialized: string[]; promoted: string[]; orphans: string[] }> {
  return fluxlib.reconcileProject(root);
}
