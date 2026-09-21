import { referenceSyncBridgeIO } from './referenceSyncBridgeIO';
import { figureSnapshotBridgeIO } from "./figureSnapshotBridgeIO";
import { generationBridgeIO } from "./generationBridgeIO";
import { stageFigureRegistration } from "./figureGeneration";
import { storedAssetPath } from "./assetPath";
// Adapter between the figure editor's in-memory model and the Flux project's
// `fig/` subsystem (Flux_Project_Format.md §3.2). Each canvas (page) is a file
// under `fig/canvases/<id>.json`; `fig/index.json` rolls them up (canvas list +
// figure numbering + palette + assets). The user never hand-edits `fig/`.

import { get } from "svelte/store";
import { readFigureSnapshot } from "./figureSnapshot";
import { withIpcLock, type IpcLease } from "../references/libLock";
import { applySourceUpdates, writeSourceUpdates, type SourceUpdate } from "../plot/sourceSync";
import { commitTextGeneration, recoverTextGeneration, bytesToBase64, type GenerationWrite } from "./textGeneration";
import type {
  Project as FigProject,
  Canvas,
  Figure,
  Asset,
  ColorGroup,
} from "../types";
import {
  project as figProject,
  dirty as figDirty,
  loadProject as figLoad,
  editGen,
  capturePersistenceGeneration,
} from "../store";
import {
  assetData,
  bytesToDataUrl,
  dataUrlToBytes,
  mimeFor,
  isAssetDirty,
  clearAssetDirty,
  clearAllAssetsDirty,
  assetDirtyGeneration,
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
import { composeCaption } from "../captions";
import { ensureFigureReferenceKeys } from "./figureIdentity";
import { reconcileCaptionFiles, captionConflictMessage, type CaptionBaseline } from "./captionReconcile";
import { prepareFigureReferenceUpdate, commitFigureReferenceUpdate, recoverFigureReferenceUpdate, releaseFigureReferenceUpdate } from "./figureReferenceSync";
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
let loadedFigureRoot: string | null = null;
let figureLoadRequest = 0;
export function figureStoreRoot(): string | null { return loadedFigureRoot; }

// W7 conflict guard: the raw fig/index.json text we last loaded or wrote — i.e.
// what we believe is on disk. saveFigFrom compares against it and refuses to
// clobber an agent/CLI write that landed since we loaded (surfacing a banner).
let figIndexBaseline: string | null = null;

async function readFigIndexText(
  fig: NonNullable<ReturnType<typeof fileBridge>>,
  root: string,
): Promise<string> {
  const p = joinPath(root, SUB, "index.json");
  return (await fig.exists(p)) ? await fig.readText(p) : "";
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
  if (await canvasesDiverged(fig, root)) return true;
  for (const [rel, baseline] of captionBaseline) {
    let text: string | null;
    text = await fig.exists(joinPath(root, rel)) ? await fig.readText(joinPath(root, rel)) : null;
    if (text !== baseline) return true;
  }
  return false;
}

// WS-5.6: the on-disk shapes + writer plan live in the ONE persistence core
// (figfiles.ts) shared with flux-core — this module keeps only the GUI-side
// concerns: stores, dirty tracking, baselines, conflict banner, quarantine UX.

/** Load the project's `fig/` subsystem into the figure-editor stores.
 *  `reload: true` = external-change reload (W10 / the banner): preserves the
 *  user's view where ids survive and makes the swap one undo entry (see
 *  store.LoadProjectOpts). Initial loads omit it. */
export async function loadFigInto(
  root: string,
  projectName: string,
  opts: { reload?: boolean } = {},
): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;
  const request = ++figureLoadRequest;
  await withIpcLock("project", "project", projectLease => withIpcLock("project", "slides", slidesLease => withIpcLock("project", "manifest", manifestLease => recoverTextGeneration(generationBridgeIO(root, fig), async()=>{await projectLease.assertOwned?.();await slidesLease.assertOwned?.();await manifestLease.assertOwned?.()}), { root }), { root }), { root });
  const ownerBefore = loadedFigureRoot;
  await recoverFigureReferenceUpdate(root, referenceSyncBridgeIO(root, fig));
  const generation = editGen.n;
  const snapshot = await readFigureSnapshot(figureSnapshotBridgeIO(root, fig));
  if (request !== figureLoadRequest) return;
  if (snapshot.status === "future-version") {
    if (!opts.reload) { figSubsystemLocked = true; figLoadFailure = snapshot.diagnostics.map(d => `${d.path}: ${d.message}`).join("\n"); }
    throw new Error(snapshot.diagnostics.map(d => `${d.path}: ${d.message}`).join("\n"));
  }
  if (opts.reload && snapshot.status !== "complete") throw new ConflictError(snapshot.diagnostics.map(d => `${d.path}: ${d.message}`).join("\n"));
  const proj = snapshot.project;
  proj.name = projectName || "Untitled";
  if (!proj.canvases.length) proj.canvases.push({ id: DEFAULT_CANVAS_ID, name: "Canvas 1" });
  if (snapshot.index?.colorGroups === undefined) proj.colorGroups = get(settings).flexokiDefault ? structuredClone(FLEXOKI) : [];
  healPlotSources(proj, root);
  const data: Record<string, string> = Object.create(null);
  const primedManifests: Record<string, FluxPlotManifest> = Object.create(null);
  const primedRecipes: Record<string, unknown> = Object.create(null);
  const pngs: [string, Uint8Array][] = [];
  for (const a of proj.assets) {
    if (a.kind === "mp4") throw new Error("Video assets cannot be loaded into Figure mode");
    if (!a.path) continue;
    try {
      const assetPath = fig.projectAssetPath ? await fig.projectAssetPath(root, storedAssetPath(`${SUB}/${a.path}`)) : joinPath(root, SUB, a.path);
      const bytes = new Uint8Array(await fig.readFile(assetPath));
      data[a.id] = bytesToDataUrl(bytes, mimeFor(a.kind));
      if (a.kind === "png") pngs.push([a.id, bytes]);
      if (a.kind === "svg") {
        const mpath = joinPath(root, SUB, "assets", `${a.id}.fluxplot.json`);
        if (await fig.exists(mpath)) primedManifests[a.id] = JSON.parse(await fig.readText(mpath));
        const rpath = joinPath(root, SUB, "assets", `${a.id}.recipe.json`);
        if (await fig.exists(rpath)) primedRecipes[a.id] = JSON.parse(await fig.readText(rpath));
      }
    } catch (error) { snapshot.diagnostics.push({ path: a.path, message: String(error) }); snapshot.status = "partial"; }
  }
  if (typeof document !== "undefined") for (const f of proj.figures) for (const e of f.elements) if (e.type === "text" && e.needsLayout) applyTextLayout(e);
  if (opts.reload && snapshot.status !== "complete") throw new ConflictError(snapshot.diagnostics.map(d => `${d.path}: ${d.message}`).join("\n"));
  const adopt = figureSaveQueue.catch(() => {}).then(() => withIpcLock("project", "project", async lease => {
    for (const [rel, baseline] of snapshot.baselines) {
      const current = await fig.exists(joinPath(root,rel)) ? await fig.readText(joinPath(root,rel)) : null;
      if (current !== baseline) throw new ConflictError(`Figures changed while reading ${rel}; reload again`);
    }
    await lease.assertOwned?.();
    if (request !== figureLoadRequest) return;
    if (editGen.n !== generation || (opts.reload && loadedFigureRoot !== ownerBefore)) throw new ConflictError("Figures changed while a reload was being prepared; your edits are retained");
    // Publication is one synchronous transition, after every awaited read.
    clearPlots(); clearSnipMeta();
    primePlotSidecars(primedManifests, primedRecipes); assetData.set(data);
    for (const [id, bytes] of pngs) captureSnipMeta(id, bytes);
    clearAllAssetsDirty();
    figIndexBaseline = snapshot.baselines.get("fig/index.json") ?? "";
    canvasBaseline.clear(); captionBaseline.clear();
    for (const [rel, text] of snapshot.baselines) {
      const match = /^fig\/canvases\/(.+)\.json$/.exec(rel);
      if (match && text !== null) canvasBaseline.set(match[1], text);
      else if (rel.startsWith("fig/captions/")) captionBaseline.set(rel, text);
    }
    acceptedCaptions = snapshot.captionBaselines;
    figSubsystemLocked = false;
    figLoadFailure = snapshot.status === "complete" ? null : snapshot.diagnostics.map(d => `${d.path}: ${d.message}`).join("\n");
    figLoad(proj, null, opts); loadedFigureRoot = root;
    if (figLoadFailure) pushToast("error", "Some figures could not be loaded", { detail: figLoadFailure + " Existing files will not be overwritten." });
  }, { root }));
  figureSaveQueue = adopt;
  await adopt;
  // A returning Figure tenant can still have this root's older accepted
  // baseline (for example after Slide → Figure conversion). Source catch-up
  // must use the newly adopted complete snapshot, never that stale editor.
  if (!opts.reload && snapshot.status === "complete" && request === figureLoadRequest) {
    try { await (await import("./sourceBridge")).syncProjectSources(root, { isCurrent: () => request === figureLoadRequest && loadedFigureRoot === root }); }
    catch (e) { if (request === figureLoadRequest) pushToast("error", "Some figure sources could not update", { detail: String((e as Error)?.message ?? e) }); }
  }
}

