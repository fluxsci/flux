import { get } from "svelte/store";
import type {
  Asset,
  Figure,
  ImageElement,
  Project,
  SvgElement,
  SemanticPlotElement,
} from "./types";
import {
  project,
  projectDir,
  dirty,
  activeFigureId,
  selection,
  newId,
  commit,
  loadProject,
  embeddedProjectRoot,
} from "./store";
import { saveFigFrom } from "./project/figbridge";
import { unionRect, elementBBox } from "./geometry";
import { gridLayout, emptyRegion } from "./layout";
import {
  assetData,
  setAssetData,
  markAssetDirty,
  bytesToDataUrl,
  dataUrlToBytes,
  mimeFor,
  intrinsicSize,
} from "./assets";
import { figureToSvg } from "./export";
import { annotationsToMarkdown, type AnnotationMdMeta } from "./references/annotationsMarkdown";
import type { Annotation } from "./references/annotations";
import { encodeTiff } from "./figure/tiff";
import { injectPngDpi } from "./figure/pngDpi";
import { planExport, describeSize } from "./figure/journalSizing";
import { parseTokens } from "./colors";
import { cachePlot, clearPlots, plotManifests, plotRecipes } from "./plot/store";
import { plotToSvgMarkup } from "./plot/export";
import type { FluxPlotManifest } from "./plot/types";
import { pushToast, errMsg } from "./toast";

// Every user-initiated open/import/save/export below surfaces its failure as a
// toast (V1 review, W1) — these previously rejected silently into the void.

// F2 hot-swap: replace a plot's cached SVG/manifest/recipe in place for an
// EXISTING assetId (regenerate). The element + its id-keyed `overrides` are left
// untouched, so the re-mount reapplies them automatically (group overrides too);
// cachePlot bumps plotGen, which forces mountPlot to re-clone the new DOM.
export function reimportPlot(
  assetId: string,
  svgText: string,
  manifest: FluxPlotManifest,
  recipe?: unknown,
): boolean {
  const ok = cachePlot(assetId, svgText, manifest, recipe);
  setAssetData(assetId, bytesToDataUrl(new TextEncoder().encode(svgText), mimeFor("svg")));
  markAssetDirty(assetId); // W8: hot-swapped bytes → rewrite on next save
  return ok;
}

// ---------------------------------------------------------------------------
// Small path helpers (POSIX; the app targets Linux primarily).
// ---------------------------------------------------------------------------
function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
}
function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

// ---------------------------------------------------------------------------
// Import assets (PNG / SVG) into the active figure.
// ---------------------------------------------------------------------------
function kindOf(name: string): "png" | "svg" {
  return name.toLowerCase().endsWith(".svg") ? "svg" : "png";
}

interface Incoming {
  asset: Asset;
  el: ImageElement | SvgElement | SemanticPlotElement;
  natW: number;
  natH: number;
}

// Sidecars discovered next to an imported `X.svg`: the FluxPlot manifest
// (`X.fluxplot.json`) makes it a SEMANTIC plot rather than an opaque image.
interface Siblings {
  svgPath?: string;
  manifestPath?: string;
  recipePath?: string;
  manifestText?: string;
  recipeText?: string;
}

// Resolve sidecars from the filesystem by deterministic sibling path (the
// preload bridge has no readdir, but `X.svg` → `X.fluxplot.json` is fixed).
async function resolveSiblingsFromFs(absPath: string): Promise<Siblings> {
  if (!/\.svg$/i.test(absPath)) return {};
  const base = absPath.replace(/\.svg$/i, "");
  const manifestPath = `${base}.fluxplot.json`;
  const recipePath = `${base}.recipe.json`;
  const out: Siblings = { svgPath: absPath, manifestPath, recipePath };
  try {
    if (await window.fig.exists(manifestPath)) out.manifestText = await window.fig.readText(manifestPath);
  } catch {
    /* unreadable — treat as a plain svg */
  }
  if (out.manifestText) {
    try {
      if (await window.fig.exists(recipePath)) out.recipeText = await window.fig.readText(recipePath);
    } catch {
      /* recipe is optional */
    }
  }
  return out;
}

