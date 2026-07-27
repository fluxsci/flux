import { get } from "svelte/store";
import type {
  Asset,
  Figure,
  ImageElement,
  Project,
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
import { migrateProject } from "./migrate";
import { validateModel, sanitizeProjectGeometry } from "./project/validate";
import { newerSchemaMessage, PROJECT_MODEL_VERSION } from "./project/types";
import { assetDisplaySize } from "./ops";
import { annotationsToMarkdown, type AnnotationMdMeta } from "./references/annotationsMarkdown";
import type { Annotation } from "./references/annotations";
import { encodeTiff } from "./figure/tiff";
import { injectPngDpi, readPngDpi } from "./figure/pngDpi";
import { captureSnipMeta, clearSnipMeta } from "./snipMeta";
import { planExport, describeSize, MM_PER_INCH } from "./figure/journalSizing";
import { parseTokens } from "./colors";
import { cachePlot, clearPlots, ensurePlotDom, plotManifests, plotRecipes, primePlotSidecars } from "./plot/store";
import { isDerivedManifest } from "./plot/derive";
import { plotToSvgMarkup } from "./plot/export";
import type { FluxPlotManifest } from "./plot/types";
import { pushToast, errMsg } from "./toast";
import { flushById } from "../shell/lifecycle";

// Every user-initiated open/import/save/export below surfaces its failure as a
// toast (V1 review, W1) — these previously rejected silently into the void.

// F2 hot-swap: replace a plot's cached SVG/manifest/recipe in place for an
// EXISTING assetId (regenerate). The element + its id-keyed `overrides` are left
// untouched, so the re-mount reapplies them automatically (group overrides too);
// cachePlot bumps plotGen, which forces mountPlot to re-clone the new DOM.
// (manifest optional: a sidecar-less vanilla svg gets a DERIVED one in cachePlot —
// same rule as import; the watcher's plots/ hot-swap passes whatever it finds.)
export function reimportPlot(
  assetId: string,
  svgText: string,
  manifest?: FluxPlotManifest,
  recipe?: unknown,
): boolean {
  const ok = cachePlot(assetId, svgText, manifest, recipe);
  setAssetData(assetId, bytesToDataUrl(new TextEncoder().encode(svgText), mimeFor("svg")));
  markAssetDirty(assetId); // W8: hot-swapped bytes → rewrite on next save
  return ok;
}

// ---------------------------------------------------------------------------
// Small path helpers ("/"-joined — Node accepts forward slashes on Windows).
// ---------------------------------------------------------------------------
function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
}
function basename(p: string): string {
  // Backslash is a LEGAL filename char on POSIX, so only treat it as a
  // separator for Windows-looking inputs (drive/UNC prefix, or backslashes
  // with no forward slash); everything else keeps the exact POSIX behavior.
  const winish =
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || (p.includes("\\") && !p.includes("/"));
  return (winish ? p.split(/[\\/]/) : p.split("/")).pop() ?? p;
}

// ---------------------------------------------------------------------------
// Import assets (PNG / SVG) into the active figure.
// ---------------------------------------------------------------------------
function kindOf(name: string): "png" | "svg" {
  return name.toLowerCase().endsWith(".svg") ? "svg" : "png";
}

// `el.width/height` arrive already set to the asset's TRUE physical size in canvas
// px (96/inch) — placement must never rescale them (see placeIncoming).
interface Incoming {
  asset: Asset;
  el: ImageElement | SemanticPlotElement;
}

// Sidecars discovered next to an imported `X.svg`: a FluxPlot manifest
// (`X.fluxplot.json`) supplies real semantics; without one the svg still goes
// through the plot pipeline with a DERIVED manifest (plot/derive.ts).
interface Siblings {
  svgPath?: string;
  manifestPath?: string;
  recipePath?: string;
  manifestText?: string;
  recipeText?: string;
  /** Paper-snip sidecar (`X.snip.json`) beside an imported PNG — the fallback
   *  provenance source when a PNG's flux-snip tEXt chunk was stripped. */
  snipText?: string;
}

