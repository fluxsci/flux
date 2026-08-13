// flux-core/figures.ts — the figure verbs (split out of index.ts; WS-6.2):
// compose/create/arrange, captions, panel + plot import/sync, part overrides,
// element styles + the text system, groups/z-order/layout, and scaffold.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { membersDeep } from "../src/lib/groups";
import { composeCaption, panelLetters, figurePanels, panelKey, splitCaption } from "../src/lib/captions";
import { elementBBox, unionRect } from "../src/lib/geometry";
import { gridLayout, emptyRegion } from "../src/lib/layout";
import { buildPartIndex } from "../src/lib/plot/parse";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import * as ops from "../src/lib/ops";
import { BUILTIN_FAMILIES } from "../src/lib/figfamily";
import type { CascadeSpec } from "../src/lib/cascade";
import * as slideOps from "../src/lib/slide/ops";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import * as fluxlib from "./fluxlib";
import { atomicWrite } from "./fsx";
import { j } from "./journal";
import {
  safeJoin,
  safeId,
  exists,
  writeText,
  readFigIndex,
  readCanvasFiles,
  loadFigModel,
  mutateFigModel,
} from "./model";
import {
  svgIntrinsicSize,
  scanAbsurdPathCoords,
  manifestHasLogAxis,
  absurdCoordWarning,
} from "./coordscan";
import type { Figure, Element, Project, PartOverride, VectorNode, TextStyle } from "../src/lib/types";
import { slugify } from "../src/lib/project/types";

/** Copy a plot SVG into fig/assets, registering it (+ natural size) on the model.
 *  Returns the new assetId and any detected FluxPlot sidecar paths (project-rel). */
