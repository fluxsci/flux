/**
 * Getting an image bundle onto a figure: the `Incoming` protocol of io.ts (the GLB template, model3d/import.ts).
 *
 * The file side copies the bundle into the immutable asset folder `fig/assets/<id>.fluximg/` and returns its content
 * id; nothing here reads or hashes a bundle. Rules:
 *  - a Slide deck refuses before anything is copied (stage 1, `FLUXIMG_NOT_IN_SLIDES`);
 *  - only a Flux project takes a bundle (its `fig/assets/`): an unsaved or legacy standalone figure is refused up
 *    front, before any dialog, save or copy (FLUXIMG_NEEDS_PROJECT);
 *  - the same content twice is ONE asset: a fresh copy whose content id the project already holds is discarded and
 *    the existing asset reused;
 *  - any failure discards the copy and rethrows the file side's own words;
 *  - a copy that takes more than a second shows "Importing image…".
 */
import { get } from "svelte/store";
import { project, activeFigureId, embeddedProjectRoot, projectDir } from "../store";
import { storeTenant, storeTenantState } from "../tenancy";
import { fileBridge, joinPath } from "../project/types";
import type { Incoming } from "../io";
import { pushToast } from "../toast";
import type { Asset } from "../types";
import type { FluximgImportResult } from "./bridge";
import { fluximgAsset, fluximgAssetId, fluximgDisplayName } from "./place";
import { FLUXIMG_NOT_IN_SLIDES } from "./policy";
import { trackFluximgImport } from "./importProgress";
import { findFluximgAsset, fluximgRecipeBeside, fluximgSourceRecord, makeFluximgElement } from "./importCore";
import { fluximgManifests } from "./store";
import type { FluximgManifest } from "./types";

export const fluximgImportRoot = (): string | null => get(embeddedProjectRoot);

/** Refuse a Slide deck: before any dialog, copy or save. */
export function assertFluximgDestination(): void {
  if (storeTenant() === "slide") throw new Error(FLUXIMG_NOT_IN_SLIDES);
}

/** Why a figure outside a Flux project folder cannot take an image bundle. */
export const FLUXIMG_NEEDS_PROJECT = "Images (fluximg) are added inside a Flux project: open or create one from Home, then add the image.";

/**
 * The project root an import copies into. The file side publishes a bundle at `fig/assets/<id>.fluximg`, which is
 * where a Flux project keeps it; a legacy standalone `.flux` folder (or an unsaved one) keeps its assets in
 * `assets/` and its save and open would look for the bundle there, so it is refused up front (before any dialog,
 * save or copy) rather than saved and then left unable to find its image. GLB import saves an unsaved standalone
 * project first; for a bundle that would only lead to a broken save.
 */
export async function ensureFluximgImportRoot(): Promise<string> {
  assertFluximgDestination();
  const owner = get(project), figure = get(activeFigureId);
  const root = get(embeddedProjectRoot);
  if (!root) throw new Error(FLUXIMG_NEEDS_PROJECT);
  if (get(embeddedProjectRoot) !== root || get(project) !== owner || get(activeFigureId) !== figure || storeTenant() !== "figure") throw new Error("The insertion destination changed");
  return root;
}