async function buildIncoming(
  name: string,
  bytes: Uint8Array,
  sib: Siblings = {},
): Promise<Incoming> {
  const kind = kindOf(name);
  const dataUrl = bytesToDataUrl(bytes, mimeFor(kind));
  const { width, height } = await intrinsicSize(dataUrl);
  const id = newId("asset");
  const asset: Asset = {
    id,
    name,
    kind,
    // W8: assign the deterministic on-disk path up front (assets/<id>.<kind>). The
    // save clones the store, so a path set only there never syncs back — meaning a
    // path-less asset would be rewritten every debounce. With the path fixed at
    // import, the dirty flag alone decides whether the bytes are (re)written.
    path: `assets/${id}.${kind}`,
    naturalWidth: width,
    naturalHeight: height,
  };
  setAssetData(asset.id, dataUrl); // also serves as the <image> fallback (spec P4)
  markAssetDirty(asset.id); // W8: newly imported bytes → write on next save

  // A semantic FluxPlot = an svg with a parseable manifest sidecar.
  if (kind === "svg" && sib.manifestText) {
    try {
      const manifest = JSON.parse(sib.manifestText) as FluxPlotManifest;
      const recipe = sib.recipeText ? JSON.parse(sib.recipeText) : undefined;
      cachePlot(asset.id, new TextDecoder().decode(bytes), manifest, recipe);
      const el: SemanticPlotElement = {
        type: "plot",
        id: newId("plot"),
        assetId: asset.id,
        x: 0,
        y: 0,
        width,
        height,
        rotation: 0,
        source: { svgPath: sib.svgPath ?? name, manifestPath: sib.manifestPath, recipePath: sib.recipePath },
        manifestRef: { specVersion: manifest.schemaVersion },
        overrides: {},
      };
      return { asset, el, natW: width, natH: height };
    } catch {
      /* malformed manifest — fall through to an opaque svg (graceful) */
    }
  }

  const el: ImageElement | SvgElement = {
    type: kind === "svg" ? "svg" : "image",
    id: newId(kind),
    assetId: asset.id,
    x: 0,
    y: 0,
    width,
    height,
    rotation: 0,
  };
  return { asset, el, natW: width, natH: height };
}

export async function importAssets() {
  try {
    const paths = await window.fig.openFiles([{ name: "Images", extensions: ["png", "svg"] }]);
    if (!paths || !paths.length) return;
    const incoming: Incoming[] = [];
    for (const path of paths) {
      const bytes = new Uint8Array(await window.fig.readFile(path));
      const sib = await resolveSiblingsFromFs(path);
      incoming.push(await buildIncoming(basename(path), bytes, sib));
    }
    placeIncoming(incoming);
  } catch (e) {
    pushToast("error", "Import failed", { detail: errMsg(e) });
  }
}

// Import a single plot/asset by absolute path (the Plot Importer, Alt+I). Reuses
// the same pipeline as importAssets so a FluxPlot svg arrives with its manifest +
// recipe sidecars resolved and placed in the active figure.
export async function importPlotFromPath(absPath: string) {
  if (!window.fig) return;
  try {
    const bytes = new Uint8Array(await window.fig.readFile(absPath));
    const sib = await resolveSiblingsFromFs(absPath);
    placeIncoming([await buildIncoming(basename(absPath), bytes, sib)]);
  } catch (e) {
    pushToast("error", "Plot import failed", { detail: `${basename(absPath)}: ${errMsg(e)}` });
  }
}

// Files dropped from the OS file explorer onto a specific figure. A dropped svg
// is paired with a dropped `*.fluxplot.json` (+ `*.recipe.json`) of the same
// base name → it imports as a semantic plot. (Drops are sandboxed Files with no
// filesystem path, so we can only pair what was dropped together.)
export async function importDroppedFiles(files: File[], figId: string) {
  const all = [...files];
  const manifests = new Map<string, File>();
  const recipes = new Map<string, File>();
  for (const f of all) {
    const n = (f.name || "").toLowerCase();
    if (n.endsWith(".fluxplot.json")) manifests.set(f.name.slice(0, -".fluxplot.json".length), f);
    else if (n.endsWith(".recipe.json")) recipes.set(f.name.slice(0, -".recipe.json".length), f);
  }
  const accepted = all.filter(
    (f) => /\.(png|svg)$/i.test(f.name || "") || /(png|svg)/i.test(f.type),
  );
  if (!accepted.length) return;
  const incoming: Incoming[] = [];
  for (const file of accepted) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let sib: Siblings = {};
    if (/\.svg$/i.test(file.name || "")) {
      const base = (file.name || "").replace(/\.svg$/i, "");
      const mf = manifests.get(base);
      if (mf) {
        const rf = recipes.get(base);
        sib = {
          svgPath: file.name,
          manifestText: await mf.text(),
          recipeText: rf ? await rf.text() : undefined,
        };
      }
    }
    incoming.push(await buildIncoming(file.name || "image", bytes, sib));
  }
  placeIncoming(incoming, figId);
}

