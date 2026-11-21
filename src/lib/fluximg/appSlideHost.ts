/**
 * The in-app image hosts for slides (stage 2): the LIVE host the editor preview and Present pass to the player
 * (mirror of `model3d/appInlineHost.ts`), and the STILLS context of static hosts (filmstrip thumbnails, the presenter's
 * next-slide view; mirror of `model3d/appPosters.ts`), both over the window's one fluximg service and its caches.
 *
 * A deck without images gets no live host at all (`createAppFluximgHost` returns undefined), so its player carries
 * nothing for images. The GL renderer is created lazily, on the first frame a surface draws.
 */
import { get } from "svelte/store";
import { project } from "../store";
import type { Deck } from "../slide/types";
import type { Asset } from "../types";
import type { FluximgSlideContext, FluximgSlideHost } from "./slideHost";
import { createFluximgSlideHost, pictureView } from "./slideSurfaces";
import { fluximgBundle, fluximgIdentity, fluximgLayerText, fluximgLutsReady, fluximgManifests, fluximgService, needLayerText, needLuts, needManifest, resolveLut } from "./store";
import { pixelKey } from "./viewOps";
import { fluximgTables, needTable, tableOf } from "./live/objectTables";
import type { TweenPicture } from "./viewTween";

type FluximgAsset = Asset & { kind: "fluximg" };

function deckImageAssets(deck: Deck): Map<string, FluximgAsset> {
  const ids = new Set<string>();
  for (const slide of deck.slides) {
    for (const element of slide.elements) if (element.type === "fluximg") ids.add(element.assetId);
    for (const beat of slide.beats) for (const track of beat.tracks) if (track.to?.assetId) ids.add(track.to.assetId);
  }
  const out = new Map<string, FluximgAsset>();
  if (!ids.size) return out;
  for (const asset of get(project).assets) if (ids.has(asset.id) && asset.kind === "fluximg") out.set(asset.id, structuredClone(asset) as FluximgAsset);
  return out;
}

/** A styled layer's table for the player's overlay, loading it on a miss (the store update reaches the host's listeners). */
function layerTable(find: (id: string) => FluximgAsset | undefined) {
  return (assetId: string, path: string) => {
    const asset = find(assetId);
    if (!asset) return undefined;
    const table = tableOf(get(fluximgTables), asset, path);
    if (!table) needTable(asset, path);
    return table ?? undefined;
  };
}

/** Layer text for the player's overlay, loading it on a miss (the store update reaches the host's listeners). */
function layerText(assets: Map<string, FluximgAsset> | ((id: string) => FluximgAsset | undefined)) {
  const find = typeof assets === "function" ? assets : (id: string) => assets.get(id);
  return (assetId: string, path: string): string | undefined => {
    const text = get(fluximgLayerText)[`${assetId}|${path}`];
    if (text === undefined) { const asset = find(assetId); if (asset) needLayerText(asset, path); }
    return text;
  };
}

export interface AppFluximg extends FluximgSlideContext {
  fluximg: FluximgSlideHost;
  dispose(): void;
}

/** The live host for one player document over `deck`'s images; undefined for a deck without any. */
export function createAppFluximgHost(deck: Deck): AppFluximg | undefined {
  const assets = deckImageAssets(deck);
  if (!assets.size) return undefined;
  const service = fluximgService();
  const core = createFluximgSlideHost({
    manifest: (id) => (assets.has(id) ? get(fluximgManifests)[id] : undefined),
    need: (id) => { const asset = assets.get(id); return asset ? needManifest(asset) : Promise.reject(new Error(`Image ${id} is not part of this deck`)); },
    bundle: (id) => { const asset = assets.get(id); return asset ? fluximgBundle(asset) : undefined; },
    identity: (id) => { const asset = assets.get(id); return asset ? fluximgIdentity(asset) : id; },
    planes: service,
    still: (id, key, request) => { const asset = assets.get(id); return asset ? service.still(key, { bundle: fluximgBundle(asset), ...request }) : Promise.reject(new Error("unknown image")); },
    stillNow: (key) => service.stillHref(key),
    resolveLut,
    luts: needLuts,
  });
  // Manifests, layer text and colour maps arrive through the stores: a frame that waited for them may now draw.
  const listeners = new Set<() => void>();
  let primed = false;
  const fire = () => { if (primed) for (const l of [...listeners]) l(); };
  const unsubscribe = [fluximgManifests.subscribe(fire), fluximgLayerText.subscribe(fire), fluximgLutsReady.subscribe(fire), fluximgTables.subscribe(fire)];
  primed = true;
  const host: FluximgSlideHost = {
    ...core,
    onChange(listener) { listeners.add(listener); const off = core.onChange(listener); return () => { listeners.delete(listener); off(); }; },
    dispose() { for (const u of unsubscribe) u(); listeners.clear(); core.dispose(); },
  };
  return {
    fluximg: host,
    fluximgManifest: (id) => (assets.has(id) ? get(fluximgManifests)[id] : undefined),
    fluximgLayerText: layerText(assets),
    fluximgTable: layerTable((id) => assets.get(id)),
    fluximgLut: (name) => { const t = resolveLut(name); if (!t) void needLuts(); return t; },
    dispose: () => host.dispose(),
  };
}