async function importPlotAsset(
  root: string,
  project: Project,
  svgFile: string,
): Promise<{ assetId: string; w: number; h: number; warning?: string; source?: { svgPath: string; manifestPath?: string; recipePath?: string } }> {
  const abs = path.resolve(svgFile);
  const raw = await fs.readFile(abs, "utf8");
  const scan = scanAbsurdPathCoords(raw, { clamp: true });
  const svg = scan.svg;
  const base = abs.replace(/\.svg$/i, "");
  const manifest = base + ".fluxplot.json";
  const recipe = base + ".recipe.json";
  const manifestText = await fs.readFile(manifest, "utf8").catch(() => null);
  const warning = scan.clamped
    ? absurdCoordWarning(path.basename(abs), scan, manifestHasLogAxis(manifestText))
    : undefined;
  const { w, h } = svgIntrinsicSize(svg);
  const tag = Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
  const assetId = `asset_${tag}`;
  const rel = `assets/${assetId}.svg`;
  await atomicWrite(safeJoin(root, `fig/${rel}`), svg);
  project.assets.push({ id: assetId, name: path.basename(abs), kind: "svg", path: rel, naturalWidth: w, naturalHeight: h });
  let source: { svgPath: string; manifestPath?: string; recipePath?: string } | undefined;
  if (manifestText != null) {
    // AGT-1/AGT-11: copy the FluxPlot manifest (+ recipe) as ASSET-LOCAL sidecars
    // (fig/assets/<id>.fluxplot.json). The GUI reconnects a plot's semantic parts
    // ONLY from that path (figbridge.ts) — without it an agent-composed plot opens
    // as an opaque <image> and the next human save bakes that in permanently. It
    // also keeps the manifest in-root so headless render's group-override expansion
    // works even when the original plot lives outside the project. `source` still
    // records the original paths as provenance (used by rerun-plot regeneration).
    await atomicWrite(safeJoin(root, `fig/assets/${assetId}.fluxplot.json`), manifestText);
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
  return { assetId, w, h, warning, source };
}

/** set-caption: store the caption in the figure's canvas model (its true home) and
 *  emit the derived fig/captions/<id>.md + index cache. */
export async function setCaption(
  root: string,
  figId: string,
  md: string,
  opts: { panel?: string } = {},
): Promise<{ panels: string[] }> {
  const trimmed = md.trim();
  return mutateFigModel(root, "set_caption", async ({ project, index }) => {
    const fig = project.figures.find((f) => f.id === figId);
    if (!fig) throw new Error(`no figure "${figId}"`);
    // AGT-2: the caption's true home is Figure.captions in the canvas file — the
    // single source composeCaption() reads. Writing only fig/captions/<id>.md (as
    // before) let the GUI's next save recompose from an empty captions map and
    // silently wipe the agent's caption.
    if (opts.panel) {
      // --panel a: write ONE panel's text (keyed by its label element's id).
      const key = opts.panel.toLowerCase();
      const panel = figurePanels(fig).find((p) => panelKey(p.label) === key);
      if (!panel || panel.id === "__figure__")
        throw new Error(`figure "${figId}" has no panel "${opts.panel}" (panels: ${panelLetters(fig).join("") || "none"})`);
      fig.captions = { ...(fig.captions ?? {}), [panel.id]: trimmed };
    } else {
      // Whole-string form: distribute the documented `Lead. **a**, … **b**, …`
      // convention into the per-panel map (the app's Caption Editor shows one
      // box per panel — a monolithic __figure__ blob mis-structures all of it).
      // No recognizable markers → the whole string is the figure-level lead.
      const split = splitCaption(fig, trimmed);
      fig.captions = split ?? { ...(fig.captions ?? {}), __figure__: trimmed };
    }
    // WS-5.6: the save that follows (mutateFigModel) composes + emits the
    // fig/captions/<id>.md file AND the index caption cache from Figure.captions
    // — the manual writes this verb used to do are the persistence core's job.
    return { panels: panelLetters(fig) };
  });
}

/** add-panel: import an SVG file as a panel on a figure. EVERY svg is a
 *  semantic plot (figure-v1 P4): a .fluxplot.json sidecar supplies the real
 *  manifest; a vanilla file gets a DERIVED one at render/cache time. */
export async function addPanel(
  root: string,
  figId: string,
  svgFile: string,
  opts: { x?: number; y?: number; width?: number; height?: number } = {},
): Promise<{ assetId: string; elementId: string; warning?: string }> {
  return mutateFigModel(root, "add_panel", async ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const { assetId, w, h, source, warning } = await importPlotAsset(root, project, svgFile);
    const box = { x: opts.x ?? 20, y: opts.y ?? 20, width: opts.width ?? w, height: opts.height ?? h };
    const elementId = ops.addPlotPanel(project, figId, {
      assetId,
      source: source ?? { svgPath: path.relative(root, path.resolve(svgFile)) },
      ...box,
    })!;
    return { assetId, elementId, ...(warning ? { warning } : {}) };
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
): Promise<{ panels: { assetId: string; elementId: string }[]; warnings: string[] }> {
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
    return { panels, warnings: infos.map((it) => it.warning).filter((w): w is string => !!w) };
  });
}

/** sync-figure: re-copy regenerated plots/*.svg into their fig/assets copies.
 *  compose/import copy plot bytes ONCE; re-running a plot script updates
 *  plots/ but composed figures keep rendering the stale copy — headless, the
 *  only workaround was delete-figure + re-compose, which destroys captions and
 *  restyles. This refreshes asset bytes + sidecars + natural size in place;
 *  element positions, captions, and id-keyed overrides are untouched.
 *  `dryRun` reports staleness without writing (render-figure's warning). */