// Position incoming placements (one centered; many auto-arranged into a grid),
// then commit assets + elements and select the new group.
function placeIncoming(incoming: Incoming[], figId?: string) {
  if (!incoming.length) return;
  const p = get(project);
  const id = figId ?? get(activeFigureId) ?? p.figures[0]?.id;
  const fig = p.figures.find((f) => f.id === id);
  if (!fig) return;

  if (incoming.length === 1) {
    const it = incoming[0];
    const s = Math.min(1, (fig.width * 0.7) / it.natW, (fig.height * 0.7) / it.natH);
    it.el.width = it.natW * s;
    it.el.height = it.natH * s;
    it.el.x = (fig.width - it.el.width) / 2;
    it.el.y = (fig.height - it.el.height) / 2;
  } else {
    autoArrange(fig, incoming);
  }

  commit((proj) => {
    const f = proj.figures.find((ff) => ff.id === id);
    if (!f) return;
    for (const it of incoming) {
      proj.assets.push(it.asset);
      f.elements.push(it.el);
    }
  });
  if (id) activeFigureId.set(id);
  selection.set(new Set(incoming.map((it) => it.el.id)));
}

// Auto-arrange a group of plots: rows for wide plots, columns for tall ones,
// packed with spacing into the largest empty region of the figure.
function autoArrange(fig: Figure, incoming: Incoming[]) {
  const minDim = Math.min(fig.width, fig.height);
  const margin = minDim * 0.04;
  const gap = minDim * 0.02;
  const inner = {
    x: margin,
    y: margin,
    w: fig.width - 2 * margin,
    h: fig.height - 2 * margin,
  };
  const occupied = unionRect(fig.elements.map(elementBBox));
  const region = emptyRegion(inner, occupied, minDim * 0.03);

  // Tall/narrow plots → side by side in a horizontal row; wide plots → stacked
  // vertically. (Decided from the average aspect ratio.)
  const aspects = incoming.map((it) => (it.natH > 0 ? it.natW / it.natH : 1));
  const meanAspect = aspects.reduce((a, b) => a + b, 0) / aspects.length;
  const orientation = meanAspect < 1 ? "rows" : "cols";

  const sizes = incoming.map((it) => ({ w: it.natW, h: it.natH }));
  const placed = gridLayout(sizes, region, gap, orientation);
  incoming.forEach((it, i) => {
    const pl = placed[i];
    it.el.x = pl.x;
    it.el.y = pl.y;
    it.el.width = pl.w;
    it.el.height = pl.h;
  });
}

// ---------------------------------------------------------------------------
// Import a Figma / DTCG color-tokens JSON file as a named palette.
// ---------------------------------------------------------------------------
export async function importPalette() {
  const paths = await window.fig.openFiles([{ name: "Color tokens", extensions: ["json"] }]);
  if (!paths || !paths.length) return;
  const groups = parseTokens(JSON.parse(await window.fig.readText(paths[0])));
  if (!groups.length) throw new Error("No colors found in that file");
  commit((p) => {
    p.colorGroups = groups;
  });
}

// ---------------------------------------------------------------------------
// Save / open. A project is a directory: project.json + assets/<id>.<ext>.
// ---------------------------------------------------------------------------
export async function saveProject() {
  try {
    const root = get(embeddedProjectRoot);
    if (root) return await saveFigFrom(root); // embedded → the project's fig/ subsystem
    const dir = get(projectDir);
    if (!dir) return await saveProjectAs();
    await writeProjectTo(dir);
  } catch (e) {
    pushToast("error", "Save failed", { detail: errMsg(e) });
  }
}

export async function saveProjectAs() {
  const root = get(embeddedProjectRoot);
  if (root) return saveFigFrom(root); // embedded → no separate "save as"
  const p = get(project);
  const path = await window.fig.save(`${p.name || "Untitled"}.flux`, [
    { name: "Flux project", extensions: ["flux"] },
  ]);
  if (!path) return;
  await writeProjectTo(path);
  projectDir.set(path);
}

