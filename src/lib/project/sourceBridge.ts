// Browser adapter for the shared source planner. This service belongs to the
// project, not whichever editor happens to own the global figure store.
import { get, writable } from "svelte/store";
import type { Project, Figure, SemanticPlotElement } from "../types";
import { project, mutate, commit, embeddedProjectRoot, acceptFigureSourceSizes } from "../store";
import { storeTenant } from "../tenancy";
import { assetData, dataUrlToBytes } from "../assets";
import { plotManifests, plotRecipes } from "../plot/store";
import { reimportPlot } from "../io";
import { fileBridge, joinPath, isNewerSchema, newerSchemaMessage, FIG_INDEX_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION } from "./types";
import { figureStoreRoot, saveFigFrom } from "./figbridge";
import { planFigSave, executeFigSave, normalizeIndexAssets, sortedCanvasMeta, type FigIndexFile } from "./figfiles";
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from "../migrate";
import { ensureFigureReferenceKeys } from "./figureIdentity";
import { reconcileCaptionFiles, captionConflictMessage } from "./captionReconcile";
import { validateModel, validateFigIndexFile } from "./validate";
import { recoverFigureReferenceUpdate } from "./figureReferenceSync";
import { applySourceUpdates, planSourceUpdates, writeSourceUpdates, type SourceStatus } from "../plot/sourceSync";
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

async function readModel(root: string): Promise<{ project: Project; index: FigIndexFile; baselines: Map<string, string> }> {
  const fb = fileBridge()!;
  await recoverFigureReferenceUpdate(root, fb);
  const baselines = new Map<string, string>();
  const read = async (rel: string) => { const text = await fb.readText(joinPath(root, rel)); baselines.set(rel, text); return text; };
  const index = JSON.parse(await read("fig/index.json")) as FigIndexFile;
  if (isNewerSchema(index.schemaVersion, FIG_INDEX_SCHEMA_VERSION)) throw new Error(newerSchemaMessage("fig/index.json", index.schemaVersion, FIG_INDEX_SCHEMA_VERSION));
  const indexErrors = validateFigIndexFile(index);
  if (indexErrors.length) throw new Error(`Figure sources cannot update an invalid index: ${indexErrors.slice(0, 3).join("; ")}`);
  const canvases = sortedCanvasMeta(index);
  const figures: Figure[] = [];
  for (const c of canvases) {
    const canvas = JSON.parse(await read(`fig/canvases/${c.id}.json`));
    if (isNewerSchema(canvas.schemaVersion, CANVAS_SCHEMA_VERSION)) throw new Error(newerSchemaMessage(`fig/canvases/${c.id}.json`, canvas.schemaVersion, CANVAS_SCHEMA_VERSION));
    figures.push(...canvas.figures.map((f: Figure) => ({ ...f, canvasId: c.id })));
  }
  const model: Project = {
    version: 2, name: "", canvases: canvases.map(({ id, name }) => ({ id, name })), figures,
    assets: normalizeIndexAssets(index), palette: index.palette ?? [], colorGroups: (index.colorGroups ?? []) as Project["colorGroups"],
    textStyles: index.textStyles, figureFamilies: index.families,
  };
  migrateProject(model);
  migrateFigureFamilies(model, familyHintsFrom(index.figures));
  ensureFigureReferenceKeys(model, index);
  const errors = validateModel(model);
  if (errors.length) throw new Error(`Figure sources cannot update invalid compositions: ${errors.slice(0, 3).join("; ")}`);
  const captions = await reconcileCaptionFiles(model, index, async (rel) => {
    try { return await read(rel); } catch { return null; }
  });
  if (captions.conflicts.length) throw new ConflictError(captionConflictMessage(captions.conflicts));
  return { project: model, index, baselines };
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
  const plan = await planSourceUpdates(root, owners.project, { ...fb, validateSvg: validSvg });
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
  const plan = await planSourceUpdates(root, owners.project, { ...fb, validateSvg: validSvg });
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
      // Apply to the CURRENT model; the user may have moved/restyled content
      // while source IO was pending. Only source-dependent sizing is touched.
      mutate((p) => applySourceUpdates(p, plan.updates));
      const accepted = [];
      for (const u of plan.updates) {
        if (!get(project).assets.some((a) => a.id === u.assetId)) continue;
        if (reimportPlot(u.assetId, u.bundle.svgText,
          u.bundle.manifestText ? JSON.parse(u.bundle.manifestText) as FluxPlotManifest : undefined,
          u.bundle.recipeText ? JSON.parse(u.bundle.recipeText) : undefined, { markEdited: false })) accepted.push(u);
      }
      acceptFigureSourceSizes(accepted);
      await saveFigFrom(root);
    } else {
      await withIpcLock("project", "project", async () => {
      for (const [rel, baseline] of disk!.baselines) {
        if (await fb.readText(joinPath(root, rel)) !== baseline) throw new ConflictError("Figures changed while sources were being read; reload sources again");
      }
      applySourceUpdates(model, plan.updates);
      await writeSourceUpdates(root, plan.updates, fb, model);
      const writes = planFigSave(model, disk!.index);
      await executeFigSave(writes, {
        read: async (rel) => { try { return await fb.readText(joinPath(root, rel)); } catch { return null; } },
        write: (rel, text) => fb.writeText(joinPath(root, rel), text),
        fsyncDir: fb.fsyncDir ? (rel) => fb.fsyncDir!(joinPath(root, rel)) : undefined,
      });
      });
    }
    for (const status of plan.statuses) if (status.status === "updating") status.status = "current";
    publish(plan.statuses);
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
