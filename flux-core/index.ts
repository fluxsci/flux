// flux-core — the project format as a library, runnable under Node (CLI + MCP).
//
// "The file is the API" (Flux_Master_Plan.md §5, AI_agent_considerations.md): the
// GUI, the CLI, and the MCP server all drive a Flux project *through its files*.
// This module owns the read/write/reindex/render logic over Node's fs, reusing
// the GUI's pure functions (figureToSvg, composeCaption) so there is one source
// of truth for the figure format — no GUI-only capability.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { figureToSvg } from "../src/lib/export";
import { membersDeep } from "../src/lib/groups";
import { composeCaption, panelLetters } from "../src/lib/captions";
import { elementBBox, unionRect } from "../src/lib/geometry";
import { gridLayout, emptyRegion } from "../src/lib/layout";
import { preparePlot, prefixIds, applyOverrides, buildPartIndex } from "../src/lib/plot/parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "../src/lib/plot/compensate";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import { withLock, setLockClient } from "./locks";
import * as fluxlib from "./fluxlib";
import { writePdf, writeFulltext } from "./items";
import { extractFulltext } from "./fulltext";
import { sniffFormat, risToBibtex } from "../src/lib/references/ris";
import { bibPdfAttachments } from "../src/lib/references/zoteroFiles";
import { mergeEnrich } from "../src/lib/references/enrich";
// Reference hydration + whole-world lookups (OpenAlex) — see flux-core/enrich.ts.
export {
  hydrateLibrary,
  searchWorld,
  searchWorldSemantic,
  similarByKey,
  authorWorks,
  citingWorks,
  relatedWorks,
} from "./enrich";
export type { HydrateResult } from "./enrich";
export type { WorldBrief } from "../src/lib/references/openalex";
// Semantic Scholar — recommendations ("papers like this") + citation contexts.
export { s2Similar, s2Citing } from "./s2";
// FluxFinder — PDF acquisition + the items/ store.
export { fetchPdfForKey, fetchPdfs, ingestPdf } from "./acquire";
export type { FetchSummary, FetchOneResult } from "./acquire";
export { assignPdfs } from "./assign";
export type { AssignSummary, AssignItemResult, AssignAction } from "./assign";
export { hasPdf, readPdf, readSource, writePdf, readFulltext, writeFulltext, loadItemsIndex, rebuildItemsIndex, itemStatus, readReaderContext } from "./items";
export { extractFulltext, getOrExtractFulltext } from "./fulltext";
// 2.3: full-text search across every stored PDF's extracted text.
export { searchFulltext } from "./fulltextSearch";
export type { FulltextResult, FulltextHit, FulltextSnippet } from "./fulltextSearch";
// FluxReader annotations (highlights/notes; searchable library-wide).
export { loadAnnotations, addAnnotation, deleteAnnotation, listAnnotations, searchAnnotations } from "./annotate";
export type { AnnotationHit } from "./annotate";
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
// API keys (machine-global ~/FluxLib/keys.json + env), shared by CLI/MCP/GUI.
export { loadKeys, saveKeys, getSecret } from "./fluxlib";
export type { FluxKeys } from "./fluxlib";
// 3.3 library organization (tags / status / collections) sidecar.
export { loadOrganize, organizeSetTags, organizeSetStatus, organizeSetCollections } from "./fluxlib";

// WS6 — client identity, stamped on every journal entry and used as lock owner.
// The CLI sets "cli", the MCP server "mcp"; the GUI writes as "human" and the
// live bridge as "agent" through their own paths. Defaults to "flux-core".
let CLIENT = process.env.FLUX_CLIENT || "flux-core";
export function setClient(c: string): void {
  CLIENT = c;
  setLockClient(c); // keep the lock layer's identity in sync (fluxlib.ts uses it)
}
export function getClient(): string {
  return CLIENT;
}
import * as ops from "../src/lib/ops";
import * as slideOps from "../src/lib/slide/ops";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import { atomicWrite } from "./fsx";
import Ajv from "ajv";
import { SCHEMAS, SCHEMA_FILENAMES, schemaForFile } from "./schemas";
import type { Figure, Element, Project, Asset, Canvas, PartOverride, VectorNode, TextStyle } from "../src/lib/types";
import { migrateProject } from "../src/lib/migrate";
import type { ProjectManifest, FigureEntry } from "../src/lib/project/types";
import { slugify } from "../src/lib/project/types";

// --------------------------------------------------------------------------
// fs helpers + project-root path safety (M9: never escape the project root)
// --------------------------------------------------------------------------
const j = (...p: string[]) => path.join(...p);

/** Resolve `rel` under `root`, throwing if it would escape the project root. */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return abs;
}

/** AGT-5: validate an id that becomes a path segment (figure/canvas ids from CLI/MCP
 *  flags like `--id` / `--canvas`). Rejects path separators, null bytes, and a leading
 *  dot so a crafted `--id ../../x` can't write outside the project tree — with a clear
 *  message, before safeJoin's generic "escapes root" backstop would fire. */
export function safeId(kind: string, id: string): string {
  if (!id || /[\\/\x00]/.test(id) || id.startsWith(".")) {
    throw new Error(`unsafe ${kind} id ${JSON.stringify(id)}: no path separators or leading dot`);
  }
  return id;
}

async function readJSON<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function writeText(p: string, t: string): Promise<void> {
  await atomicWrite(p, t); // W2: durable tmp+fsync+rename for every canonical write
}
function stamp(): string {
  return new Date().toISOString();
}

// --------------------------------------------------------------------------
// on-disk shapes (mirror figbridge.ts / project format §3.2, §7)
// --------------------------------------------------------------------------
interface FigIndexFile {
  schemaVersion: string;
  canvases: { id: string; name: string; order: number }[];
  figures: {
    id: string;
    name: string;
    label: string;
    order: number;
    kind: string;
    canvas: string;
    caption: string;
  }[];
  assets?: {
    id: string;
    kind: "png" | "svg";
    path?: string;
    name?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    // Physical resolution a PNG declared (pHYs), captured at import. Physical
    // size in canvas px = natural × 96/dpi — dropping this on load silently
    // resized re-saved rasters (the Asset.dpi round-trip bug, fixed with P3).
    dpi?: number;
  }[];
  palette?: string[];
  colorGroups?: unknown[];
  // Named text styles (project-level; mirrors figbridge.ts). Loaded into
  // Project.textStyles and written back EXPLICITLY in saveFigModelUnlocked —
  // either side omitting it silently wipes user styles on the next save.
  textStyles?: TextStyle[];
}
interface CanvasFile {
  schemaVersion: string;
  id: string;
  name: string;
  figures: Figure[];
}

export async function loadManifest(root: string): Promise<ProjectManifest> {
  return readJSON<ProjectManifest>(j(root, "project.json"));
}
async function saveManifest(root: string, m: ProjectManifest): Promise<void> {
  m.modified = stamp();
  await writeText(j(root, "project.json"), JSON.stringify(m, null, 2) + "\n");
}
async function readFigIndex(root: string): Promise<FigIndexFile | null> {
  const p = j(root, "fig", "index.json");
  return (await exists(p)) ? readJSON<FigIndexFile>(p) : null;
}
async function saveFigIndex(root: string, idx: FigIndexFile): Promise<void> {
  await writeText(j(root, "fig", "index.json"), JSON.stringify(idx, null, 2) + "\n");
}
async function readCanvasFiles(
  root: string,
  idx: FigIndexFile,
): Promise<{ byId: Record<string, Figure>; canvasOf: Record<string, string> }> {
  const byId: Record<string, Figure> = {};
  const canvasOf: Record<string, string> = {};
  for (const cm of idx.canvases ?? []) {
    const p = safeJoin(root, `fig/canvases/${cm.id}.json`);
    if (await exists(p)) {
      const cf = await readJSON<CanvasFile>(p);
      for (const f of cf.figures ?? []) {
        (f as Figure).canvasId = cm.id;
        byId[f.id] = f;
        canvasOf[f.id] = cm.id;
      }
    }
  }
  return { byId, canvasOf };
}

// --------------------------------------------------------------------------
// the figure model as a Project (so flux-core mutates via the shared pure ops
// core, exactly like the GUI). loadFigModel reads index + canvas files into a
// Project; saveFigModel writes the canvas files + index rollup + reindexes.
// --------------------------------------------------------------------------
const emptyIndex = (): FigIndexFile => ({
  schemaVersion: "0.1.0",
  canvases: [],
  figures: [],
  assets: [],
  palette: [],
  colorGroups: [],
});

