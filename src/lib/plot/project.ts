// Shared data→SVG projection for plot views, asset Becomes and data pairing.
// No DOM construction or browser geometry APIs; guide recovery reads attributes.
import type { PlotView, PlotAxisKey } from "../types";
import type { FluxPlotManifest, FluxPlotAxis, FluxPlotSeries } from "./types";
import { partDomId } from "./parse";
import { applyToPoint, transformToAncestor } from "./svgMatrix";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export interface Fit {
  m: number; c: number; log: boolean;
  /** A scale switch blends the two projection functions, not their units. */
  linear?: number;
  logarithmic?: number;
}
/** The panel's fits; `y2` / `x2` are present when the panel has a twin value axis (C4). */
export interface Fits { x: Fit; y: Fit; y2?: Fit; x2?: Fit }
/** The two fits a series projects through: its panel's, or its twin's for the axis it reads. */
export function seriesFits(fits: Fits, axis: string | undefined): Fits | null {
  if (axis === "y2") return fits.y2 ? { x: fits.x, y: fits.y2 } : null;
  if (axis === "x2") return fits.x2 ? { x: fits.x2, y: fits.y } : null;
  return fits;
}
export interface MorphPoint { index: number; x: number; y: number }
export interface MorphController {
  seek(u: number, raw?: number): void;
  targetRoot?: HTMLElement;
  dispose?(): void;
}
export type SeriesAxes = FluxPlotManifest["axes"][number];

export function axisFit(axis: FluxPlotAxis): Fit {
  const log = axis.scale === "log";
  const f = (v: number) => log ? Math.log(v) : v;
  const anchors = axis.anchors?.length >= 2 ? axis.anchors : [{ data: axis.domain[0], svg: 0 }, { data: axis.domain[1], svg: 1 }];
  const a = anchors[0], b = anchors[anchors.length - 1];
  const m = (b.svg - a.svg) / (f(b.data) - f(a.data) || 1);
  return { m, c: a.svg - m * f(a.data), log };
}
export function projectWith(fit: Fit, value: number): number {
  if (fit.linear !== undefined) return fit.linear * value + (fit.logarithmic ? fit.logarithmic * Math.log(value) : 0) + fit.c;
  return fit.m * (fit.log ? Math.log(value) : value) + fit.c;
}
export function dataOfPixel(fit: Fit, px: number): number {
  if (fit.linear === undefined) return fit.log ? Math.exp((px - fit.c) / fit.m) : (px - fit.c) / fit.m;
  if (!fit.logarithmic) return (px - fit.c) / fit.linear;
  if (!fit.linear) return Math.exp((px - fit.c) / fit.logarithmic);
  // Blends of same-direction axes stay monotone. Bisect in log space so both
  // microscopic and very large data ranges retain a well-conditioned inverse.
  let lo = -709, hi = 709;
  const increasing = fit.linear > 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if ((projectWith(fit, Math.exp(mid)) < px) === increasing) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}
/** Optional output storage lets the bound frame writer reuse its fits. */
export function blendFit(a: Fit, b: Fit, t: number, out: Fit = { m: 0, c: 0, log: false }): Fit {
  out.m = lerp(a.m, b.m, t); out.c = lerp(a.c, b.c, t); out.log = t < .5 ? a.log : b.log;
  if (a.log === b.log && a.linear === undefined && b.linear === undefined) {
    out.linear = undefined; out.logarithmic = undefined;
  } else {
    out.linear = lerp(a.linear ?? (a.log ? 0 : a.m), b.linear ?? (b.log ? 0 : b.m), t);
    out.logarithmic = lerp(a.logarithmic ?? (a.log ? a.m : 0), b.logarithmic ?? (b.log ? b.m : 0), t);
  }
  return out;
}
export const lerpData = (a: number, b: number, t: number, log: boolean): number =>
  log ? Math.exp(lerp(Math.log(a), Math.log(b), t)) : lerp(a, b, t);

