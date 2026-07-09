// Adapter between the figure editor's in-memory model and the Flux project's
// `fig/` subsystem (Flux_Project_Format.md §3.2). Each canvas (page) is a file
// under `fig/canvases/<id>.json`; `fig/index.json` rolls them up (canvas list +
// figure numbering + palette + assets). The user never hand-edits `fig/`.

import { get } from "svelte/store";
import type {
  Project as FigProject,
  Canvas,
  Figure,
  Asset,
  ColorGroup,
  TextStyle,
} from "../types";
import {
  project as figProject,
  dirty as figDirty,
  loadProject as figLoad,
  editGen,
} from "../store";
import {
  assetData,
  bytesToDataUrl,
  dataUrlToBytes,
  mimeFor,
  isAssetDirty,
  clearAssetDirty,
  clearAllAssetsDirty,
} from "../assets";
import { plotManifests, plotRecipes, cachePlot, clearPlots } from "../plot/store";
import { isDerivedManifest } from "../plot/derive";
import type { FluxPlotManifest } from "../plot/types";
import { FLEXOKI } from "../flexoki";
import { migrateProject } from "../migrate";
import { settings } from "../settings";
import { composeCaption, panelLetters } from "../captions";
import { fileBridge, joinPath, slugify } from "./types";
import { ConflictError } from "../autosave";

const SUB = "fig";
const DEFAULT_CANVAS_ID = "canvas-1";

// W7 conflict guard: the raw fig/index.json text we last loaded or wrote — i.e.
// what we believe is on disk. saveFigFrom compares against it and refuses to
// clobber an agent/CLI write that landed since we loaded (surfacing a banner).
let figIndexBaseline: string | null = null;

async function readFigIndexText(
  fig: NonNullable<ReturnType<typeof fileBridge>>,
  root: string,
): Promise<string> {
  try {
    const p = joinPath(root, SUB, "index.json");
    return (await fig.exists(p)) ? await fig.readText(p) : "";
  } catch {
    return "";
  }
}

/** W7: has fig/index.json changed on disk since we loaded/saved it? (used by the
 *  FigureMode divergence banner + W10 live-reload). */
export async function figDiskDiverged(root: string): Promise<boolean> {
  const fig = fileBridge();
  if (!fig || figIndexBaseline == null) return false;
  return (await readFigIndexText(fig, root)) !== figIndexBaseline;
}

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
  assets?: Asset[];
  palette?: string[];
  colorGroups?: ColorGroup[];
  // Named text styles (project-level; the machine-global library lives in
  // <userData>/textstyles.json). Loaded into Project.textStyles and written
  // back EXPLICITLY on save — omitting either side silently wipes them.
  textStyles?: TextStyle[];
}

interface CanvasFile {
  schemaVersion: string;
  id: string;
  name: string;
  figures: Figure[];
}