// Imports not yet placed or discarded, by content id: a batch that names one bundle twice (or two copies of it)
// shares the first copy instead of making a second asset.
const pendingByContent = new Map<string, { asset: Asset; users: number }>();
let sequence = 0;
const uniqueTail = (): string => `${Date.now().toString(36)}${(++sequence).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

let toldLiveView = false;
async function incoming(source: string | File, targetFigure?: string): Promise<Incoming> {
  assertFluximgDestination();
  const root = await ensureFluximgImportRoot();
  const owner = get(project), figureId = get(activeFigureId), targetId = targetFigure ?? figureId;
  const bridge = fileBridge();
  if (!bridge?.importFluximg || !bridge.discardFluximg) throw new Error("Images (fluximg) need the Flux desktop app.");
  const current = (): boolean => fluximgImportRoot() === root && get(project) === owner && get(activeFigureId) === figureId
    && storeTenant() === "figure" && !!targetId && owner.figures.some((f) => f.id === targetId);
  const label = typeof source === "string" ? baseName(source) : source.name;
  const assetId = fluximgAssetId(label.replace(/\.fluximg$/i, ""), uniqueTail());
  const finishProgress = trackFluximgImport(label, current, [project, activeFigureId, embeddedProjectRoot, projectDir, storeTenantState]);
  let result: FluximgImportResult & { sourcePath?: string };
  try {
    if (typeof source === "string") result = await bridge.importFluximg({ root, sourcePath: source, assetId });
    else if (bridge.importDroppedFluximg) result = await bridge.importDroppedFluximg(source, { root, assetId });
    else throw new Error("Dropped image bundles need the Flux desktop app. Place it from the Plots rail instead.");
  } finally { finishProgress(); }

  const sourcePath = typeof source === "string" ? source : result.sourcePath || source.name;
  let ownCopy = true, settled = false;
  const discardCopy = async (): Promise<void> => { if (!ownCopy) return; ownCopy = false; await bridge.discardFluximg!({ root, assetId }); };
  try {
    if (!current()) throw new Error("The insertion destination changed");
    const figure = owner.figures.find((f) => f.id === targetId);
    if (!figure) throw new Error("The insertion destination changed");
    // The same content already in the project, or in this batch: use that asset, drop the fresh copy.
    const existing = findFluximgAsset(get(project).assets, result.sha256);
    const shared = existing ? null : pendingByContent.get(`${root}|${result.sha256}`);
    let asset: Asset;
    if (existing || shared) {
      await discardCopy();
      asset = existing ?? shared!.asset;
      if (shared) shared.users++;
    } else {
      asset = fluximgAsset(assetId, result, sourcePath);
      pendingByContent.set(`${root}|${result.sha256}`, { asset, users: 1 });
    }
    const pendingKey = `${root}|${result.sha256}`;
    const release = (): void => { const p = pendingByContent.get(pendingKey); if (p && p.asset === asset && --p.users <= 0) pendingByContent.delete(pendingKey); };
    let recipe: string | null = null;
    if (typeof source === "string") {
      const beside = fluximgRecipeBeside(source);
      const abs = /^([A-Za-z]:)?[\\/]/.test(beside) ? beside : joinPath(root, beside);
      try { if (await bridge.exists(abs)) recipe = beside; } catch { /* an unreadable folder has no recipe we can use */ }
    }
    const el = makeFluximgElement(figure, asset, fluximgSourceRecord(root, sourcePath, result.sha256, recipe));
    const manifest: FluximgManifest = result.manifest;
    return {
      asset,
      el,
      canInstall: current,
      discard: async () => {
        if (settled) return;
        settled = true; release();
        await discardCopy();
      },
      install() {
        if (!current()) throw new Error("The insertion destination changed");
        settled = true; release();
        ownCopy = false; // placed: the copy belongs to the project now
        // The manifest is already here: the element need not ask a worker for it again.
        if (asset.id === assetId) fluximgManifests.update((m) => (m[asset.id] ? m : { ...m, [asset.id]: manifest }));
        void import("./sourceUpdate").then((m) => m.ensureFluximgSourceWatch()).catch(() => {});
        // Once a session: the way in to everything an image can show is one key, and nothing on the canvas says so.
        if (!toldLiveView) { toldLiveView = true; pushToast("info", "Image placed", { detail: "Press R, or double-click it, to move through it and set its contrast.", ttl: 6000 }); }
      },
    };
  } catch (error) {
    try { await discardCopy(); } catch { /* the import's own error is the one worth telling */ }
    throw error;
  }
}

/** An `Incoming` for the bundle at `sourcePath` (absolute, or relative to the project root). */
export const readIncomingFluximg = (sourcePath: string, figureId?: string): Promise<Incoming> => incoming(sourcePath, figureId);
/** An `Incoming` for a bundle folder dropped from the file manager (its path comes from the preload, never the page). */
export const readDroppedFluximg = (file: File, figureId?: string): Promise<Incoming> => incoming(file, figureId);

/** A display name for toasts. */
export const fluximgLabel = (manifest: FluximgManifest, sourcePath?: string): string => fluximgDisplayName(manifest, sourcePath);