async function writeProjectTo(dir: string) {
  if (!(await window.fig.exists(dir))) await window.fig.mkdir(dir);
  await window.fig.mkdir(joinPath(dir, "assets"));

  const p = structuredClone(get(project));
  const data = get(assetData);
  const manifests = get(plotManifests);
  const recipes = get(plotRecipes);

  for (const asset of p.assets) {
    const url = data[asset.id];
    if (!url) continue;
    const rel = `assets/${asset.id}.${asset.kind}`;
    asset.path = rel;
    await window.fig.writeFile(joinPath(dir, rel), dataUrlToBytes(url));
    // Cache a semantic plot's sidecars alongside its bytes so the project stays
    // self-contained (the authoritative copy lives in the user's plots/ dir).
    const man = manifests[asset.id];
    if (man) {
      await window.fig.writeText(joinPath(dir, `assets/${asset.id}.fluxplot.json`), JSON.stringify(man, null, 2));
      const rec = recipes[asset.id];
      if (rec !== undefined)
        await window.fig.writeText(joinPath(dir, `assets/${asset.id}.recipe.json`), JSON.stringify(rec, null, 2));
    }
  }

  await window.fig.writeText(joinPath(dir, "project.json"), JSON.stringify(p, null, 2));
  dirty.set(false);
}

export async function openProject() {
  // When embedded in a Flux project, opening a separate Flux project is
  // disabled — the shell owns project open/close.
  if (get(embeddedProjectRoot)) return;
  try {
    const dir = await window.fig.openDirectory("Open Flux project");
    if (!dir) return;

    const jsonPath = joinPath(dir, "project.json");
    if (!(await window.fig.exists(jsonPath))) {
      throw new Error("Not a Flux project (no project.json)");
    }
    const p: Project = JSON.parse(await window.fig.readText(jsonPath));

    clearPlots();
    const fresh: Record<string, string> = {};
    for (const asset of p.assets) {
      if (!asset.path) continue;
      const bytes = new Uint8Array(await window.fig.readFile(joinPath(dir, asset.path)));
      fresh[asset.id] = bytesToDataUrl(bytes, mimeFor(asset.kind));
      // Re-attach a semantic plot's manifest (+ recipe) by assetId, so its inlined
      // rendering + part overrides (stored on the element) reconnect on reload.
      if (asset.kind === "svg") {
        const mpath = joinPath(dir, `assets/${asset.id}.fluxplot.json`);
        if (await window.fig.exists(mpath)) {
          const manifest = JSON.parse(await window.fig.readText(mpath)) as FluxPlotManifest;
          let recipe: unknown;
          const rpath = joinPath(dir, `assets/${asset.id}.recipe.json`);
          if (await window.fig.exists(rpath)) recipe = JSON.parse(await window.fig.readText(rpath));
          cachePlot(asset.id, new TextDecoder().decode(bytes), manifest, recipe);
        }
      }
    }
    assetData.set(fresh);
    loadProject(p, dir);
  } catch (e) {
    pushToast("error", "Couldn't open project", { detail: errMsg(e) });
  }
}

// ---------------------------------------------------------------------------
// Export a figure to SVG / PNG / PDF.
// ---------------------------------------------------------------------------
function buildSvg(fig: Figure): string {
  const data = get(assetData);
  return figureToSvg(
    fig,
    (id) => data[id],
    (el) => (el.type === "plot" ? (plotToSvgMarkup(el) ?? undefined) : undefined),
  );
}

// 3.2: save one paper's highlights/notes as a Markdown digest via the OS save dialog.
// Callers pass the already-loaded annotations + entry metadata (reader/library both have them).
export async function saveAnnotationsMarkdown(citekey: string, annotations: Annotation[], meta: AnnotationMdMeta = {}) {
  if (!annotations.length) {
    pushToast("info", "No highlights to export yet.");
    return;
  }
  const md = annotationsToMarkdown(citekey, annotations, { ...meta, exportedAt: new Date().toISOString().slice(0, 10) });
  const path = await window.fig.save(`${citekey}-notes.md`, [{ name: "Markdown", extensions: ["md"] }]);
  if (!path) return;
  try {
    await window.fig.writeText(path, md);
    pushToast("success", `Exported ${basename(path)}`);
  } catch (e) {
    pushToast("error", "Notes export failed", { detail: errMsg(e) });
  }
}

