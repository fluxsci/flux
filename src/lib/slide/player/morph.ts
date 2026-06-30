// ---------------------------------------------------------------------------
// Flux Slide — the data-space morph (§5.4, the crown jewel). Tween one semantic
// plot (state A) into a second SAME-STRUCTURE semantic plot (state B) by matching
// parts on stable id, interpolating each datum in DATA space (log-aware), and
// projecting through a per-frame blend of the two axes' data↔pixel anchor tables.
// "The data moves" — only possible because Flux plots carry their meaning.
//
// The projection math is pure + exported (headless-testable); `createMorph`
// rewrites the live DOM (line path `d`, point markers) on `seek(t)`. Tier-2: one
// plot, scene otherwise still. v1 scope: line/scatter, matched ids, axis rescale,
// linear+log; topology changes fall back to fade (handled by the player).
// ---------------------------------------------------------------------------

import type { FluxPlotManifest, FluxPlotAxis, FluxPlotSeries } from "../../plot/types";

const SEP = "__";
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A one-axis data→svg-pixel fit `svg = m·f(data) + c` (f = log on log scales),
 *  derived from the manifest's anchor table (handles the y-flip + domain). */
interface Fit { m: number; c: number; log: boolean; }
function axisFit(axis: FluxPlotAxis): Fit {
  const log = axis.scale === "log";
  const f = (v: number) => (log ? Math.log(v) : v);
  const as = axis.anchors?.length >= 2 ? axis.anchors : [{ data: axis.domain[0], svg: 0 }, { data: axis.domain[1], svg: 1 }];
  const a0 = as[0], a1 = as[as.length - 1];
  const denom = f(a1.data) - f(a0.data) || 1;
  const m = (a1.svg - a0.svg) / denom;
  return { m, c: a0.svg - m * f(a0.data), log };
}
const projectWith = (ft: Fit, v: number) => ft.m * (ft.log ? Math.log(v) : v) + ft.c;
const blendFit = (a: Fit, b: Fit, t: number): Fit => ({ m: lerp(a.m, b.m, t), c: lerp(a.c, b.c, t), log: a.log });
const lerpData = (vA: number, vB: number, t: number, log: boolean) =>
  log ? Math.exp(lerp(Math.log(vA), Math.log(vB), t)) : lerp(vA, vB, t);

export interface MorphPoint { index: number; x: number; y: number }

/** PURE: the projected pixel positions of a series' points at morph time `t`,
 *  interpolating each datum A→B in data space then projecting through the blended
 *  axis fits. Points only in A hold at A; points matched in B move toward B. */
export function morphSeriesPixels(
  sA: FluxPlotSeries,
  sB: FluxPlotSeries,
  axA: { x: FluxPlotAxis; y: FluxPlotAxis },
  axB: { x: FluxPlotAxis; y: FluxPlotAxis },
  t: number,
): MorphPoint[] {
  const fxA = axisFit(axA.x), fxB = axisFit(axB.x), fyA = axisFit(axA.y), fyB = axisFit(axB.y);
  const fx = blendFit(fxA, fxB, t), fy = blendFit(fyA, fyB, t);
  const bIdx = new Map((sB.points ?? []).map((p) => [p.index, p]));
  return (sA.points ?? []).map((pa) => {
    const pb = bIdx.get(pa.index) ?? pa;
    return {
      index: pa.index,
      x: projectWith(fx, lerpData(pa.x, pb.x, t, fxA.log)),
      y: projectWith(fy, lerpData(pa.y, pb.y, t, fyA.log)),
    };
  });
}

export interface MorphController {
  /** Set the morph to time `t` ∈ [0,1] (0 = A, 1 = B). */
  seek(t: number): void;
}

/** Build a live morph over an already-rendered plot element (its parts are
 *  id-prefixed `${elId}__${semanticId}`). `seek` rewrites the line path + point
 *  markers in place; the player drives it (rAF for play, static seek(0|1) for
 *  resting before/after the morph beat). */
export function createMorph(wrap: ParentNode, elId: string, A: FluxPlotManifest, B: FluxPlotManifest): MorphController {
  const q = (svgId: string): Element | null => wrap.querySelector(`[id="${elId}${SEP}${svgId}"]`);
  const axA = A.axes[0] ?? { x: { scale: "linear", domain: [0, 1], anchors: [] }, y: { scale: "linear", domain: [0, 1], anchors: [] } };
  const axB = B.axes[0] ?? axA;
  const fxAorig = axisFit(axA.x), fyAorig = axisFit(axA.y);
  const pairs = (A.series ?? []).map((sA) => ({ sA, sB: (B.series ?? []).find((s) => s.id === sA.id) ?? sA }));

  function seek(t: number): void {
    for (const { sA, sB } of pairs) {
      const px = morphSeriesPixels(sA, sB, axA, axB, t);

      // line: rebuild `d` from the projected points (equal vertex count ⇒ clean)
      const lineId = sA.svg?.line;
      if (lineId && px.length) {
        const node = q(lineId);
        if (node) node.setAttribute("d", px.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" "));
      }

      // point markers: <circle> → cx/cy; anything else → translate from its A pixel
      (sA.points ?? []).forEach((pa, i) => {
        const node = q(pa.svgId) as (Element & { style?: CSSStyleDeclaration }) | null;
        if (!node) return;
        const p = px[i];
        if (node.tagName?.toLowerCase() === "circle") {
          node.setAttribute("cx", p.x.toFixed(2));
          node.setAttribute("cy", p.y.toFixed(2));
        } else if (node.style) {
          const ox = projectWith(fxAorig, pa.x), oy = projectWith(fyAorig, pa.y);
          node.style.transform = `translate(${(p.x - ox).toFixed(2)}px, ${(p.y - oy).toFixed(2)}px)`;
        }
      });
    }
  }
  return { seek };
}