// Resolve sidecars from the filesystem by deterministic sibling path (the
// preload bridge has no readdir, but `X.svg` → `X.fluxplot.json` is fixed).
async function resolveSiblingsFromFs(absPath: string): Promise<Siblings> {
  if (/\.png$/i.test(absPath)) {
    const snipPath = absPath.replace(/\.png$/i, ".snip.json");
    try {
      if (await window.fig.exists(snipPath)) return { snipText: await window.fig.readText(snipPath) };
    } catch {
      /* unreadable — the tEXt chunk (if any) still covers it */
    }
    return {};
  }
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
  const { width: natW, height: natH } = await intrinsicSize(dataUrl);
  // Physical size in canvas px (96/inch) — the size the element is PLACED at.
  // SVG: the browser already converted declared pt/mm/in units to CSS px (×96/72
  // for matplotlib's pt), so natural size IS physical. PNG: honor a pHYs DPI
  // declaration (e.g. a 300-dpi export places at ×96/300 of its pixel count);
  // a raster with no declared DPI keeps 1 image px = 1 canvas px.
  const declaredDpi = kind === "png" ? readPngDpi(bytes) : null;
  const k = declaredDpi && declaredDpi > 0 ? 96 / declaredDpi : 1;
  const width = natW * k;
  const height = natH * k;
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
    naturalWidth: natW,
    naturalHeight: natH,
    ...(declaredDpi ? { dpi: declaredDpi } : {}),
  };
  setAssetData(asset.id, dataUrl); // also serves as the <image> fallback (spec P4)
  markAssetDirty(asset.id); // W8: newly imported bytes → write on next save
  // Paper snips: pick up provenance riding the PNG (tEXt) or its sidecar, so
  // "copy citation" works on the imported element. Covers every import surface
  // that funnels here: picker, drag-drop, path import, slide paste.
  if (kind === "png") captureSnipMeta(asset.id, bytes, sib.snipText);

  // EVERY svg goes through the semantic-plot pipeline: a fluxplot sidecar gives
  // the real manifest; anything else gets a DERIVED one at cachePlot (via
  // preparePlot) — so vanilla SVGs are inline live DOM (real text, crisp,
  // x-rayable, part-editable) instead of an opaque <image>.
  if (kind === "svg") {
    let manifest: FluxPlotManifest | undefined;
    let recipe: unknown;
    if (sib.manifestText) {
      try {
        manifest = JSON.parse(sib.manifestText) as FluxPlotManifest;
        recipe = sib.recipeText ? JSON.parse(sib.recipeText) : undefined;
      } catch {
        manifest = undefined; // malformed sidecar → treated as vanilla (derived)
      }
    }
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
      source: {
        svgPath: sib.svgPath ?? name,
        // Only record sidecar paths that actually exist (a real fluxplot) — the
        // fluxplot/vanilla discriminator is sidecar presence.
        manifestPath: manifest ? sib.manifestPath : undefined,
        recipePath: manifest ? sib.recipePath : undefined,
      },
      ...(manifest ? { manifestRef: { specVersion: manifest.schemaVersion } } : {}),
      overrides: {},
    };
    return { asset, el };
  }

  const el: ImageElement = {
    type: "image",
    id: newId(kind),
    assetId: asset.id,
    x: 0,
    y: 0,
    width,
    height,
    rotation: 0,
  };
  return { asset, el };
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

// Batch-import plots/assets by absolute path (the Plot Importer's multi-insert,
// Ctrl+Enter). Reuses the same pipeline as importAssets so each FluxPlot svg
// arrives with its manifest + recipe sidecars resolved. Per-file failures never
// abort the batch: the good files still import, and the failures surface in ONE
// error toast listing each basename (no silent failures). All placements go
// through a single placeIncoming call — one undo step, grid auto-arrange for
// N>1, the physical-size contract, and select-all-new.
export async function importPlotsFromPaths(absPaths: string[]) {
  if (!window.fig || !absPaths.length) return;
  const incoming: Incoming[] = [];
  const failed: string[] = [];
  for (const absPath of absPaths) {
    try {
      const bytes = new Uint8Array(await window.fig.readFile(absPath));
      const sib = await resolveSiblingsFromFs(absPath);
      incoming.push(await buildIncoming(basename(absPath), bytes, sib));
    } catch (e) {
      failed.push(`${basename(absPath)}: ${errMsg(e)}`);
    }
  }
  placeIncoming(incoming);
  if (failed.length) {
    pushToast(
      "error",
      failed.length === 1 ? "Plot import failed" : `${failed.length} of ${absPaths.length} plot imports failed`,
      { detail: failed.join("\n") },
    );
  }
}

// Import a single plot/asset by absolute path (the Plot Importer, Alt+I) — the
// one-file case of the batch importer above.
export async function importPlotFromPath(absPath: string) {
  return importPlotsFromPaths([absPath]);
}

