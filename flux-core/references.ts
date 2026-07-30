// flux-core/references.ts — reference + config verbs over FluxLib (split out
// of index.ts; WS-6.2): add/cite/import references, DOI lookup, the
// annotations Markdown digest, library/config info, and project reconcile.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as fluxlib from "./fluxlib";
import { journal } from "./journal";
import { buildInfo, type BuildInfo } from "./buildInfo";
import { writePdf, writeFulltext, writeLinkedPdf, hasPdf } from "./items";
import { extractFulltext } from "./fulltext";
import { sniffFormat, risToBibtex } from "../src/lib/references/ris";
import { bibPdfAttachments, attachCandidates, attachPathCandidates } from "../src/lib/references/zoteroFiles";
import { parseZoteroSettings, summarizeZoteroSync, type ZoteroSettings, type ZoteroSyncSummary } from "../src/lib/references/zoteroSettings";
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
  linked: { key: string; path: string }[]; // link-mode pointers written (attach: "link")
  attachFailed: { key: string; path: string; error: string }[];
}

/** Resolve a Better-BibTeX `file` path to something on disk: absolute as-is, else tried
 *  under baseDir (the .bib's own folder) then zoteroDir (+ its `storage/`). First hit wins.
 *  Candidate ORDER lives in the shared attachPathCandidates (twin with the GUI sync). */