export async function loadFigModel(root: string): Promise<{ project: Project; index: FigIndexFile }> {
  const index = (await readFigIndex(root)) ?? emptyIndex();
  const { byId } = await readCanvasFiles(root, index);
  const canvases: Canvas[] = (index.canvases ?? []).map((c) => ({ id: c.id, name: c.name }));
  const figures: Figure[] = Object.values(byId); // canvas-then-file insertion order
  const assets: Asset[] = (index.assets ?? []).map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    kind: a.kind,
    path: a.path ?? "",
    naturalWidth: a.naturalWidth ?? 0,
    naturalHeight: a.naturalHeight ?? 0,
    ...(a.dpi != null ? { dpi: a.dpi } : {}), // keep the pHYs dpi (round-trip)
  }));
  const project: Project = {
    version: 2,
    name: "",
    canvases,
    figures,
    assets,
    palette: index.palette ?? [],
    colorGroups: (index.colorGroups as Project["colorGroups"]) ?? [],
    // undefined when the index predates styles → migrate seeds the defaults;
    // an explicit list (even []) from disk is the user's truth.
    ...(index.textStyles !== undefined ? { textStyles: index.textStyles } : {}),
  };
  // Same migration the GUI runs in normalizeProject (text autoWidth → sizing,
  // seed default text styles) — flux-core previously did NO element
  // normalization, so v1 docs mutated headless kept legacy fields forever.
  migrateProject(project);
  return { project, index };
}

/** A clean cross-ref label for a figure: `fig-<slug>` (slug-like ids pass through). */
function deriveLabel(f: Figure): string {
  const slugLike = /^[a-z0-9][a-z0-9-]*$/i.test(f.id) && !f.id.includes("_");
  const base = slugLike ? f.id : slugify(f.name || f.id);
  return `fig-${base || f.id}`;
}

export async function saveFigModel(
  root: string,
  project: Project,
  index: FigIndexFile,
  action = "save_fig",
): Promise<void> {
  // WS6: an agent file-write defers (throws) rather than clobbering an in-flight
  // human edit (the GUI holds the "project" lock while actively editing). Then journal.
  await withLock(root, "project", CLIENT, () => saveFigModelUnlocked(root, project, index));
  await journal(root, { action, figures: project.figures.map((f) => f.id) });
}

/** W3: run a read→mutate→write cycle atomically under the "project" lock, so two
 *  agents (or an agent racing the GUI's save) can never interleave a lost update —
 *  the load happens INSIDE the lock. All mutating fig verbs go through this. */
export async function mutateFigModel<T>(
  root: string,
  action: string,
  fn: (m: { project: Project; index: FigIndexFile }) => T | Promise<T>,
): Promise<T> {
  let out!: T;
  let figIds: string[] = [];
  await withLock(root, "project", CLIENT, async () => {
    const m = await loadFigModel(root);
    out = await fn(m);
    figIds = m.project.figures.map((f) => f.id);
    await saveFigModelUnlocked(root, m.project, m.index);
  });
  await journal(root, { action, figures: figIds });
  return out;
}

async function saveFigModelUnlocked(
  root: string,
  project: Project,
  index: FigIndexFile,
): Promise<void> {
  const byCanvas = new Map<string, Figure[]>();
  for (const f of project.figures) {
    const arr = byCanvas.get(f.canvasId) ?? [];
    arr.push(f);
    byCanvas.set(f.canvasId, arr);
  }
  const canvasName = new Map((index.canvases ?? []).map((c) => [c.id, c.name] as const));
  for (const [cid, figs] of byCanvas) {
    const cf: CanvasFile = {
      schemaVersion: "0.1.0",
      id: cid,
      name: canvasName.get(cid) ?? cid,
      figures: figs,
    };
    await writeText(safeJoin(root, `fig/canvases/${cid}.json`), JSON.stringify(cf, null, 2) + "\n");
  }
  const prevFig = new Map((index.figures ?? []).map((f) => [f.id, f] as const));
  index.figures = project.figures.map((f, i) => {
    const prev = prevFig.get(f.id);
    return {
      id: f.id,
      name: f.name,
      label: prev?.label ?? deriveLabel(f),
      order: i + 1,
      kind: prev?.kind ?? "main",
      canvas: f.canvasId,
      caption: prev?.caption ?? "",
    };
  });
  const prevCanvas = new Map((index.canvases ?? []).map((c) => [c.id, c] as const));
  index.canvases = project.canvases.length
    ? project.canvases.map((c, i) => ({ id: c.id, name: c.name, order: prevCanvas.get(c.id)?.order ?? i + 1 }))
    : [...byCanvas.keys()].map((id, i) => ({ id, name: canvasName.get(id) ?? id, order: i + 1 }));
  index.assets = project.assets.map((a) => ({
    id: a.id,
    kind: a.kind,
    path: a.path,
    name: a.name,
    naturalWidth: a.naturalWidth,
    naturalHeight: a.naturalHeight,
    ...(a.dpi != null ? { dpi: a.dpi } : {}),
  }));
  index.palette = project.palette;
  index.colorGroups = project.colorGroups ?? [];
  index.textStyles = project.textStyles ?? []; // explicit writeback (wipe guard)
  await saveFigIndex(root, index);
  await reindex(root);
}

/** Intrinsic size of an SVG in CSS px (96/inch), matching how the BROWSER sizes it on
 *  GUI import: the width/height attributes with their units converted (matplotlib
 *  writes pt → ×96/72), falling back to the viewBox (unitless user units = px).
 *  Physical size is the placement contract — a plot must land at the same true size
 *  whether it arrives via the GUI, the CLI, or an agent. (The old version preferred
 *  the unitless viewBox, silently placing pt-sized SVGs at 0.75× physical.) */
function svgIntrinsicSize(svg: string): { w: number; h: number } {
  const m = /<svg\b[^>]*>/i.exec(svg);
  const tag = m ? m[0] : svg.slice(0, 600);
  const PX_PER: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  const dim = (name: string): number | null => {
    const d = new RegExp(`\\b${name}="\\s*([\\d.]+)\\s*(px|pt|pc|mm|cm|in)?\\s*"`, "i").exec(tag);
    return d ? +d[1] * PX_PER[(d[2] || "px").toLowerCase()] : null; // "100%" etc. → null
  };
  const w = dim("width");
  const h = dim("height");
  if (w && h) return { w, h };
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) return { w: +vb[1], h: +vb[2] };
  return { w: 240, h: 180 };
}

/** Copy a plot SVG into fig/assets, registering it (+ natural size) on the model.
 *  Returns the new assetId and any detected FluxPlot sidecar paths (project-rel). */
async function importPlotAsset(
  root: string,
  project: Project,
  svgFile: string,
): Promise<{ assetId: string; w: number; h: number; source?: { svgPath: string; manifestPath?: string; recipePath?: string } }> {
  const abs = path.resolve(svgFile);
  const svg = await fs.readFile(abs, "utf8");
  const { w, h } = svgIntrinsicSize(svg);
  const tag = Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
  const assetId = `asset_${tag}`;
  const rel = `assets/${assetId}.svg`;
  await atomicWrite(safeJoin(root, `fig/${rel}`), svg);
  project.assets.push({ id: assetId, name: path.basename(abs), kind: "svg", path: rel, naturalWidth: w, naturalHeight: h });
  const base = abs.replace(/\.svg$/i, "");
  const manifest = base + ".fluxplot.json";
  const recipe = base + ".recipe.json";
  let source: { svgPath: string; manifestPath?: string; recipePath?: string } | undefined;
  if (await exists(manifest)) {
    // AGT-1/AGT-11: copy the FluxPlot manifest (+ recipe) as ASSET-LOCAL sidecars
    // (fig/assets/<id>.fluxplot.json). The GUI reconnects a plot's semantic parts
    // ONLY from that path (figbridge.ts) — without it an agent-composed plot opens
    // as an opaque <image> and the next human save bakes that in permanently. It
    // also keeps the manifest in-root so headless render's group-override expansion
    // works even when the original plot lives outside the project. `source` still
    // records the original paths as provenance (used by rerun-plot regeneration).
    await atomicWrite(safeJoin(root, `fig/assets/${assetId}.fluxplot.json`), await fs.readFile(manifest, "utf8"));
    const hasRecipe = await exists(recipe);
    if (hasRecipe) {
      await atomicWrite(safeJoin(root, `fig/assets/${assetId}.recipe.json`), await fs.readFile(recipe, "utf8"));
    }
    source = {
      svgPath: path.relative(root, abs),
      manifestPath: path.relative(root, manifest),
      recipePath: hasRecipe ? path.relative(root, recipe) : undefined,
    };
  }
  return { assetId, w, h, source };
}

// --------------------------------------------------------------------------
// verbs
// --------------------------------------------------------------------------

/** reindex: rebuild project.json.figures[] from fig/index.json (spec §7). */
export async function reindex(root: string): Promise<{ figures: number }> {
  const manifest = await loadManifest(root);
  const index = await readFigIndex(root);
  const figures: FigureEntry[] = (index?.figures ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    label: f.label,
    order: f.order,
    kind: f.kind === "supplementary" ? "supplementary" : "main",
    canvas: f.canvas,
    caption: `fig/captions/${f.id}.md`,
  }));
  manifest.figures = figures;
  await saveManifest(root, manifest);
  return { figures: figures.length };
}

