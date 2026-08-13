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
import { plotManifests, plotRecipes, clearPlots, primePlotSidecars } from "../plot/store";
import { captureSnipMeta, clearSnipMeta } from "../snipMeta";
import { isDerivedManifest } from "../plot/derive";
import type { FluxPlotManifest } from "../plot/types";
import { FLEXOKI } from "../flexoki";
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from "../migrate";
import { healPlotSources } from "../plot/source";
import { computeFamilyNumbers } from "../figfamily";
import type { FigureFamilyDef } from "../figfamily";
import { validateModel, validateFigIndexFile, sanitizeProjectGeometry } from "./validate";
import { quarantineCopy } from "./quarantine";
import { pushToast } from "../toast";
import { isNewerSchema, newerSchemaMessage, FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from "./types";
import { settings } from "../settings";
import { panelLetters } from "../captions";
import { applyTextLayout } from "../text";
import { fileBridge, joinPath } from "./types";
import { ConflictError } from "../autosave";
import { assertStoreTenant } from "../tenancy";
import {
  planFigSave,
  executeFigSave,
  sortedCanvasMeta,
  normalizeIndexAssets,
  type FigIndexFile,
  type CanvasFile,
  type FigSaveIO,
} from "./figfiles";

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

/** WS-5.4: has any canvas file changed on disk since we loaded/wrote it? The
 *  index-only check missed an agent editing `canvases/<id>.json` in place (same
 *  canvas set → identical index) — the GUI's next autosave silently clobbered
 *  it. A baselined file that VANISHED counts as divergence too. */
async function canvasesDiverged(
  fig: NonNullable<ReturnType<typeof fileBridge>>,
  root: string,
): Promise<boolean> {
  for (const [id, baseline] of canvasBaseline) {
    try {
      const p = joinPath(root, SUB, "canvases", `${id}.json`);
      const onDisk = (await fig.exists(p)) ? await fig.readText(p) : "";
      if (onDisk !== baseline) return true;
    } catch {
      return true; // unreadable where we have a baseline — treat as diverged
    }
  }
  return false;
}

/** W7: has the fig/ subsystem changed on disk since we loaded/saved it? (used by
 *  the FigureMode divergence banner + W10 live-reload). WS-5.4: checks the index
 *  AND every baselined canvas file. */
export async function figDiskDiverged(root: string): Promise<boolean> {
  const fig = fileBridge();
  if (!fig || figIndexBaseline == null) return false;
  if ((await readFigIndexText(fig, root)) !== figIndexBaseline) return true;
  return canvasesDiverged(fig, root);
}

// WS-5.6: the on-disk shapes + writer plan live in the ONE persistence core
// (figfiles.ts) shared with flux-core — this module keeps only the GUI-side
// concerns: stores, dirty tracking, baselines, conflict banner, quarantine UX.

/** Load the project's `fig/` subsystem into the figure-editor stores. */
export async function loadFigInto(root: string, projectName: string): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;

  figSubsystemLocked = false;
  canvasBaseline.clear();
  let index: FigIndexFile | null = null;
  let indexText = "";
  try {
    const p = joinPath(root, SUB, "index.json");
    if (await fig.exists(p)) {
      indexText = await fig.readText(p);
      index = JSON.parse(indexText) as FigIndexFile;
      // WS-5.2 forward-version guard: a NEWER fig format must not be migrated
      // DOWN and rewritten — refuse the subsystem (saves locked) instead.
      if (isNewerSchema(index.schemaVersion, FIG_INDEX_SCHEMA_VERSION)) {
        pushToast("error", "Figure subsystem written by a newer Flux", {
          detail: newerSchemaMessage("fig/index.json", index.schemaVersion, FIG_INDEX_SCHEMA_VERSION),
        });
        figSubsystemLocked = true;
        return;
      }
      // WS-5.1 load gate: a structurally-invalid index is quarantined (bytes
      // preserved as .corrupt-<ts>) and the load proceeds with defaults —
      // never silently half-parsed.
      const errs = validateFigIndexFile(index);
      if (errs.length) {
        const q = await quarantineCopy(fig, p, indexText);
        pushToast("error", "fig/index.json failed validation — starting from defaults", {
          detail: `${errs.slice(0, 5).join("\n")}${q ? `\nOriginal preserved at ${q}` : ""}`,
        });
        index = null;
        indexText = "";
      }
    }
  } catch {
    index = null;
  }
  figIndexBaseline = indexText; // W7: seed the conflict-guard baseline

  // Canvas list comes from the index (canonical order via the shared core);
  // fall back to a single default canvas.
  const sorted = sortedCanvasMeta(index);
  const canvasMeta = sorted.length ? sorted : [{ id: DEFAULT_CANVAS_ID, name: "Canvas 1", order: 1 }];

  const canvases: Canvas[] = canvasMeta.map((c) => ({ id: c.id, name: c.name }));
  const figures: Figure[] = [];
  for (const cm of canvasMeta) {
    try {
      const p = joinPath(root, SUB, "canvases", `${cm.id}.json`);
      if (await fig.exists(p)) {
        const text = await fig.readText(p);
        const cf = JSON.parse(text) as CanvasFile;
        // WS-5.2: a single newer-format canvas refuses the WHOLE subsystem —
        // loading around it would drop its figures from the next index write.
        if (isNewerSchema(cf.schemaVersion, CANVAS_SCHEMA_VERSION)) {
          pushToast("error", `Canvas "${cm.name}" written by a newer Flux — figure editing disabled`, {
            detail: newerSchemaMessage(`fig/canvases/${cm.id}.json`, cf.schemaVersion, CANVAS_SCHEMA_VERSION),
          });
          figSubsystemLocked = true;
          return;
        }
        // WS-5.1 load gate (parse → migrate → validate): migrate THIS canvas's
        // figures, validate them, and on failure quarantine the FILE + skip it
        // — sibling canvases still load (the malformed-canvas acceptance).
        const probe = {
          version: 2,
          name: "",
          canvases: [{ id: cm.id, name: cm.name }],
          figures: (cf.figures ?? []).map((f) => ({ ...f, canvasId: cm.id })),
          assets: index?.assets ?? [],
          palette: [],
        } as FigProject;
        migrateProject(probe);
        // Absolute source paths (older GUI imports, or this project opened at a
        // different path than it was imported at) become project-relative, so
        // the next save of this canvas leaves a portable file behind.
        healPlotSources(probe, root);
        const errs = validateModel(probe);
        if (errs.length) {
          const q = await quarantineCopy(fig, p, text);
          pushToast("error", `Canvas "${cm.name}" failed validation — skipped`, {
            detail: `${errs.slice(0, 5).join("\n")}${q ? `\nOriginal preserved at ${q}` : ""}`,
          });
          continue;
        }
        for (const f of probe.figures) figures.push(f);
        canvasBaseline.set(cm.id, text); // WS-5.3: seed the skip-unchanged baseline
      }
    } catch {
      /* unreadable canvas file — skip */
    }
  }

  // WS-5.6: the shared normalization — same tree, same in-memory model as
  // flux-core (name/path/size fallbacks; dpi kept only when present).
  //
  // LAZY residency (2026-07-21, plan §5.2): `model.assets` + `assetData` bytes
  // + sidecar manifests/recipes load eagerly (all cheap, and the metadata is
  // the save-safety invariant — the index regenerates from model.assets, so it
  // must stay 100% resident). The DOM PARSE is what's deferred: PlotElement
  // requests it on mount (requestPlotDom), plots render the full-fidelity
  // <image> fallback until it lands, and an LRU bounds the resident set —
  // O(active figure) instead of O(project). Mirrors io.ts openProject exactly.
  const assets: Asset[] = normalizeIndexAssets(index);
  const data: Record<string, string> = {};
  const primedManifests: Record<string, FluxPlotManifest> = {};
  const primedRecipes: Record<string, unknown> = {};
  clearPlots();
  clearSnipMeta(); // project-load boundary — snip provenance re-derives from the bytes below
  for (const a of assets) {
    if (!a.path) continue;
    try {
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, SUB, a.path)));
      data[a.id] = bytesToDataUrl(bytes, mimeFor(a.kind));
      if (a.kind === "png") captureSnipMeta(a.id, bytes);
      if (a.kind === "svg") {
        const mpath = joinPath(root, SUB, "assets", `${a.id}.fluxplot.json`);
        if (await fig.exists(mpath)) {
          primedManifests[a.id] = JSON.parse(await fig.readText(mpath)) as FluxPlotManifest;
          const rpath = joinPath(root, SUB, "assets", `${a.id}.recipe.json`);
          if (await fig.exists(rpath)) primedRecipes[a.id] = JSON.parse(await fig.readText(rpath));
        }
        // Vanilla svg (no sidecar): its DERIVED manifest appears on first
        // parse, same retroactive-deriver rule as the old eager path.
      }
    } catch {
      /* missing asset bytes — skip */
    }
  }
  primePlotSidecars(primedManifests, primedRecipes);
  assetData.set(data);
  clearAllAssetsDirty(); // W8: freshly loaded — every asset is in sync with disk

  // WS-12: heal headless-edited text now that fonts are measurable — flagged
  // elements re-wrap here (applyTextLayout clears needsLayout), so a GUI open
  // restores render parity and the next save persists honest wrap caches.
  if (typeof document !== "undefined") {
    for (const f of figures)
      for (const e of f.elements) if (e.type === "text" && e.needsLayout) applyTextLayout(e);
  }

  const proj: FigProject = {
    version: 2,
    name: projectName || "Untitled",
    canvases,
    figures,
    assets,
    palette: index?.palette ?? [],
    colorGroups:
      (index?.colorGroups as ColorGroup[] | undefined) ??
      (get(settings).flexokiDefault ? structuredClone(FLEXOKI) : []),
    // undefined (never []) when the index predates styles → migrate seeds the
    // defaults; an explicit empty list from disk stays empty (user cleared it).
    ...(index?.textStyles !== undefined ? { textStyles: index.textStyles } : {}),
    ...(index?.families !== undefined ? { figureFamilies: index.families } : {}),
  };
  // Figure families (fig-subsystem-only — never runs on slide-projected
  // Projects): seed family/number/nickname from index hints + legacy names,
  // then heal numbers to contiguity. Cross-canvas, so it runs on the full
  // collection here, not in the per-canvas probes above.
  migrateFigureFamilies(proj, familyHintsFrom(index?.figures));
  figLoad(proj, null); // normalizes (incl. migrate), resets history, dirty=false
}

