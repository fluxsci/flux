import { updateManifest } from "./manifest";
import { decodeManifest, encodeManifest } from "../src/lib/project/manifestTransaction";
// flux-core/manuscript.ts — manuscript + documents + compile (the Paper-side
// parity verbs; split out of index.ts; WS-6.2).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../electron/processRunner.cjs";
import { composeCaption, panelLetters } from "../src/lib/captions";
import { harvestZoteroLibrary, injectZoteroFields, resolveCslIdentity, type CslRecord } from "../src/lib/references/zoteroFields.js";
import { collectEmbedLabels, normalizeEmbedAlts, readQmdTree } from "../src/lib/exportQmd";
import { newSlideEmbed, serializeSlideEmbed, planSlideInsertion, scanSlideEmbeds } from "../src/lib/slide/embed";
import { slideQuartoTransform } from "../src/lib/slide/embedQuarto";
import { nodeSlideRepository } from "./slideEmbeds";
import { exportRecoveryIO } from "./recovery";
import { recoverExportSources, publishExportResource } from "../src/lib/project/exportRecovery";
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
import { withLock, assertLockOwned, type LockLease } from "./locks";
import { CLIENT, journal } from "./journal";
import { loadManifest, safeJoin, exists, writeText, readFigIndex, loadFigModel } from "./model";
import { materializeRenders } from "./render";
import type { ProjectManifest } from "../src/lib/project/types";
import { slugify } from "../src/lib/project/types";
import { CONTEXT_PATHS } from "../src/lib/project/contextTemplates";
import {
  commentsSidecarRel,
  commentsMainPath,
  documentRemovalBlocker,
  pruneDocumentFromManifest,
  sortDocuments,
} from "../src/lib/project/docOrder";
import { NotFoundError, ValidationError } from "./errors";
import { isConflictPath } from "../electron/conflictRules.js";

// --------------------------------------------------------------------------
// manuscript + documents + references + compile (the Paper-side parity verbs).
// All file-level, mirroring src/lib/project/load.ts + paper/documents/documents.ts
// over Node fs so an agent has the same reach as the GUI.
// --------------------------------------------------------------------------
const manuRel = (m: ProjectManifest, rel?: string) => {
  const target = rel ?? m.manuscript.path;
  if (!target) throw new ValidationError("This project has no default document. Create a document or specify --doc.");
  return target;
};

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

import { discoverDocuments, deleteDocumentFile, createDocumentFile, createDocumentFolder, moveDocumentFile, type DocumentIO } from "../src/lib/project/documentFiles";
function documentIO(root: string): DocumentIO {
  return {
    exists: rel => exists(safeJoin(root, rel)), read: rel => fs.readFile(safeJoin(root, rel), "utf8"),
    write: (rel, text) => writeText(safeJoin(root, rel), rel === "project.json" ? encodeManifest(decodeManifest(text)) : text),
    create: (rel, text) => atomicWrite(safeJoin(root, rel), text, true),
    mkdir: async rel => { await fs.mkdir(safeJoin(root, rel), { recursive: true }); },
    entries: async rel => (await fs.readdir(safeJoin(root, rel), { withFileTypes: true }))
      .filter(e => e.isFile() || e.isDirectory()).map(e => ({ name: e.name, dir: e.isDirectory() })),
    remove: rel => fs.rm(safeJoin(root, rel), { force: true }),
  };
}
export async function listDocuments(root: string) { return (await discoverDocuments(await loadManifest(root), documentIO(root))).docs; }
export async function createDocument(root: string, name: string, folder?: string): Promise<{ path: string }> {
  let rel = "";
  await withLock(root, "manuscript", CLIENT, () => updateManifest(root, async fresh => { rel = await createDocumentFile(fresh, documentIO(root), name, folder); }));
  await journal(root, { action: "create_document", target: rel });
  return { path: rel };
}
export async function createFolder(root: string, parent: string, name: string): Promise<{ path: string }> {
  // Recovery can itself publish cold references under the manuscript lease.
  // Finish it before entering this operation to avoid nested acquisition.
  const manifest = await loadManifest(root);
  const rel = await withLock(root, "manuscript", CLIENT, async () => createDocumentFolder(manifest, documentIO(root), parent, name));
  await journal(root, { action: "create_document_folder", target: rel });
  return { path: rel };
}
export async function moveDocument(root: string, rel: string, folder: string) {
  let result!: { path: string; changed: string[] };
  await withLock(root, "manuscript", CLIENT, () => updateManifest(root, async fresh => { result = await moveDocumentFile(fresh, documentIO(root), rel, folder); }));
  await journal(root, { action: "move_document", target: rel, destination: result.path });
  return result;
}

