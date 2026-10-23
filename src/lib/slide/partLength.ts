// ---------------------------------------------------------------------------
// Flux Slide — pen length of a plot part (pure, DOM-API-only: works on a browser Element, a linkedom
// Element or the pristine `plotDom` root). The auto-build scales a draw's duration by how far the pen
// travels (`drawDuration`, autobuild.ts); BOTH the GUI button and the headless `animate-plot` verb call
// THIS function on the same SVG, so the two cannot disagree by a rounding step (R3 code-critic F8).
// "Which geometry draws" is `strokeGeometry.drawGeometry` (shared with the drawOn preset).
// ---------------------------------------------------------------------------
import { pathToSubpaths, segsFromNodes, segLength } from "../path";
import { drawGeometry } from "./strokeGeometry";
import { buildPartTree, type XrayNode } from "../plot/tree";
import type { FluxPlotManifest } from "../plot/types";

const num = (el: Element, name: string): number => { const v = parseFloat(el.getAttribute(name) ?? ""); return Number.isFinite(v) ? v : 0; };

/** Arc length of ONE stroke geometry element in its own user units (== Chrome getTotalLength within 0.02 % on
 *  M/L/H/V/C/S/Q/T/A paths; exact for line/polyline/polygon; rect = perimeter with circular corners; ellipse =
 *  Ramanujan II). `transform` attributes are not applied (fluxplot parts carry none on their geometry). */
export function geometryLength(el: Element): number {
  switch (el.tagName.toLowerCase()) {
    case "path": {
      let len = 0;
      for (const sp of pathToSubpaths(el.getAttribute("d") ?? "")) len += segsFromNodes(sp.nodes, sp.closed).reduce((a, s) => a + segLength(s, 64), 0);
      return len;
    }
    case "line": return Math.hypot(num(el, "x2") - num(el, "x1"), num(el, "y2") - num(el, "y1"));
    case "polyline": case "polygon": {
      const n = (el.getAttribute("points") ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
      let len = 0;
      for (let i = 2; i + 1 < n.length; i += 2) len += Math.hypot(n[i] - n[i - 2], n[i + 1] - n[i - 1]);
      if (el.tagName.toLowerCase() === "polygon" && n.length >= 4) len += Math.hypot(n[0] - n[n.length - 2], n[1] - n[n.length - 1]);
      return len;
    }
    case "rect": { const w = num(el, "width"), h = num(el, "height"), r = Math.min(num(el, "rx") || num(el, "ry"), w / 2, h / 2); return 2 * (w + h) - (8 - 2 * Math.PI) * r; }
    case "circle": return 2 * Math.PI * num(el, "r");
    case "ellipse": { const a = num(el, "rx"), b = num(el, "ry"), h = ((a - b) / (a + b)) ** 2; return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))); }
    default: return 0;
  }
}

/** The LONGEST stroke the part's drawOn will trace (children draw simultaneously, so the longest sets the
 *  pace); 0 when the part has no stroke geometry (text, `<use>` ticks, filled marks). */
export function partPenLength(node: Element | null | undefined): number {
  if (!node) return 0;
  return Math.max(0, ...drawGeometry(node).strokes.map(geometryLength));
}

/** `ids` -> pen length in STAGE units: `root` is the plot's parsed SVG; `stagePerUnit` = placed width / viewBox width.
 *  A group id that has no DOM node of its own sums nothing and is simply absent. */
export function partPenLengths(root: ParentNode, ids: readonly string[], stagePerUnit: number): Record<string, number> {
  const out: Record<string, number> = {};
  // ONE pass indexes every id (first wins, as getElementById does): a per-id attribute query over a dense plot is
  // O(parts x nodes) and froze the Animate click for seconds on 100k-node scatters (review F3).
  const index = new Map<string, Element>();
  for (const el of Array.from(root.querySelectorAll?.("[id]") ?? [])) { const id = el.getAttribute("id"); if (id && !index.has(id)) index.set(id, el); }
  for (const id of ids) { const len = partPenLength(index.get(id)) * stagePerUnit; if (len > 0) out[id] = Math.round(len * 10) / 10; }
  return out;
}

/** Every build-part id of a plot (tree nodes, groups and leaves) -> pen length in STAGE units. `root` = the plot SVG parsed
 *  by whoever holds it (GUI: the cached `plotDom` <svg> element; CLI: linkedom on the file text); `elWidth` = the placed element's width in stage
 *  units. The ONE call the Animate button and `flux animate-plot` both make, so the two builds cannot disagree. */
export function plotPenLengths(root: ParentNode, manifest: FluxPlotManifest | undefined, elWidth: number): Record<string, number> {
  const tree = buildPartTree(manifest);
  // the GUI holds the pristine <svg> element (plotDom), a parse of the text gives a document: accept both
  const svg = (root as Element).tagName?.toLowerCase() === "svg" ? (root as Element) : (root as Document).querySelector?.("svg");
  const vb = (svg?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const vbWidth = vb.length === 4 && vb[2] > 0 ? vb[2] : Number(svg?.getAttribute("width")) || 0;
  if (!tree || !(vbWidth > 0) || !(elWidth > 0)) return {};
  const ids: string[] = [];
  const walk = (n: XrayNode) => { ids.push(n.id); n.children.forEach(walk); };
  walk(tree);
  return partPenLengths(root, ids, elWidth / vbWidth);
}
