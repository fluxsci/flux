/**
 * Getting an image bundle onto a figure or a slide: the `Incoming` protocol of io.ts (the GLB template, model3d/import.ts).
 *
 * The file side copies the bundle into the immutable asset folder `fig/assets/<id>.fluximg/` and returns its content
 * id; nothing here reads or hashes a bundle. Rules:
 *  - a slide takes the image like a figure does, and its bundle goes to the same place: `fig/assets/` of the project,
 *    never the deck's own assets (a deck refers to it by id; the slide bridge resolves it there on every load);
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
import { fluximgAsset, fluximgAssetId, fluximgAssetPath, fluximgDisplayName, fluximgResolvedAsset } from "./place";
import { trackFluximgImport } from "./importProgress";
import { findFluximgAsset, fluximgRecipeBeside, fluximgSourceRecord, makeFluximgElement } from "./importCore";
import { fluximgManifests, needManifest } from "./store";
import type { FluximgManifest } from "./types";
import type { FluximgElement } from "./element";

export const fluximgImportRoot = (): string | null => get(embeddedProjectRoot);

/** Where an image can go: a figure, or a slide of the open deck (stage 2). Anything else is refused before any dialog,
 *  copy or save. */
export function assertFluximgDestination(): void {
  const tenant = storeTenant();
  if (tenant !== "figure" && tenant !== "slide") throw new Error("Images (fluximg) are placed on a figure or a slide.");
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
  const owner = get(project), figure = get(activeFigureId), tenant = storeTenant();
  const root = get(embeddedProjectRoot);
  if (!root) throw new Error(FLUXIMG_NEEDS_PROJECT);
  if (get(embeddedProjectRoot) !== root || get(project) !== owner || get(activeFigureId) !== figure || storeTenant() !== tenant) throw new Error("The insertion destination changed");
  return root;
}

