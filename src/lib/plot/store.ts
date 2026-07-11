// Runtime stores for FluxPlot semantic plots, keyed by assetId (analogous to
// assetData in assets.ts). Manifests are reactive; the parsed pristine SVG DOM
// is a plain Map (DOM nodes aren't serializable / don't belong in a store).

import { writable } from "svelte/store";
import type { Id } from "../types";
import type { FluxPlotManifest } from "./types";
import { preparePlot } from "./parse";

export const plotManifests = writable<Record<Id, FluxPlotManifest>>({});
export const plotRecipes = writable<Record<Id, unknown>>({});

// Pristine parsed plot SVG roots, keyed by assetId. Cloned per placement on mount.
export const plotDom = new Map<Id, SVGSVGElement>();

// F2: a per-asset generation counter, bumped whenever a plot's cached DOM is
// (re)written. mountPlot folds this into its re-clone signature so a hot-swap
// (regenerate) re-renders in place even though the element prop is unchanged.
export const plotGen = writable<Record<Id, number>>({});

// WS-1 Fix 1 instrumentation: counts mountPlot signature() computations (the
// JSON.stringify slow path). verify-scale-figure.mjs asserts an UNRELATED
// commit triggers zero of these; reachable headless as __flux.plot.sigCalls.
export const sigCalls = { n: 0 };

/** Parse + cache a plot's SVG + manifest (+ recipe). Returns false if the SVG is
 *  malformed. Runs the shared preparePlot seam: DOM normalization (sanitize /
 *  shared-<use> inlining / deterministic id stamping — the pass that makes
 *  per-part styling possible at all) + orphan-defense manifest augmentation.
 *  flux-core's headless exporter runs the SAME seam, so app and export see
 *  identical parts and identical DOM. */
export function cachePlot(
  assetId: Id,
  svgText: string,
  manifest?: FluxPlotManifest,
  recipe?: unknown,
): boolean {
  const prepared = preparePlot(svgText, manifest);
  if (prepared.root) plotDom.set(assetId, prepared.root);
  if (prepared.manifest !== undefined) manifest = prepared.manifest;
  // manifest is always present when the svg parsed (derived if no sidecar);
  // only a parse failure leaves it undefined — don't store that.
  if (manifest !== undefined) plotManifests.update((m) => ({ ...m, [assetId]: manifest as FluxPlotManifest }));
  if (recipe !== undefined) plotRecipes.update((m) => ({ ...m, [assetId]: recipe }));
  plotGen.update((g) => ({ ...g, [assetId]: (g[assetId] ?? 0) + 1 }));
  return !!prepared.root;
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