// WS-5.2: set when a load refused the subsystem (newer on-disk format) —
// saving would downgrade files this build doesn't understand.
let figSubsystemLocked = false;

// WS-5.3: last-written/loaded serialized text per canvas — the skip-unchanged
// guard (and WS-5.4's divergence probe reads the same baseline).
const canvasBaseline = new Map<string, string>();

/** Persist the figure-editor stores into the project's `fig/` subsystem. */
export async function saveFigFrom(root: string, opts: { force?: boolean } = {}): Promise<void> {
  // Tenancy guard (slide-migration §3.2.1): slide mode loads a deck's slides
  // into the SAME app-global store this save reads. If a kept-alive
  // FigureMode's autosave ever fired then, it would write the deck's projected
  // slides into fig/ — refuse structurally instead (the autosave error path
  // surfaces the throw; nothing is written).
  assertStoreTenant("figure", "fig/ save");
  const fig = fileBridge();
  if (!fig) return;
  if (figSubsystemLocked) {
    throw new Error("figure subsystem is read-only: its on-disk format is newer than this Flux");
  }

  // W7 conflict guard: if fig/index.json changed on disk since we loaded/saved
  // (an agent or CLI edited the figure subsystem), don't clobber it — throw so
  // the FigureMode banner offers reload/overwrite. The shared autosave controller
  // treats ConflictError as stay-dirty-no-retry. `force` (the banner's Overwrite)
  // skips the check and makes the editor's version win. WS-5.4: per-canvas
  // divergence throws the same way — an in-place canvas edit leaves the index
  // byte-identical, so the index-only guard never saw it.
  if (!opts.force && figIndexBaseline != null) {
    if ((await readFigIndexText(fig, root)) !== figIndexBaseline || (await canvasesDiverged(fig, root))) {
      throw new ConflictError("figure subsystem changed on disk");
    }
  }
  if (opts.force) {
    // Overwrite-with-mine: the skip-unchanged baselines describe what WE last
    // wrote — not what's on disk anymore. Without re-baselining, a canvas whose
    // MODEL text still matches our baseline would be skipped and the external
    // edit would silently WIN an explicit Overwrite. Clearing forces a full
    // rewrite; re-reading the index makes index.json.bak preserve the external
    // version being clobbered (the only copy of it).
    canvasBaseline.clear();
    figIndexBaseline = await readFigIndexText(fig, root);
  }

  const genAtStart = editGen.n; // W4: only clear dirty if no edit lands mid-save
  const p = structuredClone(get(figProject));
  // WS-5.1: never persist NaN/Infinity — JSON turns them into null, which the
  // load gate would then (rightly) reject.
  {
    const fixed = sanitizeProjectGeometry(p);
    if (fixed) pushToast("info", `Repaired ${fixed} non-finite geometry value(s) while saving`);
  }
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

  // WS-5.6: the write set (canvases + captions + index) comes from the ONE
  // persistence core shared with flux-core; prev = the index we believe is on
  // disk (the W7 guard above ensured disk == baseline, and the force path
  // re-baselined from disk), so labels/kinds set by agents are preserved.
  let prevIndex: FigIndexFile | null = null;
  try {
    prevIndex = figIndexBaseline ? (JSON.parse(figIndexBaseline) as FigIndexFile) : null;
  } catch {
    prevIndex = null;
  }
  const plan = planFigSave(p, prevIndex);
  const io: FigSaveIO = {
    read: async (rel) => {
      try {
        const abs = joinPath(root, rel);
        return (await fig.exists(abs)) ? await fig.readText(abs) : null;
      } catch {
        return null;
      }
    },
    write: (rel, text) => fig.writeText(joinPath(root, rel), text),
    ...(fig.fsyncDir ? { fsyncDir: (rel: string) => fig.fsyncDir!(joinPath(root, rel)) } : {}),
  };
  const adopt = (rel: string, text: string) => {
    const m = /^fig\/canvases\/(.+)\.json$/.exec(rel);
    if (m) canvasBaseline.set(m[1], text); // WS-5.3/5.4 skip + divergence baseline
  };
  await executeFigSave(plan, io, {
    skipCanvas: (id, text) => (canvasBaseline.get(id) === text ? true : undefined),
    onWrite: adopt,
    onSkip: adopt,
  });
  figIndexBaseline = plan.index.text; // W7: adopt what we just wrote as the new baseline

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
  name: string; // derived display name ("Supplementary Figure 4")
  label: string;
  order: number;
  family: string; // family id — resolved here, never absent (figfamily.ts)
  number: number; // position within family (healed)
  nickname?: string;
  canvas: string;
  caption: string;
  panels: string[]; // ordered panel letters ["a","b",…] for sub-panel refs (F7)
}
export interface FigSource {
  indexFigures: FigSourceFigure[];
  families: FigureFamilyDef[]; // custom family defs (built-ins never persisted)
  figures: Record<string, Figure>; // by figure id (with elements, for rendering)
  assetData: Record<string, string>; // by asset id → data URL
  /** Migrated asset metadata (dims + dpi) — feeds assetDisplaySize for crop
   *  rendering in the paper module's renderFigureSvg. */
  assets: Asset[];
  /** Asset-local `.fluxplot.json` sidecars — group-keyed overrides need them
   *  to resolve when the paper module bakes per-part edits (inlineMarkup). */
  assetManifests: Record<string, FluxPlotManifest>;
}