// Imports not yet placed or discarded, by content id: a batch that names one bundle twice (or two copies of it)
// shares the first copy instead of making a second asset.
const pendingByContent = new Map<string, { asset: Asset; users: number }>();
let sequence = 0;
const uniqueTail = (): string => `${Date.now().toString(36)}${(++sequence).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/**
 * A bundle that is MADE rather than copied (a converted TIFF, `tiffImport.ts`): the file side writes it at the asset
 * id it is given and returns what a bundle import returns. A long job runs while the person keeps working, so its
 * destination is held only to the project, the tenant and the target figure (an edit meanwhile does not cancel it,
 * as it does a one-second bundle copy).
 */
export interface MadeBundle {
  /** The source's name (the asset id's stem). */
  label: string;
  make(root: string, assetId: string): Promise<FluximgImportResult>;
  /** What the placed element records as its source. */
  source(root: string, sha256: string): NonNullable<FluximgElement["source"]>;
}

let toldLiveView = false;
async function incoming(source: string | File | MadeBundle, targetFigure?: string): Promise<Incoming> {
  assertFluximgDestination();
  const root = await ensureFluximgImportRoot();
  const made = typeof source === "object" && "make" in source ? source : null;
  const owner = get(project), figureId = get(activeFigureId), targetId = targetFigure ?? figureId, tenant = storeTenant();
  const bridge = fileBridge();
  if (!bridge?.discardFluximg || (!made && !bridge.importFluximg)) throw new Error("Images (fluximg) need the Flux desktop app.");
  const current = made
    ? (): boolean => fluximgImportRoot() === root && storeTenant() === tenant && !!targetId && get(project).figures.some((f) => f.id === targetId)
    : (): boolean => fluximgImportRoot() === root && get(project) === owner && get(activeFigureId) === figureId
      && storeTenant() === tenant && !!targetId && owner.figures.some((f) => f.id === targetId);
  const label = made ? made.label : typeof source === "string" ? baseName(source) : (source as File).name;
  const assetId = fluximgAssetId(label.replace(/\.fluximg$/i, "").replace(/\.(ome\.)?tiff?$/i, ""), uniqueTail());
  let result: FluximgImportResult & { sourcePath?: string };
  if (made) result = await made.make(root, assetId);
  else {
    const finishProgress = trackFluximgImport(label, current, [project, activeFigureId, embeddedProjectRoot, projectDir, storeTenantState]);
    try {
      if (typeof source === "string") result = await bridge.importFluximg!({ root, sourcePath: source, assetId });
      else if (bridge.importDroppedFluximg) result = await bridge.importDroppedFluximg(source as File, { root, assetId });
      else throw new Error("Dropped image bundles need the Flux desktop app. Place it from the Plots rail instead.");
    } finally { finishProgress(); }
  }

  const sourcePath = made ? "" : typeof source === "string" ? source : result.sourcePath || (source as File).name;
  let ownCopy = true, settled = false;
  const discardCopy = async (): Promise<void> => { if (!ownCopy) return; ownCopy = false; await bridge.discardFluximg!({ root, assetId }); };
  try {
    if (!current()) throw new Error("The insertion destination changed");
    const figure = (made ? get(project) : owner).figures.find((f) => f.id === targetId);
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
      asset = fluximgAsset(assetId, result, made ? made.label : sourcePath);
      pendingByContent.set(`${root}|${result.sha256}`, { asset, users: 1 });
    }
    const pendingKey = `${root}|${result.sha256}`;
    const release = (): void => { const p = pendingByContent.get(pendingKey); if (p && p.asset === asset && --p.users <= 0) pendingByContent.delete(pendingKey); };
    let recipe: string | null = null;
    if (!made && typeof source === "string") {
      const beside = fluximgRecipeBeside(source);
      const abs = /^([A-Za-z]:)?[\\/]/.test(beside) ? beside : joinPath(root, beside);
      try { if (await bridge.exists(abs)) recipe = beside; } catch { /* an unreadable folder has no recipe we can use */ }
    }
    const el = makeFluximgElement(figure, asset, made ? made.source(root, result.sha256) : fluximgSourceRecord(root, sourcePath, result.sha256, recipe));
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
/** An `Incoming` for a bundle the file side makes (a converted TIFF): dedupe, install and discard as for any bundle. */
export const readMadeFluximg = (made: MadeBundle, figureId?: string): Promise<Incoming> => incoming(made, figureId);

/** A display name for toasts. */
export const fluximgLabel = (manifest: FluximgManifest, sourcePath?: string): string => fluximgDisplayName(manifest, sourcePath);

/**
 * The figure's record of images that only slides have placed (their bundles are the project's own, `fig/assets`; only
 * `fig/index.json` has never listed them): what an import would have recorded, from the bundle where it is
 * (`measureFluximg`: its content id and byte count) and its manifest. Used when such an image is pasted into a figure
 * (the twin of project/convert.ts for "Send slide to canvas"). Null, with a toast that says why, when a bundle is not
 * there, is no longer the one the element placed, or this build cannot measure it.
 */
export async function figureRecordsOfSlideImages(elements: ReadonlyArray<{ assetId: string; name?: string; source?: { sha256?: string } }>): Promise<Asset[] | null> {
  const bridge = fileBridge(), root = get(embeddedProjectRoot);
  const out: Asset[] = [];
  for (const assetId of new Set(elements.map((e) => e.assetId))) {
    const el = elements.find((e) => e.assetId === assetId)!;
    try {
      if (!bridge?.measureFluximg || !root) throw new Error("this build cannot read the image's bundle");
      const manifest = await needManifest({ id: assetId, path: fluximgAssetPath(assetId) });
      const m = await bridge.measureFluximg({ root, assetId });
      if (el.source?.sha256 && el.source.sha256 !== m.sha256) throw new Error("its files changed since it was placed");
      out.push({ ...fluximgResolvedAsset(assetId, manifest, m.sha256), bytes: m.bytes });
    } catch (error) {
      const why = error instanceof Error ? error.message.replace(/^ENOENT:\s*/, "") : String(error);
      pushToast("info", "The copied image is not in this project", { detail: `${el.name ?? assetId}: ${why}. Import it here before pasting.` });
      return null;
    }
  }
  return out;
}