/** list_project: a compact overview of documents, figures, references. */
export async function listProject(root: string): Promise<{
  title: string;
  documents: string[];
  figures: { id: string; label: string; name: string; order: number; panels: string[] }[];
  references: string | null;
}> {
  const manifest = await loadManifest(root);
  const index = await readFigIndex(root);
  const { byId } = index ? await readCanvasFiles(root, index) : { byId: {} as Record<string, Figure> };
  return {
    title: manifest.title,
    documents: [
      manifest.manuscript.path,
      ...(manifest.supplementary ?? []).map((s) => s.path),
    ],
    figures: (index?.figures ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      name: f.name,
      order: f.order,
      panels: byId[f.id] ? panelLetters(byId[f.id]) : [],
    })),
    references: manifest.references?.library ?? null,
  };
}

function mimeFor(kind: string): string {
  return kind === "svg" ? "image/svg+xml" : "image/png";
}

// Headless DOM (linkedom) so we can reuse the GUI's pure plot functions
// (preparePlot/prefixIds/applyOverrides/compensatePtTrue) — exactly like the
// in-app plotToSvgMarkup, one source of truth. Exported for slides.ts
// (gatherDeckPayload derives manifests for vanilla plots through the same seam).
let domReady = false;
export async function ensureDom(): Promise<void> {
  if (domReady) return;
  const { DOMParser } = await import("linkedom");
  const g = globalThis as unknown as { DOMParser?: unknown };
  if (!g.DOMParser) g.DOMParser = DOMParser;
  domReady = true;
}

/** Inline a placed semantic plot to an <svg> string with its overrides baked in
 *  (mirrors src/lib/plot/export.ts plotToSvgMarkup, but reads from disk).
 *  Runs the SAME preparePlot seam as the app's cachePlot — normalization
 *  (sanitize / shared-<use> inlining / id stamping) + orphan augmentation —
 *  so group-keyed overrides (`unclassified`, derived groups) resolve
 *  identically headless, and the same crop + pt-true compensation. */
function buildPlotMarkup(
  svgText: string,
  el: Element & {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    crop?: { x: number; y: number; width: number; height: number };
    contentScale?: number;
  },
  overrides: Record<string, unknown> | undefined,
  manifest: FluxPlotManifest | undefined,
): string | null {
  const prepared = preparePlot(svgText, manifest);
  const rootEl = prepared.root;
  if (!rootEl) return null;
  const intrinsic = svgIntrinsicPx(rootEl as unknown as globalThis.Element);
  prefixIds(rootEl as unknown as globalThis.Element, el.id);
  rootEl.setAttribute("x", String(el.x));
  rootEl.setAttribute("y", String(el.y));
  rootEl.setAttribute("width", String(el.width));
  rootEl.setAttribute("height", String(el.height));
  rootEl.setAttribute("preserveAspectRatio", "none");
  if (el.crop) {
    // NOTE: preparePlot never mutates width/height/viewBox, so reading the
    // original viewBox off the prepared root pre-override is still valid here.
    rootEl.setAttribute(
      "viewBox",
      cropViewBoxValue(rootEl.getAttribute("viewBox"), intrinsic, el.crop),
    );
    rootEl.setAttribute("overflow", "hidden");
  }
  applyOverrides(
    rootEl as unknown as globalThis.Element,
    overrides as Parameters<typeof applyOverrides>[1],
    el.id,
    prepared.manifest,
  );
  compensatePtTrue(rootEl as unknown as globalThis.Element, {
    elW: el.width,
    elH: el.height,
    crop: el.crop ?? null,
    contentScale: el.contentScale,
    intrinsic,
  });
  return (rootEl as unknown as { toString(): string }).toString();
}

/** render-figure → a standalone SVG string (reuses the GUI's figureToSvg). For
 *  semantic plots the per-part overrides are baked in (faithful to the GUI);
 *  image/svg assets are inlined as data URLs. */
export async function renderFigureSvg(root: string, id: string): Promise<string> {
  const index = await readFigIndex(root);
  if (!index) throw new Error("no fig/index.json (run `flux reindex` or open the project once)");
  const { byId } = await readCanvasFiles(root, index);
  const fig = byId[id];
  if (!fig) throw new Error(`figure not found: ${id}`);
  // Same migration every loader runs (legacy type:"svg" → semantic plot, …):
  // this reads canvas files directly, so unmigrated on-disk docs must still
  // render through the current element union. The pseudo-project also feeds
  // ops.assetDisplaySize below (crop rendering for <image>-backed elements),
  // so its assets keep the pHYs dpi.
  const renderProject: Project = {
    version: 2,
    name: "",
    canvases: [],
    figures: [fig],
    assets: (index.assets ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      kind: a.kind,
      path: a.path ?? "",
      naturalWidth: a.naturalWidth ?? 0,
      naturalHeight: a.naturalHeight ?? 0,
      ...(a.dpi != null ? { dpi: a.dpi } : {}),
    })),
    palette: [],
  };
  migrateProject(renderProject);

  const assetCache: Record<string, string> = {};
  const assetPath: Record<string, string> = {};
  for (const a of index.assets ?? []) {
    if (!a.path) continue;
    assetPath[a.id] = a.path;
    const ap = j(root, "fig", a.path);
    if (await exists(ap)) {
      const bytes = await fs.readFile(ap);
      assetCache[a.id] = `data:${mimeFor(a.kind)};base64,${bytes.toString("base64")}`;
    }
  }

  // Build faithful inline markup for each semantic plot element.
  const plotMarkup = new Map<string, string>();
  const plots = fig.elements.filter((e) => e.type === "plot");
  if (plots.length) {
    await ensureDom();
    for (const el of plots) {
      const rel = assetPath[(el as { assetId: string }).assetId];
      if (!rel) continue;
      const svgText = await fs.readFile(j(root, "fig", rel), "utf8").catch(() => null);
      if (!svgText) continue;
      let manifest: FluxPlotManifest | undefined;
      // Prefer the asset-local sidecar (always in-root, written on import/save) —
      // then fall back to the original source manifest for older projects. AGT-11:
      // source.manifestPath can point outside root (plot imported from elsewhere),
      // where safeJoin throws; the asset-local copy avoids that entirely.
      const aid = (el as { assetId?: string }).assetId;
      if (aid) {
        try {
          manifest = JSON.parse(await fs.readFile(j(root, "fig", "assets", `${aid}.fluxplot.json`), "utf8")) as FluxPlotManifest;
        } catch {
          /* no asset-local sidecar — try the source manifest below */
        }
      }
      const src = (el as { source?: { manifestPath?: string } }).source;
      if (!manifest && src?.manifestPath) {
        try {
          manifest = JSON.parse(await fs.readFile(safeJoin(root, src.manifestPath), "utf8")) as FluxPlotManifest;
        } catch {
          /* manifest optional (leaf-id overrides still apply) */
        }
      }
      const markup = buildPlotMarkup(
        svgText,
        el as Element & { id: string; x: number; y: number; width: number; height: number },
        (el as { overrides?: Record<string, unknown> }).overrides,
        manifest,
      );
      if (markup) plotMarkup.set(el.id, markup);
    }
  }

  return figureToSvg(
    fig,
    (aid) => assetCache[aid],
    (e) => plotMarkup.get(e.id),
    // Crop rendering for <image>-backed elements: same intrinsic-size source
    // as the GUI (assetDisplaySize over the index's asset dims + dpi).
    (aid) => ops.assetDisplaySize(renderProject, aid) ?? undefined,
  );
}

/** render-figure → a rasterized PNG (resvg-js; no browser). `scale` is a zoom
 *  factor over the figure's world units (default 2 ≈ 144dpi). */
export async function renderFigurePng(root: string, id: string, scale = 2): Promise<Buffer> {
  const svg = await renderFigureSvg(root, id);
  const { Resvg } = await import("@resvg/resvg-js");
  const r = new Resvg(svg, { fitTo: { mode: "zoom", value: scale } });
  return Buffer.from(r.render().asPng());
}

/** set-caption: store the caption in the figure's canvas model (its true home) and
 *  emit the derived fig/captions/<id>.md + index cache. */
