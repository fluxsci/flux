// flux-core/manuscript.ts — manuscript + documents + compile (the Paper-side
// parity verbs; split out of index.ts; WS-6.2).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { resolveSpawn } from "../electron/execResolve.cjs";
import { composeCaption } from "../src/lib/captions";
import { collectEmbedLabels, normalizeEmbedAlts, readQmdTree } from "../src/lib/exportQmd";
import { prepareExport } from "../src/lib/exportPrep";
import { familyById, type FigureFamilyDef } from "../src/lib/figfamily";
import { resolveJournalStyle, styledFamilyDef } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";
import { NATURE_ROLE_ALIASES } from "../src/lib/manuscript/sections";
import {
  EXPORT_PROFILE,
  EXPORT_PROFILE_FILE,
  journalAssetPlan,
  journalProfileYaml,
  diagnoseQuartoFailure,
} from "../src/lib/style/journalAssets";
import * as ops from "../src/lib/ops";
import { atomicWrite } from "./fsx";
import { withLock } from "./locks";
import { CLIENT, journal } from "./journal";
import { loadManifest, saveManifest, safeJoin, exists, writeText, readFigIndex, loadFigModel } from "./model";
import { materializeRenders } from "./render";
import type { ProjectManifest } from "../src/lib/project/types";
import { slugify } from "../src/lib/project/types";
import { CONTEXT_DOC_RELS, CONTEXT_PATHS } from "../src/lib/project/contextTemplates";

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

/** list the project's documents: main + supplementary + scanned manuscript/**.qmd
 *  + the Context docs (Context/ + Context/Project, .qmd AND .md — mirrors the
 *  GUI documents.listDocuments; Transcripts/Dispatches are not documents). */
export async function listDocuments(
  root: string,
): Promise<{ path: string; title: string; isMain: boolean; isContext?: boolean }[]> {
  const m = await loadManifest(root);
  const mainPath = m.manuscript.path;
  const rels = new Set<string>([mainPath]);
  const contextRels = new Set<string>();
  for (const s of m.supplementary ?? []) if (s.path) rels.add(s.path);
  const dir = mainPath.includes("/") ? mainPath.slice(0, mainPath.lastIndexOf("/")) : "";
  const scan = async (d: string, into: Set<string>, exts: string[]) => {
    try {
      for (const e of await fs.readdir(safeJoin(root, d), { withFileTypes: true }))
        if (e.isFile() && exts.some((x) => e.name.endsWith(x))) into.add(d ? `${d}/${e.name}` : e.name);
    } catch {
      /* dir may not exist */
    }
  };
  await scan(dir, rels, [".qmd"]);
  await scan(dir ? `${dir}/sections` : "sections", rels, [".qmd"]);
  await scan(CONTEXT_PATHS.dir, contextRels, [".qmd", ".md"]);
  await scan(CONTEXT_PATHS.projectDir, contextRels, [".qmd", ".md"]);
  const out: { path: string; title: string; isMain: boolean; isContext?: boolean }[] = [];
  const entryFor = async (rel: string, isContext: boolean) => {
    const isMain = rel === mainPath;
    let title = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.(qmd|md)$/, "");
    try {
      title = docTitle(await fs.readFile(safeJoin(root, rel), "utf8"), isMain ? m.title || title : title);
    } catch {
      /* keep filename title */
    }
    out.push({ path: rel, title, isMain, ...(isContext ? { isContext: true } : {}) });
  };
  for (const rel of rels) await entryFor(rel, false);
  for (const rel of contextRels) await entryFor(rel, true);
  const ctxRank = (rel: string) => {
    const i = CONTEXT_DOC_RELS.indexOf(rel);
    return i === -1 ? CONTEXT_DOC_RELS.length : i;
  };
  out.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    if (!!a.isContext !== !!b.isContext) return a.isContext ? 1 : -1;
    if (a.isContext && b.isContext) {
      const r = ctxRank(a.path) - ctxRank(b.path);
      if (r !== 0) return r;
    }
    return a.title.localeCompare(b.title);
  });
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

/** Shipped journal assets (CSL styles, Word reference docs). Resolved from this
 *  module's own location so a source checkout and the packaged CLI bundle both
 *  find them. */
const RESOURCES_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "resources",
);

/** The Node half of the shared include walker (`exportQmd.readQmdTree`) —
 *  real fs + node:path semantics. The grammar and traversal live in the shared
 *  core so the GUI cannot drift from it. */
export const qmdTreeIO = {
  readText: (abs: string) => fs.readFile(abs, "utf8").catch(() => null),
  resolveFrom: (includingFile: string, rel: string) =>
    path.resolve(path.dirname(includingFile), rel),
};

/** Read a qmd and its transitive includes; returns the involved files (in
 *  traversal order) and the EXPANDED text (includes spliced in place — the
 *  order Quarto numbers figures in). */
