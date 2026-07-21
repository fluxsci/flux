// Runtime stores for FluxPlot semantic plots, keyed by assetId (analogous to
// assetData in assets.ts). Manifests are reactive; the parsed pristine SVG DOM
// is a plain Map (DOM nodes aren't serializable / don't belong in a store).
//
// LAZY RESIDENCY (2026-07-21, notes/lazy_figure_asset_loading_plan.md): the
// parsed DOM cache is populated ON DEMAND, not at project open. Project load
// keeps the cheap layers 100% resident — `model.assets` metadata (the save-
// safety invariant: the index is regenerated from it, so pruning it would
// orphan asset bytes on save), `assetData` base64 bytes, and sidecar
// manifests/recipes — and defers only the DOM parse, which dominates memory
// (~180k renderer nodes per dense figure, measured). PlotElement renders the
// full-fidelity `<image>` fallback until its plot's DOM lands (requestPlotDom
// → time-sliced parse queue → plotGen bump flips it inline), and an LRU under
// `plotResidency.nodeCap` evicts the least-recently-used UNMOUNTED plots, so
// resident cost is bounded by the working set instead of project size.
// Slide mode keeps its eager load (deck assets, morph targets, filmstrip
// thumbnails have no mount-driven residency) — eviction is tenancy-gated off
// outside figure mode. Import/hot-swap still cache eagerly via cachePlot.

import { get, writable } from "svelte/store";
import type { Id } from "../types";
import type { FluxPlotManifest } from "./types";
import { preparePlot } from "./parse";
import { getAssetData, dataUrlToBytes } from "../assets";
import { isDerivedManifest } from "./derive";
import { storeTenant } from "../tenancy";

export const plotManifests = writable<Record<Id, FluxPlotManifest>>({});
export const plotRecipes = writable<Record<Id, unknown>>({});

// Pristine parsed plot SVG roots, keyed by assetId. Cloned per placement on mount.
export const plotDom = new Map<Id, SVGSVGElement>();

// F2: a per-asset generation counter, bumped whenever a plot's cached DOM is
// (re)written. mountPlot folds this into its re-clone signature so a hot-swap
// (regenerate) re-renders in place even though the element prop is unchanged.
// It is ALSO the lazy-load upgrade signal: PlotElement's `inline` keys on it,
// so an on-demand cachePlot flips the <image> fallback to the inline DOM.
export const plotGen = writable<Record<Id, number>>({});

// WS-1 Fix 1 instrumentation: counts mountPlot signature() computations (the
// JSON.stringify slow path). verify-scale-figure.mjs asserts an UNRELATED
// commit triggers zero of these; reachable headless as __flux.plot.sigCalls.
export const sigCalls = { n: 0 };

// ---------------------------------------------------------------------------
// Residency bookkeeping (LRU + node budget + parse queue)
// ---------------------------------------------------------------------------

const plotLru = new Map<Id, number>(); // insertion order = recency (touch re-inserts)
const lruSeq = { n: 0 };
const plotNodeCount = new Map<Id, number>(); // element nodes per cached root
const mountedPlots = new Map<Id, number>(); // live PlotElement refcounts — never evicted
const parseFailed = new Set<Id>(); // malformed svgs — don't retry-loop the parser
const pendingParse = new Set<Id>();
const drainState = { scheduled: false };
const PARSE_SLICE_MS = 6; // per-task parse budget — keeps cull-entry parses off the frame

/** Structural residency budget + dev counters (`__flux.plot.plotResidency`).
 *  nodeCap is a soft cap in ELEMENT nodes across all cached pristine DOMs
 *  (~150k ≈ five dense 14-panel figures; typical figures are 1–3k, so normal
 *  projects never evict). Mounted plots are never evicted, so the resident set
 *  may exceed the cap when the visible set alone does. */
export const plotResidency = {
  nodeCap: 150_000,
  totalNodes: 0,
  parses: 0,
  evictions: 0,
  get entries(): number {
    return plotDom.size;
  },
  pending(): number {
    return pendingParse.size;
  },
};

function touchPlot(assetId: Id): void {
  if (plotLru.has(assetId)) plotLru.delete(assetId);
  plotLru.set(assetId, ++lruSeq.n);
}

/** Drop least-recently-used UNMOUNTED plot DOMs until under the node cap.
 *  Figure-mode only: slide mode's residency is eager by design (deck assets,
 *  morph targets and filmstrip thumbnails have no mount-driven reload path).
 *  Eviction keeps assetData/manifests/recipes — the plot re-shows instantly
 *  as <image> and re-parses on next view. */
function evictOverCap(keep?: Id): void {
  if (storeTenant() !== "figure") return;
  if (plotResidency.totalNodes <= plotResidency.nodeCap) return;
  for (const id of plotLru.keys()) {
    if (plotResidency.totalNodes <= plotResidency.nodeCap) break;
    if (id === keep || mountedPlots.has(id)) continue;
    plotDom.delete(id);
    plotLru.delete(id); // deleting the current key during Map iteration is safe
    plotResidency.totalNodes -= plotNodeCount.get(id) ?? 0;
    plotNodeCount.delete(id);
    plotResidency.evictions++;
  }
}

/** Set the resident-node budget and apply it immediately (evicting LRU
 *  unmounted plots as needed) — the seam a runtime cap change (settings /
 *  dev handle / gates) goes through, since eviction otherwise only runs on
 *  cache growth. */