export async function setCaption(root: string, figId: string, md: string): Promise<void> {
  const trimmed = md.trim();
  await mutateFigModel(root, "set_caption", async ({ project, index }) => {
    const fig = project.figures.find((f) => f.id === figId);
    if (!fig) throw new Error(`no figure "${figId}"`);
    // AGT-2: the caption's true home is Figure.captions in the canvas file — the
    // single source composeCaption() reads. Writing only fig/captions/<id>.md (as
    // before) let the GUI's next save recompose from an empty captions map and
    // silently wipe the agent's caption. Store it in the __figure__ block so the
    // GUI reproduces it; still emit the derived .md + index cache for tools that
    // read only those.
    fig.captions = { ...(fig.captions ?? {}), __figure__: trimmed };
    const composed = composeCaption(fig);
    await writeText(safeJoin(root, `fig/captions/${figId}.md`), composed ? composed + "\n" : "");
    const entry = index.figures.find((x) => x.id === figId);
    if (entry) entry.caption = composed.trim();
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

/** add-panel: import an SVG file as a panel on a figure. EVERY svg is a
 *  semantic plot (figure-v1 P4): a .fluxplot.json sidecar supplies the real
 *  manifest; a vanilla file gets a DERIVED one at render/cache time. */
export async function addPanel(
  root: string,
  figId: string,
  svgFile: string,
  opts: { x?: number; y?: number; width?: number; height?: number } = {},
): Promise<{ assetId: string; elementId: string }> {
  return mutateFigModel(root, "add_panel", async ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const { assetId, w, h, source } = await importPlotAsset(root, project, svgFile);
    const box = { x: opts.x ?? 20, y: opts.y ?? 20, width: opts.width ?? w, height: opts.height ?? h };
    const elementId = ops.addPlotPanel(project, figId, {
      assetId,
      source: source ?? { svgPath: path.relative(root, path.resolve(svgFile)) },
      ...box,
    })!;
    return { assetId, elementId };
  });
}

/** import-plots: batch-import N SVG plots onto an EXISTING figure — the headless
 *  mirror of the GUI's Alt+I multi-insert (Ctrl+Enter in the Plot Importer). Each
 *  file resolves its FluxPlot sidecars (semantic when X.fluxplot.json exists) and
 *  lands at TRUE physical size (never fit-scaled). Placement mirrors the GUI's
 *  io.placeIncoming exactly: one plot centers in the frame; several pack at real
 *  size into the figure's largest empty region via the same gridLayout/emptyRegion.
 *  (compose-figure builds a NEW figure instead.) */
export async function importPlots(
  root: string,
  figId: string,
  plotPaths: string[],
): Promise<{ panels: { assetId: string; elementId: string }[] }> {
  if (!plotPaths.length) throw new Error("import-plots needs at least one plot");
  // AGT-12 pattern: pre-flight EVERY input before writing any asset, so a bad
  // path partway through can't leave earlier plots' asset files orphaned.
  for (const pp of plotPaths) {
    try {
      await fs.access(pp, fs.constants.R_OK);
    } catch {
      throw new Error(`import-plots: plot not readable: ${pp}`);
    }
  }
  return mutateFigModel(root, "import_plots", async ({ project }) => {
    const fig = ops.figById(project, figId);
    if (!fig) throw new Error(`figure not found: ${figId}`);
    const infos: Awaited<ReturnType<typeof importPlotAsset>>[] = [];
    // Compute the batch placement BEFORE appending elements (occupied = what the
    // figure already holds), exactly like the GUI's placeIncoming/autoArrange.
    const occupied = unionRect(fig.elements.map(elementBBox));
    for (const pp of plotPaths) infos.push(await importPlotAsset(root, project, pp));
    let placed: { x: number; y: number; w: number; h: number }[];
    if (infos.length === 1) {
      const it = infos[0];
      placed = [{ x: (fig.width - it.w) / 2, y: (fig.height - it.h) / 2, w: it.w, h: it.h }];
    } else {
      const minDim = Math.min(fig.width, fig.height);
      const margin = minDim * 0.04;
      const gap = minDim * 0.02;
      const inner = { x: margin, y: margin, w: fig.width - 2 * margin, h: fig.height - 2 * margin };
      const region = emptyRegion(inner, occupied, minDim * 0.03);
      // Tall/narrow plots → side by side in a row; wide plots → stacked (same
      // mean-aspect rule as the GUI's autoArrange).
      const aspects = infos.map((it) => (it.h > 0 ? it.w / it.h : 1));
      const meanAspect = aspects.reduce((a, b) => a + b, 0) / aspects.length;
      placed = gridLayout(infos.map((it) => ({ w: it.w, h: it.h })), region, gap, meanAspect < 1 ? "rows" : "cols");
    }
    const panels: { assetId: string; elementId: string }[] = [];
    infos.forEach((it, i) => {
      const box = { x: placed[i].x, y: placed[i].y, width: placed[i].w, height: placed[i].h };
      // figure-v1 P4 parity: EVERY svg is a semantic plot (the GUI derives a
      // manifest for sidecar-less files at cachePlot; headless render derives
      // inside preparePlot) — vanilla svgs must not fall back to <image>.
      const elementId = ops.addPlotPanel(project, figId, {
        assetId: it.assetId,
        source: it.source ?? { svgPath: path.relative(root, path.resolve(plotPaths[i])) },
        ...box,
      });
      if (elementId) panels.push({ assetId: it.assetId, elementId });
    });
    return { panels };
  });
}

/** create-figure: add a blank figure (optional slug id, canvas, size). */
export async function createFigure(
  root: string,
  opts: { id?: string; name?: string; canvasId?: string; width?: number; height?: number; background?: string } = {},
): Promise<{ figureId: string }> {
  return mutateFigModel(root, "create_figure", ({ project }) => {
    let canvasId = opts.canvasId ? safeId("canvas", opts.canvasId) : project.canvases[0]?.id;
    if (!canvasId) {
      canvasId = `canvas_${Date.now().toString(36)}`;
      project.canvases.push({ id: canvasId, name: "Canvas 1" });
    }
    const fig = ops.createFigure(project, {
      canvasId,
      id: opts.id ? safeId("figure", opts.id) : undefined,
      name: opts.name,
      width: opts.width,
      height: opts.height,
      background: opts.background,
    });
    return { figureId: fig.id };
  });
}

export interface ComposeFigureOpts {
  /** figure slug/id (→ `@fig-<id>`); default derived from name / first plot. */
  id?: string;
  name?: string;
  canvasId?: string;
  rows?: number;
  cols?: number;
  gap?: number;
  /** add panel labels + auto-letter (default true when >1 panel). */
  label?: boolean;
  /** write a fig/captions/<id>.md stub (default true). */
  captionStub?: boolean;
  /** padding around the grid, in world units (default 48). */
  margin?: number;
}

/** compose-figure (the flagship intent verb): assemble N plots into a single
 *  labeled multi-panel figure — import each plot, grid-arrange, auto-letter, and
 *  write a caption stub. Reuses the GUI's pure ops/geometry/captions so it is
 *  identical to building the figure by hand. */
export async function composeFigure(
  root: string,
  plotPaths: string[],
  opts: ComposeFigureOpts = {},
): Promise<{ figureId: string; panels: string[]; width: number; height: number }> {
  if (!plotPaths.length) throw new Error("compose-figure needs at least one plot");
  // AGT-12: pre-flight EVERY input before writing any asset. Previously a bad path
  // partway through the loop left the earlier plots' asset files orphaned on disk (the
  // model save never happened). Fail up front so a botched compose writes nothing.
  for (const pp of plotPaths) {
    try {
      await fs.access(pp, fs.constants.R_OK);
    } catch {
      throw new Error(`compose-figure: plot not readable: ${pp}`);
    }
  }
  const out = await mutateFigModel(root, "compose_figure", async ({ project }) => {
    let canvasId = opts.canvasId ? safeId("canvas", opts.canvasId) : project.canvases[0]?.id;
    if (!canvasId) {
      canvasId = `canvas_${Date.now().toString(36)}`;
      project.canvases.push({ id: canvasId, name: "Canvas 1" });
    }
    const first = plotPaths[0];
    const baseName = opts.name || path.basename(first, path.extname(first)) || "figure";
    const figId = opts.id ? safeId("figure", opts.id) : slugify(baseName);
    const margin = opts.margin ?? 48;
    const fig = ops.createFigure(project, { canvasId, id: figId, name: opts.name ?? figId, width: 100, height: 100 });

    const panelIds: string[] = [];
    for (const pp of plotPaths) {
      const { assetId, w, h, source } = await importPlotAsset(root, project, pp);
      const box = { x: margin, y: margin, width: w, height: h };
      // figure-v1 P4 parity: EVERY svg is a semantic plot — vanilla files get a
      // derived manifest at render/cache time, never an opaque <image>.
      const pid = ops.addPlotPanel(project, fig.id, {
        assetId,
        source: source ?? { svgPath: path.relative(root, path.resolve(pp)) },
        ...box,
      });
      if (pid) panelIds.push(pid);
    }

    ops.arrangePanels(project, fig.id, { cols: opts.cols, rows: opts.rows, gap: opts.gap, ids: panelIds });

    if (opts.label !== false && panelIds.length > 1) {
      for (const pid of panelIds) {
        const el = fig.elements.find((e) => e.id === pid);
        if (!el) continue;
        const b = elementBBox(el);
        // 8 pt bold (32/3 canvas px) — the journal-standard panel-letter size.
        ops.addPanelLabel(project, fig.id, { text: "?", x: b.x, y: Math.max(0, b.y - 16), fontSize: 32 / 3 });
      }
      ops.autoLetterPanels(project, fig.id);
    }

    const bb = unionRect(fig.elements.map(elementBBox));
    if (bb) {
      ops.setFigureLayout(project, fig.id, {
        width: Math.ceil(bb.x + bb.w + margin),
        height: Math.ceil(bb.y + bb.h + margin),
      });
    }

    return {
      figureId: fig.id,
      panels: panelLetters(fig),
      width: fig.width,
      height: fig.height,
      stub: composeCaption(fig) || `${opts.name ?? figId}.`,
    };
  });

  if (opts.captionStub !== false) await setCaption(root, out.figureId, out.stub);
  return { figureId: out.figureId, panels: out.panels, width: out.width, height: out.height };
}

/** arrange a figure's existing panels into a grid (rows|cols|gap). */
export async function arrangeFigure(
  root: string,
  figId: string,
  opts: { rows?: number; cols?: number; gap?: number } = {},
): Promise<void> {
  await mutateFigModel(root, "arrange", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.arrangePanels(project, figId, opts);
  });
}

/** proportionally scale elements (Feature 5) about a pivot (default = their bbox
 *  centre) by `factor`, scaling geometry AND stroke/corner/font weights together. */
export async function scaleElements(
  root: string,
  ids: string[],
  factor: number,
  pivot?: { x: number; y: number },
): Promise<void> {
  await mutateFigModel(root, "scale", ({ project }) => {
    ops.scaleElements(project, ids, factor, pivot);
  });
}

/** duplicate elements (Feature 4) within their figure, `count` times, each stamp
 *  offset by k·(dx,dy) with fresh element/group ids. Returns the last stamp's ids. */
export async function duplicateElements(
  root: string,
  figId: string,
  ids: string[],
  opts: { dx?: number; dy?: number; count?: number } = {},
): Promise<{ ids: string[] }> {
  return mutateFigModel(root, "duplicate", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    return { ids: ops.duplicateElements(project, figId, ids, opts) };
  });
}