export async function syncFigureAssets(
  root: string,
  figId?: string,
  opts: { dryRun?: boolean } = {},
): Promise<{
  refreshed: { assetId: string; from: string }[];
  resized: { assetId: string; elementIds: string[]; from: { w: number; h: number }; to: { w: number; h: number } }[];
  framed: { figId: string; from: { width: number; height: number }; to: { width: number; height: number } }[];
  missing: string[];
  warnings: string[];
  checked: number;
}> {
  const run = async ({ project }: { project: Project }) => {
    const figs = figId ? [ops.figById(project, figId)] : project.figures;
    if (figId && !figs[0]) throw new Error(`figure not found: ${figId}`);
    const refreshed: { assetId: string; from: string }[] = [];
    const resized: { assetId: string; elementIds: string[]; from: { w: number; h: number }; to: { w: number; h: number } }[] = [];
    const framed: { figId: string; from: { width: number; height: number }; to: { width: number; height: number } }[] = [];
    const missing: string[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let checked = 0;
    for (const fig of figs as Figure[]) {
      // Frame refit baseline: the margin the composition ALREADY keeps between
      // its content and the frame's right/bottom edge (re-applied after panels
      // grow, so "regenerate taller → sync" can't leave panels clipped).
      const bbBefore = unionRect(fig.elements.map(elementBBox));
      for (const el of fig.elements) {
        if (el.type !== "plot") continue;
        const aid = (el as { assetId?: string }).assetId;
        const src = (el as { source?: { svgPath?: string } }).source?.svgPath;
        if (!aid || !src || seen.has(aid)) continue;
        seen.add(aid);
        const asset = project.assets.find((a) => a.id === aid);
        if (!asset?.path) continue;
        checked++;
        const srcAbs = path.isAbsolute(src) ? src : path.resolve(root, src);
        const raw = await fs.readFile(srcAbs, "utf8").catch(() => null);
        if (raw == null) {
          missing.push(src);
          continue;
        }
        const scan = scanAbsurdPathCoords(raw, { clamp: true });
        const svg = scan.svg;
        const cur = await fs.readFile(safeJoin(root, `fig/${asset.path}`), "utf8").catch(() => "");
        if (cur === svg) continue;
        refreshed.push({ assetId: aid, from: src });
        const base = srcAbs.replace(/\.svg$/i, "");
        if (scan.clamped) {
          const manifestText = await fs.readFile(base + ".fluxplot.json", "utf8").catch(() => null);
          warnings.push(absurdCoordWarning(path.basename(srcAbs), scan, manifestHasLogAxis(manifestText)));
        }
        if (opts.dryRun) continue;
        await atomicWrite(safeJoin(root, `fig/${asset.path}`), svg);
        const { w, h } = svgIntrinsicSize(svg);
        const prev = { w: asset.naturalWidth || w, h: asset.naturalHeight || h };
        asset.naturalWidth = w;
        asset.naturalHeight = h;
        // Physical-size reconciliation (moma feedback #10): a regenerated plot
        // with a NEW intrinsic size used to refresh bytes only — the element
        // kept its old box, silently rescaling the plot away from true size.
        // Resize every element on this asset, preserving any deliberate user
        // scale (elW/prevNaturalW) so "regenerate at the right size" lands
        // true-size while a hand-scaled panel stays hand-scaled.
        if (Math.abs(prev.w - w) > 0.01 || Math.abs(prev.h - h) > 0.01) {
          const els: string[] = [];
          for (const f2 of project.figures)
            for (const e2 of f2.elements) {
              if (e2.type !== "plot" || (e2 as { assetId?: string }).assetId !== aid) continue;
              const sx = prev.w > 0 ? e2.width / prev.w : 1;
              const sy = prev.h > 0 ? e2.height / prev.h : 1;
              e2.width = w * sx;
              e2.height = h * sy;
              els.push(e2.id);
            }
          resized.push({ assetId: aid, elementIds: els, from: prev, to: { w, h } });
        }
        // Refresh the asset-local sidecars alongside the bytes (same pairing
        // rule as import: X.svg → X.fluxplot.json / X.recipe.json).
        for (const [ext, dest] of [
          [".fluxplot.json", `fig/assets/${aid}.fluxplot.json`],
          [".recipe.json", `fig/assets/${aid}.recipe.json`],
        ] as const) {
          const text = await fs.readFile(base + ext, "utf8").catch(() => null);
          if (text != null) await atomicWrite(safeJoin(root, dest), text);
        }
      }
      // Refit the frame when grown content no longer fits: keep the smaller of
      // the composition's previous right/bottom margin and compose's default
      // 48, and never shrink the frame (a deliberately roomy layout survives).
      if (!opts.dryRun && bbBefore) {
        const bbAfter = unionRect(fig.elements.map(elementBBox));
        if (bbAfter) {
          const padX = Math.min(48, Math.max(0, fig.width - (bbBefore.x + bbBefore.w)));
          const padY = Math.min(48, Math.max(0, fig.height - (bbBefore.y + bbBefore.h)));
          const wantW = Math.ceil(bbAfter.x + bbAfter.w + padX);
          const wantH = Math.ceil(bbAfter.y + bbAfter.h + padY);
          if (wantW > fig.width || wantH > fig.height) {
            const from = { width: fig.width, height: fig.height };
            ops.setFigureLayout(project, fig.id, {
              width: Math.max(fig.width, wantW),
              height: Math.max(fig.height, wantH),
            });
            framed.push({ figId: fig.id, from, to: { width: fig.width, height: fig.height } });
          }
        }
      }
    }
    return { refreshed, resized, framed, missing, warnings, checked };
  };
  // Dry run reads under no lock and never saves — it's render-figure's cheap
  // staleness probe. The real sync is a normal locked mutate (journaled).
  if (opts.dryRun) return run(await loadFigModel(root));
  return mutateFigModel(root, "sync_assets", run);
}

/** create-figure: add a blank figure (optional slug id, canvas, size, family). */
export async function createFigure(
  root: string,
  opts: {
    id?: string;
    name?: string;
    canvasId?: string;
    width?: number;
    height?: number;
    background?: string;
    family?: string;
    number?: number;
    nickname?: string;
  } = {},
): Promise<{ figureId: string; name: string }> {
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
      family: opts.family,
      number: opts.number,
      nickname: opts.nickname,
      width: opts.width,
      height: opts.height,
      background: opts.background,
    });
    return { figureId: fig.id, name: fig.name };
  });
}

