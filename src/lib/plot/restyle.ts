// Re-apply style on the existing clone. Structural edits still mount afresh;
// exports and the slide transform host keep their own pipeline.
import type { SemanticPlotElement } from '../types';
import type { DeckTheme } from '../slide/types';
import type { FluxPlotManifest } from './types';
import { restorePtTrue, compensatePtTrue, updatePtTrueBindings, type PtTrueBindings } from './compensate';
import { resetProjectionBindings, restoreProjection, preparePlotView, applyPlotView, projectionTickRoots, canKeepPlotViewGeometry, rememberStaticPlotView } from './projectDom';
import { restoreOverrides, applyOverrides, prepareOverrideRestoration } from './parse';
import { applyPlotTheme, plotFollowsTheme } from './themeDom';
import { applyPlotColorScale, restoreColorScales, colorScaleTickRoots } from './colorScaleDom';
import { relayoutPlot, restoreRelayout, refreshRelayoutTemplates } from './relayout';

/** A re-clone used to discard the DOM writes of transient layers on a plot
 * (the Slide editor's part presentation). A restyled clone keeps them, so such
 * a layer subscribes on an ANCESTOR of the mount host: mount calls it with
 * "before" (take your writes back, before the writers restore their pristine
 * records) and "after" (paint again), exactly as on a fresh mount. Otherwise
 * its stale originals resurrect removed overrides. A registry, not a DOM
 * event: it must behave the same in linkedom gates as in Chromium. */
export type PlotRestylePhase = 'before' | 'after';
type RestyleListener = (phase: PlotRestylePhase) => void;
const restyleListeners = new WeakMap<Element, Set<RestyleListener>>();
export function onPlotRestyle(ancestor: Element, listener: RestyleListener): () => void {
  let set = restyleListeners.get(ancestor);
  if (!set) restyleListeners.set(ancestor, set = new Set());
  set.add(listener);
  return () => { set!.delete(listener); };
}
export function notifyPlotRestyle(host: Element, phase: PlotRestylePhase): void {
  for (let at: Element | null = host; at; at = at.parentElement) for (const listener of restyleListeners.get(at) ?? []) listener(phase);
}

export interface RestyleOptions {
  element: SemanticPlotElement;
  manifest: FluxPlotManifest | undefined;
  theme: DeckTheme | null;
  bindings: PtTrueBindings;
  intrinsic: { w: number; h: number };
  reflow?: boolean;
  /** Same box/crop/content scale: reflow keeps the expensive data geometry. */
  keepLayoutData?: boolean;
  layoutManifest?: FluxPlotManifest;
}

export function restylePlotInstance(inst: SVGSVGElement, { element, manifest: originalManifest, theme, bindings, intrinsic, reflow, layoutManifest, keepLayoutData }: RestyleOptions) {
  let manifest = originalManifest;
  if (reflow) {
    // Colour-key edits precede reflow against the ORIGINAL anchors, exactly as
    // on mount. Keeping all geometry fails that oracle; restoring unchanged
    // data paths cost 38 ms on the 25.8k-node owner plot (2026-10-29), vs 9 ms
    // with just decoration/key geometry restored and re-applied.
    resetProjectionBindings(inst);
    restoreOverrides(inst, element.overrides, element.id, layoutManifest);
    restoreRelayout(inst, keepLayoutData);
    restoreColorScales(inst);
  } else restorePtTrue(inst, bindings);
  const keepGeometry = canKeepPlotViewGeometry(inst, manifest, element.view);
  restoreProjection(inst, keepGeometry);
  if (!reflow) restoreOverrides(inst, element.overrides, element.id, manifest);
  applyPlotTheme(inst, manifest, theme && plotFollowsTheme(element, 'slide') ? theme : null);
  const scales = applyPlotColorScale(inst, manifest, element.colorScale, element.id, { styleBytes: true });
  if (reflow) {
    refreshRelayoutTemplates(inst);
    manifest = relayoutPlot(inst, originalManifest, element, "exact", { skipData: keepLayoutData }).manifest;
    prepareOverrideRestoration(inst);
  }
  preparePlotView(inst, manifest, element.view, element.id, undefined, true);
  applyOverrides(inst, element.overrides, element.id, manifest);
  applyPlotView(inst, manifest, element.view, element.id, undefined, keepGeometry);
  rememberStaticPlotView(inst, manifest, element.view);
  updatePtTrueBindings(bindings, [...colorScaleTickRoots(inst), ...projectionTickRoots(inst)]);
  if (!reflow) compensatePtTrue(inst, {
    elW: element.width, elH: element.height, crop: element.crop ?? null,
    contentScale: element.contentScale, intrinsic, styleBytes: true,
  }, bindings);
  return { scales, manifest };
}