/** Load the project's `fig/` subsystem into the figure-editor stores. */
export async function loadFigInto(root: string, projectName: string): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;

  let index: FigIndexFile | null = null;
  let indexText = "";
  try {
    const p = joinPath(root, SUB, "index.json");
    if (await fig.exists(p)) {
      indexText = await fig.readText(p);
      index = JSON.parse(indexText) as FigIndexFile;
    }
  } catch {
    index = null;
  }
  figIndexBaseline = indexText; // W7: seed the conflict-guard baseline

  // Canvas list comes from the index; fall back to a single default canvas.
  const canvasMeta =
    index?.canvases && index.canvases.length
      ? [...index.canvases].sort((a, b) => a.order - b.order)
      : [{ id: DEFAULT_CANVAS_ID, name: "Canvas 1", order: 1 }];

  const canvases: Canvas[] = canvasMeta.map((c) => ({ id: c.id, name: c.name }));
  const figures: Figure[] = [];
  for (const cm of canvasMeta) {
    try {
      const p = joinPath(root, SUB, "canvases", `${cm.id}.json`);
      if (await fig.exists(p)) {
        const cf = JSON.parse(await fig.readText(p)) as CanvasFile;
        for (const f of cf.figures ?? []) {
          f.canvasId = cm.id; // canvas membership is authoritative from the file
          figures.push(f);
        }
      }
    } catch {
      /* unreadable canvas file — skip */
    }
  }

  const assets: Asset[] = index?.assets ?? [];
  const data: Record<string, string> = {};
  clearPlots();
  for (const a of assets) {
    if (!a.path) continue;
    try {
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, SUB, a.path)));
      data[a.id] = bytesToDataUrl(bytes, mimeFor(a.kind));
      // Cache EVERY svg's DOM (+ manifest/recipe when the asset-local sidecar
      // exists; a vanilla svg gets a DERIVED manifest inside cachePlot), so the
      // inlined rendering + part overrides reconnect on reload — mirrors
      // io.ts openProject exactly (figure-v1 P4).
      if (a.kind === "svg") {
        let manifest: FluxPlotManifest | undefined;
        let recipe: unknown;
        const mpath = joinPath(root, SUB, "assets", `${a.id}.fluxplot.json`);
        if (await fig.exists(mpath)) {
          manifest = JSON.parse(await fig.readText(mpath)) as FluxPlotManifest;
          const rpath = joinPath(root, SUB, "assets", `${a.id}.recipe.json`);
          if (await fig.exists(rpath)) recipe = JSON.parse(await fig.readText(rpath));
        }
        cachePlot(a.id, new TextDecoder().decode(bytes), manifest, recipe);
      }
    } catch {
      /* missing asset bytes — skip */
    }
  }
  assetData.set(data);
  clearAllAssetsDirty(); // W8: freshly loaded — every asset is in sync with disk

  const proj: FigProject = {
    version: 2,
    name: projectName || "Untitled",
    canvases,
    figures,
    assets,
    palette: index?.palette ?? [],
    colorGroups:
      index?.colorGroups ??
      (get(settings).flexokiDefault ? structuredClone(FLEXOKI) : []),
    // undefined (never []) when the index predates styles → migrate seeds the
    // defaults; an explicit empty list from disk stays empty (user cleared it).
    ...(index?.textStyles !== undefined ? { textStyles: index.textStyles } : {}),
  };
  figLoad(proj, null); // normalizes (incl. migrate), resets history, dirty=false
}