export function applyPlotNodeCap(cap: number): void {
  plotResidency.nodeCap = cap;
  evictOverCap();
}

/** A PlotElement placement is displaying this asset — pin it against eviction. */
export function retainPlot(assetId: Id): void {
  mountedPlots.set(assetId, (mountedPlots.get(assetId) ?? 0) + 1);
}

export function releasePlot(assetId: Id): void {
  const n = (mountedPlots.get(assetId) ?? 0) - 1;
  if (n <= 0) {
    mountedPlots.delete(assetId);
    // Leaving the screen counts as a use: a long-mounted plot must not carry
    // a stale LRU stamp into unmounted life (it's the likeliest to return).
    if (plotLru.has(assetId)) touchPlot(assetId);
  } else mountedPlots.set(assetId, n);
}

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
  if (prepared.root) {
    const prev = plotNodeCount.get(assetId);
    if (prev != null) plotResidency.totalNodes -= prev;
    const count = prepared.root.querySelectorAll("*").length + 1;
    plotNodeCount.set(assetId, count);
    plotResidency.totalNodes += count;
    plotResidency.parses++;
    parseFailed.delete(assetId);
    touchPlot(assetId);
    plotDom.set(assetId, prepared.root);
    evictOverCap(assetId);
  }
  if (prepared.manifest !== undefined) manifest = prepared.manifest;
  // manifest is always present when the svg parsed (derived if no sidecar);
  // only a parse failure leaves it undefined — don't store that.
  if (manifest !== undefined) plotManifests.update((m) => ({ ...m, [assetId]: manifest as FluxPlotManifest }));
  if (recipe !== undefined) plotRecipes.update((m) => ({ ...m, [assetId]: recipe }));
  plotGen.update((g) => ({ ...g, [assetId]: (g[assetId] ?? 0) + 1 }));
  return !!prepared.root;
}

/** Prime the resident sidecar layers (manifest/recipe) at project open WITHOUT
 *  parsing any DOM — the lazy-load complement of the old eager cachePlot loop.
 *  Vanilla (sidecar-less) svgs stay absent here: their manifest DERIVES on
 *  first parse, same retroactive-deriver rule as before. */
export function primePlotSidecars(
  manifests: Record<Id, FluxPlotManifest>,
  recipes: Record<Id, unknown>,
): void {
  if (Object.keys(manifests).length) plotManifests.update((m) => ({ ...m, ...manifests }));
  if (Object.keys(recipes).length) plotRecipes.update((m) => ({ ...m, ...recipes }));
}

/** Parse + cache one plot's DOM on demand from already-resident assetData
 *  bytes. No-op (with an LRU touch) when cached. Synchronous — export paths
 *  call this to guarantee overrides bake instead of the <image> fallback. */
export function ensurePlotDom(assetId: Id): boolean {
  if (plotDom.has(assetId)) {
    touchPlot(assetId);
    return true;
  }
  if (parseFailed.has(assetId)) return false;
  const url = getAssetData(assetId);
  if (!url || !url.startsWith("data:image/svg")) return false;
  const stored = get(plotManifests)[assetId];
  // A previously-derived manifest is re-derived by the parse (retroactive
  // deriver improvements — same rule as the load path); only a REAL sidecar
  // manifest is passed through.
  const real = stored && !isDerivedManifest(stored) ? stored : undefined;
  const ok = cachePlot(assetId, new TextDecoder().decode(dataUrlToBytes(url)), real, get(plotRecipes)[assetId]);
  if (!ok) parseFailed.add(assetId);
  return ok;
}

/** Queue a plot for on-demand parsing (PlotElement mount / cull-entry). The
 *  queue drains in ~6ms time slices on the macrotask queue, so a figure's
 *  panels upgrade from <image> to inline over a few frames without ever
 *  blocking input — and a dense canvas mounting 100+ plots can't recreate the
 *  one-long-task open stall this system removed. Self-terminating (no ambient
 *  loop — the E43 rule). */
export function requestPlotDom(assetId: Id): void {
  if (plotDom.has(assetId) || pendingParse.has(assetId) || parseFailed.has(assetId)) return;
  if (!getAssetData(assetId)) return;
  pendingParse.add(assetId);
  scheduleDrain();
}

function scheduleDrain(): void {
  if (drainState.scheduled) return;
  drainState.scheduled = true;
  setTimeout(drainParseQueue, 0);
}

function drainParseQueue(): void {
  drainState.scheduled = false;
  const t0 = performance.now();
  for (const id of pendingParse) {
    pendingParse.delete(id);
    ensurePlotDom(id);
    if (performance.now() - t0 >= PARSE_SLICE_MS) break;
  }
  if (pendingParse.size) scheduleDrain();
}

export function hasPlotDom(assetId: Id): boolean {
  return plotDom.has(assetId);
}

/** Reset all plot caches (on project open/close). Mounted-plot refcounts are
 *  deliberately kept — they track live component lifecycles, and the old
 *  components release themselves as the new project's elements mount. */
export function clearPlots(): void {
  plotDom.clear();
  plotManifests.set({});
  plotRecipes.set({});
  plotGen.set({});
  plotLru.clear();
  plotNodeCount.clear();
  parseFailed.clear();
  pendingParse.clear();
  plotResidency.totalNodes = 0;
}
