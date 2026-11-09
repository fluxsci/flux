import { referenceSyncBridgeIO } from './referenceSyncBridgeIO';
import "../editorCore"; // links the editor core into the store (./editorLink)
import { figureSnapshotBridgeIO } from "./figureSnapshotBridgeIO";
import { generationBridgeIO } from "./generationBridgeIO";
import { stageFigureRegistration } from "./figureGeneration";
import type { TextGenerationIO } from "./textGeneration";
import { commitTextGeneration, recoverTextGeneration } from "./textGeneration";
// Browser adapter for the shared source planner. This service belongs to the
// project, not whichever editor happens to own the global figure store.
import { get, writable } from "svelte/store";
import type { Project, Figure, SemanticPlotElement } from "../types";
import { project, mutate, commit, embeddedProjectRoot, publishAcceptedFigureSources } from "../store";
import { storeTenant } from "../tenancy";
import { assetData, dataUrlToBytes } from "../assets";
import { plotManifests, plotRecipes } from "../plot/store";
import { reimportPlot } from "../io";
import { fileBridge, joinPath, isNewerSchema, newerSchemaMessage, FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from "./types";
import { readFigureSnapshot, requireCompleteFigureSnapshot } from "./figureSnapshot";
import { figureStoreRoot, saveFigFrom } from "./figbridge";
import { planFigSave, executeFigSave, normalizeIndexAssets, sortedCanvasMeta, type FigIndexFile } from "./figfiles";
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from "../migrate";
import { ensureFigureReferenceKeys } from "./figureIdentity";
import { reconcileCaptionFiles, captionConflictMessage } from "./captionReconcile";
import { validateModel, validateFigIndexFile } from "./validate";
import { recoverFigureReferenceUpdate } from "./figureReferenceSync";
import { applySourceUpdates, planSourceUpdates, proveSourceUpdates, writeSourceUpdates, type SourceStatus, type SourceProofs } from "../plot/sourceSync";
import { withIpcLock } from "../references/libLock";
import { isUnderRoot, toProjectRelativeSource } from "../plot/source";
import { newId } from "../ids";
import { ConflictError } from "../autosave";
import { bumpFigRevision } from "../../shell/scholar/revisions";
import type { FluxPlotManifest } from "../plot/types";
import { figureSourceOwners } from "./figureSourceOwners";
import { pushToast } from "../toast";

export const sourceStatuses = writable<Record<string, SourceStatus>>({});
export interface SourceSyncReport { changed: string[]; statuses: SourceStatus[]; checked: number }
const inflight = new Map<string, Promise<SourceSyncReport>>();
const pending = new Set<string>();
const liveFigure = (root: string) => storeTenant() === "figure" && figureStoreRoot() === root && get(embeddedProjectRoot) === root;
const validSvg = (text: string) => !new DOMParser().parseFromString(text, "image/svg+xml").querySelector("parsererror");

// Source proofs (plot/sourceSync.ts SourceProofs), kept per project in the machine-local
// cache so the FIRST check after launch is also stat-only. The file is advisory: a missing,
// unreadable or stale one only means sources are compared by content once more.
const PROOFS_VERSION = 1;
const proofsPath = (root: string) => joinPath(root, ".meta", "cache", "source-proofs.json");
const proofStores = new Map<string, Promise<{ map: Map<string, string>; dirty: boolean }>>();
function loadProofs(root: string): Promise<{ map: Map<string, string>; dirty: boolean }> {
  let store = proofStores.get(root);
  if (!store) {
    store = (async () => {
      const map = new Map<string, string>();
      try {
        const fb = fileBridge()!, path = proofsPath(root);
        if (await fb.exists(path)) {
          const file = JSON.parse(await fb.readText(path)) as { version?: number; proofs?: Record<string, unknown> };
          if (file?.version === PROOFS_VERSION && file.proofs && typeof file.proofs === "object")
            for (const [key, proof] of Object.entries(file.proofs)) if (typeof proof === "string") map.set(key, proof);
        }
      } catch { /* advisory */ }
      return { map, dirty: false };
    })();
    if (proofStores.size > 8) proofStores.clear();
    proofStores.set(root, store);
  }
  return store;
}
async function sourceProofs(root: string): Promise<{ proofs: SourceProofs | undefined; flush(): Promise<void> }> {
  const fb = fileBridge();
  if (!fb?.stat) return { proofs: undefined, flush: async () => {} };
  const store = await loadProofs(root);
  return {
    proofs: {
      get: key => store.map.get(key),
      set: (key, proof) => { if (store.map.get(key) !== proof) { store.map.set(key, proof); store.dirty = true; } },
      delete: key => { if (store.map.delete(key)) store.dirty = true; },
    },
    async flush() {
      if (!store.dirty) return;
      store.dirty = false;
      try {
        await fb.mkdir(joinPath(root, ".meta", "cache"));
        await fb.writeText(proofsPath(root), JSON.stringify({ version: PROOFS_VERSION, proofs: Object.fromEntries(store.map) }));
      } catch { store.dirty = true; }
    },
  };
}

async function readModel(root: string): Promise<{ project: Project; index: FigIndexFile; baselines: Map<string, string | null> }> {
  const fb = fileBridge()!;
  await recoverFigureReferenceUpdate(root, referenceSyncBridgeIO(root, fb));
  const snapshot = requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotBridgeIO(root, fb)));
  if (!snapshot.index) throw new Error("Missing fig/index.json");
  return { project: snapshot.project, index: snapshot.index, baselines: snapshot.baselines };
}
function publish(statuses: SourceStatus[]) {
  sourceStatuses.set(Object.fromEntries(statuses.map((s) => [s.assetId, s])));
}