async function resolveAttachPath(p: string, baseDir?: string, zoteroDir?: string): Promise<string | null> {
  const candidates = attachPathCandidates(p, {
    baseDir,
    zoteroDir,
    isAbsolute: path.isAbsolute,
    join: (a, b) => path.resolve(a, b),
  });
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
 *  named in each entry's Better-BibTeX `file` field lands in items/<key>/ and is
 *  text-extracted (the Zotero "bring the PDFs in too" path) — paths resolved against baseDir
 *  then zoteroDir. `attachMode: "copy"` (default) stores the bytes as paper.pdf;
 *  `"link"` writes a paper.link.json pointer to the external file instead (one-copy
 *  semantics for big Zotero libraries; fulltext is still extracted so search works).
 *  NEW entries always attach; MERGED entries attach only when they have NO PDF yet
 *  (the re-sync backfill: a paper whose PDF arrived in Zotero after the entry did) —
 *  an existing paper.pdf/pointer is never overwritten. */
export async function importReferences(
  text: string,
  opts: { attachFiles?: boolean; attachMode?: "copy" | "link"; baseDir?: string; zoteroDir?: string; libPath?: string } = {},
): Promise<ImportReport> {
  const format = sniffFormat(text);
  const bib = format === "ris" ? risToBibtex(text) : text;
  const res = await fluxlib.addToFluxLib(bib, { source: "bibtex" });
  const report: ImportReport = {
    format,
    added: res.added.map((e) => e.key),
    deduped: res.deduped.map((e) => e.key),
    attached: [],
    linked: [],
    attachFailed: [],
  };
  if (!opts.attachFiles) return report;
  const mode = opts.attachMode ?? "copy";
  // Attach candidates via the shared planner: every new entry, plus merged entries
  // that still lack a PDF/pointer (the re-sync backfill — see attachCandidates).
  const needsPdf = new Set<string>();
  for (const d of res.deduped) if (!(await hasPdf(d.key, opts.libPath))) needsPdf.add(d.key);
  const candidates = attachCandidates(bib, res.added, res.deduped, needsPdf);
  for (const { key, raw } of candidates) {
    const atts = bibPdfAttachments(raw);
    if (!atts.length) continue;
    // Attach the first resolvable PDF as the main paper (Zotero entries carry one full
    // text almost always); extra PDFs are reported but not filed, keeping import lossless-ish.
    const att = atts[0];
    const resolved = await resolveAttachPath(att.path, opts.baseDir, opts.zoteroDir);
    if (!resolved) {
      report.attachFailed.push({ key, path: att.path, error: "file not found" });
      continue;
    }
    try {
      const buf = await fs.readFile(resolved);
      // pdf.js rejects a Node Buffer; hand extractFulltext a standalone Uint8Array (a
      // fresh copy, so a fake-worker transfer can't touch Node's pooled buffer memory).
      const bytes = new Uint8Array(buf.byteLength);
      bytes.set(buf);
      if (mode === "link") {
        await writeLinkedPdf(key, resolved, opts.libPath);
        report.linked.push({ key, path: resolved });
      } else {
        await writePdf(key, bytes, { source: "ingest", url: resolved }, opts.libPath);
        report.attached.push({ key, path: resolved });
      }
      const ft = await extractFulltext(bytes);
      if (ft.text) await writeFulltext(key, ft.text, opts.libPath);
    } catch (e) {
      report.attachFailed.push({ key, path: resolved, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------
// Zotero sync — the standing intake valve over a Better-BibTeX "Keep updated" export
// (settings shape + summary line live in src/lib/references/zoteroSettings.ts).
// ---------------------------------------------------------------------------------

export interface ZoteroSyncResult {
  settings: ZoteroSettings;
  report: ImportReport;
  summary: ZoteroSyncSummary;
  line: string; // the shared human summary
}

/** Read the machine `zotero` settings (null = not configured). */
export async function zoteroSettings(): Promise<ZoteroSettings | null> {
  const prefs = await fluxlib.getPreferences();
  return parseZoteroSettings((prefs as Record<string, unknown>).zotero);
}

/** One Zotero sync pass: re-import the configured (or overridden) BBT auto-export
 *  .bib into FluxLib. Idempotent and additive — known entries dedupe by DOI/signature,
 *  PDFs attach for new entries and backfill PDF-less known ones. With `save`, the
 *  effective settings persist to preferences.json (the CLI's way to connect). */
export async function zoteroSync(
  opts: { bib?: string; dataDir?: string; attach?: "copy" | "link"; save?: boolean; libPath?: string } = {},
): Promise<ZoteroSyncResult> {
  const stored = await zoteroSettings();
  const bibPath = opts.bib ? path.resolve(opts.bib) : stored?.bibPath;
  if (!bibPath) {
    throw new Error(
      "Zotero is not connected: no bib path configured. Connect in the app (Library → Zotero) or pass --bib <auto-export.bib> (add --save to remember it).",
    );
  }
  const settings: ZoteroSettings = {
    bibPath,
    dataDir: opts.dataDir ?? stored?.dataDir ?? path.dirname(bibPath),
    attach: opts.attach ?? stored?.attach ?? "copy",
    auto: stored?.auto ?? true,
  };
  let text: string;
  try {
    text = await fs.readFile(bibPath, "utf8");
  } catch {
    throw new Error(`Zotero export not readable: ${bibPath} — is the Better BibTeX "Keep updated" export still in place?`);
  }
  const report = await importReferences(text, {
    attachFiles: true,
    attachMode: settings.attach,
    baseDir: path.dirname(bibPath),
    zoteroDir: settings.dataDir,
    libPath: opts.libPath,
  });
  if (opts.save) await fluxlib.setPreferences({ zotero: settings });
  const summary: ZoteroSyncSummary = {
    added: report.added.length,
    merged: report.deduped.length,
    attached: report.attached.length,
    linked: report.linked.length,
    failed: report.attachFailed.length,
  };
  return { settings, report, summary, line: summarizeZoteroSync(summary) };
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
// move, Context layer sync, agents.json seed) — idempotent + fast after the
// first run.
export { ensureFluxConfig } from "./fluxlib";

/** Machine-level paths for `flux config` / MCP config_paths. Runs
 *  ensureFluxConfig first, so the first call on a machine initializes
 *  ~/FluxConfig (and migrates the legacy layout). Locked JSON shape. */
export async function configInfo(): Promise<{
  fluxConfigPath: string;
  fluxLibPath: string;
  contextPath: string;
  userContextPath: string;
  fluxContextPath: string;
  agentsConfigPath: string;
  userDataDir: string;
  build: BuildInfo;
}> {
  const info = await fluxlib.ensureFluxConfig();
  return {
    fluxConfigPath: info.fluxConfigPath,
    fluxLibPath: info.fluxLibPath,
    contextPath: info.contextPath,
    userContextPath: info.userContextPath,
    fluxContextPath: info.fluxContextPath,
    agentsConfigPath: info.agentsConfigPath,
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
