// flux-core/manuscript.ts — manuscript + documents + compile (the Paper-side
// parity verbs; split out of index.ts; WS-6.2).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { composeCaption } from "../src/lib/captions";
import { collectEmbedLabels, transformQmdForExport, normalizeEmbedAlts } from "../src/lib/exportQmd";
import * as ops from "../src/lib/ops";
import { atomicWrite } from "./fsx";
import { withLock } from "./locks";
import { CLIENT, journal } from "./journal";
import { loadManifest, saveManifest, safeJoin, exists, writeText, readFigIndex, loadFigModel } from "./model";
import { materializeRenders } from "./render";
import type { ProjectManifest } from "../src/lib/project/types";
import { slugify } from "../src/lib/project/types";

// --------------------------------------------------------------------------
// manuscript + documents + references + compile (the Paper-side parity verbs).
// All file-level, mirroring src/lib/project/load.ts + paper/documents/documents.ts
// over Node fs so an agent has the same reach as the GUI.
// --------------------------------------------------------------------------
const manuRel = (m: ProjectManifest, rel?: string) => rel ?? m.manuscript.path;

/** read a manuscript document's text (defaults to the main .qmd). */
export async function getManuscript(root: string, relPath?: string): Promise<string> {
  const m = await loadManifest(root);
  const p = safeJoin(root, manuRel(m, relPath));
  return (await exists(p)) ? fs.readFile(p, "utf8") : "";
}

/** write a manuscript document's text (defaults to the main .qmd). */
export async function setManuscript(root: string, text: string, relPath?: string): Promise<void> {
  const m = await loadManifest(root);
  const rel = manuRel(m, relPath);
  await withLock(root, "manuscript", CLIENT, async () => {
    await writeText(safeJoin(root, rel), text);
  });
  await journal(root, { action: "set_manuscript", target: rel });
}

