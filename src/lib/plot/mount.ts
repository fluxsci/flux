// Svelte action that mounts a FluxPlot semantic SVG inline into a host <g>.
//
// We clone from the pristine cached DOM (never mutate the cache), prefix ids per
// placement, size the outer <svg> to the element's box, apply per-part
// overrides, then run pt-true compensation (geometry scales with the box; text/
// glyph/stroke sizes stay true-pt — plot/compensate.ts). Re-clones only when
// source, viewport, crop or layout mode changes. Styles re-apply in place;
// pure x/y moves only update the outer <svg> attributes.

import { applyPlotView, preparePlotView, projectionTickRoots, rememberStaticPlotView } from "./projectDom";
import { restylePlotInstance, notifyPlotRestyle } from "./restyle";
import { applyPlotColorScale, colorScaleTickRoots } from "./colorScaleDom";
import { applyPlotTheme, plotFollowsTheme } from "./themeDom";
import type { DeckTheme } from "../slide/types";
import { ensureColormapLuts, colormapLutsLoaded } from "../color/colormapLuts";
import { get } from "svelte/store";
import type { SemanticPlotElement, CropRect, PartOverride, PlotView } from "../types";
import { plotGen, plotDom, plotManifests, sigCalls, mountCounters } from "./store";
import { applyOverrides, prefixIds, prepareOverrideRestoration } from "./parse";
import { compensatePtTrue, compilePtTrueBindings, updatePtTrueBindings, type PtTrueBindings, svgIntrinsicPx, cropViewBoxValue } from "./compensate";
import type { FluxPlotManifest } from "./types";
import { relayoutPlot, relayoutSkipTickAxes } from "./relayout";
import { registerRelayoutPreview } from "./relayout/previewPaint";
import { updatePlotVisibleBounds, clearPlotVisibleBounds, hidesPlotParts, hasMeasuredPlotBounds } from './visibleBounds';
import type { Rect } from '../geometry';

// Structural changes invalidate the clone; styles reuse its compiled bindings.
function signatures(e: SemanticPlotElement, gen: number, theme: DeckTheme | null, elastic = false) {
  sigCalls.n++;
  return {
    structure: [e.assetId, e.width, e.height, gen, JSON.stringify(e.crop ?? null), e.layoutMode ?? "auto", elastic ? [...relayoutSkipTickAxes(get(plotManifests)[e.assetId], e.view)].sort().join(",") : ""].join("|"),
    style: [JSON.stringify(e.overrides ?? {}), JSON.stringify(e.colorScale ?? null), JSON.stringify(e.view ?? null), e.contentScale ?? 1, themeKey(e, theme)].join("|"),
  };
}

const themeKey = (e: SemanticPlotElement, theme: DeckTheme | null): string =>
  theme && plotFollowsTheme(e, "slide") ? `${theme.text}/${theme.textMuted}/${theme.background}` : "";

// A lazy asset can finish while its kept-alive pane is display:none. Retain
// last-good bounds and retry only when a pane is shown, never on a timer.
const pendingBounds=new Map<SVGSVGElement,()=>void>();
/** Publish bounds deferred while their plot was display:none (a hidden pane or
 * a parked Canvas placement). Callers run it once the subtree shows again. */
export function flushPendingPlotBounds():void {
  for(const [root,publish]of pendingBounds)if(root.isConnected&&root.getClientRects().length){pendingBounds.delete(root);publish();}
}
if(typeof window!=='undefined')window.addEventListener('flux:pane-shown',()=>{
  if(pendingBounds.size)queueMicrotask(flushPendingPlotBounds);
});

