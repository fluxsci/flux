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

/** The vertices a series can tween: explicit marker `points` when present, else
 *  the manifest's raw `data` arrays (line-only series — a plain fp.line emits
 *  every vertex under `data` but no `points`, and without this the morph passed
 *  the compatibility gate then silently no-op'd the line). */
function tweenVertices(s: FluxPlotSeries): { index: number; x: number; y: number }[] {
  if (s.points?.length) return s.points;
  const xs = s.data?.x ?? [], ys = s.data?.y ?? [];
  const n = Math.min(xs.length, ys.length);
  return Array.from({ length: n }, (_, i) => ({ index: i, x: xs[i], y: ys[i] }));
}

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
  const bIdx = new Map(tweenVertices(sB).map((p) => [p.index, p]));
  return tweenVertices(sA).map((pa) => {
    const pb = bIdx.get(pa.index) ?? pa;
    return {
      index: pa.index,
      x: projectWith(fx, lerpData(pa.x, pb.x, t, fxA.log)),
      y: projectWith(fy, lerpData(pa.y, pb.y, t, fyA.log)),
    };
  });
}

/** PURE (SLD-8): can A tween into B? A morph pairs series by stable id and interpolates points
 *  in data space — so it's only meaningful when the two plots share structure. Compatible iff at
 *  least one series id is present in BOTH and, for such a series, both sides carry tweenable
 *  geometry (data points or a line path). A 10-point scatter → 4-bar chart (disjoint ids, or a
 *  bar series with neither points nor a line) is INCOMPATIBLE — without this gate the morph
 *  silently held/ignored mismatched parts and produced a wrong tween. Used by the editor to
 *  disable bad targets and by the player to skip (rather than mis-run) an incompatible morph. */
export function morphCompatible(A: FluxPlotManifest | undefined, B: FluxPlotManifest | undefined): boolean {
  const ba = A?.series ?? [], bb = B?.series ?? [];
  if (!ba.length || !bb.length) return false;
  const bById = new Map(bb.map((s) => [s.id, s]));
  const tweenable = (s: FluxPlotSeries) => (s.points?.length ?? 0) > 0 || !!s.svg?.line;
  for (const sA of ba) {
    const sB = bById.get(sA.id);
    if (sB && tweenable(sA) && tweenable(sB)) return true;
  }
  return false;
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

      // line: rebuild `d` from the projected points (equal vertex count ⇒ clean).
      // fluxplot wraps the series line in a <g data-role="line"> (esp. when the
      // line carries markers) whose CHILD <path> holds the geometry — rewrite the
      // drawable path, not the group (setting `d` on a <g> is a silent no-op).
      const lineId = sA.svg?.line;
      if (lineId && px.length) {
        const found = q(lineId);
        const node = found && found.tagName?.toLowerCase() !== "path" ? (found.querySelector?.("path") ?? found) : found;
        if (node) {
          node.setAttribute("d", px.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" "));
          // A prior drawOn leaves a stroke-dash window sized to the ORIGINAL
          // path; on a rewritten (longer) path it truncates the tail. Once the
          // morph owns the geometry (t>0) that dash is stale — clear it. At
          // t=0 the rebuild matches A's length, and drawOn's pre-beat hidden
          // state still needs its dasharray, so leave it alone.
          if (t > 0) {
            const st = (node as Element & { style?: CSSStyleDeclaration }).style;
            st?.removeProperty?.("stroke-dasharray");
            st?.removeProperty?.("stroke-dashoffset");
          }
        }
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
