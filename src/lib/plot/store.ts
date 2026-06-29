// Runtime stores for FluxPlot semantic plots, keyed by assetId (analogous to
// assetData in assets.ts). Manifests are reactive; the parsed pristine SVG DOM
// is a plain Map (DOM nodes aren't serializable / don't belong in a store).

import { writable } from "svelte/store";
import type { Id } from "../types";
import type { FluxPlotManifest } from "./types";
import { parsePlotSvg } from "./parse";

export const plotManifests = writable<Record<Id, FluxPlotManifest>>({});
export const plotRecipes = writable<Record<Id, unknown>>({});

// Pristine parsed plot SVG roots, keyed by assetId. Cloned per placement on mount.
export const plotDom = new Map<Id, SVGSVGElement>();

// F2: a per-asset generation counter, bumped whenever a plot's cached DOM is
// (re)written. mountPlot folds this into its re-clone signature so a hot-swap
// (regenerate) re-renders in place even though the element prop is unchanged.
export const plotGen = writable<Record<Id, number>>({});

/** Parse + cache a plot's SVG + manifest (+ recipe). Returns false if the SVG is malformed. */
export function cachePlot(
  assetId: Id,
  svgText: string,
  manifest: FluxPlotManifest,
  recipe?: unknown,
): boolean {
  const root = parsePlotSvg(svgText);
  if (root) plotDom.set(assetId, root);
  plotManifests.update((m) => ({ ...m, [assetId]: manifest }));
  if (recipe !== undefined) plotRecipes.update((m) => ({ ...m, [assetId]: recipe }));
  plotGen.update((g) => ({ ...g, [assetId]: (g[assetId] ?? 0) + 1 }));
  return !!root;
}

export function hasPlotDom(assetId: Id): boolean {
  return plotDom.has(assetId);
}

/** Reset all plot caches (on project open/close). */
export function clearPlots(): void {
  plotDom.clear();
  plotManifests.set({});
  plotRecipes.set({});
  plotGen.set({});
}
