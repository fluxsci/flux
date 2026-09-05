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
  if (!A || !B || !A.series?.length || A.series.length !== B.series?.length) return false;
  if (A.axes?.length !== B.axes?.length) return false;
  for (let i = 0; i < (A.axes?.length ?? 0); i++) {
    if (A.axes[i].x.scale !== B.axes[i].x.scale || A.axes[i].y.scale !== B.axes[i].y.scale) return false;
  }
  const bById = new Map(B.series.map((s) => [s.id, s]));
  return A.series.every((a) => {
    const b = bById.get(a.id);
    if (!b) return false;
    const av = tweenVertices(a), bv = tweenVertices(b);
    if (!av.length || av.length !== bv.length || Boolean(a.svg?.line) !== Boolean(b.svg?.line)) return false;
    const indices = new Set(bv.map((p) => p.index));
    return av.every((p) => indices.has(p.index));
  });
}

export interface MorphController {
  /** Set the morph to time `t` ∈ [0,1] (0 = A, 1 = B). */
  seek(t: number): void;
  /** The compiled destination content; later cues bind its semantic parts. */
  targetRoot?: HTMLElement;
}

/** Build a live morph over an already-rendered plot element (its parts are
 *  id-prefixed `${elId}__${semanticId}`). `seek` rewrites the line path + point
 *  markers in place; the player drives it (rAF for play, static seek(0|1) for
 *  resting before/after the morph beat). */
export function createMorph(wrap: ParentNode, elId: string, A: FluxPlotManifest, B: FluxPlotManifest, geometryInterpolated = false): MorphController {
  // Resolve all DOM and datum identities ONCE. The frame path contains no
  // selectors, map construction, axis fitting, or source-array searches.
  const nodes = new Map<string, Element>();
  for (const node of Array.from(wrap.querySelectorAll("[id]"))) nodes.set(node.id, node);
  const q = (id: string) => nodes.get(`${elId}${SEP}${id}`);
  const axA = A.axes[0] ?? { x: { scale: "linear", domain: [0, 1], anchors: [] }, y: { scale: "linear", domain: [0, 1], anchors: [] } };
  const axB = B.axes[0] ?? axA;
  const fxA = axisFit(axA.x), fyA = axisFit(axA.y), fxB = axisFit(axB.x), fyB = axisFit(axB.y);
  const bSeries = new Map((B.series ?? []).map((s) => [s.id, s]));
  const pairs = (A.series ?? []).map((a) => {
    const b = bSeries.get(a.id) ?? a;
    const bv = new Map(tweenVertices(b).map((p) => [p.index, p]));
    const markers = new Map((a.points ?? []).map((p) => [p.index, p.svgId]));
    const points = tweenVertices(a).map((pa) => {
      const pb = bv.get(pa.index) ?? pa;
      return { a: pa, b: pb, node: q(markers.get(pa.index) ?? ""), ox: projectWith(fxA, pa.x), oy: projectWith(fyA, pa.y), ex: projectWith(fxB, pb.x), ey: projectWith(fyB, pb.y) };
    });
    const found = a.svg?.line ? q(a.svg.line) : undefined;
    const line = found?.tagName?.toLowerCase() === "path" ? found : found?.querySelector("path");
    return { points, line };
  });
  function seek(raw: number): void {
    const t = Math.max(0, Math.min(1, raw));
    // Other controllers may share these nodes, so endpoint seeks still write.
    const fx = blendFit(fxA, fxB, t), fy = blendFit(fyA, fyB, t);
    for (const pair of pairs) {
      const path: string[] = [];
      for (let i = 0; i < pair.points.length; i++) {
        const p = pair.points[i];
        const x = projectWith(fx, lerpData(p.a.x, p.b.x, t, fxA.log));
        const y = projectWith(fy, lerpData(p.a.y, p.b.y, t, fyA.log));
        if (pair.line) path.push(`${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`);
        if (p.node?.tagName?.toLowerCase() === "circle") {
          p.node.setAttribute("cx", x.toFixed(2)); p.node.setAttribute("cy", y.toFixed(2));
        } else if (p.node) {
          // The complete SVG binding already moves this marker linearly. Add
          // only the data-space correction, on a separate CSS channel so an
          // entrance transform and authored marker transform remain intact.
          const ox = geometryInterpolated ? lerp(p.ox, p.ex, t) : p.ox;
          const oy = geometryInterpolated ? lerp(p.oy, p.ey, t) : p.oy;
          (p.node as SVGElement).style.translate = `${(x - ox).toFixed(2)}px ${(y - oy).toFixed(2)}px`;
        }
      }
      if (pair.line && path.length) {
        pair.line.setAttribute("d", path.join(" "));
        if (t > 0) {
          (pair.line as SVGElement).style.removeProperty("stroke-dasharray");
          (pair.line as SVGElement).style.removeProperty("stroke-dashoffset");
        }
      }
    }
  }
  return { seek };
}