export async function readExpandedQmd(
  file: string,
  seen = new Set<string>(),
): Promise<{ files: string[]; expanded: string }> {
  const { files, expanded } = await readQmdTree(file, qmdTreeIO, seen);
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

export async function compile(
  root: string,
  to = "pdf",
  opts: { style?: string } = {},
): Promise<CompileSummary> {
  const m = await loadManifest(root);
  // Journal style: the CLI flag wins, else the project's stored pointer, else
  // the house style (which is a genuine no-op — DEFAULT_JOURNAL_STYLE).
  const style = resolveJournalStyle(
    opts.style ?? (m as { style?: { journal?: string | null } }).style?.journal ?? null,
    BUILTIN_JOURNAL_STYLES,
  );
  // Figures embed as ../fig/renders/<id>.svg — materialize them so a bare quarto
  // render (agent/CI, no app open) gets real images instead of broken links.
  const renders = await materializeRenders(root, m.manuscript.path).catch(() => ({ wrote: 0, failed: [] as string[], warnings: [] as string[] }));

  // Bare-quarto parity transform, applied IN PLACE and restored after the
  // render: family caption leads + composed model captions into empty embed
  // alts, embed ids demoted, and ALL `@fig-…` refs rewritten to literal
  // family-formatted text — Quarto's appearance-order numbering can't express
  // figure families, so it no longer numbers figures at all (exportQmd.ts).
  // Sources are restored in `finally`; even an unrestored transform is a
  // valid readable manuscript.
  const docAbs = path.resolve(root, m.manuscript.path);
  const captions = new Map<string, string>();
  const figIdentity = new Map<string, { family: FigureFamilyDef; number: number }>();
  const knownLabels = new Set<string>();
  try {
    const { project, index } = await loadFigModel(root);
    for (const f of index.figures ?? []) {
      knownLabels.add(f.label);
      const fig = ops.figById(project, f.id);
      // Post-load identity is healed (migrateFigureFamilies) — use it verbatim.
      if (fig?.family && fig.number != null) {
        figIdentity.set(f.label, {
          family: styledFamilyDef(style, familyById(fig.family, project.figureFamilies)),
          number: fig.number,
        });
      }
      const cap = fig ? composeCaption(fig) : "";
      if (cap.trim()) captions.set(f.label, cap);
    }
  } catch {
    /* no fig model → nothing to inject */
  }
  const ctx = { captions, figures: figIdentity, panels: style.figures.panels };
  // The shared prep owns the walk + transform + restore (src/lib/exportPrep.ts)
  // so the GUI runs byte-for-byte the same preparation.
  const prep = await prepareExport(
    { ...qmdTreeIO, writeText: atomicWrite },
    {
      entry: docAbs,
      ctx,
      structure: { order: style.structure.order, aliases: NATURE_ROLE_ALIASES },
    },
  );
  const expanded = prep.expanded;

  // Journal assets + the ephemeral Quarto profile. Nothing here touches the
  // user's _quarto.yml or their front matter: the profile is a separate file
  // merged by `--profile`, removed again in the finally below.
  const manuscriptDir = m.manuscript.path.includes("/")
    ? m.manuscript.path.slice(0, m.manuscript.path.lastIndexOf("/"))
    : "";
  const profileAbs = path.resolve(root, manuscriptDir, EXPORT_PROFILE_FILE);
  let useProfile = false;
  if (style.id !== "flux") {
    for (const a of journalAssetPlan(style)) {
      const dest = path.resolve(root, a.rel);
      const src = path.resolve(RESOURCES_DIR, a.resource);
      try {
        const bytes = await fs.readFile(src);
        // Skip a byte-identical rewrite (the §3 invariant) so re-exporting does
        // not churn mtimes on a committed style asset.
        const cur = await fs.readFile(dest).catch(() => null);
        if (!cur || !cur.equals(bytes)) {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, bytes);
        }
      } catch {
        /* a missing shipped asset must not abort the render — quarto will fall
           back to its defaults and the log will say so */
      }
    }
    await fs.writeFile(profileAbs, journalProfileYaml(style, { manuscriptDir })).then(
      () => (useProfile = true),
      () => (useProfile = false),
    );
  }

  let code = 0;
  let log = "";
  try {
    ({ code, log } = await new Promise<{ code: number; log: string }>((resolve, reject) => {
      const q = resolveSpawn("quarto", ["render", m.manuscript.path, "--to", to, ...(useProfile ? ["--profile", EXPORT_PROFILE] : [])]);
      const child = spawn(q.command, q.args, {
        cwd: root,
        windowsVerbatimArguments: q.windowsVerbatimArguments,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => reject(new Error(`quarto not available: ${e.message}`)));
      child.on("close", (c) => resolve({ code: c ?? 0, log: out }));
    }));
  } finally {
    await prep.restore();
    if (useProfile) await fs.rm(profileAbs, { force: true }).catch(() => {});
  }
  await journal(root, { action: "compile", to, code });
  // A missing external tool must read as one actionable sentence, not as the
  // ten-frame Lua trace Quarto prints for it.
  const diagnosis = code !== 0 ? diagnoseQuartoFailure(log) : null;
  if (diagnosis) log = `${log}\n\n${diagnosis}`;
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