export async function exportFigureSvg(fig: Figure) {
  const path = await window.fig.save(`${fig.name}.svg`, [{ name: "SVG", extensions: ["svg"] }]);
  if (!path) return;
  try {
    await window.fig.writeText(path, buildSvg(fig));
    pushToast("success", `Exported ${basename(path)}`);
  } catch (e) {
    pushToast("error", "SVG export failed", { detail: errMsg(e) });
  }
}

// Rasterize a figure's SVG to an offscreen canvas at explicit pixel dimensions. When
// `transparent`, the background rect is dropped and the canvas keeps its alpha; otherwise
// it's flood-filled (the figure's background, or white) so the raster is opaque.
async function rasterizeFigure(fig: Figure, pxW: number, pxH: number, transparent: boolean): Promise<HTMLCanvasElement> {
  const svg = transparent ? buildSvg({ ...fig, background: "transparent" }) : buildSvg(fig);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Failed to render SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(pxW));
    canvas.height = Math.max(1, Math.round(pxH));
    const ctx = canvas.getContext("2d")!;
    if (!transparent) {
      ctx.fillStyle = fig.background && fig.background !== "transparent" ? fig.background : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!out) throw new Error("PNG encode failed");
  return new Uint8Array(await out.arrayBuffer());
}

// Quick PNG export (⌘K) — a plain pixel multiple, no physical sizing.
export async function exportFigurePng(fig: Figure, scale = 4) {
  const path = await window.fig.save(`${fig.name}.png`, [{ name: "PNG", extensions: ["png"] }]);
  if (!path) return;
  try {
    const canvas = await rasterizeFigure(fig, fig.width * scale, fig.height * scale, false);
    await window.fig.writeFile(path, await canvasToPng(canvas));
    pushToast("success", `Exported ${basename(path)}`);
  } catch (e) {
    pushToast("error", "PNG export failed", { detail: errMsg(e) });
  }
}

export interface JournalExportOpts {
  format: "png" | "tiff";
  mm: number; // physical width
  dpi: number;
  transparent?: boolean;
}

// 3.1 Journal-spec raster: render at the physical width (mm) × dpi the publisher asks for,
// resolution embedded (PNG pHYs / TIFF XResolution) so the placed figure prints at exactly
// that column width. TIFF (uncompressed baseline) is the format most journals require. This
// half produces the bytes (pure of any dialog/disk) so it's browser-testable directly.
export async function renderFigureBytes(fig: Figure, opts: JournalExportOpts): Promise<Uint8Array> {
  const plan = planExport(fig.width, fig.height, opts.mm, opts.dpi);
  const canvas = await rasterizeFigure(fig, plan.pxWidth, plan.pxHeight, !!opts.transparent);
  if (opts.format === "tiff") {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return encodeTiff(data, canvas.width, canvas.height, { dpi: opts.dpi, alpha: !!opts.transparent });
  }
  return injectPngDpi(await canvasToPng(canvas), opts.dpi);
}

export async function exportFigureJournal(fig: Figure, opts: JournalExportOpts) {
  const ext = opts.format;
  const path = await window.fig.save(`${fig.name}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
  if (!path) return;
  try {
    const plan = planExport(fig.width, fig.height, opts.mm, opts.dpi);
    const bytes = await renderFigureBytes(fig, opts);
    await window.fig.writeFile(path, bytes);
    pushToast("success", `Exported ${basename(path)} · ${describeSize(plan.pxWidth, plan.pxHeight, opts.dpi)}`);
  } catch (e) {
    pushToast("error", `${ext.toUpperCase()} export failed`, { detail: errMsg(e) });
  }
}

export async function exportFigurePdf(fig: Figure) {
  const path = await window.fig.save(`${fig.name}.pdf`, [{ name: "PDF", extensions: ["pdf"] }]);
  if (!path) return;
  try {
    if (!window.fig.exportPdf) throw new Error("PDF export is unavailable in this build.");
    await window.fig.exportPdf(buildSvg(fig), path, fig.width, fig.height);
    pushToast("success", `Exported ${basename(path)}`);
  } catch (e) {
    pushToast("error", "PDF export failed", { detail: errMsg(e) });
  }
}