// WS-5.2: set when a load refused the subsystem (newer on-disk format) —
// saving would downgrade files this build doesn't understand.
let figSubsystemLocked = false;
let figLoadFailure: string | null = null;

// WS-5.3: last-written/loaded serialized text per canvas — the skip-unchanged
// guard (and WS-5.4's divergence probe reads the same baseline).
const canvasBaseline = new Map<string, string>();
const captionBaseline = new Map<string, string | null>();
// Legacy indexes can have an empty/stale caption cache even when canvas and
// Markdown agree. The accepted model at load is the honest three-way base.
let acceptedCaptions = new Map<string, CaptionBaseline>();

/** Persist the figure-editor stores into the project's `fig/` subsystem. */
let figureSaveQueue: Promise<void> = Promise.resolve();
export function saveFigFrom(root: string, opts: { force?: boolean; sourceUpdates?: readonly SourceUpdate[]; sourceOwnersUnchanged?: () => Promise<void> } = {}): Promise<void> {
  const next = figureSaveQueue.catch(() => {}).then(() => withIpcLock("project", "project", lease => opts.sourceUpdates?.length ? withIpcLock("project", "slides", async slidesLease => {await opts.sourceOwnersUnchanged?.(); await saveFigFromUnlocked(root, opts, lease, slidesLease)}, {root}) : saveFigFromUnlocked(root, opts, lease), { root }));
  figureSaveQueue = next;
  return next;
}
async function saveFigFromUnlocked(root: string, opts: { force?: boolean; sourceUpdates?: readonly SourceUpdate[]; sourceOwnersUnchanged?: () => Promise<void> } = {}, lease?: IpcLease, slidesLease?: IpcLease): Promise<void> {
  const assertOwned = async () => { await lease?.assertOwned?.(); await slidesLease?.assertOwned?.(); };
  await assertOwned();
  // Tenancy guard (slide-migration §3.2.1): slide mode loads a deck's slides
  // into the SAME app-global store this save reads. If a kept-alive
  // FigureMode's autosave ever fired then, it would write the deck's projected
  // slides into fig/ — refuse structurally instead (the autosave error path
  // surfaces the throw; nothing is written).
  assertStoreTenant("figure", "fig/ save");
  const fig = fileBridge();
  if (!fig) return;
  if (loadedFigureRoot !== root) throw new Error("Figure save belongs to a different project");
  if (figSubsystemLocked) {
    throw new Error("figure subsystem is read-only: its on-disk format is newer than this Flux");
  }
  if (figLoadFailure) throw new Error(figLoadFailure);
  await recoverFigureReferenceUpdate(root, referenceSyncBridgeIO(root, fig));

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
  // Explicit overwrite preserves BOTH branches first. Unknown IO failures still
  // propagate; a readable future format is never downgraded by this choice.
  if (opts.force) {
    const current = await readFigureSnapshot(figureSnapshotBridgeIO(root, fig));
    if (current.status === "future-version") throw new ConflictError("Newer figure format cannot be overwritten; save a recovery copy instead");
    if (current.missingIndexInventory === "unavailable") throw new ConflictError("Cannot overwrite figures while the missing-index inventory is unreadable: " + current.diagnostics.map(d => d.message).join("; "));
    const paths = new Set(["fig/index.json", ...[...canvasBaseline.keys()].map(id => `fig/canvases/${id}.json`), ...captionBaseline.keys(), ...current.baselines.keys()]);
    const theirs: Record<string, string | null> = Object.create(null);
    for (const rel of paths) theirs[rel] = await fig.exists(joinPath(root,rel)) ? await fig.readText(joinPath(root,rel)) : null;
    await lease?.assertOwned?.();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fig.mkdir(joinPath(root,".meta","figure-conflicts"));
    await fig.writeText(joinPath(root,".meta","figure-conflicts",`${stamp}.json`), JSON.stringify({version:1, winner:"editor including captions", theirs, acceptedIndex:figIndexBaseline, mine:get(figProject)},null,2));
    await fig.fsyncDir?.(joinPath(root,".meta","figure-conflicts"));
    await fig.fsyncDir?.(joinPath(root,".meta"));
  }

  capturePersistenceGeneration();
  const genAtStart = editGen.n; // W4: only clear dirty if no edit lands mid-save
  const p = structuredClone(get(figProject));
  if (opts.sourceUpdates?.length) applySourceUpdates(p, opts.sourceUpdates);
  const originalCaptions = new Map(p.figures.map((f) => [f.id, composeCaption(f)]));
  const previous = figIndexBaseline ? JSON.parse(figIndexBaseline) as FigIndexFile : null;
  const captions = opts.force ? { conflicts: [], imported: [] } : await reconcileCaptionFiles(p, previous, async (rel) => {
    return await fig.exists(joinPath(root, rel)) ? await fig.readText(joinPath(root, rel)) : null;
  }, acceptedCaptions);
  if (captions.conflicts.length) throw new ConflictError(captionConflictMessage(captions.conflicts));
  // WS-5.1: never persist NaN/Infinity — JSON turns them into null, which the
  // load gate would then (rightly) reject.
  {
    const errors = validateModel(p);
    if (errors.length) throw new Error(`Figures could not be saved: ${errors.slice(0, 5).join("; ")}`);
  }
  const data = get(assetData);
  const assetGenerations = new Map(p.assets.map((a) => [a.id, assetDirtyGeneration(a.id)]));
  const manifests = get(plotManifests);
  const recipes = get(plotRecipes);

  await fig.mkdir(joinPath(root, ".meta"));
  await fig.mkdir(joinPath(root, SUB));
  await fig.mkdir(joinPath(root, SUB, "canvases"));
  await fig.mkdir(joinPath(root, SUB, "assets"));
  await fig.mkdir(joinPath(root, SUB, "captions"));

  const stagedAssets=new Map<string,GenerationWrite>();
  // Asset bytes → fig/assets/<id>.<kind> (+ a semantic plot's sidecars next to it).
  // W8: only (re)write NEW (path-less) or CHANGED (dirty) assets — an unchanged
  // asset is already on disk, so a debounced save no longer rewrites MBs of bytes.
  for (const a of p.assets) {
    if (opts.sourceUpdates?.some(update => update.assetId === a.id)) continue;
    const url = data[a.id];
    const isNew = !a.path;
    if (!url) {
      if (isNew || isAssetDirty(a.id)) throw new Error(`Cannot save changed asset ${a.id}: its bytes are unavailable`);
      continue;
    }
    if (isNew) a.path = `assets/${a.id}.${a.kind}`; // ensure a path for the index
    if (!isNew && !isAssetDirty(a.id)) continue; // unchanged → skip the byte write
    await lease?.assertOwned?.();
    stagedAssets.set(storedAssetPath(`${SUB}/${a.path}`), {base64:bytesToBase64(dataUrlToBytes(url))});
    // NEVER persist a DERIVED manifest (same guard as io.ts writeProjectTo):
    // sidecar presence is the fluxplot/vanilla discriminator, and re-deriving
    // at every load keeps deriver improvements retroactive — a written derived
    // sidecar would freeze it and misclassify the vanilla svg as a fluxplot.
    const man = manifests[a.id];
    if (man && !isDerivedManifest(man)) {
      stagedAssets.set(`${SUB}/assets/${a.id}.fluxplot.json`, JSON.stringify(man, null, 2));
      const rec = recipes[a.id];
      if (rec !== undefined)
        stagedAssets.set(`${SUB}/assets/${a.id}.recipe.json`, JSON.stringify(rec, null, 2));
      else stagedAssets.set(`${SUB}/assets/${a.id}.recipe.json`,null);
    }
    else {
      stagedAssets.set(`${SUB}/assets/${a.id}.fluxplot.json`,null);
      stagedAssets.set(`${SUB}/assets/${a.id}.recipe.json`,null);
    }
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
  const plan = planFigSave(p, prevIndex, new Map([...canvasBaseline].map(([id,text])=>[`fig/canvases/${id}.json`,text])));
  const beforeFigures: Figure[] = [];
  for (const c of prevIndex?.canvases ?? []) {
    const text = canvasBaseline.get(c.id) ?? await fig.readText(joinPath(root, `fig/canvases/${c.id}.json`));
    beforeFigures.push(...(JSON.parse(text) as CanvasFile).figures);
  }
  const referenceUpdate = await prepareFigureReferenceUpdate(root, beforeFigures, p.figures, referenceSyncBridgeIO(root, fig), {
    index: prevIndex, figureFiles: [...plan.canvases, plan.index],
  });
  const io: FigSaveIO = {
    read: async (rel) => {
      const abs = joinPath(root, rel);
      return (await fig.exists(abs)) ? await fig.readText(abs) : null;
    },
    write: (rel, text) => fig.writeText(joinPath(root, rel), text),
    ...(fig.fsyncDir ? { fsyncDir: (rel: string) => fig.fsyncDir!(joinPath(root, rel)) } : {}),
  };
  try {
    const writes = stagedAssets;
    if (opts.sourceUpdates?.length) await writeSourceUpdates(root, opts.sourceUpdates, {
      writeText: async (abs,text) => { writes.set(abs.slice(root.replace(/\/$/, "").length + 1),text); },
      remove: async abs => { writes.set(abs.slice(root.replace(/\/$/, "").length + 1),null); },
    }, p);
    await executeFigSave(plan, { read: io.read, write: async (rel,text) => { writes.set(rel,text); } });
    await withIpcLock("project", "manifest", async manifestLease => {
      await stageFigureRegistration(io, JSON.parse(plan.index.text), writes);
      await commitTextGeneration(generationBridgeIO(root, fig), writes, async () => { await assertOwned(); await manifestLease.assertOwned?.(); });
    }, { root });
    await commitFigureReferenceUpdate(root, referenceUpdate, referenceSyncBridgeIO(root, fig));
  } catch (e) { await releaseFigureReferenceUpdate(root, referenceUpdate); throw e; }
  // Adopt only the committed generation, never partial per-file writes.
  canvasBaseline.clear();
  for (const canvas of plan.canvases) {
    const id = /^fig\/canvases\/(.+)\.json$/.exec(canvas.path)?.[1];
    if (id) canvasBaseline.set(id,canvas.text);
  }
  for (const a of p.assets) clearAssetDirty(a.id, assetGenerations.get(a.id));
  figIndexBaseline = plan.index.text; // W7: adopt what we just wrote as the new baseline
  captionBaseline.clear();
  for (const cap of plan.captions) captionBaseline.set(cap.path, cap.text);
  acceptedCaptions = new Map(p.figures.map(f => [f.id, { model: composeCaption(f).trim(), sidecar: composeCaption(f) + "\n" }]));
  if (loadedFigureRoot === root && captions.imported.length) figProject.update(model => {
    for (const id of captions.imported) {
      const live = model.figures.find(f => f.id === id);
      if (live && composeCaption(live) === originalCaptions.get(id)) live.captions = structuredClone(p.figures.find(f => f.id === id)!.captions);
    }
    return model;
  });

  // WS6: record the human's save in the provenance journal (Electron only; the
  // mem/demo bridge has no journalAppend, so this is a no-op there).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "save_fig", target: p.figures.map((f) => f.id), client: "human" });

  // W4: an edit that landed during the async writes above keeps its dirty flag,
  // so the autosave controller's trailing save persists it (previously the
  // unconditional clear silently dropped it until the next unrelated edit).
  if (!opts.sourceUpdates?.length && loadedFigureRoot === root && editGen.n === genAtStart) figDirty.set(false);
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
  /** Canvas list in canonical order (id + display name) — the FigurePicker's
   *  canvas-scope dropdown (issue #10). */
  canvases: { id: string; name: string }[];
}

// Paper's read-only view also needs an accepted base for legacy indexes with
// an empty caption cache. Bound this cache to the currently read project.
let readCaptionRoot: string | null = null;
let readCaptionBaselines = new Map<string, CaptionBaseline>();

export async function readFigSource(root: string): Promise<FigSource> {
  if (readCaptionRoot !== root) { readCaptionRoot = root; readCaptionBaselines.clear(); }
  const empty: FigSource = {
    indexFigures: [],
    families: [],
    figures: {},
    assetData: {},
    assets: [],
    assetManifests: {},
    canvases: [],
  };
  const fig = fileBridge();
  if (!fig) return empty;
  await recoverFigureReferenceUpdate(root, referenceSyncBridgeIO(root, fig));

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
  ensureFigureReferenceKeys(view, index);
  const captionState = await reconcileCaptionFiles(view, index, async (rel) => {
    return await fig.exists(joinPath(root, rel)) ? await fig.readText(joinPath(root, rel)) : null;
  }, readCaptionBaselines);
  if (readCaptionRoot === root) {
    for (const [id, baseline] of captionState.baselines) readCaptionBaselines.set(id, baseline);
    const ids = new Set(view.figures.map(f => f.id));
    for (const id of readCaptionBaselines.keys()) if (!ids.has(id)) readCaptionBaselines.delete(id);
  }
  if (captionState.conflicts.length) console.warn(captionConflictMessage(captionState.conflicts));

  const assetData: Record<string, string> = {};
  const assetManifests: Record<string, FluxPlotManifest> = {};
  for (const a of srcAssets) {
    if (a.kind === "mp4") throw new Error("Video assets cannot be loaded into Figure mode");
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
        label: m?.referenceKey ?? f.label,
        order: f.order,
        family: h.family,
        number: h.number,
        ...(nickname ? { nickname } : {}),
        canvas: f.canvas,
        caption: m ? composeCaption(m) : captionMd[f.id] ?? f.caption ?? "",
        panels: figures[f.id] ? panelLetters(figures[f.id]) : [],
      };
    }),
    families: index.families ?? [],
    figures,
    assetData,
    assets: view.assets, // post-migration (dims + pHYs dpi intact)
    assetManifests,
    canvases: canvasMeta.map((c) => ({ id: c.id, name: c.name })),
  };
}