/** set a figure's ruler guides (Feature 11) — figure-local guide lines that
 *  elements snap to. Either axis omitted → cleared. Lay down a column grid or
 *  baseline set programmatically; the GUI shows + snaps to them. */
export async function setGuides(
  root: string,
  figId: string,
  guides: { x?: number[]; y?: number[] },
): Promise<void> {
  await mutateFigModel(root, "set_guides", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.setGuides(project, figId, guides);
  });
}

/** distribute a figure's elements along an axis. With `gap`, place them at an
 *  EXACT edge-to-edge gap (anchored on the first); without, equalize the spacing
 *  between the outermost items (needs ≥3). `ids` restricts the set (default all). */
export async function distributeFigure(
  root: string,
  figId: string,
  axis: "h" | "v",
  gap?: number,
  ids?: string[],
): Promise<void> {
  await mutateFigModel(root, "distribute", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.distributePanels(project, figId, axis, ids, gap);
  });
}

/** reorder one element to an absolute z-index within its figure (0 = bottom). */
export async function reorderElement(
  root: string,
  figId: string,
  id: string,
  toIndex: number,
): Promise<void> {
  await mutateFigModel(root, "reorder", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.reorderElement(project, figId, id, toIndex);
  });
}

/** rotate elements by `deltaDeg` about a pivot (default = selection bbox centre). */
export async function rotateElements(
  root: string,
  ids: string[],
  deltaDeg: number,
  pivot?: { x: number; y: number },
): Promise<void> {
  await mutateFigModel(root, "rotate", ({ project }) => {
    ops.rotateElements(project, ids, deltaDeg, pivot);
  });
}

/** add a vector path (Feature 1 pen) to a figure from an editable node list.
 *  Mirrors the GUI pen / bridge add_path — the node list is normalized + the bbox
 *  fitted by ops.addPath, and the path renders/exports identically. */
export async function addPath(
  root: string,
  figId: string,
  opts: { nodes: VectorNode[]; closed?: boolean; fill?: string; stroke?: string; strokeWidth?: number },
): Promise<{ id: string }> {
  return mutateFigModel(root, "add_path", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const id = ops.addPath(project, figId, opts);
    if (!id) throw new Error("add-path: need ≥2 nodes");
    return { id };
  });
}

/** replace a path's nodes and/or closed flag (Feature 1 node-edit). Adopts a
 *  legacy d-only path into nodes first, so any path stays editable. */
export async function editPath(
  root: string,
  id: string,
  patch: { nodes?: VectorNode[]; closed?: boolean },
): Promise<{ id: string }> {
  return mutateFigModel(root, "edit_path", ({ project }) => {
    ops.updatePath(project, id, patch);
    return { id };
  });
}

/** auto-letter a figure's panel-label elements (a, b, c…) by reading order. */
export async function autoLabel(root: string, figId: string): Promise<{ panels: string[] }> {
  return mutateFigModel(root, "auto_label", ({ project }) => {
    const fig = ops.figById(project, figId);
    if (!fig) throw new Error(`figure not found: ${figId}`);
    ops.autoLetterPanels(project, figId);
    return { panels: panelLetters(fig) };
  });
}

/** Read a plot element's semantic manifest — sidecar-first (fig/assets/<id>.fluxplot.json,
 *  the W9 round-trip location), then the provenance source.manifestPath. Returns null for
 *  opaque images or when no manifest is on disk. */
async function readPlotManifest(root: string, el: Element): Promise<FluxPlotManifest | null> {
  const aid = (el as { assetId?: string }).assetId;
  if (aid) {
    try {
      return JSON.parse(
        await fs.readFile(j(root, "fig", "assets", `${aid}.fluxplot.json`), "utf8"),
      ) as FluxPlotManifest;
    } catch {
      /* fall through to source */
    }
  }
  const src = (el as { source?: { manifestPath?: string } }).source;
  if (src?.manifestPath) {
    try {
      return JSON.parse(await fs.readFile(safeJoin(root, src.manifestPath), "utf8")) as FluxPlotManifest;
    } catch {
      /* no manifest reachable */
    }
  }
  return null;
}

/** Every addressable part id in a manifest: the flat leaf ids (buildPartIndex) plus
 *  every node/group id in the parts tree. Used to reject typo'd partIds (AGT-13). */
function addressablePartIds(m: FluxPlotManifest): Set<string> {
  const ids = new Set<string>(Object.keys(buildPartIndex(m)));
  const walk = (n: { id?: string; ref?: string; members?: string[]; children?: unknown[] } | undefined) => {
    if (!n) return;
    if (n.id) ids.add(n.id);
    if (n.ref) ids.add(n.ref);
    for (const mem of n.members ?? []) ids.add(mem);
    for (const c of (n.children ?? []) as (typeof n)[]) walk(c);
  };
  walk(m.parts as never);
  return ids;
}

/** restyle a semantic-plot part/series by stable id (e.g. "control.line" or the
 *  group "control"). Writes an override that survives regeneration. If elementId
 *  is omitted and the figure has exactly one plot panel, that panel is used. */
export async function setPartOverride(
  root: string,
  figId: string,
  partId: string,
  patch: PartOverride,
  elementId?: string,
): Promise<{ elementId: string }> {
  return mutateFigModel(root, "restyle_part", async ({ project }) => {
    const fig = ops.figById(project, figId);
    if (!fig) throw new Error(`figure not found: ${figId}`);
    let elId = elementId;
    if (!elId) {
      const plots = fig.elements.filter((e) => e.type === "plot");
      if (plots.length !== 1) throw new Error(`figure ${figId} has ${plots.length} plot panels; pass elementId`);
      elId = plots[0].id;
    }
    // AGT-13: reject typo'd partIds instead of silently writing an inert override.
    const el = fig.elements.find((e) => e.id === elId);
    if (el) {
      const manifest = await readPlotManifest(root, el);
      if (manifest) {
        const valid = addressablePartIds(manifest);
        if (valid.size && !valid.has(partId)) {
          const known = [...valid].sort();
          const shown = known.slice(0, 40).join(", ");
          throw new Error(
            `unknown part "${partId}" on ${figId}. ${known.length} known part(s): ${shown}` +
              (known.length > 40 ? `, … (+${known.length - 40} more)` : ""),
          );
        }
      }
    }
    ops.setPartOverride(project, elId, partId, patch);
    return { elementId: elId };
  });
}

/** set element-level style (fill/stroke/strokeWidth/opacity/color/font…) on ids.
 *  Text-metric patches invalidate the element's derived wrap cache inside
 *  ops.setElementStyle itself, so a headless edit can never leave stale lines
 *  behind — the GUI re-wraps on its next load/layout. */
export async function setElementStyle(
  root: string,
  ids: string[],
  patch: ops.ElementStylePatch,
): Promise<void> {
  await mutateFigModel(root, "set_style", ({ project }) => {
    ops.setElementStyle(project, ids, patch);
  });
}

