// Shared source-discovery adapter for deck-owned plots, including targets
// that occur only in animation tracks. Figure-owned assets are resolved from
// the accepted Figure registry; this adapter never overwrites those bytes.
import type { Deck } from "./types";
import type { Asset } from "../types";
import type { SourceUpdate } from "../plot/sourceSync";
import { applySourceUpdates } from "../plot/sourceSync";
import { deckToProject } from "./deckProject";

export function deckSourceProject(deck: Deck, opts: { includeExternal?: boolean } = {}) {
  const project = deckToProject(deck, deck.assets);
  const local = new Set(deck.assets.map((a) => a.id));
  for (let i = 0; i < deck.slides.length; i++) {
    const slide = deck.slides[i], figure = project.figures[i];
    figure.elements = figure.elements.filter((e) => e.type !== "plot" || opts.includeExternal || local.has(e.assetId));
    for (const beat of slide.beats) for (const track of beat.tracks) {
      const to = track.to;
      if (!to?.assetId || (!opts.includeExternal && !local.has(to.assetId)) || typeof to.svgPath !== "string") continue;
      const origin = slide.elements.find((e) => e.id === track.target && e.type === "plot");
      if (origin?.type !== "plot") continue;
      figure.elements.push({ ...structuredClone(origin), id: `source:${track.id}`, assetId: to.assetId,
        source: { svgPath: to.svgPath, ...(typeof to.manifestPath === "string" ? { manifestPath: to.manifestPath } : {}), ...(typeof to.recipePath === "string" ? { recipePath: to.recipePath } : {}), ...(typeof to.external === "boolean" ? { external: to.external } : {}), ...(typeof to.frozen === "boolean" ? { frozen: to.frozen } : {}) } });
    }
  }
  return project;
}

/** Update plot metadata and physical scale, preserving the authored stage,
 * camera, animation endpoints and every unrelated in-flight edit. */
export function applyDeckSourceUpdates(deck: Deck, updates: readonly Pick<SourceUpdate, "assetId" | "width" | "height">[], externalAssets: readonly Asset[] = []): void {
  const localIds = new Set(deck.assets.map((a) => a.id));
  const project = deckToProject(deck, [...deck.assets, ...externalAssets.filter((a) => !localIds.has(a.id))]);
  applySourceUpdates(project, updates);
  deck.assets = project.assets.filter((a) => localIds.has(a.id));
  for (let i = 0; i < deck.slides.length; i++) deck.slides[i].elements = project.figures[i].elements;
}

/** Reconcile persisted external intrinsic baselines with accepted source
 * metadata. This is the same operation on reopen, live refresh and export.
 * Legacy references without a baseline adopt current dimensions once: their
 * historical scale cannot be inferred from the placement rectangle alone. */
export function reconcileDeckExternalAssetSizes(deck: Deck, accepted: readonly Pick<Asset, "id" | "naturalWidth" | "naturalHeight">[]): boolean {
  const local = new Set(deck.assets.map((a) => a.id));
  const used = new Set<string>();
  for (const slide of deck.slides) {
    for (const e of slide.elements) if (e.type === "plot" && !local.has(e.assetId)) used.add(e.assetId);
    for (const beat of slide.beats) for (const track of beat.tracks) if (track.to?.assetId && !local.has(track.to.assetId)) used.add(track.to.assetId);
  }
  const prior = deck.externalAssetSizes ?? {};
  const next = Object.fromEntries(Object.entries(prior).filter(([id]) => used.has(id)));
  const previousAssets: Asset[] = [], updates: Pick<SourceUpdate, "assetId" | "width" | "height">[] = [];
  for (const asset of accepted) {
    if (!used.has(asset.id) || !(asset.naturalWidth > 0 && asset.naturalHeight > 0) || !Number.isFinite(asset.naturalWidth + asset.naturalHeight)) continue;
    const old = prior[asset.id], width = asset.naturalWidth, height = asset.naturalHeight;
    if (old && (old.width !== width || old.height !== height)) {
      previousAssets.push({ id: asset.id, name: asset.id, kind: "svg", path: "", naturalWidth: old.width, naturalHeight: old.height });
      updates.push({ assetId: asset.id, width, height });
    }
    next[asset.id] = { width, height };
  }
  const changed = JSON.stringify(prior) !== JSON.stringify(next);
  if (updates.length) applyDeckSourceUpdates(deck, updates, previousAssets);
  if (Object.keys(next).length) deck.externalAssetSizes = next;
  else delete deck.externalAssetSizes;
  return changed;
}