/** Marker subsampling never removes vertices from a line; nulls retain gaps. */
export function seriesVertices(s: FluxPlotSeries): MorphPoint[] {
  if (!s.svg?.line) return s.points ?? [];
  const xs = s.data?.x, ys = s.data?.y;
  if (!xs || !ys) return s.points ?? [];
  const out: MorphPoint[] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i], y = ys[i];
    if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) out.push({ index: i, x, y });
  }
  return out;
}
export function seriesAxes(manifest: FluxPlotManifest, series: FluxPlotSeries): SeriesAxes | undefined {
  if (!Array.isArray(manifest.axes)) return undefined;
  if (series.panelId) return manifest.axes.find((a) => a.panelId === series.panelId);
  return manifest.axes.length === 1 ? manifest.axes[0] : undefined;
}
export function usableAxis(axis: FluxPlotAxis): boolean {
  if (!axis || axis.supported === false || !["linear", "log"].includes(axis.scale)) return false;
  if (!Array.isArray(axis.anchors) || axis.anchors.length < 2 || !Array.isArray(axis.domain) || axis.domain.length !== 2 || !axis.domain.every(Number.isFinite) || axis.domain[0] === axis.domain[1]) return false;
  if (!axis.anchors.every((p) => p && Number.isFinite(p.data) && Number.isFinite(p.svg))) return false;
  const a = axis.anchors[0], b = axis.anchors[axis.anchors.length - 1];
  return a.data !== b.data && a.svg !== b.svg && (axis.scale !== "log" || axis.domain.every(v => v > 0) && axis.anchors.every(p => p.data > 0));
}
export function viewFits(manifest: FluxPlotManifest, view?: PlotView, panelId?: string): Fits | null {
  const axes = seriesAxes(manifest, { panelId } as FluxPlotSeries);
  if (!axes || axes.projection && axes.projection !== "rectilinear") return null;
  const fit = (key: PlotAxisKey): Fit | null => {
    const axis = (axes as unknown as Record<string, FluxPlotAxis | undefined>)[key], patch = view?.[key];
    if (!axis || !usableAxis(axis)) return null;
    if (!patch?.domain && !patch?.scale) return axisFit(axis);
    const domain = patch.domain ?? axis.domain;
    const changed = { ...axis, domain, scale: patch.scale ?? axis.scale,
      anchors: [{ data: domain[0], svg: axis.anchors[0].svg },
        { data: domain[1], svg: axis.anchors[axis.anchors.length - 1].svg }] };
    return usableAxis(changed) ? axisFit(changed) : null;
  };
  const x = fit("x"), y = fit("y");
  if (!x || !y) return null;
  const out: Fits = { x, y };
  // a twin's value axis (ax.twinx / twiny, a secondary axis): its own fit, viewable on its own
  for (const key of ["y2", "x2"] as const) {
    if (!(axes as unknown as Record<string, unknown>)[key]) continue;
    const f = fit(key);
    if (f) out[key] = f;
    else if (view?.[key]) return null; // a view was asked of an unusable twin axis
  }
  return out;
}

export function seriesTweenable(a: FluxPlotSeries, b: FluxPlotSeries | null | undefined, axA: SeriesAxes | undefined, axB: SeriesAxes | undefined): boolean {
  if (!b || a.id !== b.id || a.panelId !== b.panelId || !axA || !axB) return false;
  if ([a, b].some(s => s.capabilities?.dataMorph === false || s.rasterized || s.roles?.some(r => !["line", "point"].includes(r)))) return false;
  if ([axA, axB].some(ax => ax.projection && ax.projection !== "rectilinear" || !usableAxis(ax.x) || !usableAxis(ax.y))) return false;
  if (axA.x.scale !== axB.x.scale || axA.y.scale !== axB.y.scale || Boolean(a.svg?.line) !== Boolean(b.svg?.line)) return false;
  const av = seriesVertices(a), bv = seriesVertices(b);
  if (!av.length || !bv.length) return false;
  const indices = new Set(bv.map(p => p.index));
  if (indices.size !== bv.length || new Set(av.map(p => p.index)).size !== av.length || !av.some(p => indices.has(p.index))) return false;
  return [[av, axA], [bv, axB]].every(([vs, axes]) => (vs as MorphPoint[]).every(p => {
    const ax = axes as SeriesAxes;
    return Number.isFinite(p.x) && Number.isFinite(p.y) && (ax.x.scale !== "log" || p.x > 0) && (ax.y.scale !== "log" || p.y > 0);
  }));
}
/** Shared eligibility rule for the compiler, authoring UI and CLI. */
export function hasTweenableSeries(a?: FluxPlotManifest, b?: FluxPlotManifest): boolean {
  // Custom/legacy manifests may carry no series (the retired morphCompatible said false).
  if (!Array.isArray(a?.series) || !Array.isArray(b?.series)) return false;
  return a.series.some(s => {
    const other = b.series.find(v => v.id === s.id);
    return seriesTweenable(s, other, seriesAxes(a, s), other ? seriesAxes(b, other) : undefined);
  });
}