/** set/clear an image/plot element's crop window (figure-v1 P5). Figma
 *  semantics via ops.setCrop: the content→canvas mapping is preserved (content
 *  pinned) — the element box follows the window; `null` resets to the full
 *  content at the current content scale. crop is in intrinsic content px
 *  (assetDisplaySize units). */
export async function setCrop(
  root: string,
  id: string,
  crop: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  await mutateFigModel(root, "set_crop", ({ project }) => {
    if (!ops.setCrop(project, id, crop)) throw new Error(`element not found (or not image/plot): ${id}`);
  });
}

// --- text system (figure-v1 P3): B/I/U toggle + named text styles ------------

/** toggle bold/italic/underline across text elements (all-on → off, else on). */
export async function toggleTextStyle(
  root: string,
  ids: string[],
  which: ops.TextToggle,
): Promise<void> {
  await mutateFigModel(root, "toggle_text_style", ({ project }) => {
    ops.toggleTextStyle(project, ids, which);
  });
}

/** add a text element to a figure (parity gap: every other create verb existed). */
export async function addFigText(
  root: string,
  figId: string,
  opts: { text: string } & ops.Box & ops.TextOpts,
): Promise<{ id: string }> {
  return mutateFigModel(root, "add_text", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const id = ops.addText(project, figId, opts);
    if (!id) throw new Error(`could not add text to ${figId}`);
    return { id };
  });
}

/** create a named text style (optionally snapshotting an element's look). */
export async function createTextStyle(
  root: string,
  def: { name: string; fromElementId?: string } & Partial<Omit<TextStyle, "id" | "name">>,
): Promise<{ style: TextStyle }> {
  return mutateFigModel(root, "create_text_style", ({ project }) => {
    if (def.fromElementId) {
      const st = ops.textStyleFromElement(project, def.fromElementId, def.name);
      if (!st) throw new Error(`text element not found: ${def.fromElementId}`);
      return { style: st };
    }
    const st = ops.createTextStyle(project, {
      name: def.name,
      fontFamily: def.fontFamily ?? "Arial",
      fontSize: def.fontSize ?? 28 / 3,
      fontWeight: def.fontWeight ?? 400,
      fontStyle: def.fontStyle ?? "normal",
      ...(def.underline != null ? { underline: def.underline } : {}),
      ...(def.lineHeight != null ? { lineHeight: def.lineHeight } : {}),
      ...(def.color != null ? { color: def.color } : {}),
      ...(def.align != null ? { align: def.align } : {}),
    });
    return { style: st };
  });
}

/** patch a named text style — re-applies to every linked element (live link).
 *  A `name` in the patch renames. */
export async function updateTextStyle(
  root: string,
  styleId: string,
  patch: Partial<Omit<TextStyle, "id">>,
): Promise<void> {
  await mutateFigModel(root, "update_text_style", ({ project }) => {
    if (!ops.textStyleById(project, styleId)) throw new Error(`text style not found: ${styleId}`);
    ops.updateTextStyle(project, styleId, patch);
  });
}

/** delete a named text style (linked elements keep their look, drop the link). */
export async function deleteTextStyle(root: string, styleId: string): Promise<void> {
  await mutateFigModel(root, "delete_text_style", ({ project }) => {
    if (!ops.textStyleById(project, styleId)) throw new Error(`text style not found: ${styleId}`);
    ops.deleteTextStyle(project, styleId);
  });
}

/** apply a named text style to text elements (sets defined props + styleId). */
export async function applyTextStyle(
  root: string,
  ids: string[],
  styleId: string,
): Promise<{ applied: number }> {
  return mutateFigModel(root, "apply_text_style", ({ project }) => {
    if (!ops.textStyleById(project, styleId)) throw new Error(`text style not found: ${styleId}`);
    return { applied: ops.applyTextStyle(project, ids, styleId) };
  });
}

/** list the project's named text styles (read-only). */
export async function listTextStyles(root: string): Promise<TextStyle[]> {
  const { project } = await loadFigModel(root);
  return project.textStyles ?? [];
}

/** The machine-global text-style library (<userData>/textstyles.json — the
 *  SAME file the Electron GUI reads/writes; fluxlib.userDataDir reproduces
 *  app.getPath("userData")). Definitions only; applying copies into a project. */
export async function listGlobalTextStyles(): Promise<TextStyle[]> {
  try {
    const p = j(fluxlib.userDataDir(), "textstyles.json");
    const parsed = JSON.parse(await fs.readFile(p, "utf8")) as { styles?: TextStyle[] };
    return Array.isArray(parsed?.styles) ? parsed.styles : [];
  } catch {
    return [];
  }
}

/** upsert a style (by id) into the machine-global library. */
export async function saveGlobalTextStyle(style: TextStyle): Promise<void> {
  const dir = fluxlib.userDataDir();
  const cur = await listGlobalTextStyles();
  const next = [...cur.filter((s) => s.id !== style.id), style];
  await fs.mkdir(dir, { recursive: true });
  await writeText(j(dir, "textstyles.json"), JSON.stringify({ schemaVersion: "0.1.0", styles: next }, null, 2) + "\n");
}

// --- W11 (AGT-6): figure verbs that existed as pure ops + live-bridge commands
// but had no flux-core/CLI/MCP wrapper — so a closed-app agent couldn't delete a
// wrong panel, align a column, group, etc. Thin mutateFigModel wrappers. ---

/** delete elements by id (across the active figures). */
export async function deleteElements(root: string, ids: string[]): Promise<void> {
  await mutateFigModel(root, "delete", ({ project }) => {
    ops.deleteElements(project, ids);
  });
}

/** delete a whole figure. Returns the id the GUI would activate next. */
export async function deleteFigure(root: string, figId: string): Promise<{ nextActiveId: string | null }> {
  return mutateFigModel(root, "delete_figure", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    return ops.deleteFigure(project, figId);
  });
}

/** duplicate a whole figure (fresh element/group ids). Returns the new figure id. */
export async function duplicateFigure(root: string, figId: string): Promise<{ figureId: string }> {
  return mutateFigModel(root, "duplicate_figure", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const id = ops.duplicateFigure(project, figId);
    if (!id) throw new Error(`could not duplicate ${figId}`);
    return { figureId: id };
  });
}

/** align a figure's elements (left/right/top/bottom/centerH/centerV). */
export async function alignFigure(
  root: string,
  figId: string,
  kind: "left" | "right" | "top" | "bottom" | "centerH" | "centerV",
  ids?: string[],
): Promise<void> {
  await mutateFigModel(root, "align", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.alignPanels(project, figId, kind, ids);
  });
}

/** group elements/whole top groups into one NAMED, nestable unit (P7 registry;
 *  members spliced z-contiguous). Returns the new group id. */
export async function groupElements(
  root: string,
  ids: string[],
  opts: { name?: string; parentId?: string } = {},
): Promise<{ groupId: string }> {
  return mutateFigModel(root, "group", ({ project }) => {
    const gid = ops.group(project, ids, opts);
    if (!gid) throw new Error("group needs ≥2 top-level units in the same figure");
    return { groupId: gid };
  });
}

/** ungroup: dissolve each id's TOP-level group (element ids) or the exact
 *  group (group ids) — members drop to the parent group or go loose. */
export async function ungroupElements(root: string, ids: string[]): Promise<void> {
  await mutateFigModel(root, "ungroup", ({ project }) => {
    ops.ungroup(project, ids);
  });
}

/** rename a registry group. */
export async function renameGroup(root: string, groupId: string, name: string): Promise<void> {
  await mutateFigModel(root, "rename_group", ({ project }) => {
    if (!ops.renameGroup(project, groupId, name)) throw new Error(`group not found: ${groupId}`);
  });
}

/** set a group's hidden/locked flags (the Layers panel group eye/padlock);
 *  members render/export via effectiveHidden, so hiding a group empties it
 *  from renderFigureSvg too. */
export async function setGroupState(
  root: string,
  groupId: string,
  patch: { hidden?: boolean; locked?: boolean },
): Promise<void> {
  await mutateFigModel(root, "set_group_state", ({ project }) => {
    if (!ops.setGroupState(project, groupId, patch)) throw new Error(`group not found: ${groupId}`);
  });
}

export interface GroupInfo {
  figureId: string;
  id: string;
  name: string;
  parentId?: string;
  hidden?: boolean;
  locked?: boolean;
  members: string[];
}

/** read-only: list the group registry (name/nesting/state + member ids, deep),
 *  across the project or one figure. */
export async function listGroups(root: string, figId?: string): Promise<{ groups: GroupInfo[] }> {
  const { project } = await loadFigModel(root);
  const figs = figId ? project.figures.filter((f) => f.id === figId) : project.figures;
  const groups: GroupInfo[] = figs.flatMap((f) =>
    Object.values(f.groups ?? {}).map((g) => ({
      figureId: f.id,
      id: g.id,
      name: g.name,
      ...(g.parentId ? { parentId: g.parentId } : {}),
      ...(g.hidden ? { hidden: true } : {}),
      ...(g.locked ? { locked: true } : {}),
      members: membersDeep(f, g.id).map((e) => e.id),
    })),
  );
  return { groups };
}