/** Pull a title from a .qmd's YAML front-matter (mirrors documents.docTitle). */
function docTitle(src: string, fallback: string): string {
  if (src.startsWith("---")) {
    const end = src.indexOf("\n---", 3);
    if (end >= 0) {
      const mm = /^title:[ \t]*(.+?)[ \t]*$/m.exec(src.slice(3, end));
      if (mm) return mm[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return fallback;
}

/** list the project's documents: main + supplementary + scanned manuscript/**.qmd. */
export async function listDocuments(
  root: string,
): Promise<{ path: string; title: string; isMain: boolean }[]> {
  const m = await loadManifest(root);
  const mainPath = m.manuscript.path;
  const rels = new Set<string>([mainPath]);
  for (const s of m.supplementary ?? []) if (s.path) rels.add(s.path);
  const dir = mainPath.includes("/") ? mainPath.slice(0, mainPath.lastIndexOf("/")) : "";
  const scan = async (d: string) => {
    try {
      for (const e of await fs.readdir(safeJoin(root, d), { withFileTypes: true }))
        if (e.isFile() && e.name.endsWith(".qmd")) rels.add(d ? `${d}/${e.name}` : e.name);
    } catch {
      /* dir may not exist */
    }
  };
  await scan(dir);
  await scan(dir ? `${dir}/sections` : "sections");
  const out: { path: string; title: string; isMain: boolean }[] = [];
  for (const rel of rels) {
    const isMain = rel === mainPath;
    let title = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.qmd$/, "");
    try {
      title = docTitle(await fs.readFile(safeJoin(root, rel), "utf8"), isMain ? m.title || title : title);
    } catch {
      /* keep filename title */
    }
    out.push({ path: rel, title, isMain });
  }
  out.sort((a, b) => (a.isMain ? -1 : b.isMain ? 1 : a.title.localeCompare(b.title)));
  return out;
}

/** create a new blank document (seeded front-matter), registered in the manifest. */
export async function createDocument(root: string, name: string): Promise<{ path: string }> {
  const m = await loadManifest(root);
  const dir = m.manuscript.path.includes("/")
    ? m.manuscript.path.slice(0, m.manuscript.path.lastIndexOf("/"))
    : "";
  const slug = slugify(name);
  let rel = dir ? `${dir}/${slug}.qmd` : `${slug}.qmd`;
  let n = 2;
  while (await exists(safeJoin(root, rel))) {
    rel = dir ? `${dir}/${slug}-${n}.qmd` : `${slug}-${n}.qmd`;
    n++;
  }
  await writeText(safeJoin(root, rel), `---\ntitle: "${name.replace(/"/g, '\\"')}"\n---\n\n`);
  m.supplementary = m.supplementary ?? [];
  if (!m.supplementary.some((s) => s.path === rel)) {
    m.supplementary.push({ path: rel });
    await saveManifest(root, m);
  }
  await journal(root, { action: "create_document", target: rel });
  return { path: rel };
}

/** append a figure cross-reference (`@fig-<label>`) to a document; returns the handle. */
export async function insertFigureRef(
  root: string,
  figId: string,
  relPath?: string,
): Promise<{ ref: string }> {
  const index = await readFigIndex(root);
  const f = index?.figures.find((x) => x.id === figId);
  const ref = `@${f?.label ?? `fig-${figId}`}`;
  const cur = await getManuscript(root, relPath);
  await setManuscript(root, cur.replace(/\s*$/, "") + `\n\nSee ${ref}.\n`, relPath);
  return { ref };
}

/** compile the manuscript via Quarto (pdf|html|docx). Requires `quarto` on PATH. */
// Quarto `{{< include path >}}` directive (path relative to the including file).
const INCLUDE_RE = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g;

/** Read a qmd and its transitive includes; returns the involved files (in
 *  traversal order) and the EXPANDED text (includes spliced in place — the
 *  order Quarto numbers figures in). */
export async function readExpandedQmd(
  file: string,
  seen = new Set<string>(),
): Promise<{ files: string[]; expanded: string }> {
  if (seen.has(file)) return { files: [], expanded: "" };
  seen.add(file);
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const files = [file];
  let expanded = "";
  let last = 0;
  for (const mm of text.matchAll(INCLUDE_RE)) {
    expanded += text.slice(last, mm.index);
    const sub = await readExpandedQmd(path.resolve(path.dirname(file), mm[1]), seen);
    files.push(...sub.files);
    expanded += sub.expanded;
    last = (mm.index ?? 0) + mm[0].length;
  }
  expanded += text.slice(last);
  return { files, expanded };
}

/** normalize-embeds: clear legacy alt-text captions from every embed line in
 *  the manuscript (+ includes + supplementary docs). Canonical embeds carry an
 *  EMPTY alt — the figure model owns captions (the open app does this pass
 *  automatically on figure load; this is the headless mirror). */
export async function normalizeEmbeds(root: string): Promise<{ files: { path: string; cleared: number }[] }> {
  const m = await loadManifest(root);
  const { index } = await loadFigModel(root);
  const labels = new Set((index.figures ?? []).map((f) => f.label));
  const seen = new Set<string>();
  const all: string[] = [];
  for (const docPath of [m.manuscript.path, ...(m.supplementary ?? []).map((s) => s.path)]) {
    const { files } = await readExpandedQmd(path.resolve(root, docPath), seen);
    all.push(...files);
  }
  const out: { path: string; cleared: number }[] = [];
  for (const f of all) {
    const text = await fs.readFile(f, "utf8").catch(() => null);
    if (text == null) continue;
    const r = normalizeEmbedAlts(text, (l) => labels.has(l));
    if (r.cleared) {
      await atomicWrite(f, r.text);
      out.push({ path: path.relative(root, f), cleared: r.cleared });
    }
  }
  await journal(root, { action: "normalize_embeds", files: out.map((f) => f.path) });
  return { files: out };
}

export interface CompileSummary {
  code: number;
  log: string;
  /** the compiled artifact (absolute path), when quarto reported/produced one. */
  output?: string;
  figures?: { embedded: number; resolved: number; missing: string[] };
  citations?: { keys: number; resolved: number; missing: string[] };
}

/** Citation keys used in a qmd (Quarto/pandoc `@key` syntax), excluding
 *  crossref namespaces (@fig-/@tbl-/@sec-/@eq-/@lst-). */
function citationKeysIn(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s([;])@([A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_]|[A-Za-z0-9_])/g)) {
    const k = m[1];
    if (/^(fig|tbl|sec|eq|lst|thm)-/.test(k)) continue;
    keys.add(k);
  }
  return [...keys];
}