export async function readFigSource(root: string): Promise<FigSource> {
  const empty: FigSource = {
    indexFigures: [],
    families: [],
    figures: {},
    assetData: {},
    assets: [],
    assetManifests: {},
  };
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

  const canvasMeta = sortedCanvasMeta(index);
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
  const srcAssets = normalizeIndexAssets(index);
  const view = {
    version: 2,
    name: "",
    canvases: [],
    figures: Object.values(figures),
    assets: srcAssets,
    palette: [],
    ...(index.families !== undefined ? { figureFamilies: index.families } : {}),
  } as FigProject;
  migrateProject(view);
  // Family identity for the read-only view: same seeding + healing as the
  // editor load, so paper-side numbering matches what the figure editor shows.
  migrateFigureFamilies(view, familyHintsFrom(index.figures));

  const assetData: Record<string, string> = {};
  const assetManifests: Record<string, FluxPlotManifest> = {};
  for (const a of srcAssets) {
    if (!a.path) continue;
    try {
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, SUB, a.path)));
      assetData[a.id] = bytesToDataUrl(bytes, mimeFor(a.kind));
      if (a.kind === "png") captureSnipMeta(a.id, bytes);
    } catch {
      /* skip missing asset bytes */
    }
    if (a.kind === "svg") {
      // Same sidecar the editor load primes (io.ts) — optional: a vanilla svg
      // without one derives its manifest at prepare time (inlineMarkup).
      try {
        const mpath = joinPath(root, SUB, `assets/${a.id}.fluxplot.json`);
        if (await fig.exists(mpath))
          assetManifests[a.id] = JSON.parse(await fig.readText(mpath)) as FluxPlotManifest;
      } catch {
        /* unreadable sidecar — leaf-id overrides still apply */
      }
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

  // Healed identity per index entry: prefer the migrated in-memory figure;
  // an index-only entry (unreadable canvas file) falls back to its stored
  // fields, run through the same healer so numbers stay consistent.
  const carriers = (index.figures ?? []).map(
    (f) =>
      figures[f.id] ??
      ({ id: f.id, name: f.name, family: f.family, number: f.number } as Figure),
  );
  const healedIds = computeFamilyNumbers(carriers);

  return {
    indexFigures: (index.figures ?? []).map((f) => {
      const m = figures[f.id];
      const h = healedIds.get(f.id) ?? { family: "figure", number: f.order };
      const nickname = m?.nickname ?? f.nickname;
      return {
        id: f.id,
        name: m?.name ?? f.name,
        label: f.label,
        order: f.order,
        family: h.family,
        number: h.number,
        ...(nickname ? { nickname } : {}),
        canvas: f.canvas,
        caption: captionMd[f.id] ?? f.caption ?? "",
        panels: figures[f.id] ? panelLetters(figures[f.id]) : [],
      };
    }),
    families: index.families ?? [],
    figures,
    assetData,
    assets: view.assets, // post-migration (dims + pHYs dpi intact)
    assetManifests,
  };
}