/** set a figure's frame (x/y/width/height/background/name). */
export async function setFigureLayout(
  root: string,
  figId: string,
  patch: { x?: number; y?: number; width?: number; height?: number; background?: string; name?: string },
): Promise<void> {
  await mutateFigModel(root, "set_figure_layout", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.setFigureLayout(project, figId, patch);
  });
}

/** change elements' z-order within their figure (front/back/forward/backward). */
export async function setZOrder(
  root: string,
  figId: string,
  ids: string[],
  where: ops.ZOrder,
): Promise<void> {
  await mutateFigModel(root, "set_z", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.setZOrder(project, figId, ids, where);
  });
}

/** new: scaffold a minimal Flux project on disk. */
export async function scaffold(
  root: string,
  opts: { title?: string; author?: string } = {},
): Promise<void> {
  // AGT-15: the tree is built by the ONE shared source (src/lib/project/scaffoldTree)
  // consumed identically by the GUI, so `flux new` and app-New can never drift again
  // (the CLI used to write a different manifest, an empty fig index, and no
  // _quarto.yml/README while its manifest pointed at one).
  const title = opts.title ?? path.basename(root);
  const tree = buildScaffoldTree({ title, author: opts.author }, slideOps.createDeck({ title }));
  for (const d of tree.dirs) await fs.mkdir(j(root, d), { recursive: true });
  for (const [rel, text] of tree.files) await writeText(safeJoin(root, rel), text);
  // Guarantee the machine-global FluxLib exists; the project's library.bib starts
  // empty and fills via the cited-subset model as references are added/cited.
  await fluxlib.ensureFluxLib();
}

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
export async function citeDoi(root: string, doi: string): Promise<{ bibtex: string; keys: string[] }> {
  const { clean, bibtex } = await fetchDoiBibtex(doi);
  const res = await fluxlib.addToFluxLib(bibtex, { source: "doi" });
  await fluxlib.materializeIntoProject(root, res.keys);
  await journal(root, { action: "cite_doi", doi: clean, keys: res.keys });
  return { bibtex, keys: res.keys };
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

/** Reconcile a project's cited-subset library.bib against FluxLib (on open / on
 *  demand): promote project-local-only cited entries up, materialize the rest,
 *  report orphans. Non-destructive. */
export async function reconcile(
  root: string,
): Promise<{ materialized: string[]; promoted: string[]; orphans: string[] }> {
  return fluxlib.reconcileProject(root);
}

/** Write fig/renders/<id>.svg for every figure embedded in `docPath` (or every project
 *  figure when the doc can't be read). Quarto reads these from DISK — the GUI preview
 *  and in-app PDF inline from memory, so nothing else keeps renders/ fresh (gitignored
 *  derived state; W8 deliberately keeps MB-scale renders off the autosave path). */
export async function materializeRenders(
  root: string,
  docPath?: string,
): Promise<{ wrote: number; failed: string[] }> {
  const failed: string[] = [];
  let wrote = 0;
  const index = await readFigIndex(root);
  if (!index) return { wrote, failed };
  const known = new Set(index.figures.map((f) => f.id));
  let ids = new Set<string>(known);
  if (docPath) {
    try {
      const src = await fs.readFile(safeJoin(root, docPath), "utf8");
      const embedded = new Set<string>();
      const re = /^\s*!\[.*?\]\(([^)]*)\)\{#(fig-[A-Za-z0-9_-]+)[^}]*\}\s*$/;
      for (const line of src.split("\n")) {
        const m = re.exec(line);
        if (!m) continue;
        const fromPath = /fig\/renders\/([A-Za-z0-9_-]+)\.svg$/.exec(m[1]);
        if (fromPath && known.has(fromPath[1])) embedded.add(fromPath[1]);
      }
      if (embedded.size) ids = embedded;
    } catch {
      /* unreadable doc → render all known figures (safe superset) */
    }
  }
  await fs.mkdir(safeJoin(root, "fig/renders"), { recursive: true });
  for (const id of ids) {
    try {
      const svg = await renderFigureSvg(root, id);
      await atomicWrite(safeJoin(root, `fig/renders/${id}.svg`), svg);
      wrote++;
    } catch {
      failed.push(id);
    }
  }
  return { wrote, failed };
}

/** compile the manuscript via Quarto (pdf|html|docx). Requires `quarto` on PATH. */
export async function compile(root: string, to = "pdf"): Promise<{ code: number; log: string }> {
  const m = await loadManifest(root);
  // Figures embed as ../fig/renders/<id>.svg — materialize them so a bare quarto
  // render (agent/CI, no app open) gets real images instead of broken links.
  const renders = await materializeRenders(root, m.manuscript.path).catch(() => ({ wrote: 0, failed: [] as string[] }));
  const { code, log } = await new Promise<{ code: number; log: string }>((resolve, reject) => {
    const child = spawn("quarto", ["render", m.manuscript.path, "--to", to], { cwd: root });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", (e) => reject(new Error(`quarto not available: ${e.message}`)));
    child.on("close", (c) => resolve({ code: c ?? 0, log }));
  });
  await journal(root, { action: "compile", to, code });
  const note = renders.failed.length ? `\n(figure renders failed: ${renders.failed.join(", ")})` : "";
  return { code, log: log + note };
}

// --------------------------------------------------------------------------
// Review comments (the human's margin comments). Threads live in a sibling
// `comments.json` (main doc) / `<base>.comments.json` (other docs) — never in
// the .qmd (Principle 6). Mirrors src/shell/modes/paper/comments/comments.ts so
// an agent has first-class, journaled, lock-respecting access to the same file
// the GUI writes (the GUI editor is the authoring side; this is the read/resolve
// side). The anchor is a W3C-style TextQuoteSelector: `quote` (+ prefix/suffix)
// is the exact manuscript text a comment targets.
// --------------------------------------------------------------------------
export interface CommentMessage {
  author: string;
  body: string;
  createdAt: string;
}
export interface TextQuoteSelector {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}
export interface CommentThread {
  id: string;
  anchor: TextQuoteSelector;
  resolved: boolean;
  messages: CommentMessage[];
}
interface CommentsFile {
  version: 1;
  threads: CommentThread[];
}

/** The comments sidecar path (project-relative) for a document. The main
 *  manuscript keeps `comments.json`; other docs get `<base>.comments.json`. */
function commentsRel(m: ProjectManifest, docRel?: string): string {
  const mp = docRel ?? m.manuscript.path; // e.g. "manuscript/main.qmd"
  const dir = mp.includes("/") ? mp.slice(0, mp.lastIndexOf("/")) : "";
  const isMain = mp === m.manuscript.path;
  const base = mp.slice(mp.lastIndexOf("/") + 1).replace(/\.qmd$/, "");
  const name = isMain ? "comments.json" : `${base}.comments.json`;
  return dir ? `${dir}/${name}` : name;
}

/** list-comments: read a document's comment threads (defaults to the main .qmd).
 *  Returns all threads; the caller filters resolved vs. open. Empty if none. */
export async function listComments(root: string, docRel?: string): Promise<CommentThread[]> {
  const m = await loadManifest(root);
  const p = safeJoin(root, commentsRel(m, docRel));
  if (!(await exists(p))) return [];
  try {
    const data = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return [];
  }
}

export interface ResolveCommentResult {
  id: string;
  quote: string;
  resolved: number;
  total: number;
}

/** resolve-comment: mark a thread resolved — by its id, or by a substring of its
 *  quoted text (must match exactly one open thread). Optionally append a reply.
 *  Holds the `manuscript` lock (so it defers to a live human edit) + journals. */
export async function resolveComment(
  root: string,
  idOrQuote: string,
  opts: { docRel?: string; note?: string; author?: string } = {},
): Promise<ResolveCommentResult> {
  const m = await loadManifest(root);
  const rel = commentsRel(m, opts.docRel);
  const p = safeJoin(root, rel);
  if (!(await exists(p))) throw new Error(`no comments file: ${rel}`);
  let file: CommentsFile;
  try {
    file = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
  } catch {
    throw new Error(`comments file is not valid JSON: ${rel}`);
  }
  const threads = Array.isArray(file.threads) ? file.threads : [];
  let thread = threads.find((t) => t.id === idOrQuote);
  if (!thread) {
    const needle = idOrQuote.toLowerCase();
    const hits = threads.filter((t) => (t.anchor?.quote ?? "").toLowerCase().includes(needle));
    if (hits.length === 0) throw new Error(`no comment matches "${idOrQuote}" in ${rel}`);
    if (hits.length > 1)
      throw new Error(
        `"${idOrQuote}" matches ${hits.length} comments; use the thread id (one of: ${hits.map((t) => t.id).join(", ")})`,
      );
    thread = hits[0];
  }
  thread.resolved = true;
  if (opts.note) {
    thread.messages = thread.messages ?? [];
    thread.messages.push({ author: opts.author ?? CLIENT, body: opts.note, createdAt: stamp() });
  }
  const out: CommentsFile = { version: 1, threads };
  await withLock(root, "manuscript", CLIENT, async () => {
    await writeText(p, JSON.stringify(out, null, 2) + "\n");
  });
  await journal(root, { action: "resolve_comment", target: rel, thread: thread.id });
  return {
    id: thread.id,
    quote: thread.anchor?.quote ?? "",
    resolved: threads.filter((t) => t.resolved).length,
    total: threads.length,
  };
}

// --------------------------------------------------------------------------
// WS2: JSON schemas + validation. The bundled schemas (schemas.ts) are the
// machine contract; `writeSchemas` ships them in-project (.meta/schema/) and
// `validate` checks an agent's writes against them.
// --------------------------------------------------------------------------
export async function writeSchemas(root: string): Promise<void> {
  const dir = j(root, ".meta", "schema");
  for (const [key, schema] of Object.entries(SCHEMAS)) {
    await atomicWrite(
      j(dir, SCHEMA_FILENAMES[key as keyof typeof SCHEMAS]),
      JSON.stringify(schema, null, 2) + "\n",
    );
  }
}

export interface ValidateResult {
  ok: boolean;
  checked: number;
  errors: string[];
}

/** Validate the whole project (or one file) against the bundled JSON Schemas. */
export async function validate(root: string, file?: string): Promise<ValidateResult> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const errors: string[] = [];
  let checked = 0;
  const check = (key: keyof typeof SCHEMAS, rel: string, data: unknown) => {
    checked++;
    const v = ajv.compile(SCHEMAS[key]);
    if (!v(data)) for (const e of v.errors ?? []) errors.push(`${rel}: ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);
  };
  const readRel = async (rel: string) => JSON.parse(await fs.readFile(safeJoin(root, rel), "utf8"));

  if (file) {
    const key = schemaForFile(file);
    if (!key) throw new Error(`no schema known for ${file}`);
    check(key, file, await readRel(file));
    return { ok: errors.length === 0, checked, errors };
  }

  if (await exists(j(root, "project.json"))) check("project", "project.json", await readRel("project.json"));
  const idx = await readFigIndex(root);
  if (idx) {
    check("figIndex", "fig/index.json", idx);
    for (const cm of idx.canvases ?? []) {
      const rel = `fig/canvases/${cm.id}.json`;
      if (await exists(safeJoin(root, rel))) check("canvas", rel, await readRel(rel));
    }
  }
  // Decks (slides/<id>/deck.json) — validate every deck registered in the manifest.
  try {
    const m = await loadManifest(root);
    for (const s of m.slides ?? []) {
      const rel = s.path ?? `slides/${s.id}/deck.json`;
      if (await exists(safeJoin(root, rel))) check("deck", rel, await readRel(rel));
    }
  } catch {
    /* no manifest — skip deck validation */
  }
  return { ok: errors.length === 0, checked, errors };
}

/** Validate a FluxPlot output (the WS7 contract): the manifest is schema-valid AND
 *  every svg id the manifest references actually exists in the .svg — i.e. the plot
 *  is genuinely part-addressable. This is what the external `fluxplot` lib targets. */
export async function validatePlot(svgPath: string): Promise<ValidateResult & { references: number; matched: number }> {
  const abs = path.resolve(svgPath);
  const manifestPath = abs.replace(/\.svg$/i, ".fluxplot.json");
  const errors: string[] = [];
  if (!(await exists(manifestPath))) {
    return { ok: false, checked: 0, references: 0, matched: 0, errors: [`missing manifest sidecar ${path.basename(manifestPath)}`] };
  }
  const svg = await fs.readFile(abs, "utf8");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FluxPlotManifest;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const v = ajv.compile(SCHEMAS.manifest);
  if (!v(manifest)) for (const e of v.errors ?? []) errors.push(`manifest: ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);

  const referenced = Object.keys(buildPartIndex(manifest));
  let matched = 0;
  for (const id of referenced) {
    if (svg.includes(`id="${id}"`)) matched++;
    else errors.push(`manifest references id "${id}" but the SVG has no element with that id`);
  }
  return { ok: errors.length === 0, checked: 1, references: referenced.length, matched, errors };
}

// --------------------------------------------------------------------------
// F2 reproducibility: re-run a plot's recipe (the generating script + params)
// and capture the emitted SVG/manifest. v0 recipe contract (spec §11.3):
//   { command, args?, cwd?, params?, output, lastRun? }
// The script receives params both as `--key value` flags and as FLUX_PARAMS
// (JSON) in the environment, and is expected to write `output` (an .svg, with an
// optional `<base>.fluxplot.json` sidecar) relative to the recipe's dir.
// --------------------------------------------------------------------------
export interface RecipeRunResult {
  code: number;
  svgPath: string;
  manifestPath: string;
  stdout: string;
  stderr: string;
}

async function findProjectRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (await exists(path.join(dir, "project.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Append a provenance line to .meta/journal.ndjson.
 *  W2: O_APPEND (not read-whole-rewrite) — concurrent writers can no longer drop
 *  each other's entries and cost stays O(1); size-based rotation keeps it bounded. */
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
export async function journal(root: string, entry: Record<string, unknown>): Promise<void> {
  const p = j(root, ".meta", "journal.ndjson");
  await fs.mkdir(path.dirname(p), { recursive: true });
  try {
    const st = await fs.stat(p);
    if (st.size > JOURNAL_MAX_BYTES)
      await fs.rename(p, j(root, ".meta", `journal-${Date.now()}.ndjson`));
  } catch {
    /* no journal yet */
  }
  await fs.appendFile(p, JSON.stringify({ ts: stamp(), client: CLIENT, ...entry }) + "\n");
}

export async function runRecipe(
  recipePath: string,
  paramOverrides: Record<string, string | number | boolean> = {},
): Promise<RecipeRunResult> {
  const recipe = await readJSON<{
    command: string;
    args?: string[];
    cwd?: string;
    params?: Record<string, unknown>;
    output: string;
    lastRun?: string;
  }>(recipePath);
  if (!recipe.command) throw new Error("recipe has no `command`");
  const dir = path.dirname(recipePath);
  const params = { ...(recipe.params ?? {}), ...paramOverrides };
  const args = [...(recipe.args ?? [])];
  for (const [k, v] of Object.entries(params)) args.push(`--${k}`, String(v));
  const cwd = path.resolve(dir, recipe.cwd ?? ".");

  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(recipe.command, args, {
        cwd,
        env: { ...process.env, FLUX_PARAMS: JSON.stringify(params) },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c ?? 0, stdout: out, stderr: err }));
    },
  );

  // Persist the merged params + last-run time back to the recipe (provenance).
  recipe.params = params;
  recipe.lastRun = stamp();
  await writeText(recipePath, JSON.stringify(recipe, null, 2) + "\n");

  const out = recipe.output ? path.resolve(dir, recipe.output) : "";
  const root = await findProjectRoot(dir);
  if (root) await journal(root, { action: "rerun-plot", recipe: path.relative(root, recipePath), params, code });

  return {
    code,
    svgPath: out,
    manifestPath: out.replace(/\.svg$/, ".fluxplot.json"),
    stdout,
    stderr,
  };
}

/** Compose the canonical caption for a figure from its panel blocks (F7). */
export async function captionFor(root: string, figId: string): Promise<string> {
  const index = await readFigIndex(root);
  if (!index) return "";
  const { byId } = await readCanvasFiles(root, index);
  return byId[figId] ? composeCaption(byId[figId]) : "";
}

// --------------------------------------------------------------------------
// Flux Slide — the deck verbs (load/save/list/create/validate a deck). Defined
// in ./slides (which reuses safeJoin/journal/loadManifest/getClient above) and
// re-exported here so the CLI + MCP reach them through one flux-core surface.
// --------------------------------------------------------------------------
export {
  loadDeck,
  saveDeck,
  listDecks,
  createDeck,
  addSlide,
  validateDeck,
  gatherDeckPayload,
  exportDeck,
  // W11b — slide authoring (agent parity for the Slides pillar)
  deleteSlide,
  duplicateSlide,
  reorderSlides,
  setSlide,
  setDeckTheme,
  addTextToSlide,
  addMathToSlide,
  addEmbedFigureToSlide,
  addBeat,
  setAnimation,
  // Slides overhaul WS2 — timeline + part-control verbs
  setBeat,
  reorderBeats,
  moveTrack,
  duplicateTrack,
  reorderTracks,
  setTrackEnabled,
  setPartVisibility,
  setPartStyle,
  animatePartVerb,
  animateElementVerb,
  setMorph,
  type DeckSummary,
  type ValidateDeckResult,
} from "./slides";