/** Prepared once; sampleSeries writes into reusable storage on the frame path. */
export function pairVertices(a: FluxPlotSeries, b: FluxPlotSeries | null): { a: MorphPoint; b: MorphPoint }[] {
  const bv = new Map((b ? seriesVertices(b) : []).map(p => [p.index, p]));
  const av = new Map(seriesVertices(a).map(p => [p.index, p]));
  return [...new Set([...av.keys(), ...bv.keys()])].sort((a, b) => a - b).map(index => {
    const from = av.get(index), to = bv.get(index);
    return { a: from ?? to!, b: to ?? from! };
  });
}
export function sampleSeries(pairs: ReturnType<typeof pairVertices>, from: Fits, to: Fits, t: number, out: MorphPoint[], fits: Fits): void {
  blendFit(from.x, to.x, t, fits.x); blendFit(from.y, to.y, t, fits.y);
  for (let i = 0; i < pairs.length; i++) {
    const { a, b } = pairs[i];
    out[i].x = projectWith(fits.x, lerpData(a.x, b.x, t, from.x.log && to.x.log));
    out[i].y = projectWith(fits.y, lerpData(a.y, b.y, t, from.y.log && to.y.log));
  }
}
export function projectSeries(a: FluxPlotSeries, b: FluxPlotSeries | null, from: Fits, to: Fits, t: number): MorphPoint[] {
  const pairs = pairVertices(a, b), out = pairs.map(p => ({ ...p.a }));
  sampleSeries(pairs, from, to, t, out, { x: { ...from.x }, y: { ...from.y } });
  return out;
}

/** Recover a guide's anchor after its own/ancestor SVG attribute transforms.
 * This is deliberately attribute-only: it also runs in linkedom. */
