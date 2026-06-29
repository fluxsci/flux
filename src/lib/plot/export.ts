// Serialize a placed semantic plot back to an inlined <svg> string (overrides
// baked in, ids prefixed) for figure export — so exported figures keep real,
// tagged, editable vector parts instead of a flattened raster (spec §9 / P4).

import { get } from "svelte/store";
import type { SemanticPlotElement } from "../types";
import { plotDom, plotManifests } from "./store";
import { applyOverrides, prefixIds } from "./parse";

export function plotToSvgMarkup(element: SemanticPlotElement): string | null {
  const cached = plotDom.get(element.assetId);
  if (!cached) return null;
  const inst = cached.cloneNode(true) as SVGSVGElement;
  prefixIds(inst, element.id);
  inst.setAttribute("x", String(element.x));
  inst.setAttribute("y", String(element.y));
  inst.setAttribute("width", String(element.width));
  inst.setAttribute("height", String(element.height));
  inst.setAttribute("preserveAspectRatio", "none");
  applyOverrides(inst, element.overrides, element.id, get(plotManifests)[element.assetId]);
  return new XMLSerializer().serializeToString(inst);
}