// WS-1 Fix 1: content-affecting fields, snapshotted by value/
// reference after each update. ops.setPartOverride/setCrop are copy-on-write
// (fresh overrides/crop object per change — verify-ops.ts locks the invariant),
// so reference equality on those plus scalar equality on the rest proves the
// content unchanged WITHOUT the per-notify JSON.stringify. A snapshot (not a
// prev-element comparison) is required because callers mutate the SAME element
// object in place — comparing next.element.width to element.width would compare
// the object with itself.
interface SigSnapshot {
  assetId: string;
  width: number;
  height: number;
  gen: number;
  overrides: Record<string, PartOverride> | undefined;
  crop: CropRect | undefined;
  view: PlotView | undefined;
  colorScale: SemanticPlotElement["colorScale"];
  contentScale: number;
  layoutMode: SemanticPlotElement["layoutMode"];
  theme: string;
}
const snap = (e: SemanticPlotElement, gen: number, theme: DeckTheme | null): SigSnapshot => ({
  assetId: e.assetId,
  width: e.width,
  height: e.height,
  gen,
  overrides: e.overrides,
  crop: e.crop,
  view: e.view,
  colorScale: e.colorScale,
  contentScale: e.contentScale ?? 1,
  layoutMode: e.layoutMode,
  theme: themeKey(e, theme),
});
const sameSnap = (a: SigSnapshot, e: SemanticPlotElement, gen: number, theme: DeckTheme | null): boolean =>
  a.assetId === e.assetId &&
  a.width === e.width &&
  a.height === e.height &&
  a.gen === gen &&
  a.overrides === e.overrides &&
  a.crop === e.crop &&
  a.view === e.view &&
  a.colorScale === e.colorScale && // ops.setPlotColorScale is copy-on-write like setPlotView
  a.contentScale === (e.contentScale ?? 1) &&
  a.layoutMode === e.layoutMode &&
  a.theme === themeKey(e, theme);