/** set-figure-family: assign a figure's structured identity — family and/or
 *  number (insert-and-shift; the rest of the family renumbers around it)
 *  and/or nickname (null clears). */
export async function setFigureIdentity(
  root: string,
  figId: string,
  patch: { family?: string; number?: number; nickname?: string | null },
): Promise<{ name: string; renumbered: number }> {
  return mutateFigModel(root, "set_figure_family", ({ project }) => {
    const f = ops.figById(project, figId);
    if (!f) throw new Error(`figure not found: ${figId}`);
    if (patch.family) {
      const known =
        BUILTIN_FAMILIES.some((b) => b.id === patch.family) ||
        (project.figureFamilies ?? []).some((x) => x.id === patch.family);
      if (!known) {
        throw new Error(
          `unknown family "${patch.family}" — define it first (define-figure-family) or use figure/supplementary/extended-data`,
        );
      }
    }
    const changed = ops.setFigureIdentity(project, figId, patch);
    return { name: f.name, renumbered: Math.max(0, changed.length - 1) };
  });
}

/** define-figure-family: create/update a custom family ("movie" → "Mov. 3b"). */
export async function defineFigureFamily(
  root: string,
  def: { id: string; displayName: string; refTemplate?: string; captionTemplate?: string },
): Promise<{ id: string; refTemplate: string; captionTemplate: string }> {
  return mutateFigModel(root, "define_figure_family", ({ project }) => {
    const full = ops.defineFigureFamily(project, def);
    return { id: full.id, refTemplate: full.refTemplate, captionTemplate: full.captionTemplate };
  });
}

/** remove-figure-family: drop a custom family; members move to the main
 *  figure family (appended). */