/** Persist the figure-editor stores into the project's `fig/` subsystem. */
export async function saveFigFrom(root: string, opts: { force?: boolean } = {}): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;

  // W7 conflict guard: if fig/index.json changed on disk since we loaded/saved
  // (an agent or CLI edited the figure subsystem), don't clobber it — throw so
  // the FigureMode banner offers reload/overwrite. The shared autosave controller
  // treats ConflictError as stay-dirty-no-retry. `force` (the banner's Overwrite)
  // skips the check and makes the editor's version win.
  if (!opts.force && figIndexBaseline != null && (await readFigIndexText(fig, root)) !== figIndexBaseline) {
    throw new ConflictError("figure subsystem changed on disk");
  }

  const genAtStart = editGen.n; // W4: only clear dirty if no edit lands mid-save
  const p = structuredClone(get(figProject));
  const data = get(assetData);
  const manifests = get(plotManifests);
  const recipes = get(plotRecipes);

  await fig.mkdir(joinPath(root, SUB));
  await fig.mkdir(joinPath(root, SUB, "canvases"));
  await fig.mkdir(joinPath(root, SUB, "assets"));
  await fig.mkdir(joinPath(root, SUB, "captions"));

  // Asset bytes → fig/assets/<id>.<kind> (+ a semantic plot's sidecars next to it).
  // W8: only (re)write NEW (path-less) or CHANGED (dirty) assets — an unchanged
  // asset is already on disk, so a debounced save no longer rewrites MBs of bytes.
  for (const a of p.assets) {
    const url = data[a.id];
    if (!url) continue;
    const isNew = !a.path;
    if (isNew) a.path = `assets/${a.id}.${a.kind}`; // ensure a path for the index
    if (!isNew && !isAssetDirty(a.id)) continue; // unchanged → skip the byte write
    await fig.writeFile(joinPath(root, SUB, a.path), dataUrlToBytes(url));
    // NEVER persist a DERIVED manifest (same guard as io.ts writeProjectTo):
    // sidecar presence is the fluxplot/vanilla discriminator, and re-deriving
    // at every load keeps deriver improvements retroactive — a written derived
    // sidecar would freeze it and misclassify the vanilla svg as a fluxplot.
    const man = manifests[a.id];
    if (man && !isDerivedManifest(man)) {
      await fig.writeText(joinPath(root, SUB, "assets", `${a.id}.fluxplot.json`), JSON.stringify(man, null, 2));
      const rec = recipes[a.id];
      if (rec !== undefined)
        await fig.writeText(joinPath(root, SUB, "assets", `${a.id}.recipe.json`), JSON.stringify(rec, null, 2));
    }
    clearAssetDirty(a.id); // persisted — back in sync with disk
  }

  // Guarantee at least one canvas (older in-memory projects may predate it).
  const canvases: Canvas[] =
    p.canvases && p.canvases.length
      ? p.canvases
      : [{ id: DEFAULT_CANVAS_ID, name: "Canvas 1" }];

  // One file per canvas (figures + elements) — the authoritative composition.
  for (const c of canvases) {
    const canvasFile: CanvasFile = {
      schemaVersion: "0.1.0",
      id: c.id,
      name: c.name,
      figures: p.figures.filter((f) => f.canvasId === c.id),
    };
    await fig.writeText(
      joinPath(root, SUB, "canvases", `${c.id}.json`),
      JSON.stringify(canvasFile, null, 2) + "\n",
    );
  }

  // Captions → fig/captions/<id>.md (Flux_Project_Format.md §3.2): the single
  // source of truth, composed from each figure's panel blocks (F7). The index
  // also caches the composed text for tools that read only index.json.
  const captionById: Record<string, string> = {};
  for (const f of p.figures) {
    const cap = composeCaption(f);
    captionById[f.id] = cap;
    await fig.writeText(joinPath(root, SUB, "captions", `${f.id}.md`), cap ? cap + "\n" : "");
  }

  // Preserve existing cross-ref labels (the figure↔prose join key) across saves;
  // only derive a label for figures that don't have one yet (F7 label stability —
  // otherwise renaming a figure would silently break its @fig-… references).
  const prevLabels: Record<string, string> = {};
  const prevKinds: Record<string, "main" | "supplementary"> = {};
  try {
    const ip = joinPath(root, SUB, "index.json");
    if (await fig.exists(ip)) {
      const prev = JSON.parse(await fig.readText(ip)) as FigIndexFile;
      for (const pf of prev.figures ?? []) {
        if (pf.label) prevLabels[pf.id] = pf.label;
        if (pf.kind === "main" || pf.kind === "supplementary") prevKinds[pf.id] = pf.kind;
      }
    }
  } catch {
    /* no prior index — derive fresh labels below */
  }

  // Index (rollup) — drives numbering / cross-ref; also stores palette + assets.
  const index: FigIndexFile = {
    schemaVersion: "0.1.0",
    canvases: canvases.map((c, i) => ({ id: c.id, name: c.name, order: i + 1 })),
    figures: p.figures.map((f, i) => ({
      id: f.id,
      name: f.name,
      label: prevLabels[f.id] ?? `fig-${slugify(f.name || f.id)}`,
      order: i + 1,
      // An agent can mark a figure supplementary (flux-core preserves it) — the
      // GUI save must not silently revert it to "main".
      kind: prevKinds[f.id] ?? "main",
      canvas: f.canvasId,
      caption: captionById[f.id] ?? "",
    })),
    assets: p.assets,
    palette: p.palette,
    colorGroups: p.colorGroups ?? [],
    textStyles: p.textStyles ?? [], // explicit writeback (silent-wipe guard)
  };
  const indexText = JSON.stringify(index, null, 2) + "\n";
  await fig.writeText(joinPath(root, SUB, "index.json"), indexText);
  figIndexBaseline = indexText; // W7: adopt what we just wrote as the new baseline

  // WS6: record the human's save in the provenance journal (Electron only; the
  // mem/demo bridge has no journalAppend, so this is a no-op there).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "save_fig", target: p.figures.map((f) => f.id), client: "human" });

  // W4: an edit that landed during the async writes above keeps its dirty flag,
  // so the autosave controller's trailing save persists it (previously the
  // unconditional clear silently dropped it until the next unrelated edit).
  if (editGen.n === genAtStart) figDirty.set(false);
}

