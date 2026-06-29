// Svelte action that mounts a FluxPlot semantic SVG inline into a host <g>.
//
// We clone from the pristine cached DOM (never mutate the cache), prefix ids per
// placement, size the outer <svg> to the element's box, and apply per-part
// overrides. Re-clones only when geometry / overrides actually change (a cheap
// signature guard) so steady-state pan/zoom and unrelated store updates are free.

import { get } from "svelte/store";
import type { SemanticPlotElement } from "../types";
import { plotDom, plotManifests } from "./store";
import { applyOverrides, prefixIds } from "./parse";

function signature(e: SemanticPlotElement, gen: number): string {
  return [e.assetId, e.x, e.y, e.width, e.height, gen, JSON.stringify(e.overrides ?? {})].join("|");
}

export function mountPlot(host: SVGGElement, params: { element: SemanticPlotElement; gen?: number }) {
  let element = params.element;
  let gen = params.gen ?? 0;
  let sig = "";

  function render() {
    host.replaceChildren();
    const cached = plotDom.get(element.assetId);
    if (!cached) return; // PlotElement shows the <image> fallback instead
    // importNode adopts the node into this document (the cache lives in a parsed XML doc).
    const inst = document.importNode(cached, true) as SVGSVGElement;
    prefixIds(inst, element.id);
    inst.setAttribute("x", String(element.x));
    inst.setAttribute("y", String(element.y));
    inst.setAttribute("width", String(element.width));
    inst.setAttribute("height", String(element.height));
    inst.setAttribute("preserveAspectRatio", "none");
    inst.style.overflow = "visible";
    applyOverrides(inst, element.overrides, element.id, get(plotManifests)[element.assetId]);
    host.appendChild(inst);
  }

  sig = signature(element, gen);
  render();

  return {
    update(next: { element: SemanticPlotElement; gen?: number }) {
      element = next.element;
      gen = next.gen ?? 0;
      const ns = signature(element, gen);
      if (ns === sig) return;
      sig = ns;
      render();
    },
    destroy() {
      host.replaceChildren();
    },
  };
}