export async function removeFigureFamily(
  root: string,
  id: string,
): Promise<{ moved: number }> {
  return mutateFigModel(root, "remove_figure_family", ({ project }) => {
    const moved = project.figures.filter((f) => f.family === id).length;
    ops.removeFigureFamily(project, id);
    return { moved };
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
): Promise<{ figureId: string; panels: string[]; width: number; height: number; warnings: string[] }> {
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
    const warnings: string[] = [];
    for (const pp of plotPaths) {
      const { assetId, w, h, source, warning } = await importPlotAsset(root, project, pp);
      if (warning) warnings.push(warning);
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
      warnings,
    };
  });

  if (opts.captionStub !== false) await setCaption(root, out.figureId, out.stub);
  return { figureId: out.figureId, panels: out.panels, width: out.width, height: out.height, warnings: out.warnings };
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

/** cascade: apply a stepped delta across elements — the unit at rank k (in
 *  spec.order over `ids`; default = the ids order) gets value ⊕ delta·step_k,
 *  step = k with firstFixed, else k+1. A whole group is ONE rigid rank. The
 *  math/guards live in the shared pure core (ops.cascadeElements). */
export async function cascadeElements(root: string, figId: string, ids: string[], spec: CascadeSpec): Promise<void> {
  await mutateFigModel(root, "cascade", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.cascadeElements(project, figId, ids, spec);
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

/** auto-letter a figure's panel-label elements (a, b, c…) by reading order.
 *  Panels (plot/image) that have NO label first get the same "?" stub
 *  compose-figure seeds, so auto-label works on any figure — including one
 *  assembled via import-plots + arrange, which used to dead-end with "no panel
 *  labels to letter" (moma feedback #4). `changed:false` = the assignment
 *  already matched (a silent "✓ labeled" on a no-op cost the moma agent a
 *  render-inspect cycle). */
export async function autoLabel(
  root: string,
  figId: string,
): Promise<{ panels: string[]; changed: boolean; created: number }> {
  return mutateFigModel(root, "auto_label", ({ project }) => {
    const fig = ops.figById(project, figId);
    if (!fig) throw new Error(`figure not found: ${figId}`);
    const { created } = ops.ensurePanelLabels(project, figId);
    const { changed } = ops.autoLetterPanels(project, figId);
    return { panels: panelLetters(fig), changed: changed || created > 0, created };
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

/** add a text element to a figure (parity gap: every other create verb existed).
 *  `panelLabel: true` creates a semantic panel label instead (bold 8 pt, linked
 *  to the seeded "Panel Label" style, letterable by auto-label) — the flag the
 *  auto-label error message always advertised (moma feedback #4). */
export async function addFigText(
  root: string,
  figId: string,
  opts: { text: string; panelLabel?: boolean } & ops.Box & ops.TextOpts,
): Promise<{ id: string }> {
  return mutateFigModel(root, "add_text", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const id = opts.panelLabel
      ? ops.addPanelLabel(project, figId, opts)
      : ops.addText(project, figId, opts);
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

/** delete a whole figure. Returns the id the GUI would activate next.
 *  Headless delete allows an empty canvas — an auto-created blank placeholder
 *  would silently take order 1 and shift every figure's number (the moma
 *  numbering trap). Stale renders are unlinked so they can't be mistaken for
 *  live output. */
export async function deleteFigure(root: string, figId: string): Promise<{ nextActiveId: string | null }> {
  const r = await mutateFigModel(root, "delete_figure", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    const out = ops.deleteFigure(project, figId, { allowEmpty: true });
    // Prune assets no remaining figure references. A headless delete has no
    // undo, and index entries that outlive their references also outlive their
    // FILES the moment anything tidies fig/assets — 2026-08-13: four agent
    // deletes left 14 index entries pointing at removed files, spamming ENOENT
    // on every subsequent load. Asset files themselves are deliberately left
    // alone (cheap, and a recompose can reuse them); the GUI keeps its entries
    // too (snapshot undo restores the figure with them). The INDEX must only
    // ever name assets some figure still uses.
    const used = new Set<string>();
    for (const f of project.figures)
      for (const e of f.elements) {
        const aid = (e as { assetId?: string }).assetId;
        if (aid) used.add(aid);
      }
    project.assets = project.assets.filter((a) => used.has(a.id));
    return out;
  });
  for (const ext of [".svg", ".png"]) {
    await fs.unlink(safeJoin(root, `fig/renders/${figId}${ext}`)).catch(() => {});
  }
  return r;
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

/** bring elements inside the figure frame: minimal per-unit translation so each
 *  rotation-aware bbox lies inside (oversized units cover the frame); never
 *  resizes. `ids` restricts the set (default = all elements). */
export async function bringInside(root: string, figId: string, ids?: string[]): Promise<void> {
  await mutateFigModel(root, "bring_inside", ({ project }) => {
    if (!ops.figById(project, figId)) throw new Error(`figure not found: ${figId}`);
    ops.bringInside(project, figId, ids);
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

/** Compose the canonical caption for a figure from its panel blocks (F7). */
export async function captionFor(root: string, figId: string): Promise<string> {
  const index = await readFigIndex(root);
  if (!index) return "";
  const { byId } = await readCanvasFiles(root, index);
  return byId[figId] ? composeCaption(byId[figId]) : "";
}
