// Serialize a placed semantic plot back to an inlined <svg> string (overrides
// baked in, ids prefixed, crop + pt-true compensation applied — identical to
// the live mount) for figure export — so exported figures keep real, tagged,
// editable vector parts instead of a flattened raster (spec §9 / P4).

import { get } from "svelte/store";
import type { SemanticPlotElement } from "../types";
import { plotDom, plotManifests, pristinePlotRoot } from "./store";
import { applyOverrides, prefixIds } from "./parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "./compensate";

export function plotToSvgMarkup(element: SemanticPlotElement): string | null {
  // Inline only what the editor has (the cached DOM is the "this plot is
  // resident" signal the export paths ensure), but SERIALIZE the pristine parse:
  // the cached DOM carries editor-only optimizations (baked <style> rules,
  // hoisted clip-paths — plot/parse.ts) that must not reach an exported file,
  // which is byte-compared against flux-core's render.
  if (!plotDom.has(element.assetId)) return null;
  const inst = pristinePlotRoot(element.assetId);
  if (!inst) return null;
  const intrinsic = svgIntrinsicPx(inst);
  prefixIds(inst, element.id);
  inst.setAttribute("x", String(element.x));
  inst.setAttribute("y", String(element.y));
  inst.setAttribute("width", String(element.width));
  inst.setAttribute("height", String(element.height));
  inst.setAttribute("preserveAspectRatio", "none");
  if (element.crop) {
    inst.setAttribute("viewBox", cropViewBoxValue(inst.getAttribute("viewBox"), intrinsic, element.crop));
    inst.setAttribute("overflow", "hidden");
  }
  applyOverrides(inst, element.overrides, element.id, get(plotManifests)[element.assetId]);
  compensatePtTrue(inst, {
    elW: element.width,
    elH: element.height,
    crop: element.crop ?? null,
    contentScale: element.contentScale,
    intrinsic,
  });
  return new XMLSerializer().serializeToString(inst);
}
