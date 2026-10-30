// Re-apply style on a fixed-layout clone. The caller keeps structural edits
// and elastic reflow on the full mount path; exports and slides keep theirs.
import type { SemanticPlotElement } from '../types';
import type { DeckTheme } from '../slide/types';
import type { FluxPlotManifest } from './types';
import { restorePtTrue, compensatePtTrue, updatePtTrueBindings, type PtTrueBindings } from './compensate';
import { restoreProjection, preparePlotView, applyPlotView, projectionTickRoots, canKeepPlotViewGeometry, rememberStaticPlotView } from './projectDom';
import { restoreOverrides, applyOverrides } from './parse';
import { applyPlotTheme, plotFollowsTheme } from './themeDom';
import { applyPlotColorScale, colorScaleTickRoots } from './colorScaleDom';

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
}

export function restylePlotInstance(inst: SVGSVGElement, { element, manifest, theme, bindings, intrinsic }: RestyleOptions) {
  restorePtTrue(inst, bindings);
  const keepGeometry = canKeepPlotViewGeometry(inst, manifest, element.view);
  restoreProjection(inst, keepGeometry);
  restoreOverrides(inst, element.overrides, element.id, manifest);
  applyPlotTheme(inst, manifest, theme && plotFollowsTheme(element, 'slide') ? theme : null);
  const scales = applyPlotColorScale(inst, manifest, element.colorScale, element.id);
  preparePlotView(inst, manifest, element.view, element.id, undefined, true);
  applyOverrides(inst, element.overrides, element.id, manifest);
  applyPlotView(inst, manifest, element.view, element.id, undefined, keepGeometry);
  rememberStaticPlotView(inst, manifest, element.view);
  updatePtTrueBindings(bindings, [...colorScaleTickRoots(inst), ...projectionTickRoots(inst)]);
  compensatePtTrue(inst, {
    elW: element.width, elH: element.height, crop: element.crop ?? null,
    contentScale: element.contentScale, intrinsic, styleBytes: true,
  }, bindings);
  return { scales, manifest };
}