/** Inspect only; no implicit changes when a Details panel opens. */
export async function sourceDetails(root: string): Promise<SourceStatus[]> {
  const fb = fileBridge();
  if (!fb) return [];
  const model = liveFigure(root) ? get(project) : (await readModel(root)).project;
  const owners = await figureSourceOwners(root, model, fb);
  const proved = await sourceProofs(root);
  const plan = await planSourceUpdates(root, owners.project, { ...fb, validateSvg: validSvg }, { proofs: proved.proofs });
  void proved.flush();
  return plan.statuses.map((s) => s.status === "updating" ? { ...s, detail: "A newer source is ready to reload" } : s);
}

/** Serialize explicit reload and watcher refresh. A successful revision is
 * published only AFTER asset bytes and their composition metadata persist. */
export function syncProjectSources(root: string, opts: { isCurrent?: () => boolean } = {}): Promise<SourceSyncReport> {
  const existing = inflight.get(root);
  if (existing) { pending.add(root); return existing; }
  const run = (async () => {
    let result: SourceSyncReport;
    const changed = new Set<string>();
    do {
      pending.delete(root);
      result = await sync(root, opts);
      for (const id of result.changed) changed.add(id);
    } while (pending.has(root) && (!opts.isCurrent || opts.isCurrent()));
    return { ...result, changed: [...changed] };
  })().finally(() => { inflight.delete(root); pending.delete(root); });
  inflight.set(root, run);
  return run;
}
async function sync(root: string, opts: { isCurrent?: () => boolean }): Promise<SourceSyncReport> {
  const fb = fileBridge();
  if (!fb) return { changed: [], statuses: [], checked: 0 };
  const wasLive = liveFigure(root);
  const disk = wasLive ? null : await readModel(root);
  const model = wasLive ? structuredClone(get(project)) : disk!.project;
  const owners = await figureSourceOwners(root, model, fb);
  const proved = await sourceProofs(root);
  const plan = await planSourceUpdates(root, owners.project, { ...fb, validateSvg: validSvg }, { proofs: proved.proofs });
  void proved.flush();
  if (opts.isCurrent && !opts.isCurrent()) return { changed: [], statuses: [], checked: plan.checked };
  // Mode switching during IO must not write a deck into fig/ or resurrect the
  // previous project's cache. The next open/watch/reload will retry safely.
  if (wasLive !== liveFigure(root)) return { changed: [], statuses: plan.statuses, checked: plan.checked };
  const previousStatuses = get(sourceStatuses);
  for (const status of plan.statuses) {
    if (!owners.deckAssetIds.has(status.assetId) || (status.status !== "error" && status.status !== "missing")) continue;
    const previous = previousStatuses[status.assetId];
    if (previous?.status !== status.status || previous.detail !== status.detail || previous.path !== status.path)
      pushToast("error", `Slide source ${status.status === "missing" ? "missing" : "update failed"}`, { detail: `${status.path}: ${status.detail ?? "Last saved version retained"}` });
  }
  publish(plan.statuses);
  if (!plan.updates.length) return { changed: [], statuses: plan.statuses, checked: plan.checked };
  try {
    await owners.assertUnchanged();
    if (opts.isCurrent && !opts.isCurrent() || wasLive !== liveFigure(root)) return { changed: [], statuses: plan.statuses, checked: plan.checked };
    if (wasLive) {
      // Persist a private candidate first. Failed writes never become accepted
      // source bytes/sizes, and typing remains live throughout preparation.
      await saveFigFrom(root, { sourceUpdates: plan.updates, sourceOwnersUnchanged: owners.assertUnchanged });
      if (!liveFigure(root) || (opts.isCurrent && !opts.isCurrent())) return { changed: [], statuses: plan.statuses, checked: plan.checked };
      const accepted = [];
      for (const u of plan.updates) {
        if (!get(project).assets.some(a => a.id === u.assetId)) continue;
        if (!reimportPlot(u.assetId, u.bundle.svgText,
          u.bundle.manifestText ? JSON.parse(u.bundle.manifestText) : undefined,
          u.bundle.recipeText ? JSON.parse(u.bundle.recipeText) : undefined, { markEdited: false })) throw new Error(`Could not publish validated source ${u.assetId}`);
        accepted.push(u);
      }
      publishAcceptedFigureSources(accepted);
      // Keep the trailing save: independent edits made during I/O must persist.
      await saveFigFrom(root);
    } else {
      await withIpcLock("project", "project", async lease => withIpcLock("project", "slides", async slidesLease => withIpcLock("project", "manifest", async manifestLease => {
      const io = generationBridgeIO(root, fb);
      await recoverTextGeneration(io,async()=>{await lease.assertOwned?.();await slidesLease.assertOwned?.();await manifestLease.assertOwned?.()});
      await owners.assertUnchanged();
      for (const [rel, baseline] of disk!.baselines) {
        if (await io.read(rel) !== baseline) throw new ConflictError("Figures changed while sources were being read; reload sources again");
      }
      applySourceUpdates(model, plan.updates);
      const staged = new Map<string,string|null>();
      await writeSourceUpdates(root, plan.updates, {
        writeText: async(abs,text)=>{staged.set(abs.slice(root.replace(/\/$/, "").length+1),text)},
        remove:async abs=>{staged.set(abs.slice(root.replace(/\/$/, "").length+1),null)},
      }, model);
      const writes = planFigSave(model, disk!.index, disk!.baselines);
      const read = async(rel:string) => await fb.exists(joinPath(root,rel)) ? fb.readText(joinPath(root,rel)) : null;
      await executeFigSave(writes,{read,write:async(rel,text)=>{staged.set(rel,text)}});
      await stageFigureRegistration(io, JSON.parse(writes.index.text), staged);
      await commitTextGeneration(io,staged,async()=>{await lease.assertOwned?.();await slidesLease.assertOwned?.();await manifestLease.assertOwned?.()});
      }, { root }), { root }), { root });
    }
    for (const status of plan.statuses) if (status.status === "updating") status.status = "current";
    publish(plan.statuses);
    await proveSourceUpdates(plan.updates, fb, proved.proofs);
    void proved.flush();
    bumpFigRevision();
    return { changed: plan.updates.map((u) => u.assetId), statuses: plan.statuses, checked: plan.checked };
  } catch (error) {
    for (const status of plan.statuses) if (status.status === "updating") { status.status = "error"; status.detail = String((error as Error)?.message ?? error); }
    publish(plan.statuses);
    throw error;
  }
}