/** delete a document from the project: its .qmd and its comments sidecar are
 *  removed and the manifest forgets it (supplementary + documentOrder). What
 *  may be deleted and what counts as the document's files is the shared policy
 *  in docOrder.ts — the main manuscript and Context documents are refused, and
 *  the GUI's × applies the same rules. Figures, references and every other
 *  document are untouched: a document only REFERENCES them. */
export async function deleteDocument(root: string, rel: string): Promise<{ path: string; removed: string[] }> {
  let removed: string[] = [];
  await withLock(root, "manuscript", CLIENT, () => updateManifest(root, async fresh => {
    const blocker = documentRemovalBlocker((await discoverDocuments(fresh, documentIO(root))).docs, rel);
    if (blocker) throw blocker.code === 'unknown' ? new NotFoundError(blocker.reason) : new ValidationError(blocker.reason);
    const result = await deleteDocumentFile(fresh, documentIO(root), rel);
    removed = result.removed;
  }));
  await journal(root, { action: "delete_document", target: rel });
  return { path: rel, removed };
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

/** Insert one linked slide block under the document lock, after an optional unique line anchor. */
export async function insertSlideEmbed(root: string, deck: string, slide: string, opts: { doc?: string; width?: string; caption?: string; anchor?: string } = {}) {
  const m = await loadManifest(root), rel = manuRel(m, opts.doc), abs = safeJoin(root, rel);
  const before = await fs.readFile(abs, "utf8");
  let pos = before.length;
  if (opts.anchor !== undefined) {
    if (!opts.anchor || before.indexOf(opts.anchor) < 0 || before.indexOf(opts.anchor) !== before.lastIndexOf(opts.anchor))
      throw new ValidationError("The insertion anchor must occur exactly once in the document");
    pos = before.indexOf(opts.anchor) + opts.anchor.length;
  }
  const ref = newSlideEmbed(rel, deck, slide, opts), markdown = serializeSlideEmbed(ref);
  const repository = await nodeSlideRepository(root);
  try {
    await repository.materialize(ref);
    const edit = planSlideInsertion(before, pos, markdown);
    await withLock(root, "manuscript", CLIENT, async () => {
      if (await fs.readFile(abs, "utf8") !== before) throw new ValidationError("Document changed while preparing slide insertion; retry");
      await writeText(abs, before.slice(0, edit.from) + edit.insert + before.slice(edit.to));
    });
  } finally { repository.dispose(); }
  await journal(root, { action: "insert_slide_embed", target: rel, deck, slide, id: ref.id });
  return { path: rel, id: ref.id, deck, slide, markdown };
}

/** compile the manuscript via Quarto (pdf|html|docx). Requires `quarto` on PATH. */

/** Shipped journal assets (CSL styles, Word reference docs). Resolved from this
 *  module's own location so a source checkout and the packaged CLI bundle both
 *  find them. */
const RESOURCES_DIR = path.resolve(
  // fileURLToPath, never `.pathname`: on Windows that is "/C:/…", which
  // path.resolve turns into "C:\C:\…" — every shipped CSL and Word reference
  // read silently failed there, so a journal-styled export lost its style.
  path.dirname(fileURLToPath(import.meta.url)),
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
  for (const docPath of [m.manuscript.path, ...(m.supplementary ?? []).map((s) => s.path)].filter(Boolean)) {
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
  /** Present when live Zotero fields were requested and written. `notesPlain` counts
   *  footnote/endnote citations, which stay displayed text rather than live fields. */
  zotero?: { citations: number; bound: number; embedded: number; notesPlain: number; style: string };
  /** docx only. Word paints nothing for an SVG picture with no raster fallback, which
   *  is all pandoc can emit without rsvg-convert on PATH — so each one gets a PNG
   *  spliced in. `failed` names pictures left as-is (no rasterizer available in a
   *  packaged build, or an SVG resvg could not render). */
  svgFallbacks?: { added: number; failed: string[] };
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

/** The Zotero style id + locale for this render — the shared resolver with node IO.
 *  Candidate precedence lives in ONE place (resolveCslIdentity, twin-engine rule);
 *  the in-app export calls the same function over the FileBridge. */
async function cslIdentity(root: string, docAbs: string, styleCsl?: string): Promise<{ styleId: string; locale: string }> {
  return resolveCslIdentity((p) => fs.readFile(p, "utf8").catch(() => null), {
    root,
    docPath: docAbs,
    styleCsl,
  });
}

export async function compile(
  root: string,
  to = "pdf",
  opts: { doc?: string; style?: string; zoteroFields?: boolean; zoteroLibraryDocs?: string[] } = {},
): Promise<CompileSummary> {
  return withLock(root, "export", CLIENT, async lease => compileOwned(root, to, opts, lease));
}
async function compileOwned(root: string, to: string, opts: { doc?: string; style?: string; zoteroFields?: boolean; zoteroLibraryDocs?: string[] }, lease: LockLease): Promise<CompileSummary> {
  const recoveryIO = exportRecoveryIO(root, () => assertLockOwned(lease));
  await recoverExportSources(recoveryIO, root);
  const m = await loadManifest(root);
  const document = manuRel(m, opts.doc);
  safeJoin(root, document);
  // Journal style: the CLI flag wins, else the project's stored pointer, else
  // the house style (which is a genuine no-op — DEFAULT_JOURNAL_STYLE).
  const style = resolveJournalStyle(
    opts.style ?? (m as { style?: { journal?: string | null } }).style?.journal ?? null,
    BUILTIN_JOURNAL_STYLES,
  );
  // Figures embed as ../fig/renders/<id>.svg — materialize them so a bare quarto
  // render (agent/CI, no app open) gets real images instead of broken links.
  const renders = await materializeRenders(root, document);

  // Bare-quarto parity transform, applied IN PLACE and restored after the
  // render: family caption leads + composed model captions into empty embed
  // alts, embed ids demoted, and ALL `@fig-…` refs rewritten to literal
  // family-formatted text — Quarto's appearance-order numbering can't express
  // figure families, so it no longer numbers figures at all (exportQmd.ts).
  // Sources are restored in `finally`; even an unrestored transform is a
  // valid readable manuscript.
  const docAbs = path.resolve(root, document);
  const ext = to === "html" ? "html" : to === "docx" ? "docx" : to;
  if (!/^[a-z0-9-]+$/i.test(ext)) throw new ValidationError("Unsupported output format");
  const source = await fs.readFile(docAbs, "utf8");
  const yaml = await import("js-yaml");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source);
  const meta = frontmatter ? (yaml.load(frontmatter[1]) as Record<string, any> | null) : null;
  const outputName = meta?.format?.[to]?.["output-file"] ?? meta?.["output-file"] ?? path.basename(docAbs).replace(/\.qmd$/i, `.${ext}`);
  if (typeof outputName !== "string" || path.basename(outputName) !== outputName) throw new ValidationError("Quarto output-file must be a filename");
  const temporaryName = `.flux-export-${crypto.randomUUID()}.${ext}`;
  let pendingOutput: string | undefined;
  try {
  const captions = new Map<string, string>();
  const figIdentity = new Map<string, { family: FigureFamilyDef; number: number; panels: string[] }>();
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
          panels: panelLetters(fig),
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
  const slideRepository = await nodeSlideRepository(root);
  const slideTransform = slideQuartoTransform(root, slideRepository, to === "html");
  const prep = await prepareExport(
    { ...qmdTreeIO, readText: recoveryIO.readText, writeText: recoveryIO.writeText },
    {
      entry: docAbs,
      recovery: { root, id: crypto.randomUUID(), io: recoveryIO },
      ctx,
      structure: { order: style.structure.order, aliases: NATURE_ROLE_ALIASES },
      markCitations: !!opts.zoteroFields,
      ...slideTransform,
    },
  );
  const expanded = prep.expanded;

  // Journal assets + the ephemeral Quarto profile. Nothing here touches the
  // user's _quarto.yml or their front matter: the profile is a separate file
  // merged by `--profile`, removed again in the finally below.
  const manuscriptDir = document.includes("/")
    ? document.slice(0, document.lastIndexOf("/"))
    : "";
  const profileName = `flux-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const profileRel = `${manuscriptDir ? manuscriptDir + "/" : ""}_quarto-${profileName}.yml`;
  const profileAbs = path.resolve(root, profileRel);
  let useProfile = false;
  let code = 0;
  let log = "";
  try {
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
    await publishExportResource(recoveryIO, root, profileName, profileRel, journalProfileYaml(style, { manuscriptDir }));
    useProfile = true;
  }

    const rendered = await runProcess({ executable: "quarto", argv: ["render", path.basename(docAbs), "--to", to, "--output", temporaryName, ...(to === "html" && scanSlideEmbeds(expanded).length ? ["--embed-resources"] : []), ...(useProfile ? ["--profile", profileName] : [])], cwd: path.dirname(docAbs) }, { timeoutMs: 30 * 60 * 1000, maxOutputBytes: 4 * 1024 * 1024 });
    code = rendered.status === "exited" ? rendered.code : -1;
    log = rendered.stdout + rendered.stderr + (rendered.status === "exited" ? "" : `\nQuarto ${rendered.status}${rendered.signal ? ` (${rendered.signal})` : ""}`);
    if (rendered.truncated.stdout || rendered.truncated.stderr) log += "\n(Quarto log exceeded the retained output limit.)";
  } finally {
    slideRepository.dispose();
    await prep.restore();
    // The recovery journal owns exact-content cleanup of the temporary profile.
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
  const candidates = [
    ...(created ? [path.resolve(path.dirname(docAbs), created[1].trim()), path.resolve(root, created[1].trim())] : []),
    path.join(path.dirname(docAbs), temporaryName), path.join(root, "_output", temporaryName),
  ];
  for (const candidate of candidates) if (path.basename(candidate) === temporaryName && await exists(candidate)) { pendingOutput = candidate; break; }
  if (code === 0 && !pendingOutput) throw new Error("Quarto reported success without producing the owned artifact");
  if (pendingOutput && code === 0) output = path.join(path.dirname(pendingOutput), outputName);
  const embeddedLabels = collectEmbedLabels(expanded);
  const figures = {
    embedded: embeddedLabels.length,
    resolved: embeddedLabels.filter((l) => knownLabels.has(l)).length,
    missing: embeddedLabels.filter((l) => !knownLabels.has(l)),
  };
  const bibText = await fs
    .readFile(path.join(root, (m as { references?: { library?: string } }).references?.library ?? "references/library.bib"), "utf8");
  const bibKeys = new Set([...bibText.matchAll(/@\w+\s*\{\s*([^,\s{}]+)\s*,/g)].map((mm) => mm[1]));
  const used = citationKeysIn(expanded);
  const citations = {
    keys: used.length,
    resolved: used.filter((k) => bibKeys.has(k)).length,
    missing: used.filter((k) => !bibKeys.has(k)),
  };
  let svgFallbacks: CompileSummary["svgFallbacks"];
  let zotero: CompileSummary["zotero"];
  if (output && pendingOutput && code === 0) {
    if (renders.failed.length) throw new Error(`Figure renders failed: ${renders.failed.join(", ")}`);
    let bytes: Uint8Array = new Uint8Array(await fs.readFile(pendingOutput));
    if (to === "docx") {
      const { postprocessDocx } = await import("../src/lib/references/docxArtifact");
      const { rasterizeSvgToPng } = await import("./render");
      const processed = await postprocessDocx(bytes, {
        rasterize: async (svg, width) => new Uint8Array(await rasterizeSvgToPng(svg, width)),
        ...(opts.zoteroFields ? { inject: async (input: Uint8Array) => {
          const { getCite } = await import("../src/lib/references/bibtex");
          const Cite = await getCite(), records: Record<string, CslRecord> = {};
          for (const rec of (new Cite(bibText).data as CslRecord[]) ?? []) if (rec?.id) records[String(rec.id)] = rec;
          const libraryDocs = await Promise.all((opts.zoteroLibraryDocs ?? []).map(async f => ({ name: path.basename(f), bytes: new Uint8Array(await fs.readFile(path.resolve(root, f))) })));
          const identity = await cslIdentity(root, docAbs, style.csl);
          const injected = injectZoteroFields(input, { items: records, styleId: identity.styleId, locale: identity.locale, index: libraryDocs.length ? harvestZoteroLibrary(libraryDocs) : null });
          return { bytes: injected.bytes, summary: { citations: injected.report.citations, bound: injected.report.bound, embedded: injected.report.embedded, notesPlain: injected.report.notesPlain, style: identity.styleId } };
        } } : {}),
      });
      bytes = processed.bytes; zotero = processed.zotero; svgFallbacks = processed.svgFallbacks;
      log += processed.warnings.map(w => `\n⚠ ${w}`).join("");
    } else if (to === "pdf" && new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("Invalid PDF output");
    else if (to === "html" && !/<html[\s>]/i.test(new TextDecoder().decode(bytes))) throw new Error("Invalid HTML output");
    await assertLockOwned(lease);
    await atomicWrite(output, bytes);
  }

  return { code, log: log + note, output, figures, citations, zotero, svgFallbacks };
  } finally {
    for (const owned of new Set([pendingOutput, path.join(path.dirname(docAbs), temporaryName), path.join(root, "_output", temporaryName)])) if (owned) await fs.rm(owned, { force: true });
  }
}