export function mountPlot(host: SVGGElement, params: { element: SemanticPlotElement; gen?: number; theme?: DeckTheme | null; onBounds?:(bounds:Rect|null|undefined)=>void }) {
  let element = params.element;
  let gen = params.gen ?? 0;
  let theme: DeckTheme | null = params.theme ?? null;
  let sig = "";
  let keys = signatures(element, gen, theme);
  let bindings: PtTrueBindings | undefined;
  let intrinsic = { w: 0, h: 0 };
  let reflow = false;
  let layoutManifest: FluxPlotManifest | undefined;
  let layoutContentScale = element.contentScale ?? 1;
  let last: SigSnapshot = snap(element, gen, theme);
  let inst: SVGSVGElement | null = null;
  let colorMapsRequested = false;
  let unregisterPreview=()=>{};
  let onBounds=params.onBounds;
  let measureGeneration=0;
  let boundsRoot:SVGSVGElement|null=null;

  function place() {
    if (!inst) return;
    inst.setAttribute("x", String(element.x));
    inst.setAttribute("y", String(element.y));
  }

  function requestColorMaps(unresolved: readonly string[]) {
    if (!unresolved.length || colorMapsRequested) return;
    colorMapsRequested = true;
    const assetId = element.assetId;
    void ensureColormapLuts().then(() => { if (colormapLutsLoaded()) plotGen.update((g) => ({ ...g, [assetId]: (g[assetId] ?? 0) + 1 })); });
  }

  function publishBounds() {
    if (!inst) return;
    const cached = plotDom.get(element.assetId);
    if (!cached) return;
    pendingBounds.delete(inst);
    // A restyle, like a mount, publishes only after the completed DOM commit.
    const generation=++measureGeneration,current=inst,source={dom:cached,key:sig};
    const publish=()=>{if(generation===measureGeneration&&current.isConnected){boundsRoot=current;onBounds?.(updatePlotVisibleBounds(current,element,source));}};
    queueMicrotask(()=>{
      if(generation!==measureGeneration||!current.isConnected)return;
      if(!hidesPlotParts(element)||hasMeasuredPlotBounds(source)||current.getClientRects().length)publish();
      else pendingBounds.set(current,publish);
    });
  }

  function restyle() {
    if (!inst || !bindings) return;
    mountCounters.restyles++;
    if (reflow) mountCounters.elasticRestyles++;
    const manifest = get(plotManifests)[element.assetId];
    notifyPlotRestyle(host, "before");
    const { scales, manifest: effective } = restylePlotInstance(inst, { element, manifest, theme, bindings, intrinsic, reflow, layoutManifest, keepLayoutData: layoutContentScale === (element.contentScale ?? 1) });
    layoutManifest = effective;
    layoutContentScale = element.contentScale ?? 1;
    notifyPlotRestyle(host, "after");
    requestColorMaps(scales.unresolved);
    place();
    unregisterPreview();
    unregisterPreview = registerRelayoutPreview(inst, manifest, element);
    publishBounds();
  }

  function render() {
    mountCounters.renders++;
    if (inst) mountCounters.reclones++;
    unregisterPreview();
    const previous=inst;
    if(previous)pendingBounds.delete(previous);
    host.replaceChildren();
    inst = null;
    const cached = plotDom.get(element.assetId);
    if (!cached) {if(boundsRoot)clearPlotVisibleBounds(element.id,boundsRoot);boundsRoot=null;onBounds?.(undefined);return;} // raster fallback
    // importNode adopts the node into this document (the cache lives in a parsed XML doc).
    inst = document.importNode(cached, true) as SVGSVGElement;
    intrinsic = svgIntrinsicPx(cached); // BEFORE width/height are overwritten
    prefixIds(inst, element.id);
    place();
    inst.setAttribute("width", String(element.width));
    inst.setAttribute("height", String(element.height));
    inst.setAttribute("preserveAspectRatio", "none");
    if (element.crop) {
      inst.setAttribute("viewBox", cropViewBoxValue(cached.getAttribute("viewBox"), intrinsic, element.crop));
      inst.style.overflow = "hidden"; // crop clips
    } else {
      inst.style.overflow = "visible";
    }
    bindings = compilePtTrueBindings(inst);
    const manifest = get(plotManifests)[element.assetId];
    // the deck theme's ink (Slide mode) and live colour scales BEFORE overrides, so an explicit
    // per-part paint still wins
    applyPlotTheme(inst, manifest, theme && plotFollowsTheme(element, "slide") ? theme : null);
    const scales = applyPlotColorScale(inst, manifest, element.colorScale, element.id, { styleBytes: true });
    requestColorMaps(scales.unresolved);
    const layout = relayoutPlot(inst, manifest, element);
    prepareOverrideRestoration(inst);
    preparePlotView(inst, layout.manifest, element.view, element.id, undefined, true);
    applyOverrides(inst, element.overrides, element.id, layout.manifest);
    applyPlotView(inst, layout.manifest, element.view, element.id);
    rememberStaticPlotView(inst, layout.manifest, element.view);
    reflow = layout.reflow;
    layoutManifest = layout.manifest;
    layoutContentScale = element.contentScale ?? 1;
    keys = signatures(element, gen, theme, reflow);
    sig = keys.structure + "|" + keys.style;
    updatePtTrueBindings(bindings, [...colorScaleTickRoots(inst), ...projectionTickRoots(inst)]);
    if (!layout.reflow) compensatePtTrue(inst, {
      elW: element.width,
      elH: element.height,
      crop: element.crop ?? null,
      contentScale: element.contentScale,
      intrinsic,
      styleBytes: true, // a later restyle restores these byte-exactly
    }, bindings);
    host.appendChild(inst);
    unregisterPreview=registerRelayoutPreview(inst,manifest,element);
    publishBounds();
  }

  sig = keys.structure + "|" + keys.style;
  render();

  return {
    update(next: { element: SemanticPlotElement; gen?: number; theme?: DeckTheme | null; onBounds?:(bounds:Rect|null|undefined)=>void }) {
      element = next.element;
      onBounds=next.onBounds;
      gen = next.gen ?? 0;
      theme = next.theme ?? null;
      // Fast path (WS-1 Fix 1): snapshot equality ⇒ content unchanged ⇒ no
      // JSON.stringify. Store notifies for unrelated commits cost O(1) here.
      if (sameSnap(last, element, gen, theme)) {
        place(); // x/y-only change: move the viewport, keep the clone
        return;
      }
      last = snap(element, gen, theme);
      const nextKeys = signatures(element, gen, theme, reflow);
      const ns = nextKeys.structure + "|" + nextKeys.style;
      if (ns === sig) {
        place(); // same content by value (e.g. undo round-trip): keep the clone
        return;
      }
      const structural = nextKeys.structure !== keys.structure;
      keys = nextKeys;
      sig = ns;
      if (structural || !inst || !bindings) render();
      else restyle();
    },
    destroy() {
      measureGeneration++;
      if(inst)pendingBounds.delete(inst);
      if(boundsRoot)clearPlotVisibleBounds(element.id,boundsRoot);
      unregisterPreview();
      host.replaceChildren();
    },
  };
}