/** Change a source for this figure's placements only. A fresh asset ID keeps
 * unrelated figures and decks on their existing link/version. Undo is the
 * ordinary figure history operation. Root UI chooses the source file. */
export async function setFigureSourceLink(root: string, opts: { figureId: string; assetId: string; svgPath?: string; frozen?: boolean }): Promise<void> {
  if (!liveFigure(root)) throw new Error("Open this figure before changing its source link");
  const p = get(project), sourceAsset = p.assets.find((a) => a.id === opts.assetId);
  const url = get(assetData)[opts.assetId];
  if (!sourceAsset || !url) throw new Error("The saved source asset is unavailable");
  const f = p.figures.find((f) => f.id === opts.figureId);
  if (!f) throw new Error("Figure not found");
  const placements = f.elements.filter((e): e is SemanticPlotElement => e.type === "plot" && e.assetId === opts.assetId);
  if (!placements.length) throw new Error("No matching plot placement");
  const assetId = newId("asset");
  const manifest = get(plotManifests)[opts.assetId], recipe = get(plotRecipes)[opts.assetId];
  commit((model) => {
    model.assets.push({ ...sourceAsset, id: assetId, path: `assets/${assetId}.svg` });
    const target = model.figures.find((f) => f.id === opts.figureId)!;
    for (const e of target.elements) if (e.type === "plot" && e.assetId === opts.assetId) {
      e.assetId = assetId;
      const svgPath = opts.svgPath ? toProjectRelativeSource(root, opts.svgPath) : e.source?.svgPath ?? "";
      e.source = { ...e.source, svgPath, ...(opts.svgPath ? { manifestPath: svgPath.replace(/\.svg$/i, ".fluxplot.json"), recipePath: svgPath.replace(/\.svg$/i, ".recipe.json"), external: !isUnderRoot(root, opts.svgPath) } : {}), frozen: opts.frozen ?? false };
    }
  });
  reimportPlot(assetId, new TextDecoder().decode(dataUrlToBytes(url)), manifest, recipe);
  await saveFigFrom(root);
  if (!opts.frozen) await syncProjectSources(root);
  else { const statuses = await sourceDetails(root); publish(statuses); bumpFigRevision(); }
}