export async function compile(root: string, to = "pdf"): Promise<CompileSummary> {
  const m = await loadManifest(root);
  // Figures embed as ../fig/renders/<id>.svg — materialize them so a bare quarto
  // render (agent/CI, no app open) gets real images instead of broken links.
  const renders = await materializeRenders(root, m.manuscript.path).catch(() => ({ wrote: 0, failed: [] as string[], warnings: [] as string[] }));

  // Bare-quarto parity transform, applied IN PLACE and restored after the
  // render: (1) composed model captions into empty embed alts (Quarto reads
  // the alt as the figcaption, and only captioned figures get numbers);
  // (2) panel refs `@fig-x-a` → literal "Figure 3a" (Quarto's crossref only
  // knows whole figures — they compiled to "?@fig-x-a"). Sources are restored
  // in `finally`; even an unrestored transform is a valid readable manuscript.
  const docAbs = path.resolve(root, m.manuscript.path);
  const { files, expanded } = await readExpandedQmd(docAbs);
  const numbers = new Map(collectEmbedLabels(expanded).map((l, i) => [l, i + 1] as const));
  const captions = new Map<string, string>();
  const knownLabels = new Set<string>();
  try {
    const { project, index } = await loadFigModel(root);
    for (const f of index.figures ?? []) {
      knownLabels.add(f.label);
      const fig = ops.figById(project, f.id);
      const cap = fig ? composeCaption(fig) : "";
      if (cap.trim()) captions.set(f.label, cap);
    }
  } catch {
    /* no fig model → nothing to inject */
  }
  const ctx = { captions, numbers };
  const originals = new Map<string, string>();
  for (const f of files) {
    const text = await fs.readFile(f, "utf8").catch(() => null);
    if (text == null) continue;
    const transformed = transformQmdForExport(text, ctx);
    if (transformed !== text) {
      originals.set(f, text);
      await atomicWrite(f, transformed);
    }
  }

  let code = 0;
  let log = "";
  try {
    ({ code, log } = await new Promise<{ code: number; log: string }>((resolve, reject) => {
      const child = spawn("quarto", ["render", m.manuscript.path, "--to", to], { cwd: root });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => reject(new Error(`quarto not available: ${e.message}`)));
      child.on("close", (c) => resolve({ code: c ?? 0, log: out }));
    }));
  } finally {
    for (const [f, text] of originals) await atomicWrite(f, text).catch(() => {});
  }
  await journal(root, { action: "compile", to, code });
  const note =
    (renders.failed.length ? `\n(figure renders failed: ${renders.failed.join(", ")})` : "") +
    (renders.warnings.length ? `\n⚠ ${renders.warnings.join("\n⚠ ")}` : "");

  // Post-compile summary (moma feedback #12): the output path and a compact
  // figures/citations resolution report, so "did everything land?" needs no
  // digging through the quarto log.
  let output: string | undefined;
  const created = /Output created:\s*(.+)/.exec(log);
  if (created) {
    const cand = path.resolve(path.dirname(docAbs), created[1].trim());
    if (await exists(cand)) output = cand;
  }
  if (!output && code === 0) {
    const ext = to === "html" ? ".html" : to === "docx" ? ".docx" : `.${to.replace(/^[^a-z]*/i, "")}`;
    const cand = docAbs.replace(/\.qmd$/i, ext);
    if (await exists(cand)) output = cand;
  }
  const embeddedLabels = collectEmbedLabels(expanded);
  const figures = {
    embedded: embeddedLabels.length,
    resolved: embeddedLabels.filter((l) => knownLabels.has(l)).length,
    missing: embeddedLabels.filter((l) => !knownLabels.has(l)),
  };
  const bibText = await fs
    .readFile(path.join(root, (m as { references?: { library?: string } }).references?.library ?? "references/library.bib"), "utf8")
    .catch(() => "");
  const bibKeys = new Set([...bibText.matchAll(/@\w+\s*\{\s*([^,\s{}]+)\s*,/g)].map((mm) => mm[1]));
  const used = citationKeysIn(expanded);
  const citations = {
    keys: used.length,
    resolved: used.filter((k) => bibKeys.has(k)).length,
    missing: used.filter((k) => !bibKeys.has(k)),
  };
  return { code, log: log + note, output, figures, citations };
}
