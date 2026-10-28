// Svelte action that mounts a FluxPlot semantic SVG inline into a host <g>.
//
// We clone from the pristine cached DOM (never mutate the cache), prefix ids per
// placement, size the outer <svg> to the element's box, apply per-part
// overrides, then run pt-true compensation (geometry scales with the box; text/
// glyph/stroke sizes stay true-pt — plot/compensate.ts). Re-clones only when
// content-affecting fields change; pure x/y moves update the outer <svg>
// attributes in place (no re-clone per committed drag).

import { applyPlotView, preparePlotView } from "./projectDom";
import { applyPlotColorScale } from "./colorScaleDom";
import { applyPlotTheme, plotFollowsTheme } from "./themeDom";
import type { DeckTheme } from "../slide/types";
import { ensureColormapLuts, colormapLutsLoaded } from "../color/colormapLuts";
import { get } from "svelte/store";
import type { SemanticPlotElement, CropRect, PartOverride, PlotView } from "../types";
import { plotGen, plotDom, plotManifests, sigCalls } from "./store";
import { applyOverrides, prefixIds } from "./parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "./compensate";
import { relayoutPlot } from "./relayout";
import { registerRelayoutPreview } from "./relayout/previewPaint";
import { updatePlotVisibleBounds, clearPlotVisibleBounds, hidesPlotParts, hasMeasuredPlotBounds } from './visibleBounds';
import type { Rect } from '../geometry';

// Content signature: anything that requires a fresh clone + override/compensate
// pass. x/y are deliberately EXCLUDED (fast-path below).
function signature(e: SemanticPlotElement, gen: number, theme: DeckTheme | null): string {
  sigCalls.n++; // dev counter — verify-scale-figure asserts 0 on unrelated commits
  return [
    e.assetId,
    e.width,
    e.height,
    gen,
    JSON.stringify(e.overrides ?? {}),
    JSON.stringify(e.crop ?? null),
    JSON.stringify(e.colorScale ?? null),
    JSON.stringify(e.view ?? null),
    e.contentScale ?? 1,
    e.layoutMode ?? "auto",
    // the deck theme the scaffold ink follows (Slide mode; Figure passes none)
    themeKey(e, theme),
  ].join("|");
}

const themeKey = (e: SemanticPlotElement, theme: DeckTheme | null): string =>
  theme && plotFollowsTheme(e, "slide") ? `${theme.text}/${theme.textMuted}/${theme.background}` : "";

// A lazy asset can finish while its kept-alive pane is display:none. Retain
// last-good bounds and retry only when a pane is shown, never on a timer.
const pendingBounds=new Map<SVGSVGElement,()=>void>();
if(typeof window!=='undefined')window.addEventListener('flux:pane-shown',()=>{
  if(pendingBounds.size)queueMicrotask(()=>{for(const [root,publish]of pendingBounds)if(root.isConnected&&root.getClientRects().length){pendingBounds.delete(root);publish();}});
});

// WS-1 Fix 1: the fields whose CHANGE forces a re-clone, snapshotted by value/
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

  function render() {
    unregisterPreview();
    const previous=inst;
    if(previous)pendingBounds.delete(previous);
    host.replaceChildren();
    inst = null;
    const cached = plotDom.get(element.assetId);
    if (!cached) {if(boundsRoot)clearPlotVisibleBounds(element.id,boundsRoot);boundsRoot=null;onBounds?.(undefined);return;} // raster fallback
    // importNode adopts the node into this document (the cache lives in a parsed XML doc).
    inst = document.importNode(cached, true) as SVGSVGElement;
    const intrinsic = svgIntrinsicPx(cached); // BEFORE width/height are overwritten
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
    const manifest = get(plotManifests)[element.assetId];
    // the deck theme's ink (Slide mode) and live colour scales BEFORE overrides, so an explicit
    // per-part paint still wins
    applyPlotTheme(inst, manifest, theme && plotFollowsTheme(element, "slide") ? theme : null);
    const scales = applyPlotColorScale(inst, manifest, element.colorScale, element.id);
    if (scales.unresolved.length && !colorMapsRequested) {
      // a named map whose table is not loaded yet: paint as generated now, re-render once it is
      colorMapsRequested = true;
      const assetId = element.assetId;
      void ensureColormapLuts().then(() => { if (colormapLutsLoaded()) plotGen.update((g) => ({ ...g, [assetId]: (g[assetId] ?? 0) + 1 })); });
    }
    const layout = relayoutPlot(inst, manifest, element);
    preparePlotView(inst, layout.manifest, element.view, element.id);
    applyOverrides(inst, element.overrides, element.id, layout.manifest);
    applyPlotView(inst, layout.manifest, element.view, element.id);
    if (!layout.reflow) compensatePtTrue(inst, {
      elW: element.width,
      elH: element.height,
      crop: element.crop ?? null,
      contentScale: element.contentScale,
      intrinsic,
    });
    host.appendChild(inst);
    unregisterPreview=registerRelayoutPreview(inst,manifest,element);
    // Actions may run before the outer scene is attached. A microtask observes
    // the completed DOM commit; stale callbacks never publish a prior mount.
    const generation=++measureGeneration,current=inst,source={dom:cached,key:sig};
    const publish=()=>{if(generation===measureGeneration&&current.isConnected){boundsRoot=current;onBounds?.(updatePlotVisibleBounds(current,element,source));}};
    queueMicrotask(()=>{
      if(generation!==measureGeneration||!current.isConnected)return;
      if(!hidesPlotParts(element)||hasMeasuredPlotBounds(source)||current.getClientRects().length)publish();
      else pendingBounds.set(current,publish);
    });
  }

  sig = signature(element, gen, theme);
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
      const ns = signature(element, gen, theme);
      if (ns === sig) {
        place(); // same content by value (e.g. undo round-trip): keep the clone
        return;
      }
      sig = ns;
      render();
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
