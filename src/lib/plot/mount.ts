// Svelte action that mounts a FluxPlot semantic SVG inline into a host <g>.
//
// We clone from the pristine cached DOM (never mutate the cache), prefix ids per
// placement, size the outer <svg> to the element's box, apply per-part
// overrides, then run pt-true compensation (geometry scales with the box; text/
// glyph/stroke sizes stay true-pt — plot/compensate.ts). Re-clones only when
// content-affecting fields change; pure x/y moves update the outer <svg>
// attributes in place (no re-clone per committed drag).

import { get } from "svelte/store";
import type { SemanticPlotElement } from "../types";
import { plotDom, plotManifests } from "./store";
import { applyOverrides, prefixIds } from "./parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "./compensate";

// Content signature: anything that requires a fresh clone + override/compensate
// pass. x/y are deliberately EXCLUDED (fast-path below).
function signature(e: SemanticPlotElement, gen: number): string {
  return [
    e.assetId,
    e.width,
    e.height,
    gen,
    JSON.stringify(e.overrides ?? {}),
    JSON.stringify(e.crop ?? null),
    e.contentScale ?? 1,
  ].join("|");
}

export function mountPlot(host: SVGGElement, params: { element: SemanticPlotElement; gen?: number }) {
  let element = params.element;
  let gen = params.gen ?? 0;
  let sig = "";
  let inst: SVGSVGElement | null = null;

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
    applyOverrides(inst, element.overrides, element.id, get(plotManifests)[element.assetId]);
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
      const ns = signature(element, gen);
      if (ns === sig) {
        place(); // x/y-only change: move the viewport, keep the clone
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