function guidePixel(node: Element, root: Element, axis: PlotAxisKey): number | null {
  const drawable = ["path", "text", "line", "use"].includes(node.tagName.toLowerCase()) ? node : node.querySelector("path,text,line,use");
  if (!drawable) return null;
  const nums = (s: string) => (s.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const tag = drawable.tagName.toLowerCase();
  const pt = tag === "path" ? nums(drawable.getAttribute("d") ?? "").slice(0, 2) :
    [parseFloat(drawable.getAttribute(tag === "line" ? "x1" : "x") ?? "0"), parseFloat(drawable.getAttribute(tag === "line" ? "y1" : "y") ?? "0")];
  if (pt.length !== 2) return null;
  // Node-local → root user space through the shared SVG affine reader.
  const { x, y } = applyToPoint({ x: pt[0], y: pt[1] }, transformToAncestor(drawable, root));
  return Number.isFinite(axis === "x" ? x : y) ? (axis === "x" ? x : y) : null;
}
export function guideAxes(manifest: FluxPlotManifest, leaf: string): SeriesAxes | undefined {
  if (manifest.axes?.length === 1) return manifest.axes[0];
  return manifest.axes?.find(ax => ax.panelId && leaf.startsWith(`${ax.panelId}.axis.`));
}
export function guideData(manifest: FluxPlotManifest, root: Element, elId = ""): Map<string, { axis: PlotAxisKey; value: number }> {
  const out = new Map<string, { axis: PlotAxisKey; value: number }>();
  const prefix = elId ? partDomId(elId, "") : "";
  for (const node of Array.from(root.querySelectorAll("[id]"))) {
    const id = node.getAttribute("id") ?? "";
    if (!id.startsWith(prefix)) continue;
    const leaf = id.slice(prefix.length), match = /(?:^|\.)axis\.(x|y|x2|y2)\.(?:tick|gridline|ticklabel|tick-label)\.\d+$/.exec(leaf);
    if (!match) continue;
    const axis = match[1] as PlotAxisKey, axes = guideAxes(manifest, leaf);
    const record = axes ? (axes as unknown as Record<string, FluxPlotAxis | undefined>)[axis] : undefined;
    if (!record || !usableAxis(record)) continue;
    const px = guidePixel(node, root, axis.startsWith("x") ? "x" : "y");
    if (px !== null) out.set(leaf, { axis, value: dataOfPixel(axisFit(record), px) });
  }
  return out;
}

/** Roles whose members are polygons a view can re-project vertex by vertex (F4). */
const FILLED_ROLES = new Set(["bar", "area", "box", "violin", "whisker", "cap", "median", "mean", "flier", "segment", "errorbar",
  "x-heatmap", "x-hexbin", "x-contourf", "x-contour", "x-hex", "cell", "contour-level"]);
/** The leaf ids of a series' filled marks (bars, cells, hexagons, bands, box parts …) that a view
 *  re-projects — the SVG decides whether each really is a polygon. Lines and points are the
 *  vertex machinery's; images have no vertices. */
export function filledLeaves(s: FluxPlotSeries): string[] {
  if (s.rasterized || s.kind === "image") return [];
  const out = new Set<string>(), groups = new Set<string>();
  for (const c of s.components ?? []) {
    if (c.role === "point" || c.role === "line") continue;
    if (c.members?.length && (FILLED_ROLES.has(c.role) || FILLED_ROLES.has(c.memberRole ?? ""))) { groups.add(c.svgId); for (const m of c.members) out.add(m); }
    else if (FILLED_ROLES.has(c.role)) out.add(c.svgId);
  }
  for (const [role, v] of Object.entries(s.svg ?? {})) {
    if (role === "line" || role === "points") continue;
    if (Array.isArray(v)) { if (FILLED_ROLES.has(role.replace(/s$/, "")) || FILLED_ROLES.has(role)) for (const id of v) out.add(id); }
    else if (typeof v === "string" && FILLED_ROLES.has(role)) out.add(v);
  }
  for (const g of groups) out.delete(g); // a layer whose members are listed is not a leaf itself
  return [...out];
}

/** Refuse invalid log projections per series, never emit NaN SVG geometry. */
export function plotViewIssues(manifest: FluxPlotManifest | undefined, view: PlotView | undefined): string[] {
  if (!manifest || !view) return [];
  if (!manifest.axes?.length || !manifest.series?.length) return ["This plot has no axes/series to view."];
  const issues: string[] = [];
  for (const axes of manifest.axes) if (!viewFits(manifest, view, axes.panelId)) issues.push("Plot view has unusable axes or an invalid domain (log domains must be positive).");
  let unchanged = false;
  for (const s of manifest.series) {
    const vertices = seriesVertices(s), panelFits = viewFits(manifest, view, s.panelId);
    if (!vertices.length || s.capabilities?.dataMorph === false || s.rasterized || s.roles?.some(r => !["line", "point"].includes(r))) {
      // filled marks re-project vertex by vertex (F4); only images and rasters stay put
      if (s.rasterized || !filledLeaves(s).length && !vertices.length) unchanged = true;
      if (s.rasterized || !vertices.length) continue;
    }
    const fits = panelFits ? seriesFits(panelFits, (s as { axis?: string }).axis) : null;
    if (panelFits && !fits) issues.push(`Series ‹${s.id}› reads a twin axis (${(s as { axis?: string }).axis}) this plot cannot project; it stays put.`);
    if (fits && vertices.some(p => fits.x.log && p.x <= 0 || fits.y.log && p.y <= 0)) issues.push(`Series ‹${s.id}› has non-positive data; its log view is not applied.`);
  }
  if (unchanged) issues.push("View applies to lines, points, bars, cells, hexagons and guides of this plot; images and rasterized layers remain unchanged.");
  return issues;
}
