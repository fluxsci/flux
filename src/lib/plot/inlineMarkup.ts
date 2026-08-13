// Shared inline-markup builder for a PLACED semantic plot (Twin-Engine §2):
// parse the asset SVG from text, bake the element's per-part overrides, apply
// crop + pt-true compensation, and serialize to an <svg> string ready for
// figureToSvg's plotMarkup callback. ONE implementation for every disk-backed
// render path — flux-core's headless renderFigureSvg/materializeRenders AND the
// paper module's renderFigureSvg (embeds, hover cards, pickers, in-app
// preview/PDF, app-side materializeRenders) — so a part the user hid or
// restyled in the figure editor stays hidden/restyled EVERYWHERE (the
// 2026-08-12 double-title report: the paper path used to skip overrides
// entirely and draw the raw plot). The GUI figure-editor export keeps its
// live-store twin (plot/export.ts plotToSvgMarkup — same pipeline over the
// cached pristine DOM); this module is the from-text equivalent.
//
// DOM dependency: uses the global DOMParser via preparePlot — native in the
// renderer; headless callers register linkedom first (flux-core ensureDom()).

import { preparePlot, prefixIds, applyOverrides } from "./parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "./compensate";
import type { FluxPlotManifest } from "./types";

export interface PlacedPlotFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  crop?: { x: number; y: number; width: number; height: number };
  contentScale?: number;
}

// XMLSerializer in the renderer; linkedom's toString headless (linkedom
// registers no XMLSerializer global — its Element.toString serializes).
function serializeSvg(el: object): string {
  if (typeof XMLSerializer !== "undefined")
    return new XMLSerializer().serializeToString(el as Node);
  return String(el);
}

/** Runs the SAME preparePlot seam as the app's cachePlot — normalization
 *  (sanitize / shared-<use> inlining / id stamping) + orphan augmentation —
 *  so group-keyed overrides (`unclassified`, derived groups) resolve
 *  identically everywhere, and the same crop + pt-true compensation. */
export function buildPlotMarkup(
  svgText: string,
  el: PlacedPlotFrame,
  overrides: Record<string, unknown> | undefined,
  manifest: FluxPlotManifest | undefined,
): string | null {
  const prepared = preparePlot(svgText, manifest);
  const rootEl = prepared.root;
  if (!rootEl) return null;
  const intrinsic = svgIntrinsicPx(rootEl as unknown as globalThis.Element);
  prefixIds(rootEl as unknown as globalThis.Element, el.id);
  rootEl.setAttribute("x", String(el.x));
  rootEl.setAttribute("y", String(el.y));
  rootEl.setAttribute("width", String(el.width));
  rootEl.setAttribute("height", String(el.height));
  rootEl.setAttribute("preserveAspectRatio", "none");
  if (el.crop) {
    // NOTE: preparePlot never mutates width/height/viewBox, so reading the
    // original viewBox off the prepared root pre-override is still valid here.
    rootEl.setAttribute(
      "viewBox",
      cropViewBoxValue(rootEl.getAttribute("viewBox"), intrinsic, el.crop),
    );
    rootEl.setAttribute("overflow", "hidden");
  }
  applyOverrides(
    rootEl as unknown as globalThis.Element,
    overrides as Parameters<typeof applyOverrides>[1],
    el.id,
    prepared.manifest,
  );
  compensatePtTrue(rootEl as unknown as globalThis.Element, {
    elW: el.width,
    elH: el.height,
    crop: el.crop ?? null,
    contentScale: el.contentScale,
    intrinsic,
  });
  return serializeSvg(rootEl);
}