// Files dropped from the OS file explorer onto a specific figure. A dropped svg
// is paired with a dropped `*.fluxplot.json` (+ `*.recipe.json`) of the same
// base name → it imports as a semantic plot. (Drops are sandboxed Files with no
// filesystem path, so we can only pair what was dropped together.)
export async function importDroppedFiles(files: File[], figId: string) {
  const all = [...files];
  const manifests = new Map<string, File>();
  const recipes = new Map<string, File>();
  const snips = new Map<string, File>();
  for (const f of all) {
    const n = (f.name || "").toLowerCase();
    if (n.endsWith(".fluxplot.json")) manifests.set(f.name.slice(0, -".fluxplot.json".length), f);
    else if (n.endsWith(".recipe.json")) recipes.set(f.name.slice(0, -".recipe.json".length), f);
    else if (n.endsWith(".snip.json")) snips.set(f.name.slice(0, -".snip.json".length), f);
  }
  const accepted = all.filter(
    (f) => /\.(png|svg)$/i.test(f.name || "") || /(png|svg)/i.test(f.type),
  );
  if (!accepted.length) {
    // A dropped JPEG/PDF/TIFF/… previously did NOTHING — say why (no silent failures).
    pushToast("info", "Only PNG/SVG can be imported here");
    return;
  }
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
    } else if (/\.png$/i.test(file.name || "")) {
      // A dropped snip's provenance normally rides its tEXt chunk; a dropped
      // X.snip.json pairs up for the stripped-PNG case (mirrors the fluxplot pair).
      const sf = snips.get((file.name || "").replace(/\.png$/i, ""));
      if (sf) sib = { snipText: await sf.text() };
    }
    incoming.push(await buildIncoming(file.name || "image", bytes, sib));
  }
  placeIncoming(incoming, figId);
}