/**
 * The stills context for static renders (no GPU, no decoder of its own): each image shows the cached still of the
 * step's picture. `settle()` renders the stills, manifests and layer files the last render missed and resolves true
 * when it did (the host renders again), false when nothing was missing (a plain slide is not rendered twice).
 */
export function createAppFluximgStills(signal: AbortSignal): { context: FluximgSlideContext; settle(): Promise<boolean> } {
  const assetOf = (id: string): FluximgAsset | undefined => get(project).assets.find((a): a is FluximgAsset => a.id === id && a.kind === "fluximg");
  const stills = new Map<string, { asset: FluximgAsset; picture: TweenPicture; w: number; h: number }>();
  const manifests = new Set<string>(), texts = new Map<string, { asset: FluximgAsset; path: string }>(), tables = new Map<string, { asset: FluximgAsset; path: string }>();
  let luts = false;
  const context: FluximgSlideContext = {
    fluximgManifest(id) {
      const m = get(fluximgManifests)[id];
      if (!m) manifests.add(id);
      return m;
    },
    fluximgStill(id, picture, w, h) {
      const asset = assetOf(id), manifest = get(fluximgManifests)[id];
      if (!asset || !manifest) return undefined;
      const key = `${fluximgIdentity(asset)}|${pixelKey(manifest, picture.view, picture.crop, w, h)}`;
      const href = fluximgService().stillHref(key);
      if (!href) stills.set(key, { asset, picture, w, h });
      return href;
    },
    fluximgLayerText(id, path) {
      const text = get(fluximgLayerText)[`${id}|${path}`];
      if (text === undefined) { const asset = assetOf(id); if (asset) texts.set(`${id}|${path}`, { asset, path }); }
      return text;
    },
    fluximgTable(id, path) {
      const asset = assetOf(id);
      if (!asset) return undefined;
      const table = tableOf(get(fluximgTables), asset, path);
      if (!table) tables.set(`${id}|${path}`, { asset, path });
      return table ?? undefined;
    },
    fluximgLut(name) { const t = resolveLut(name); if (!t && !get(fluximgLutsReady)) luts = true; return t; },
  };
  return {
    context,
    async settle() {
      const wantStills = [...stills.entries()], wantManifests = [...manifests], wantTexts = [...texts.values()], wantTables = [...tables.values()], wantLuts = luts;
      stills.clear(); manifests.clear(); texts.clear(); tables.clear(); luts = false;
      if (!wantStills.length && !wantManifests.length && !wantTexts.length && !wantTables.length && !wantLuts) return false;
      const svc = fluximgService();
      await Promise.all([
        ...wantStills.map(([key, s]) => svc.still(key, { bundle: fluximgBundle(s.asset), view: pictureView(s.picture.view), crop: s.picture.crop, outWidth: s.w, outHeight: s.h }).catch(() => undefined)),
        ...wantManifests.map((id) => { const asset = assetOf(id); return asset ? needManifest(asset).catch(() => undefined) : undefined; }),
        ...wantTexts.map(({ asset, path }) => { needLayerText(asset, path); return svc.text(fluximgBundle(asset), path).catch(() => undefined); }),
        ...wantTables.map(({ asset, path }) => { needTable(asset, path); return svc.table(fluximgBundle(asset), path).then(() => new Promise((r) => setTimeout(r, 0))).catch(() => undefined); }),
        ...(wantLuts ? [needLuts().catch(() => undefined)] : []),
      ]);
      return !signal.aborted;
    },
  };
}
