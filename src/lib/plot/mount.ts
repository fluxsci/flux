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
import { ensureColormapLuts, colormapLutsLoaded } from "../color/colormapLuts";
import { get } from "svelte/store";
import type { SemanticPlotElement, CropRect, PartOverride, PlotView } from "../types";
import { plotGen, plotDom, plotManifests, sigCalls } from "./store";
import { applyOverrides, prefixIds } from "./parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "./compensate";

// Content signature: anything that requires a fresh clone + override/compensate
// pass. x/y are deliberately EXCLUDED (fast-path below).
function signature(e: SemanticPlotElement, gen: number): string {
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
  ].join("|");
}

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
}
const snap = (e: SemanticPlotElement, gen: number): SigSnapshot => ({
  assetId: e.assetId,
  width: e.width,
  height: e.height,
  gen,
  overrides: e.overrides,
  crop: e.crop,
  view: e.view,
  colorScale: e.colorScale,
  contentScale: e.contentScale ?? 1,
});
const sameSnap = (a: SigSnapshot, e: SemanticPlotElement, gen: number): boolean =>
  a.assetId === e.assetId &&
  a.width === e.width &&
  a.height === e.height &&
  a.gen === gen &&
  a.overrides === e.overrides &&
  a.crop === e.crop &&
  a.view === e.view &&
  a.colorScale === e.colorScale && // ops.setPlotColorScale is copy-on-write like setPlotView
  a.contentScale === (e.contentScale ?? 1);

export function mountPlot(host: SVGGElement, params: { element: SemanticPlotElement; gen?: number }) {
  let element = params.element;
  let gen = params.gen ?? 0;
  let sig = "";
  let last: SigSnapshot = snap(element, gen);
  let inst: SVGSVGElement | null = null;
  let colorMapsRequested = false;

  function place() {
    if (!inst) return;
    inst.setAttribute("x", String(element.x));
    inst.setAttribute("y", String(element.y));
  }

  function render() {
    host.replaceChildren();
    inst = null;
    const cached = plotDom.get(element.assetId);
    if (!cached) return; // PlotElement shows the <image> fallback instead
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
    preparePlotView(inst, manifest, element.view, element.id);
    // live colour scales BEFORE overrides, so an explicit per-part paint still wins
    const scales = applyPlotColorScale(inst, manifest, element.colorScale, element.id);
    if (scales.unresolved.length && !colorMapsRequested) {
      // a named map whose table is not loaded yet: paint as generated now, re-render once it is
      colorMapsRequested = true;
      const assetId = element.assetId;
      void ensureColormapLuts().then(() => { if (colormapLutsLoaded()) plotGen.update((g) => ({ ...g, [assetId]: (g[assetId] ?? 0) + 1 })); });
    }
    applyOverrides(inst, element.overrides, element.id, manifest);
    applyPlotView(inst, manifest, element.view, element.id);
    compensatePtTrue(inst, {
      elW: element.width,
      elH: element.height,
      crop: element.crop ?? null,
      contentScale: element.contentScale,
      intrinsic,
    });
    host.appendChild(inst);
  }

  sig = signature(element, gen);
  render();

  return {
    update(next: { element: SemanticPlotElement; gen?: number }) {
      element = next.element;
      gen = next.gen ?? 0;
      // Fast path (WS-1 Fix 1): snapshot equality ⇒ content unchanged ⇒ no
      // JSON.stringify. Store notifies for unrelated commits cost O(1) here.
      if (sameSnap(last, element, gen)) {
        place(); // x/y-only change: move the viewport, keep the clone
        return;
      }
      last = snap(element, gen);
      const ns = signature(element, gen);
      if (ns === sig) {
        place(); // same content by value (e.g. undo round-trip): keep the clone
        return;
      }
      sig = ns;
      render();
    },
    destroy() {
      host.replaceChildren();
    },
  };
}