// Position incoming placements (one centered; many auto-arranged into a grid),
// then commit assets + elements and select the new group. Everything is placed
// at its TRUE physical size (Figma-style) — never fit-scaled to the frame. A
// plot that doesn't fit overflows the frame and the toast says so: the user
// either resizes deliberately in Flux or fixes the plot's figsize at the source.
// (The old 70%-fit rule silently rescaled each import by a different factor, so
// same-pt fonts landed at different apparent sizes — the one thing a journal
// figure tool must never do.)
function placeIncoming(incoming: Incoming[], figId?: string) {
  if (!incoming.length) return;
  const p = get(project);
  const id = figId ?? get(activeFigureId) ?? p.figures[0]?.id;
  const fig = p.figures.find((f) => f.id === id);
  if (!fig) return;

  if (incoming.length === 1) {
    const it = incoming[0];
    it.el.x = (fig.width - it.el.width) / 2;
    it.el.y = (fig.height - it.el.height) / 2;
  } else {
    autoArrange(fig, incoming);
  }
  const mm = (px: number) => ((px / 96) * MM_PER_INCH).toFixed(1);
  const over = incoming.filter(
    (it) => it.el.x < 0 || it.el.y < 0 || it.el.x + it.el.width > fig.width || it.el.y + it.el.height > fig.height,
  );
  if (over.length) {
    const one = over.length === 1 ? over[0].el : null;
    pushToast("info", "Placed at true physical size — larger than the frame", {
      detail: one
        ? `${mm(one.width)} × ${mm(one.height)} mm vs frame ${mm(fig.width)} × ${mm(fig.height)} mm. Ctrl+Shift+I brings it inside the frame (unresized); or resize it here / regenerate the plot at the size it should print.`
        : `${over.length} of ${incoming.length} imports exceed the ${mm(fig.width)} × ${mm(fig.height)} mm frame. Ctrl+Shift+I brings them inside the frame (unresized, may overlap); or resize them here / regenerate the plots at the size they should print.`,
    });
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
  const aspects = incoming.map((it) => (it.el.height > 0 ? it.el.width / it.el.height : 1));
  const meanAspect = aspects.reduce((a, b) => a + b, 0) / aspects.length;
  const orientation = meanAspect < 1 ? "rows" : "cols";

  const sizes = incoming.map((it) => ({ w: it.el.width, h: it.el.height }));
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
  try {
    const root = get(embeddedProjectRoot);
    // Embedded → no separate "save as". Route through the figure autosave flush
    // (W5 registry) instead of a bare saveFigFrom: a ConflictError then raises
    // FigureMode's diverged-on-disk banner (W7), and other failures get the
    // controller's retry + sticky toast rather than an unhandled rejection.
    if (root) return await flushById("figure");
    const p = get(project);
    const path = await window.fig.save(`${p.name || "Untitled"}.flux`, [
      { name: "Flux project", extensions: ["flux"] },
    ]);
    if (!path) return;
    await writeProjectTo(path);
    projectDir.set(path);
  } catch (e) {
    pushToast("error", "Save failed", { detail: errMsg(e) });
  }
}

async function writeProjectTo(dir: string) {
  if (!(await window.fig.exists(dir))) await window.fig.mkdir(dir);
  await window.fig.mkdir(joinPath(dir, "assets"));

  const p = structuredClone(get(project));
  // WS-5.1: never persist NaN/Infinity — JSON turns them into null, which the
  // load gate would then (rightly) reject.
  {
    const fixed = sanitizeProjectGeometry(p);
    if (fixed) pushToast("info", `Repaired ${fixed} non-finite geometry value(s) while saving`);
  }
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
    // NEVER persist a DERIVED manifest: sidecar presence is the fluxplot/vanilla
    // discriminator, and re-deriving at every load keeps deriver improvements
    // retroactive (a written derived sidecar would freeze it and misclassify
    // the vanilla svg as a fluxplot on the next load).
    const man = manifests[asset.id];
    if (man && !isDerivedManifest(man)) {
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
    // WS-5.2: refuse a NEWER standalone model before migrate.ts stamps it DOWN
    // to version 2 and the next save rewrites it lossily.
    if (typeof (p as { version?: unknown }).version === "number" && (p.version as number) > PROJECT_MODEL_VERSION) {
      throw new Error(newerSchemaMessage("This project file", p.version, String(PROJECT_MODEL_VERSION)));
    }
    // WS-5.1: parse → migrate → validate (legacy-lenient, post-migration-strict).
    // A standalone project file is an ENTRY manifest — validation failure
    // refuses the open (the catch below toasts the detail).
    migrateProject(p);
    {
      const errs = validateModel(p);
      if (errs.length)
        throw new Error(`project model failed validation:\n${errs.slice(0, 8).join("\n")}${errs.length > 8 ? `\n… ${errs.length - 8} more` : ""}`);
    }

    clearPlots();
    clearSnipMeta();
    // LAZY residency (2026-07-21, plan §5.2): bytes + sidecar manifests load
    // eagerly (cheap; assetData is the <image> fallback), the DOM parse
    // defers to PlotElement's mount request — the standalone twin of the
    // figbridge.loadFigInto shape.
    const fresh: Record<string, string> = {};
    const primedManifests: Record<string, FluxPlotManifest> = {};
    const primedRecipes: Record<string, unknown> = {};
    for (const asset of p.assets) {
      if (!asset.path) continue;
      const bytes = new Uint8Array(await window.fig.readFile(joinPath(dir, asset.path)));
      fresh[asset.id] = bytesToDataUrl(bytes, mimeFor(asset.kind));
      if (asset.kind === "png") captureSnipMeta(asset.id, bytes);
      if (asset.kind === "svg") {
        const mpath = joinPath(dir, `assets/${asset.id}.fluxplot.json`);
        if (await window.fig.exists(mpath)) {
          primedManifests[asset.id] = JSON.parse(await window.fig.readText(mpath)) as FluxPlotManifest;
          const rpath = joinPath(dir, `assets/${asset.id}.recipe.json`);
          if (await window.fig.exists(rpath)) primedRecipes[asset.id] = JSON.parse(await window.fig.readText(rpath));
        }
      }
    }
    primePlotSidecars(primedManifests, primedRecipes);
    assetData.set(fresh);
    loadProject(p, dir);
  } catch (e) {
    pushToast("error", "Couldn't open project", { detail: errMsg(e) });
  }
}

// ---------------------------------------------------------------------------
// Export a figure to SVG / PNG / PDF.
// ---------------------------------------------------------------------------

/** Lazy-residency export gate (plan §5.6): parse any of this figure's plots
 *  that aren't resident (deferred at open, or LRU-evicted) before serializing,
 *  so plotToSvgMarkup bakes real vector parts + per-part overrides instead of
 *  silently falling to the <image> fallback. Synchronous — the bytes are
 *  already resident in assetData. */
export function ensureFigurePlots(fig: Figure): void {
  for (const el of fig.elements) if (el.type === "plot") ensurePlotDom(el.assetId);
}

/** Serialize a figure to standalone SVG markup with plots inlined (exported
 *  for the lazy-residency gates; every GUI export path funnels through here). */
export function buildFigureSvg(fig: Figure): string {
  ensureFigurePlots(fig);
  const data = get(assetData);
  const p = get(project);
  return figureToSvg(
    fig,
    (id) => data[id],
    (el) => (el.type === "plot" ? (plotToSvgMarkup(el) ?? undefined) : undefined),
    // Crop rendering for <image>-backed elements (P5): intrinsic content size
    // in assetDisplaySize units — the crop window's own coordinate space.
    (id) => assetDisplaySize(p, id) ?? undefined,
  );
}
const buildSvg = buildFigureSvg;

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