// ---------------------------------------------------------------------------
// Read-only access to fig/ for the Paper module. Unlike loadFigInto (which
// clobbers the live figure-editor stores), this just parses the files and
// returns the data, so the manuscript editor can resolve/render @fig refs
// without disturbing whatever the figure editor is doing.
// ---------------------------------------------------------------------------
export interface FigSourceFigure {
  id: string;
  name: string;
  label: string;
  order: number;
  canvas: string;
  caption: string;
  panels: string[]; // ordered panel letters ["a","b",…] for sub-panel refs (F7)
}
export interface FigSource {
  indexFigures: FigSourceFigure[];
  figures: Record<string, Figure>; // by figure id (with elements, for rendering)
  assetData: Record<string, string>; // by asset id → data URL
}

export async function readFigSource(root: string): Promise<FigSource> {
  const empty: FigSource = { indexFigures: [], figures: {}, assetData: {} };
  const fig = fileBridge();
  if (!fig) return empty;

  let index: FigIndexFile | null = null;
  try {
    const p = joinPath(root, SUB, "index.json");
    if (await fig.exists(p)) index = JSON.parse(await fig.readText(p)) as FigIndexFile;
  } catch {
    index = null;
  }
  if (!index) return empty;

  const canvasMeta = index.canvases?.length
    ? [...index.canvases].sort((a, b) => a.order - b.order)
    : [];
  const figures: Record<string, Figure> = {};
  for (const cm of canvasMeta) {
    try {
      const p = joinPath(root, SUB, "canvases", `${cm.id}.json`);
      if (await fig.exists(p)) {
        const cf = JSON.parse(await fig.readText(p)) as CanvasFile;
        for (const f of cf.figures ?? []) {
          f.canvasId = cm.id;
          figures[f.id] = f;
        }
      }
    } catch {
      /* skip unreadable canvas */
    }
  }
  // Same migration every loader runs (legacy type:"svg" → plot, …) — this is a
  // read-only view for the Paper module / slide embedFigure, so unmigrated
  // on-disk docs must still render through the current element union.
  migrateProject({
    version: 2,
    name: "",
    canvases: [],
    figures: Object.values(figures),
    assets: index.assets ?? [],
    palette: [],
  });

  const assetData: Record<string, string> = {};
  for (const a of index.assets ?? []) {
    if (!a.path) continue;
    try {
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, SUB, a.path)));
      assetData[a.id] = bytesToDataUrl(bytes, mimeFor(a.kind));
    } catch {
      /* skip missing asset bytes */
    }
  }

  // Prefer the per-figure caption file (F7 single-source); fall back to the
  // cached index caption for older projects without caption files.
  const captionMd: Record<string, string> = {};
  for (const f of index.figures ?? []) {
    try {
      const cp = joinPath(root, SUB, "captions", `${f.id}.md`);
      if (await fig.exists(cp)) captionMd[f.id] = (await fig.readText(cp)).trim();
    } catch {
      /* skip unreadable caption */
    }
  }

  return {
    indexFigures: (index.figures ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      order: f.order,
      canvas: f.canvas,
      caption: captionMd[f.id] ?? f.caption ?? "",
      panels: figures[f.id] ? panelLetters(figures[f.id]) : [],
    })),
    figures,
    assetData,
  };
}
