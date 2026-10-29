// The one attribute writer for static plot views and animated data/view changes.
// All identities, fits and guide values bind once; frames reuse numeric buffers.
import type { PlotView, PlotAxisKey } from "../types";
import type { FluxPlotManifest, FluxPlotSeries, FluxPlotAxis } from "./types";
import { partDomId, applyTickGroupOverrides, restorePlotClip } from "./parse";
import { axisFit, blendFit, guideAxes, guideData, guidePixel, matchTickSets, pairVertices, projectWith, sampleSeries, seriesFits, dataOfPixel, filledLeaves, viewProjectsVertices, retickable, tickFlightLaw, capturedAxis, type TickSpec,
  seriesAxes, seriesVertices, seriesTweenable, viewFits, lerpData, lerpPixel, type Fit, type Fits, type MorphPoint } from "./project";
import { transformToAncestor } from "./svgMatrix";
import { ticksFor, scalarLabels, formatTick } from "./ticks";
import { effectiveScale, parseColormap, slotFor, normalize, INDEX_KINDS, rgbHex, shortFloat } from "./colorscale";
import { colormapLut } from "../color/colormapLuts";
import { ticksAt } from "./relayout/ticking";
import {writeMathLabel} from "./relayout/mathLabel";
import type { ColorScaleView } from "../types";

interface Field { value: string | null; written: boolean }
interface Pristine {
  attrs: Map<string, Field>;
  styles: Map<string, Field>;
  active: boolean;
  hadStyle: boolean;
}
const pristine = new WeakMap<Element, Pristine>();
function recFor(node: Element): Pristine {
  let rec = pristine.get(node);
  if (!rec) { rec = { attrs: new Map(), styles: new Map(), active: false, hadStyle: false }; pristine.set(node, rec); }
  return rec;
}
function reserve(node: Element, attrs: string[], styles: string[]): void {
  const rec = recFor(node);
  for (const name of attrs) if (!rec.attrs.has(name)) rec.attrs.set(name, { value: null, written: false });
  for (const name of styles) if (!rec.styles.has(name)) rec.styles.set(name, { value: null, written: false });
}
function record(node: Element): Pristine {
  const rec = recFor(node);
  if (!rec.active) { rec.active = true; rec.hadStyle = node.hasAttribute("style"); }
  return rec;
}
function attr(node: Element, name: string, value: string | null): void {
  const rec = record(node);
  let field = rec.attrs.get(name);
  if (!field) { field = { value: null, written: false }; rec.attrs.set(name, field); }
  if (!field.written) { field.value = node.getAttribute(name); field.written = true; }
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}
function style(node: Element, name: string, value: string): void {
  if (name === "opacity" || name === "translate") restorePlotClip(node);
  const rec = record(node), st = (node as SVGElement).style;
  let field = rec.styles.get(name);
  if (!field) { field = { value: null, written: false }; rec.styles.set(name, field); }
  if (!field.written) { field.value = st.getPropertyValue(name) ?? ""; field.written = true; }
  if (value) st.setProperty(name, value); else st.removeProperty(name);
}
function restore(node: Element): void {
  const rec = pristine.get(node);
  if (!rec?.active) return;
  for (const [name, field] of rec.attrs) if (field.written) {
    if (field.value === null) node.removeAttribute(name); else node.setAttribute(name, field.value);
    field.written = false;
  }
  const st = (node as SVGElement).style;
  for (const [name, field] of rec.styles) if (field.written) {
    if (field.value) st.setProperty(name, field.value); else st.removeProperty(name);
    field.written = false;
  }
  if (!rec.hadStyle && !node.getAttribute("style")) node.removeAttribute("style");
  rec.active = false;
}
const roots = new WeakMap<Element, Set<Element>>();
/** Ticks, labels and gridlines this module cloned for a re-ticked axis (F4), per root. */
const retickClones = new WeakMap<Element, Element[]>();
function dropRetick(root: Element): void {
  const clones = retickClones.get(root);
  if (clones) { for (const c of clones) c.parentNode?.removeChild(c); retickClones.delete(root); }
}
/** Restore only the fields projection wrote. Compensation must be restored first. */
export function restoreProjection(root: Element): void {
  dropRetick(root);
  const nodes = roots.get(root);
  if (nodes) for (const node of nodes) restore(node);
}
export function writeSeriesLine(path: Element, vertices: readonly MorphPoint[]): void {
  let d = "", previous = -2;
  for (const p of vertices) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { previous = -2; continue; }
    d += `${d ? " " : ""}${p.index === previous + 1 ? "L" : "M"}${p.x.toFixed(6)} ${p.y.toFixed(6)}`;
    previous = p.index;
  }
  attr(path, "d", d);
}
function writeSeriesRuns(path: Element, runs: MorphPoint[][]): void {
  let d = "";
  for (const run of runs) for (let i = 0; i < run.length; i++) {
    const p = run[i];
    d += `${d ? " " : ""}${i ? "L" : "M"}${p.x.toFixed(6)} ${p.y.toFixed(6)}`;
  }
  attr(path, "d", d);
}
export function writeMarker(node: Element, x: number, y: number, ox: number, oy: number): void {
  if (node.tagName.toLowerCase() === "circle") {
    attr(node, "cx", x.toFixed(2)); attr(node, "cy", y.toFixed(2));
  } else style(node, "translate", `${(x - ox).toFixed(2)}px ${(y - oy).toFixed(2)}px`);
}
export function writeGuide(node: Element, delta: { dx?: number; dy?: number }, edgeFade: number): void {
  const original = node.getAttribute("transform");
  attr(node, "transform", `translate(${(delta.dx ?? 0).toFixed(6)} ${(delta.dy ?? 0).toFixed(6)})${original ? ` ${original}` : ""}`);
  const opacity = (node as SVGElement).style.getPropertyValue("opacity") || node.getAttribute("opacity");
  style(node, "opacity", String((opacity === null || opacity === "" ? 1 : Number(opacity)) * edgeFade));
}

export interface PlotViewOptions {
  t?: number;
  from?: Fits;
  to?: Fits;
  series?: (a: FluxPlotSeries) => FluxPlotSeries | null;
  /** Panel ownership and pristine guide anchors for an asset transition. */
  toManifest?: FluxPlotManifest;
  rawFromManifest?:FluxPlotManifest;
  rawToManifest?:FluxPlotManifest;
  fromView?: PlotView;
  sourceRoot?: Element;
  targetRoot?: Element;
  /** The static binding writes the original A→B marker/guide geometry first. */
  geometryInterpolated?: boolean;
  /** Raw (un-eased) progress; defaults to `t`. */
  raw?: number;
  /** The content becomes another asset. At rest the frame IS an endpoint's own
   *  render (raw ≤ 0 with no start view, raw ≥ 1 with no end view), so its
   *  guides keep their own opacity: no edge fade. */
  assetChange?: boolean;
  /** This frame's live colour-scale views, so a value morph (F7) paints a tweened value the
   *  way the colour-scale writer would. */
  colorScale?: Record<string, ColorScaleView>;
  /** T8: hand the axis ticks off in flight (pooled clones ride the blended fit; see buildFlight). Set by the slide
   *  transform host only; a bare `{t}` call keeps the generated ticks moving and fading. */
  tickHandoff?: boolean;
}
interface Panel {
  from: Fits; to: Fits; rawA: Fits; rawB: Fits;
  fits: Fits;
  xRange: [number, number]; yRange: [number, number];
  xEndRange: [number, number]; yEndRange: [number, number];
  /** Pixel ranges per axis key (the twins' too), start and end. */
  ranges: Partial<Record<PlotAxisKey, [number, number]>>;
  endRanges: Partial<Record<PlotAxisKey, [number, number]>>;
}
interface SeriesBinding {
  panel: Panel;
  /** The fits this series projects through: the panel's, or the twin's for `series.axis`
   *  (live views onto the panel's Fit objects, so a blended panel fit is seen here too). */
  from: Fits; to: Fits; fits: Fits;
  pairs: ReturnType<typeof pairVertices>;
  vertices: MorphPoint[];
  line: Element | null;
  topology?: { a: MorphPoint[]; b: MorphPoint[]; common: MorphPoint[][];
    outgoing: Element; incoming: Element; paint: string[]; aRuns: MorphPoint[][]; bRuns: MorphPoint[][] };
  markers: { node: Element; vertex: number; ox: number; oy: number; ex: number; ey: number }[];
}
interface GuideBinding {
  node: Element; panel: Panel; axis: PlotAxisKey; value: number; endValue: number;
  origin: number; end: number; delta: { dx?: number; dy?: number };
  /** Where the TICK this guide belongs to rests (`origin` of the tick mark with the same leaf index; its own `origin` when it
   *  has none). A re-ticked clone of this guide is placed at `pixel - anchor` from it, which keeps the guide's resting offset
   *  from its tick: a y label sits its baseline offset (~0.36 em) below the tick, and a clone must too. */
  anchor: number;
  /** The same anchor in the END version's geometry (an asset Change moves a guide's natural place from `origin` to `end`). Equal to
   *  `anchor` when the Change keeps the asset. Read by the elastic re-tick at an end (retick, atEnd); the hand-off pool places each clone
   *  from its own bytes instead (cloneHome / FlightAxis.home). */
  anchorEnd: number;
  /** Which plot version carries this guide: the start's, the end's (both for a Change that keeps the asset). */
  inA: boolean; inB: boolean;
  /** The leaf id (unprefixed) and its guide kind, for re-ticking (F4). A reference line is never re-ticked or handed off. */
  leaf: string; kind: "tick" | "tick-label" | "gridline" | "reference";
}
/** A filled mark (a bar, a heatmap cell, a hexagon, a contour band, a box or violin body)
 *  re-projected vertex by vertex: its path's vertices in DATA units, read once through the
 *  generated fits, written each frame through the view's (F4). Polygons only (M / L / Z). */
interface ShapeBinding {
  node: Element; panel: Panel; from: Fits; to: Fits; fits: Fits;
  subpaths: { x: Float64Array; y: Float64Array; closed: boolean; ops: string }[];
  /** A MARKER-LIKE mark (a mean dot, a flier: role mean / flier, not a mean LINE) keeps its drawn size and is moved whole, like a
   *  scatter marker: its anchor (the centre of its drawing: anchorOf) in
   *  data units at each end, and the anchor's pixel at each end as drawn. Re-projected vertex by vertex, a circle became an oval on
   *  any axis that re-scaled. */
  glyph?: { a: { x: number; y: number }; b: { x: number; y: number }; pa: { x: number; y: number }; pb: { x: number; y: number } };
  /** A value morph (F7): the same member in the other plot version, matched by data-key (or id):
   *  its polygon in data units (vertex counts equal), and the two data values a colour scale
   *  paints, so height and colour tween member by member. */
  target?: { subpaths: ShapeBinding["subpaths"] };
  value?: { a: number; b: number; scale: FluxPlotManifest["colorScales"] extends (infer T)[] | undefined ? T : never; paint: "fill" | "stroke" | "both" };
}
/** T8 tick hand-off: one pooled tick of a re-ticked axis during a view Change. `va`/`vb` are its data value in the
 *  start / end set (equal-ish for a matched tick); a matched tick walks from `va` to `vb` so the generated end
 *  and the nice end are both hit exactly. */
interface FlightTick {
  va: number; vb: number; a: boolean; b: boolean; log: boolean; sameText: boolean;
  /** how far each side's label rests from its tick (generated ticks only; undefined = the template's offset) */
  oa?: number; ob?: number;
  tick?: Element; grid?: Element; labelA?: Element; labelB?: Element;
}
interface FlightAxis {
  panel: Panel; axis: PlotAxisKey; guides: GuideBinding[]; ticks: FlightTick[];
  aRet: boolean; bRet: boolean;
  origin: { tick?: GuideBinding; "tick-label"?: GuideBinding; gridline?: GuideBinding };
  /** Where each template's CLONES are drawn before a frame moves them: the template's pristine pixel and its own tick's, read off the
   *  live nodes when the pool was cloned (the asset the slide mounted, which an asset Change's start or end need not be). */
  home: Partial<Record<"tick" | "tick-label" | "gridline", { pixel: number; anchor: number }>>;
  /** last template inline style copied onto the pool, per kind (a per-leaf override reaches the clones) */
  css: Partial<Record<"tick" | "tick-label" | "gridline", string>>;
}
interface Projection {
  series: SeriesBinding[]; guides: GuideBinding[]; panels: Panel[]; shapes: ShapeBinding[];
  /** Reference lines spanning the axes along one axis (axhline / axvline), moved on the other like a gridline. */
  references: GuideBinding[];
  interpolated: boolean;
  /** Pooled hand-off ticks per re-ticked axis (a view Change in flight; see buildFlight). */
  flight: FlightAxis[];
  /** every node buildFlight cloned for this plan (they live in the plot's own SVG and go with it) */
  flightNodes: Element[];
  /** Pristine clones of the guide nodes, bound before overrides (relayout: a re-tick's template never carries a source leaf's nudge). */
  templates: Map<Element, Element>;
  /** Per panel and axis key: the view axis' tick scheme, for re-ticking at rest. */
  axesInfo: Map<string | undefined, Record<string, { locator?: string; formatter?: string; scale: string }>>;
}

/** Parse an absolute M / L / C / Q / Z path into subpaths of coordinate pairs; null when it holds any other command (relative,
 *  H / V, arcs). `ops` holds one letter per pair: the command that pair opens, "." for a pair continuing it. The curves' control
 *  points are pairs like the rest: a linear fit maps a Bezier exactly by mapping its control points. Every letter is tokenised, so an
 *  unknown command refuses the path (the old M / L / Z tokeniser skipped a C and chained a circle's control points into a 25-vertex
 *  polygon, which a re-scaled axis drew as an oval). */
function polygonSubpaths(d: string | null): { x: number[]; y: number[]; closed: boolean; ops: string }[] | null {
  if (!d) return null;
  const tokens = d.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?|[A-Za-z]/gi);
  if (!tokens) return null;
  const out: { x: number[]; y: number[]; closed: boolean; ops: string }[] = [];
  const size: Record<string, number> = { M: 1, L: 1, C: 3, Q: 2 };
  let cur: { x: number[]; y: number[]; closed: boolean; ops: string } | null = null, i = 0;
  const isNum = (k: number) => /^[-+.\d]/.test(tokens[k] ?? "");
  while (i < tokens.length) {
    const t = tokens[i++];
    if (t in size) {
      if (t === "M") { cur = { x: [], y: [], closed: false, ops: "" }; out.push(cur); }
      if (!cur) return null;
      let first = true;
      while (isNum(i)) {
        for (let k = 0; k < size[t]; k++) {
          if (!isNum(i) || !isNum(i + 1)) return null;
          cur.x.push(Number(tokens[i])); cur.y.push(Number(tokens[i + 1])); i += 2;
          // a repeated group restates its command; an M's extra pairs are implicit L's
          cur.ops += k > 0 ? "." : !first && t === "M" ? "L" : t;
        }
        first = false;
      }
    } else if (t === "Z" || t === "z") { if (cur) cur.closed = true; }
    else return null; // relative, H / V, S / T, arcs: not a path we rewrite
  }
  return out.length && out.every((sp) => sp.x.length >= 2) ? out : null;
}

/** One frame of a filled mark. A value morph walks each vertex between its two rest pixels (lerpPixel, the pixel law); a mark with
 *  no counterpart rides this frame's fit. A marker-like mark keeps its drawn bytes and is moved whole (`glyph`). */
function writePolygons(sh: ShapeBinding, t: number): void {
  const { node, subpaths } = sh, target = sh.target?.subpaths;
  if (sh.glyph) {
    const g = sh.glyph;
    const x = lerpPixel(sh.from.x, sh.to.x, g.a.x, g.b.x, t), y = lerpPixel(sh.from.y, sh.to.y, g.a.y, g.b.y, t);
    // the drawn anchor: the static binder lerps the bytes from the start's to the end's (the same bytes for a view)
    if (Number.isFinite(x) && Number.isFinite(y)) writeMarker(node, x, y, g.pa.x + (g.pb.x - g.pa.x) * t, g.pa.y + (g.pb.y - g.pa.y) * t);
    return;
  }
  let d = "";
  for (const [k, sp] of subpaths.entries()) {
    const tp = target?.[k];
    for (let i = 0; i < sp.x.length; i++) {
      const px = tp ? lerpPixel(sh.from.x, sh.to.x, sp.x[i], tp.x[i], t) : projectWith(sh.fits.x, sp.x[i]);
      const py = tp ? lerpPixel(sh.from.y, sh.to.y, sp.y[i], tp.y[i], t) : projectWith(sh.fits.y, sp.y[i]);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return; // leave the generated bytes
      const op = sp.ops[i];
      d += `${op === "." ? " " : `${d ? " " : ""}${op} `}${px.toFixed(6)} ${py.toFixed(6)}`;
    }
    if (sp.closed) d += " z";
  }
  attr(node, "d", d + (subpaths.some((sp) => sp.closed) ? " " : ""));
}

/** Parse one polygon element into data units through `fits`; null when it is no plain polygon. */
function polygonInData(path: Element, root: Element, fits: Fits): ShapeBinding["subpaths"] | null {
  if ((path.getAttribute("d") ?? "").length > 200000) return null;
  const m = transformToAncestor(path, root);
  if (Math.abs(m[0] - 1) > 1e-9 || Math.abs(m[3] - 1) > 1e-9 || Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9 || Math.abs(m[4]) > 1e-9 || Math.abs(m[5]) > 1e-9) return null;
  const polys = polygonSubpaths(path.getAttribute("d"));
  if (!polys) return null;
  const subpaths = polys.map((sp) => ({ x: Float64Array.from(sp.x, (px) => dataOfPixel(fits.x, px)), y: Float64Array.from(sp.y, (py) => dataOfPixel(fits.y, py)), closed: sp.closed, ops: sp.ops }));
  return subpaths.some((sp) => !Array.from(sp.x).every(Number.isFinite) || !Array.from(sp.y).every(Number.isFinite)) ? null : subpaths;
}

/** A mean dot or a flier is a MARKER (a fixed-size glyph at a data point), not a data extent: one drawn as a single two-point
 *  segment is a mean LINE (boxplot meanline), which spans its box and re-projects like it. */
const MARKER_ROLES = new Set(["mean", "flier"]);
function markerLike(found: Element, subpaths: ShapeBinding["subpaths"]): boolean {
  const role = found.getAttribute("data-role") ?? found.querySelector("[data-role]")?.getAttribute("data-role") ?? "";
  return MARKER_ROLES.has(role) && !(subpaths.length === 1 && subpaths[0].x.length === 2 && !subpaths[0].closed);
}
/** A mark's anchor as drawn through `fit`: the centre of its vertices' pixel box (a marker's data point: a mean dot's centre is its mean),
 *  and that pixel in data units. Without a view the choice cancels (the walk and the content binder's lerp of the two drawings are the same
 *  line); under a view on a log axis only the true centre lands on its value (a vertex mean, biased by the circle path's repeated first
 *  point, put the dot 0.06 px off). */
function anchorOf(subpaths: ShapeBinding["subpaths"], fit: Fits): { data: { x: number; y: number }; px: { x: number; y: number } } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (let i = 0; i < sp.x.length; i++) {
    const x = projectWith(fit.x, sp.x[i]), y = projectWith(fit.y, sp.y[i]);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const px = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  return { px, data: { x: dataOfPixel(fit.x, px.x), y: dataOfPixel(fit.y, px.y) } };
}

const pathOf = (found: Element | null): Element | null => (found?.tagName.toLowerCase() === "path" ? found : found?.querySelector("path") ?? null);
const paintOfGroup = (node: Element): "fill" | "stroke" | "both" => {
  for (let el: Element | null = node; el; el = el.parentElement) {
    const p = el.getAttribute("data-paint");
    if (p) return p.includes("fill") && p.includes("stroke") ? "both" : p.includes("stroke") ? "stroke" : "fill";
    if (el.hasAttribute("data-color-scale")) break;
  }
  return "fill";
};
interface CachedProjection { manifest: FluxPlotManifest; view: PlotView | undefined; opts: PlotViewOptions | undefined; plan: Projection }
const plans = new WeakMap<Element, CachedProjection[]>();
/** A changed figsize supplies new pristine geometry on this same clone. */
export function resetProjectionBindings(root:Element):void {
  restoreProjection(root);
  for(const el of roots.get(root)??[])pristine.delete(el);
  roots.delete(root);plans.delete(root);
}

/** `axis.x.tick.3` / `axis.x.ticklabel.3` / `axis.x.gridline.3` -> `axis.x.#3`: the three guides of one tick share it. */
const guideIndexKey = (leaf: string) => leaf.replace(/\.(?:ticklabel|tick-label|tick|gridline)\.(\d+)$/, ".#$1");

function bind(root: Element, manifest: FluxPlotManifest, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): Projection {
  if (!manifest.axes?.length || !manifest.series?.length || opts?.toManifest && (!opts.toManifest.axes?.length || !opts.toManifest.series?.length)) return { series: [], guides: [], panels: [], shapes: [], references: [], interpolated: false, axesInfo: new Map(), flight: [], flightNodes: [], templates: new Map() };
  const nodes = roots.get(root) ?? new Set<Element>(); roots.set(root, nodes);
  // One id index per bind (first element in document order wins, exactly what
  // root.querySelector('[id="…"]') returned): a per-leaf querySelector scanned
  // the whole subtree per leaf — ~35 ms for a 3k-leaf hexmatrix mount (perf 2026-09-30).
  // bind only inserts id-less residue nodes, so the index cannot go stale.
  let index: Map<string, Element> | null = null;
  const q = (leaf: string): Element | null => {
    const id = elId ? partDomId(elId, leaf) : leaf;
    if (!index) {
      index = new Map();
      for (const el of Array.from(root.querySelectorAll("[id]"))) { const v = el.getAttribute("id"); if (v !== null && !index.has(v)) index.set(v, el); }
    }
    const node = index.get(id) ?? null;
    if (node) nodes.add(node);
    return node;
  };
  const panels = new Map<string | undefined, Panel>();
  const axesInfo: Projection["axesInfo"] = new Map();
  for (const ax of manifest.axes ?? []) {
    const info: Record<string, { locator?: string; formatter?: string; scale: string }> = {};
    for (const key of ["x", "y", "y2", "x2"] as const) {
      const rec = (ax as unknown as Record<string, FluxPlotAxis & { tickLocator?: string; tickFormatter?: string } | undefined>)[key];
      if (rec) info[key] = { locator: rec.tickLocator, formatter: rec.tickFormatter, scale: rec.scale };
    }
    axesInfo.set(ax.panelId, info);
    const rawA = viewFits(opts?.rawFromManifest??manifest, undefined, ax.panelId);
    const rawB = viewFits(opts?.rawToManifest??opts?.toManifest ?? manifest, undefined, ax.panelId);
    const from = (manifest.axes.length === 1 ? opts?.from : undefined) ?? viewFits(manifest, opts?.fromView, ax.panelId);
    const to = (manifest.axes.length === 1 ? opts?.to : undefined) ?? viewFits(opts?.toManifest ?? manifest, view, ax.panelId);
    const endAxes = (opts?.toManifest ?? manifest).axes.find(a => a.panelId === ax.panelId);
    if (!rawA || !rawB || !from || !to || !endAxes) continue;
    const range = (key: PlotAxisKey, axes = ax): [number, number] | undefined => {
      const record = (axes as unknown as Record<string, FluxPlotAxis | undefined>)[key];
      if (!record) return undefined;
      const fit = axisFit(record);
      return [projectWith(fit, record.domain[0]), projectWith(fit, record.domain[1])];
    };
    const fits: Fits = { x: { ...from.x }, y: { ...from.y } };
    if (from.y2 && to.y2) fits.y2 = { ...from.y2 };
    if (from.x2 && to.x2) fits.x2 = { ...from.x2 };
    const ranges: Panel["ranges"] = {}, endRanges: Panel["ranges"] = {};
    for (const key of ["x", "y", "y2", "x2"] as const) { const r = range(key), e = range(key, endAxes); if (r) ranges[key] = r; if (e) endRanges[key] = e; }
    panels.set(ax.panelId, { from, to, rawA, rawB, fits,
      xRange: ranges.x!, yRange: ranges.y!, xEndRange: endRanges.x!, yEndRange: endRanges.y!, ranges, endRanges });
  }
  const series: SeriesBinding[] = [];
  for (const a of manifest.series ?? []) {
    const panel = panels.get(a.panelId), b = opts?.series?.(a) ?? null;
    // a view moves the line and points of every series that has them (a band series carries its own); a DATA morph between two
    // versions additionally needs both to be morphable, which seriesTweenable checks below
    if (!panel || !viewProjectsVertices(a)) continue;
    if (opts?.series && (!b || !seriesTweenable(a, b, seriesAxes(manifest, a), seriesAxes(opts.toManifest ?? manifest, b)))) continue;
    // a series on a twin's value axis projects through that axis' fit (C4)
    const axisKey = (a as { axis?: string }).axis;
    const sFrom = seriesFits(panel.from, axisKey), sTo = seriesFits(panel.to, axisKey), sFits = seriesFits(panel.fits, axisKey);
    if (!sFrom || !sTo || !sFits) continue;
    const pairs = pairVertices(a, b);
    if (!pairs.length || pairs.some(p =>
      (sFrom.x.log || sTo.x.log) && (p.a.x <= 0 || p.b.x <= 0) ||
      (sFrom.y.log || sTo.y.log) && (p.a.y <= 0 || p.b.y <= 0))) continue;
    const found = a.svg?.line ? q(a.svg.line) : null;
    const line = found?.tagName.toLowerCase() === "path" ? found : found?.querySelector("path") ?? null;
    if (line) { nodes.add(line); reserve(line, ["d"], []); }
    const byIndex = new Map(pairs.map((p, i) => [p.a.index, i]));
    const markers: SeriesBinding["markers"] = [];
    const aPoints = new Map((a.points ?? []).map(p => [p.svgId, p]));
    const bPoints = new Map((b?.points ?? []).map(p => [p.svgId, p]));
    for (const p of new Map([...aPoints, ...bPoints]).values()) {
      const node = q(p.svgId), vertex = byIndex.get(p.index);
      if (!node || vertex === undefined) continue;
      reserve(node, node.tagName.toLowerCase() === "circle" ? ["cx", "cy"] : [], node.tagName.toLowerCase() === "circle" ? [] : ["translate"]);
      const start = aPoints.get(p.svgId) ?? p, end = bPoints.get(p.svgId) ?? start;
      const rawStart = seriesFits(aPoints.has(p.svgId) ? panel.rawA : panel.rawB, axisKey) ?? panel.rawA, rawEnd = seriesFits(panel.rawB, axisKey) ?? panel.rawB;
      markers.push({ node, vertex, ox: projectWith(rawStart.x, start.x), oy: projectWith(rawStart.y, start.y),
        ex: projectWith(rawEnd.x, end.x), ey: projectWith(rawEnd.y, end.y) });
    }
    const binding: SeriesBinding = { panel, from: sFrom, to: sTo, fits: sFits, pairs, vertices: pairs.map(p => ({ ...p.a })), line, markers };
    if (line && b) {
      const av = seriesVertices(a), bv = seriesVertices(b);
      if (av.length !== bv.length || av.some((p, i) => p.index !== bv[i]?.index)) {
        const values = new Map(binding.vertices.map(p => [p.index, p]));
        const edges = (vs: MorphPoint[]) => new Set(vs.slice(1).filter((p, i) => p.index === vs[i].index + 1).map(p => p.index));
        const ae = edges(av), be = edges(bv);
        const runs = (ends: number[]) => ends.map(i => [values.get(i - 1)!, values.get(i)!]);
        const target = b.svg?.line && opts?.targetRoot ? Array.from(opts.targetRoot.querySelectorAll("[id]")).find(n => n.getAttribute("id") === b.svg!.line) : null;
        const targetPath = target?.tagName.toLowerCase() === "path" ? target : target?.querySelector("path");
        const paint = [...new Set([...Array.from(line.attributes), ...Array.from(targetPath?.attributes ?? [])].map(a => a.name))].filter(n => !["id", "d"].includes(n));
        const clone = () => {
          const node = line.cloneNode(false) as Element;
          node.removeAttribute("id"); node.setAttribute("data-projection-residue", "");
          line.parentNode!.insertBefore(node, line.nextSibling);
          reserve(node, ["d", ...paint], ["opacity"]); nodes.add(node);
          (node as SVGElement).style.opacity = "0";
          return node;
        };
        binding.topology = { a: av.map(p => values.get(p.index)!), b: bv.map(p => values.get(p.index)!), paint,
          common: runs([...ae].filter(i => be.has(i))), aRuns: runs([...ae].filter(i => !be.has(i))), bRuns: runs([...be].filter(i => !ae.has(i))),
          outgoing: clone(), incoming: clone() };
      }
    }
    series.push(binding);
  }
  // filled marks: bars, cells, hexagons, contour bands, box / violin bodies — polygons whose
  // vertices are read back into data units through the generated fits and re-projected (F4)
  const shapes: ShapeBinding[] = [];
  const targetIndex = opts?.targetRoot ? new Map(Array.from(opts.targetRoot.querySelectorAll("[id]")).map((n) => [n.getAttribute("id") ?? "", n])) : null;
  // The polygon a mark STARTS from is the start asset's own pristine one, never what the live node holds: a transform is compiled while the
  // live content still shows the element's BASE asset, so a Change that follows another asset Change (bars5 -> bars10 -> bars5) would otherwise
  // read the base asset's geometry as if it were its own start (the second step began from the merged wide bars).
  const sourceIndex = opts?.sourceRoot ? new Map(Array.from(opts.sourceRoot.querySelectorAll("[id]")).map((n) => [n.getAttribute("id") ?? "", n])) : null;
  for (const a of manifest.series ?? []) {
    const panel = panels.get(a.panelId);
    if (!panel || a.rasterized) continue;
    const axisKey = (a as { axis?: string }).axis;
    const sFrom = seriesFits(panel.from, axisKey), sTo = seriesFits(panel.to, axisKey), sFits = seriesFits(panel.fits, axisKey), sRaw = seriesFits(panel.rawA, axisKey);
    if (!sFrom || !sTo || !sFits || !sRaw) continue;
    // an asset change: the same series in the other version, its members by data-key (bars by
    // category, cells and hexagons by row.col) else by id — a value morph (F7) when both
    // versions say their members are keyed (capabilities.valueMorph)
    const b = opts?.series ? opts.series(a) : null;
    if (opts?.series && (!b || b.rasterized || !(a.capabilities?.valueMorph || b.capabilities?.valueMorph) || !filledLeaves(b).length)) continue;
    const sRawB = b ? seriesFits(panel.rawB, (b as { axis?: string }).axis) : null;
    const bByKey = new Map<string, Element>(), bById = new Map<string, Element>();
    if (b && targetIndex) for (const leaf of filledLeaves(b)) {
      const el = targetIndex.get(leaf);
      if (!el) continue;
      bById.set(leaf, el);
      const key = el.getAttribute("data-key") ?? pathOf(el)?.getAttribute("data-key");
      if (key) bByKey.set(key, el);
    }
    const scaleId = (a as { color?: { scale?: string } }).color?.scale ?? (a as { field?: { colorScale?: string } }).field?.colorScale;
    const scale = scaleId ? (manifest.colorScales ?? []).find((sc) => sc.id === scaleId) : undefined;
    const paired = new Set<Element>();   // the end version's marks some start mark already stands for
    for (const leaf of filledLeaves(a)) {
      const found = q(leaf);
      const path = pathOf(found);
      if (!path) continue;
      const home = pathOf(sourceIndex?.get(leaf) ?? null);
      const subpaths = home ? polygonInData(home, opts!.sourceRoot!, sRaw) : polygonInData(path, root, sRaw);
      if (!subpaths) continue;
      const binding: ShapeBinding = { node: path, panel, from: sFrom, to: sTo, fits: sFits, subpaths };
      const glyph = markerLike(found!, subpaths);
      if (b && sRawB && opts?.targetRoot) {
        const key = found!.getAttribute("data-key") ?? path.getAttribute("data-key");
        const twin = (key ? bByKey.get(key) : undefined) ?? bById.get(leaf);
        const twinPath = twin ? pathOf(twin) : null;
        if (twin) paired.add(twin);
        const twinPolys = twinPath ? polygonInData(twinPath, opts.targetRoot, sRawB) : null;
        if (twinPolys && twinPolys.length === subpaths.length && twinPolys.every((sp, k) => sp.ops === subpaths[k].ops)) binding.target = { subpaths: twinPolys };
        // A twin of another shape (a cap the start drew in two pieces around its mean dot, one in the end) is the content binder's
        // drawing: it fades the start's copy out and the end's in (render.compilePlotContent), and the live node is the END's copy, which
        // the start's polygon must never be written on (the two-piece cap rode the start's data through the flight and stepped at the
        // landing). Both copies keep their bytes and are moved whole on the part's anchor walk, so they travel with the bar they cap
        // instead of fading in place beside it.
        else if (twin) {
          const twinSub = twinPath ? polygonInData(twinPath, opts.targetRoot, sRawB) : null;
          if (twinSub) {
            const a = anchorOf(subpaths, sRaw), bb = anchorOf(twinSub, sRawB), walk = { a: a.data, b: bb.data };
            reserve(path, [], ["translate"]); nodes.add(path);
            shapes.push({ ...binding, glyph: { ...walk, pa: bb.px, pb: bb.px } });
            const id = found!.getAttribute("id"), out = id ? pathOf(Array.from(root.querySelectorAll("[data-residue-of]")).find((n) => n.getAttribute("data-residue-of") === id) ?? null) : null;
            if (out) { reserve(out, [], ["translate"]); nodes.add(out); shapes.push({ ...binding, node: out, glyph: { ...walk, pa: a.px, pb: a.px } }); }
          }
          continue;
        }
        const va = Number(path.getAttribute("data-value") ?? found!.getAttribute("data-value")), vb = Number(twinPath?.getAttribute("data-value") ?? twin?.getAttribute("data-value"));
        if (scale && scale.recolor === "live" && Number.isFinite(va) && Number.isFinite(vb) && va !== vb) {
          binding.value = { a: va, b: vb, scale, paint: paintOfGroup(path) };
          reserve(path, ["data-value"], ["fill", "stroke", "fill-opacity", "stroke-opacity"]);
        }
      }
      if (glyph) {
        const a = anchorOf(subpaths, sRaw), bb = binding.target && sRawB ? anchorOf(binding.target.subpaths, sRawB) : a;
        binding.glyph = { a: a.data, b: bb.data, pa: a.px, pb: bb.px };
        reserve(path, [], ["translate"]); nodes.add(path);
        shapes.push(binding);
        continue;
      }
      nodes.add(path); reserve(path, ["d"], []);
      shapes.push(binding);
    }
    // A mark only the END version has (a bar a Change grows) stands where it will rest: its own pristine polygon through the END view's fit,
    // never blended with the start's (it grows in place, as it does without a view). Without an end view its own bytes are already the rest.
    if (b && sRawB && opts?.targetRoot && view) for (const leaf of filledLeaves(b)) {
      const home = bById.get(leaf);
      if (!home || paired.has(home)) continue;
      const path = pathOf(q(leaf)), twinPath = pathOf(home), subpaths = path && twinPath ? polygonInData(twinPath, opts.targetRoot, sRawB) : null;
      if (!path || !subpaths) continue;
      nodes.add(path); reserve(path, ["d"], []);
      shapes.push({ node: path, panel, from: sFrom, to: sTo, fits: sTo, subpaths });
    }
  }
  const guides: GuideBinding[] = [];
  const data = guideData(opts?.rawFromManifest??manifest, opts?.sourceRoot ?? root, opts?.sourceRoot ? "" : elId);
  const targetData = opts?.targetRoot ? guideData(opts.rawToManifest??opts.toManifest ?? manifest, opts.targetRoot) : data;
  for (const [leaf, g] of new Map([...targetData, ...data])) {
    const axes = guideAxes(manifest, leaf), panel = panels.get(axes?.panelId), node = q(leaf);
    if (!axes || !panel || !node) continue;
    const rawFitA = (data.has(leaf) ? panel.rawA : panel.rawB)[g.axis], rawFitB = panel.rawB[g.axis];
    if (!rawFitA || !rawFitB || !panel.fits[g.axis]) continue;
    reserve(node, ["transform"], ["opacity", "display"]);
    const kind: GuideBinding["kind"] = /\.gridline\.\d+$/.test(leaf) ? "gridline" : /\.(?:ticklabel|tick-label)\.\d+$/.test(leaf) ? "tick-label" : "tick";
    const origin = projectWith(rawFitA, g.value);
    const end = projectWith(rawFitB, targetData.get(leaf)?.value ?? g.value);
    guides.push({ node, panel, axis: g.axis, value: g.value, endValue: targetData.get(leaf)?.value ?? g.value, origin, anchor: origin, anchorEnd: end,
      end, delta: g.axis.startsWith("x") ? { dx: 0 } : { dy: 0 }, leaf, kind, inA: data.has(leaf), inB: targetData.has(leaf) });
  }
  // a label (or gridline) rests at its tick's pixel plus a constant: anchor every guide to the tick of its own index
  const tickAt = new Map<Panel, Map<string, number>>(), tickEndAt = new Map<Panel, Map<string, number>>();
  for (const g of guides) if (g.kind === "tick") {
    (tickAt.get(g.panel) ?? tickAt.set(g.panel, new Map()).get(g.panel)!).set(`${g.axis}|${guideIndexKey(g.leaf)}`, g.origin);
    (tickEndAt.get(g.panel) ?? tickEndAt.set(g.panel, new Map()).get(g.panel)!).set(`${g.axis}|${guideIndexKey(g.leaf)}`, g.end);
  }
  for (const g of guides) {
    const key = `${g.axis}|${guideIndexKey(g.leaf)}`;
    g.anchor = tickAt.get(g.panel)?.get(key) ?? g.origin;
    g.anchorEnd = tickEndAt.get(g.panel)?.get(key) ?? g.end;
  }
  // Reference lines (role reference-line overlays) stand at data values but are neither series nor axis guides, so a view used to
  // move every mark and tick around them and leave them at their generated pixel. One spanning the axes along one axis (a layout
  // frame blending axes with data; without a frame, a path holding one coordinate constant) walks the other axis' fit like a
  // gridline. One in data on both axes (an identity line) re-projects vertex by vertex like a filled mark.
  const references: GuideBinding[] = [];
  for (const o of manifest.overlays ?? []) {
    if (o.role !== "reference-line") continue;
    const node = q(o.svgId), path = pathOf(node), frame = manifest.layout?.frames[o.svgId];
    const owner = frame?.axes ? manifest.axes.find((a) => (a.svgId ?? a.id) === frame.axes)
      : manifest.axes.length === 1 ? manifest.axes[0] : manifest.axes.find((a) => a.panelId && o.svgId.startsWith(`${a.panelId}.`));
    const panel = owner ? panels.get(owner.panelId) : undefined;
    // read from the start's pristine bytes (a line only the end version draws is the content binder's fade, as for guides)
    const homeRoot = opts?.sourceRoot ?? root, home = sourceIndex ? pathOf(sourceIndex.get(o.svgId) ?? null) : path;
    if (!node || !path || !panel || !home) continue;
    const drawn = polygonSubpaths(home.getAttribute("d"));
    const flat = (k: "x" | "y") => !!drawn && drawn.every((sp) => sp.x.length >= 2 && sp[k].every((v) => Math.abs(v - sp[k][0]) < 1e-6));
    const axis: "x" | "y" | null = frame ? (frame.f === "blend" && frame.y === "data" && frame.x !== "data" ? "y" : frame.f === "blend" && frame.x === "data" && frame.y !== "data" ? "x" : null)
      : flat("y") ? "y" : flat("x") ? "x" : null;
    if (frame?.f === "data") {
      const subpaths = polygonInData(home, homeRoot, panel.rawA);
      if (subpaths) { nodes.add(path); reserve(path, ["d"], []); shapes.push({ node: path, panel, from: panel.from, to: panel.to, fits: panel.fits, subpaths }); }
      continue;
    }
    const pixel = axis ? guidePixel(home, homeRoot, axis) : null;
    if (!axis || pixel === null) continue;
    const value = dataOfPixel(panel.rawA[axis]!, pixel);
    const target = pathOf(targetIndex?.get(o.svgId) ?? null), endPixel = target ? guidePixel(target, opts!.targetRoot!, axis) : null;
    const endValue = endPixel === null ? value : dataOfPixel(panel.rawB[axis]!, endPixel);
    const origin = projectWith(panel.rawA[axis]!, value), end = projectWith(panel.rawB[axis]!, endValue);
    if (!Number.isFinite(value) || !Number.isFinite(endValue)) continue;
    reserve(node, ["transform"], ["opacity", "display"]);
    references.push({ node, panel, axis, value, endValue, origin, end, anchor: origin, anchorEnd: end,
      delta: axis === "x" ? { dx: 0 } : { dy: 0 }, leaf: o.svgId, kind: "reference", inA: true, inB: !targetIndex || !!target });
  }
  const flightNodes: Element[] = [];
  const flight = opts?.tickHandoff && (view || opts.fromView || opts.assetChange) ? buildFlight(root, manifest, view, opts, panels, guides, nodes, flightNodes, targetIndex, sourceIndex) : [];
  return { series, guides, panels: [...panels.values()], shapes, references, interpolated: opts?.geometryInterpolated ?? false, axesInfo, flight, flightNodes,
    // relayout: pristine clones of the guides, bound before overrides (a re-tick template never carries a source leaf's nudge)
    templates: new Map(guides.map(g => [g.node, g.node.cloneNode(true) as Element])) };
}

// ---------------------------------------------------------------------------
// T8 TICK HAND-OFF. During a view Change the axis' ticks are not frozen at the generated
// set (which popped to the nice set at the end): both end sets ride the blended fit.
// A tick whose DATA value is in both sets is one tick (matchTickSets; its label swaps text once at t=.5 if the two
// exact strings differ: "1" -> "1.0"); start-only ticks fade out, end-only ticks fade in (tickFlightLaw). The
// nodes are pooled at bind time (before pt-true compensation binds its node list), so a
// frame only writes transform / opacity / display.
// ---------------------------------------------------------------------------
/** The inline `display` a node has in the plot's own state: what projection recorded before it wrote one, else the live value. */
const ownDisplay = (node: Element): string => {
  const field = pristine.get(node)?.styles.get("display");
  return (field?.written ? field.value : (node as SVGElement).style.getPropertyValue("display")) ?? "";
};
let flightSerial = 0;
/** A pooled clone made from a version's own pristine guide (an asset Change): where its bytes draw it, its tick's place and its own
 *  transform. At its version's end it is placed by the identity on that version's exact bytes, the paint the canonical node has at rest. */
const cloneHome = new WeakMap<Element, { pixel: number; anchor: number; transform: string | null }>();
const labelHtml = (l: { text: string; base?: string; exponent?: string }) =>
  l.exponent !== undefined ? `${l.base}<tspan baseline-shift="super" style="font-size: 70%">${l.exponent}</tspan>` : l.text;
/** A guide's pixel in its pristine state (the transform projection may have written on it put back for the reading). */
function pristinePixel(node: Element, root: Element, axis: PlotAxisKey): number | null {
  const field = pristine.get(node)?.attrs.get("transform"), live = node.getAttribute("transform");
  const put = (v: string | null) => { if (v === null) node.removeAttribute("transform"); else node.setAttribute("transform", v); };
  if (field?.written) put(field.value);
  const px = guidePixel(node, root, axis.startsWith("x") ? "x" : "y");
  if (field?.written) put(live);
  return px;
}
function buildFlight(root: Element, manifest: FluxPlotManifest, view: PlotView | undefined, opts: PlotViewOptions, panels: Map<string | undefined, Panel>,
  guides: GuideBinding[], nodes: Set<Element>, created: Element[], targetIndex: Map<string, Element> | null, sourceIndex: Map<string, Element> | null = null): FlightAxis[] {
  const out: FlightAxis[] = [];
  for (const [panelId, panel] of panels) for (const axis of ["x", "y", "y2", "x2"] as PlotAxisKey[]) {
    // the MAJOR ticks of the axis: a minor tick (relayout reports them as guides of their own, `.minor.` leaves) keeps its generated node and
    // rides the guide pass; it is re-ticked only with relayout ticking (an elastic plot), which keeps main's rest law (transform.ts tickHandoff)
    const mine = guides.filter(g => g.panel === panel && g.axis === axis && !g.leaf.includes(".minor."));
    if (!mine.length) continue;
    // An asset Change has two manifests (and two pixel ranges): each side's set is read from its own version, so a Change that starts from
    // (or lands on) a re-ticked view hands the ticks off exactly as a view Change does, and a side with no view keeps its generated ticks.
    const endManifest = opts.toManifest ?? manifest;
    const aRet = retickable(manifest, opts.fromView, panelId, axis), bRet = retickable(endManifest, view, panelId, axis);
    if (!aRet && !bRet && !opts.assetChange) continue;
    const range = panel.ranges[axis]; if (!range) continue;
    const endRange = panel.endRanges[axis] ?? range;
    // a side's tick set: nice ticks of its domain (what the static retick paints), or the generated ones (their
    // recovered values and exact strings)
    const nice = (sideView: PlotView | undefined, side: "a" | "b"): { set: TickSpec[]; log: boolean } | null => {
      const fit = viewFits(side === "a" ? manifest : endManifest, sideView, panelId)?.[axis], r = side === "a" ? range : endRange; if (!fit) return null;
      const d = [dataOfPixel(fit, r[0]), dataOfPixel(fit, r[1])], lo = Math.min(...d), hi = Math.max(...d), eps = (hi - lo) * 1e-9;
      const values = ticksFor(fit.log ? "log" : "linear", lo, hi).filter(v => v >= lo - eps && v <= hi + eps);
      const labels = fit.log ? values.map(v => labelHtml(formatTick(v, "log"))) : scalarLabels(values);
      return { set: values.map((value, i) => ({ value, html: labels[i] })), log: fit.log };
    };
    // The generated ticks of this axis, one entry per TICK (its mark, label and gridline share a leaf index, and their
    // recovered values differ by the rounding of three separate SVG coordinates, so they are grouped by index, never by value).
    // each version's own pristine guide nodes behind its generated ticks (an asset Change: opts.sourceRoot / opts.targetRoot). The live
    // nodes hold the asset the slide MOUNTED, which in a chain is neither end (the second step of ratio -> pp -> ratio read its start
    // labels off the base asset: its "-4" and "-6" turned into "1.1" and "1" on the first moving frame)
    const sources = new WeakMap<TickSpec, { root: Element; nodes: Partial<Record<"tick" | "tick-label" | "gridline", Element>> }>();
    const generated = (side: "a" | "b"): TickSpec[] => {
      const byIndex = new Map<string, { mark?: GuideBinding; label?: GuideBinding; grid?: GuideBinding; other?: number; html: string }>();
      const valueOf = (g: GuideBinding) => side === "a" ? g.value : g.endValue;
      // a label's exact string comes from the version it belongs to: the live node holds the START's, so an asset Change reads the end's
      // from the end's own pristine render
      const ownIndex = opts.assetChange ? side === "b" ? targetIndex : sourceIndex : null, ownRoot = side === "b" ? opts.targetRoot : opts.sourceRoot;
      const labelNode = (g: GuideBinding): Element => ownIndex?.get(g.leaf) || g.node;
      for (const g of mine) {
        if (!(side === "a" ? g.inA : g.inB)) continue;
        const key = guideIndexKey(g.leaf);
        const entry = byIndex.get(key) ?? byIndex.set(key, { html: "" }).get(key)!;
        if (g.kind === "tick") entry.mark = g; else entry.other ??= valueOf(g);
        if (g.kind === "gridline") entry.grid = g;
        if (g.kind === "tick-label") {
          entry.label = g;
          const node = labelNode(g), text = node.tagName.toLowerCase() === "text" ? node : node.querySelector("text"); entry.html = text?.innerHTML ?? "";
        }
      }
      const gap = (e: { mark?: GuideBinding; label?: GuideBinding }) => e.label && e.mark ? side === "a" ? e.label.origin - e.mark.origin : e.label.end - e.mark.end : undefined;
      return [...byIndex.values()].map(e => {
        const spec: TickSpec = { value: e.mark ? valueOf(e.mark) : e.other!, html: e.html, offset: gap(e) };
        if (ownIndex && ownRoot) {
          const own = (g?: GuideBinding) => g ? ownIndex.get(g.leaf) : undefined;
          sources.set(spec, { root: ownRoot, nodes: { tick: own(e.mark), "tick-label": own(e.label), gridline: own(e.grid) } });
        }
        return spec;
      });
    };
    const na = aRet ? nice(opts.fromView, "a") : null, nb = bRet ? nice(view, "b") : null;
    const A = na?.set ?? generated("a"), B = nb?.set ?? generated("b");
    // ticks match in log units only when BOTH sides are log: a log -> linear Change (a ratio axis 0.9 / 1 / 1.1 -> percentage points
    // -4 / 0 / 4) matched in log units dropped every end tick at or below zero, and the end axis landed with one tick
    const log = !!panel.from[axis]?.log && !!panel.to[axis]?.log;
    // An asset Change that no view re-ticks hands off too when the guide pairing would pair DIFFERENT values: a tick index both versions
    // have stands for another value in each (a new version on other units: 0.9 / 1 / 1.1 -> -4 / 0 / 4). Paired by leaf index, "1.1" slid onto
    // "0" and swapped its text half way, and the end's extra "4" appeared at the landing; handed off, each version's ticks ride the moving
    // axis and fade (the view Change's law). Where every shared index keeps its value (a category axis gaining categories, the same ticks
    // on a new range) the guide pairing stays: each tick walks to its own end place and an added one fades in as itself.
    if (!aRet && !bRet) {
      const f = (v: number) => log ? Math.log(v) : v;
      const steps = (set: TickSpec[]) => { const v = set.map(t => f(t.value)).sort((p, q) => p - q); return v.slice(1).map((x, i) => x - v[i]); };
      const step = Math.min(...steps(A), ...steps(B)), tol = Number.isFinite(step) && step > 0 ? 0.02 * step : 1e-9; // matchTickSets' tolerance
      if (!mine.some(g => g.kind === "tick" && g.inA && g.inB && !(Math.abs(f(g.value) - f(g.endValue)) <= tol))) continue;
    }
    // The first guide of the kind that is shown in the plot's own state. A Change that starts from a re-ticked static view
    // binds with the generated guides already hidden by that static pass, so the display is read through the pristine
    // record (the value before projection wrote it), not off the live style.
    const template = (kind: GuideBinding["kind"]) => mine.find(g => g.kind === kind && ownDisplay(g.node) !== "none");
    const origin = { tick: template("tick"), "tick-label": template("tick-label"), gridline: template("gridline") };
    if (!origin.tick && !origin["tick-label"]) continue;
    // A clone copies its template's bytes as they are NOW: the asset the slide mounted, whatever this Change starts or ends on. It is
    // placed from there (an asset Change between two y axes placed its clones against the template's lerped start -> end place, so the
    // end's ticks landed 21 px above where the end render has them: the first version's "1" tick against the second's "-4").
    const home: FlightAxis["home"] = {};
    for (const kind of ["tick", "tick-label", "gridline"] as const) {
      const tpl = origin[kind]; if (!tpl) continue;
      const tick = mine.find(g => g.kind === "tick" && guideIndexKey(g.leaf) === guideIndexKey(tpl.leaf)) ?? tpl;
      const pixel = pristinePixel(tpl.node, root, axis), anchor = pristinePixel(tick.node, root, axis);
      home[kind] = pixel !== null && anchor !== null ? { pixel, anchor } : { pixel: tpl.origin, anchor: tpl.anchor };
    }
    const ticks: FlightTick[] = [];
    const cursor: Partial<Record<string, Element>> = {};
    const serial = ++flightSerial; // unique ids when two plans of a chain pool the same template
    const mk = (kind: "tick" | "tick-label" | "gridline", n: string, html?: string, spec?: TickSpec): Element | undefined => {
      const tpl = origin[kind]; if (!tpl) return undefined;
      const src = spec ? sources.get(spec) : undefined, own = src?.nodes[kind], ownTick = src?.nodes.tick ?? own;
      const ownPixel = own && src ? guidePixel(own, src.root, axis.startsWith("x") ? "x" : "y") : null;
      const ownAnchor = ownTick && src ? guidePixel(ownTick, src.root, axis.startsWith("x") ? "x" : "y") : null;
      const sourced = !!own && ownPixel !== null && ownAnchor !== null;
      const clone = (sourced ? own! : tpl.node).cloneNode(true) as Element;
      if (sourced) cloneHome.set(clone, { pixel: ownPixel!, anchor: ownAnchor!, transform: own!.getAttribute("transform") });
      clone.setAttribute("id", `${tpl.node.getAttribute("id") ?? tpl.leaf}.flight.${serial}.${n}`);
      // residue: the slide binder (render.compilePlotContent) must see straight past a pooled tick, never key or fade it
      clone.setAttribute("data-projection-tick", ""); clone.setAttribute("data-projection-flight", ""); clone.setAttribute("data-projection-residue", "");
      (clone as SVGElement).style.setProperty("display", "none");
      if (kind === "tick-label" && html !== undefined) {
        const text = clone.tagName.toLowerCase() === "text" ? clone : clone.querySelector("text");
        if (text) text.innerHTML = html;
      }
      const after = cursor[kind] ?? tpl.node;
      after.parentNode?.insertBefore(clone, after.nextSibling);
      cursor[kind] = clone;
      nodes.add(clone); created.push(clone); reserve(clone, ["transform"], ["opacity", "display"]);
      return clone;
    };
    let n = 0;
    for (const pair of matchTickSets(A, B, log)) {
      const same = !!pair.a && !!pair.b && pair.a.html === pair.b.html;
      const va = pair.a?.value ?? pair.b!.value, vb = pair.b?.value ?? pair.a!.value;
      ticks.push({ va, vb, a: !!pair.a, b: !!pair.b, log, sameText: same, oa: pair.a?.offset, ob: pair.b?.offset,
        // each tick is drawn from its own version's bytes (the end's when both have it; one label stands for a matched pair with the
        // same text), so a first frame paints the start's ticks and a last frame the end's
        tick: mk("tick", String(n), undefined, pair.b ?? pair.a), grid: mk("gridline", String(n), undefined, pair.b ?? pair.a),
        labelA: pair.a ? mk("tick-label", `${n}a`, pair.a.html, same ? pair.b : pair.a) : undefined,
        labelB: pair.b && !same && (!pair.a || pair.a.html !== pair.b.html) ? mk("tick-label", `${n}b`, pair.b.html, pair.b) : undefined });
      n++;
    }
    out.push({ panel, axis, guides: mine, ticks, aRet, bRet, origin, home, css: {} });
  }
  return out;
}
/** Place + fade the pooled ticks for this frame; returns the generated guide nodes replaced. */
function writeFlight(plan: Projection, t: number, progress = t): Set<Element> {
  const replaced = new Set<Element>();
  const law = tickFlightLaw(t);
  for (const fa of plan.flight) {
    // An axis handed off only because the two versions of an asset Change tick it differently (no view at either end) rests on the
    // versions' OWN generated ticks: at either end the frame is that version's render, and the canonical tick nodes are the parts a
    // later track addresses (pooled at rest, a highlight of the end's "0" label would have animated a hidden node).
    if (!fa.aRet && !fa.bRet && (progress <= 0 || progress >= 1)) {
      for (const ft of fa.ticks) for (const el of [ft.tick, ft.grid, ft.labelA, ft.labelB]) if (el) style(el, "display", "none");
      continue;
    }
    // No early-out at either end: the generated nodes also stand for an end that is not re-ticked, but a label drawn through the
    // pool (an ancestor translate) rasterises a hair differently from the generated one (own text transform), so the pool
    // draws the WHOLE Change, t = 0 and t = 1 included: the first and the last frame use the raster path of the frames beside them.
    const fit = fa.panel.fits[fa.axis]; if (!fit) continue;
    const r0 = fa.panel.ranges[fa.axis]!, r1 = fa.panel.endRanges[fa.axis] ?? r0;
    const e0 = r0[0] + (r1[0] - r0[0]) * t, e1 = r0[1] + (r1[1] - r0[1]) * t, lo = Math.min(e0, e1), hi = Math.max(e0, e1), soft = (hi - lo) * .04 || 1;
    for (const g of fa.guides) { style(g.node, "display", "none"); replaced.add(g.node); }
    const isX = fa.axis.startsWith("x");
    // the template carries the leaf-level overrides / ghost factor of this frame: read its opacity now, and mirror its
    // inline style onto the pool when it changed
    const baseOf = (tpl: GuideBinding | undefined, kind: "tick" | "tick-label" | "gridline"): number => {
      if (!tpl) return 1;
      const css = tpl.node.getAttribute("style") ?? "";
      if (fa.css[kind] !== css) {
        fa.css[kind] = css;
        // a pooled node is hidden in its pristine state, whatever the template's `display` is right now
        for (const ft of fa.ticks) for (const el of kind === "tick" ? [ft.tick] : kind === "gridline" ? [ft.grid] : [ft.labelA, ft.labelB])
          if (el) { const st = (el as SVGElement).style; st.cssText = css; st.setProperty("display", "none"); }
      }
      const o = (tpl.node as SVGElement).style.getPropertyValue("opacity") || tpl.node.getAttribute("opacity");
      return o ? Number(o) : 1;
    };
    const base = { tick: baseOf(fa.origin.tick, "tick"), label: baseOf(fa.origin["tick-label"], "tick-label"), grid: baseOf(fa.origin.gridline, "gridline") };
    // `offset`: where this tick's label rests from its tick (a generated label's own; absent = the template's, which every nice
    // label takes, exactly as the static re-tick places it)
    // a clone is moved from where it is drawn (`home`: its template's pristine place); `offset` places a label that far from its tick
    const put = (node: Element | undefined, tpl: GuideBinding | undefined, pixel: number, opacity: number, b: number, offset?: number) => {
      if (!node || !tpl) return;
      if (!(opacity > 0.002) || !Number.isFinite(pixel)) { style(node, "display", "none"); return; }
      const own = cloneHome.get(node), h = own ?? fa.home[tpl.kind] ?? { pixel: tpl.origin, anchor: tpl.anchor };
      // a clone of a version's own guide keeps that guide's own gap to its tick (measured off the same bytes it draws: the recovered
      // label value is another reading of it, 1.8 px off where a layout reports text anchors); a template clone takes `offset`
      const delta = pixel - h.anchor + (offset === undefined || own ? 0 : offset - (h.pixel - h.anchor)), original = tpl.node.getAttribute("transform");
      const pristineTransform = pristine.get(tpl.node)?.attrs.get("transform"), baseT = own ? own.transform : pristineTransform?.written ? pristineTransform.value : original;
      attr(node, "transform", `translate(${(isX ? delta : 0).toFixed(6)} ${(isX ? 0 : delta).toFixed(6)})${baseT ? ` ${baseT}` : ""}`);
      style(node, "opacity", String(opacity * b)); style(node, "display", "");
    };
    const from = fa.panel.from[fa.axis], to = fa.panel.to[fa.axis];
    for (const ft of fa.ticks) {
      // the pixel law (lerpPixel): a tick walks from where its value sits on the start's axis to where it sits on the end's (for a tick
      // in one set, its one value on both: exactly the blended fit). A value one side cannot place (zero or below on a log axis: the
      // blended fit's log term made it NaN, so it stayed hidden until the landing frame drew it) stands at the place it has.
      const va = ft.a ? ft.va : ft.vb, vb = ft.b ? ft.vb : ft.va;
      const pixel = from && to ? lerpPixel(from, to, va, vb, t) : projectWith(fit, va);
      const out = Math.max(lo - pixel, pixel - hi, 0) - 1e-6, edge = out <= 0 ? 1 : Math.max(0, 1 - out / soft);
      const w = ft.a && ft.b ? 1 : ft.a ? law.aOnly : law.bOnly;
      put(ft.tick, fa.origin.tick, pixel, w * edge, base.tick);
      put(ft.grid, fa.origin.gridline, pixel, w * edge, base.grid);
      // a matched tick's label walks from its generated offset to the template's (a nice label is placed as the static re-tick places it)
      const rest = fa.origin["tick-label"] ? fa.origin["tick-label"].origin - fa.origin["tick-label"].anchor : 0;
      const offset = ft.a && ft.b ? (ft.oa ?? rest) + ((ft.ob ?? rest) - (ft.oa ?? rest)) * t : ft.a ? ft.oa : ft.ob;
      if (ft.sameText || !(ft.a && ft.b)) { put(ft.labelA ?? ft.labelB, fa.origin["tick-label"], pixel, w * edge, base.label, offset); }
      else { // matched, exact text differs: one hard swap at t = .5, always full opacity
        put(ft.labelA, fa.origin["tick-label"], pixel, law.swapToB ? 0 : edge, base.label, offset);
        put(ft.labelB, fa.origin["tick-label"], pixel, law.swapToB ? edge : 0, base.label, offset);
      }
    }
  }
  return replaced;
}
function projection(root: Element, manifest: FluxPlotManifest, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): Projection {
  let entries = plans.get(root);
  if (entries) for (const prior of entries) if (prior.manifest === manifest && prior.view === view && prior.opts === opts) return prior.plan;
  const plan = bind(root, manifest, view, elId, opts);
  if (!entries) { entries = []; plans.set(root, entries); }
  entries.push({ manifest, view, opts, plan });
  return plan;
}
/** Bind before overrides/compensation, or before the first playback frame. */
export function preparePlotView(root: Element, manifest: FluxPlotManifest | undefined, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): void {
  if (manifest && (view || opts)) projection(root, manifest, view, elId, opts);
}
export function applyPlotView(root: Element, manifest: FluxPlotManifest | undefined, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): void {
  restoreProjection(root);
  if (!manifest || !view && !opts) return;
  const plan = projection(root, manifest, view, elId, opts), t = Math.max(0, Math.min(1, opts?.t ?? 1));
  for (const panel of plan.panels) {
    blendFit(panel.from.x, panel.to.x, t, panel.fits.x); blendFit(panel.from.y, panel.to.y, t, panel.fits.y);
    if (panel.fits.y2 && panel.from.y2 && panel.to.y2) blendFit(panel.from.y2, panel.to.y2, t, panel.fits.y2);
    if (panel.fits.x2 && panel.from.x2 && panel.to.x2) blendFit(panel.from.x2, panel.to.x2, t, panel.fits.x2);
  }
  for (const s of plan.series) {
    sampleSeries(s.pairs, s.from, s.to, t, s.vertices, s.fits);
    if (s.line) {
      const topology = s.topology;
      if (!topology) writeSeriesLine(s.line, s.vertices);
      else {
        if (t <= 0) writeSeriesLine(s.line, topology.a);
        else if (t >= 1) writeSeriesLine(s.line, topology.b);
        else writeSeriesRuns(s.line, topology.common);
        writeSeriesRuns(topology.outgoing, topology.aRuns); writeSeriesRuns(topology.incoming, topology.bRuns);
        for (const name of topology.paint) {
          const value = s.line.getAttribute(name);
          attr(topology.outgoing, name, value); attr(topology.incoming, name, value);
        }
        const opacity = Number((s.line as SVGElement).style.opacity || s.line.getAttribute("opacity") || 1);
        style(topology.outgoing, "opacity", String(t <= 0 || t >= 1 ? 0 : opacity * Math.max(0, 1 - t / .4)));
        style(topology.incoming, "opacity", String(t <= 0 || t >= 1 ? 0 : opacity * Math.max(0, (t - .6) / .4)));
      }
      if (t > 0 && opts) {
        // A completed drawOn window must not truncate the new, longer line.
        (s.line as SVGElement).style.removeProperty("stroke-dasharray");
        (s.line as SVGElement).style.removeProperty("stroke-dashoffset");
      }
    }
    for (const marker of s.markers) {
      const p = s.vertices[marker.vertex];
      writeMarker(marker.node, p.x, p.y,
        marker.ox + (plan.interpolated ? (marker.ex - marker.ox) * t : 0),
        marker.oy + (plan.interpolated ? (marker.ey - marker.oy) * t : 0));
    }
  }
  const parsedTables = new Map<string, { parsed: ReturnType<typeof parseColormap>; eff: ReturnType<typeof effectiveScale> }>();
  for (const sh of plan.shapes) {
    writePolygons(sh, t);
    if (!sh.value) continue;
    // the colour of the tweened value, through the colour law with this frame's view (F7)
    let table = parsedTables.get(sh.value.scale.id);
    if (!table) {
      const eff = effectiveScale(sh.value.scale, opts?.colorScale?.[sh.value.scale.id], colormapLut);
      if (eff.unresolved || eff.issues.length) continue;
      table = { parsed: parseColormap(eff.colormap), eff };
      parsedTables.set(sh.value.scale.id, table);
    }
    const value = lerpData(sh.value.a, sh.value.b, t, false);
    attr(sh.node, "data-value", shortFloat(value));
    const c = table.parsed.colors[slotFor(table.parsed.N, normalize(table.eff.norm, value), INDEX_KINDS.includes(table.eff.norm.kind))];
    const hex = c.a <= 0 ? "none" : rgbHex(c), opacity = c.a > 0 && c.a < 1 ? shortFloat(c.a) : "";
    if (sh.value.paint !== "stroke") { style(sh.node, "fill", hex); if (opacity) style(sh.node, "fill-opacity", opacity); }
    if (sh.value.paint !== "fill") { style(sh.node, "stroke", hex); if (opacity) style(sh.node, "stroke-opacity", opacity); }
  }
  const progress = opts?.raw ?? t;
  // at an asset Change's end the frame IS that end's own render: an axis its view leaves alone keeps its generated guides at full opacity
  // (the static render skips an unchanged axis; only a viewed one fades its guides at the plot edge)
  const atRest = (axis: PlotAxisKey) => !!opts?.assetChange && (progress >= 1 && !view?.[axis] || progress <= 0 && !opts.fromView?.[axis]);
  // at rest with a view, an axis whose domain or scale changed gets ticks generated for the new
  // domain (its own scheme: nice 1·2·5 steps or decades) in place of the generated ones (F4)
  // A Change with a tick hand-off draws its ticks through the pool for the whole flight, t = 0 and t = 1 included (writeFlight: the first and
  // last frames use the raster path of the frames beside them; an axis handed off only because two asset versions tick it at other values
  // rests on the versions' own ticks). Otherwise a static render with a view re-ticks, and so does an elastic (relayout) Change at either
  // end, with the view and the plot version that end rests at.
  const restingView = opts && progress <= 0 ? opts.fromView : view;
  const restingManifest = opts && progress >= 1 ? opts.toManifest ?? manifest : manifest;
  const reticked = opts && plan.flight.length ? writeFlight(plan, t, progress)
    : (!opts || !!opts.rawFromManifest && (progress <= 0 || progress >= 1)) && restingView ? retick(root, plan, restingView, restingManifest, !!opts && progress >= 1)
    : new Set<Element>();
  if (!reticked.size) dropRetick(root);
  for (const g of [...plan.guides, ...plan.references]) {
    if (reticked.has(g.node)) continue;
    const p = g.panel, fit = p.fits[g.axis]!, raw = p.rawA[g.axis]!;
    // Unchanged guides keep their original bytes, including ticks at the edge.
    if (fit.m === raw.m && fit.c === raw.c && fit.log === raw.log && fit.linear === undefined && (!plan.interpolated || g.origin === g.end)) continue;
    const pixel = lerpPixel(p.from[g.axis]!, p.to[g.axis]!, g.value, g.endValue, t);
    const a = p.ranges[g.axis] ?? (g.axis.startsWith("x") ? p.xRange : p.yRange), b = p.endRanges[g.axis] ?? (g.axis.startsWith("x") ? p.xEndRange : p.yEndRange);
    const edge0 = a[0] + (b[0] - a[0]) * t, edge1 = a[1] + (b[1] - a[1]) * t;
    const lo = Math.min(edge0, edge1), hi = Math.max(edge0, edge1);
    // A guide fades by how far its TICK has left the axis' range (the tick hand-off's law, writeFlight), never inside it: the old ramp
    // faded every guide within 4 % of an edge, so a tick at the axis' first category ("Wake low δ", whose label's own value, -0.24, sits
    // left of the axis start) vanished on the first moving frame of an asset Change that never moved it.
    const tickPixel = pixel - (g.origin - g.anchor), out = Math.max(lo - tickPixel, tickPixel - hi, 0) - 1e-6, soft = (hi - lo) * .04 || 1;
    const fade = atRest(g.axis) ? 1 : Number.isFinite(pixel) ? (out <= 0 ? 1 : Math.max(0, 1 - out / soft)) : 0;
    g.delta[g.axis.startsWith("x") ? "dx" : "dy"] = Number.isFinite(pixel) ? pixel - (g.origin + (plan.interpolated ? (g.end - g.origin) * t : 0)) : 0;
    writeGuide(g.node, g.delta, fade);
  }
}

/** Regenerate the ticks, tick labels and gridlines of every viewed axis whose fit changed: the
 *  generated ones are hidden and clones of the first visible template are placed at nice tick
 *  positions for the new domain, labelled with the axis' own formatter (ScalarFormatter
 *  decimals for a plain linear axis, 10ᵏ for a log one). Category, date, fixed and offset
 *  (sci) schemes keep the generated ticks, which the guide pass moves and fades instead.
 *  Returns the generated guide nodes that were replaced (hidden). */
function retick(root: Element, plan: Projection, view: PlotView, manifest: FluxPlotManifest,atEnd=false): Set<Element> {
  dropRetick(root);
  const replaced = new Set<Element>();
  const clones: Element[] = [];
  const byAxis = new Map<string, GuideBinding[]>();
  for (const g of plan.guides) {
    const key = `${plan.panels.indexOf(g.panel)}|${g.axis}|${g.leaf.includes('.secondary.')?'far':'near'}|${g.leaf.includes('.minor.')?'minor':'major'}`;
    (byAxis.get(key) ?? byAxis.set(key, []).get(key)!).push(g);
  }
  for (const [key, guides] of byAxis) {
    const [panelIndex, axis] = key.split("|") as [string, PlotAxisKey];
    const panel = plan.panels[Number(panelIndex)];
    const patch = view[axis];
    const panelId = [...(plan.axesInfo.keys())][Number(panelIndex)];
    if (!patch || !retickable(manifest, view, panelId, axis)) continue;
    const fit = panel.fits[axis], raw = (atEnd?panel.rawB:panel.rawA)[axis];
    if (!fit || !raw) continue;
    const domain = patch.domain ?? [dataOfPixel(raw, ((atEnd?panel.endRanges:panel.ranges)[axis] ?? panel.xRange)[0]), dataOfPixel(raw, ((atEnd?panel.endRanges:panel.ranges)[axis] ?? panel.xRange)[1])];
    const log = fit.log;
    const captured=capturedAxis(manifest,panelId,axis);
    const ck=axis.startsWith('x')?'x':'y',input=captured?.ticking[ck],rangeForPort=(atEnd?panel.endRanges:panel.ranges)[axis]??(axis.startsWith('x')?panel.xRange:panel.yRange);
    const table=input?ticksAt({...input,domain,scale:log?'log':'linear',retick:true},Math.abs(rangeForPort[1]-rangeForPort[0]),manifest.layout!.fonts[captured!.axisStyle[ck].font]?.sizePt??10,ck==='y'):null;
    const minor=key.endsWith('|minor');
    if(minor&&(!input||input.minorRetick===false))continue;
    const values = (minor?table?.minor:table?.values)??ticksFor(log ? "log" : "linear", Math.min(...domain), Math.max(...domain));
    if (!values.length) continue;
    const range = (atEnd?panel.endRanges:panel.ranges)[axis] ?? (axis.startsWith("x") ? panel.xRange : panel.yRange);
    const lo = Math.min(...range), hi = Math.max(...range);
    const labels: { text: string; base?: string; exponent?: string }[] = table?(minor?table.minorLabels:table.labels).map(text=>{const m=/^\$\\mathdefault\{([\d.]+)\^\{([^}]+)\}\}\$$/.exec(text);return m?{text,base:m[1],exponent:m[2]}:{text:text.replace(/\$|\\mathdefault\{|[{}]/g,'')};}):log ? values.map((v) => formatTick(v, "log")) : scalarLabels(values).map((text) => ({ text }));
    const template = (kind: GuideBinding["kind"]) => guides.find((g) => g.kind === kind && (g.node as SVGElement).style.getPropertyValue("display") !== "none");
    const templates = { tick: template("tick"), "tick-label": template("tick-label"), gridline: template("gridline") };
    if (!templates.tick && !templates["tick-label"]) continue;
    for (const g of guides) { style(g.node, "display", "none"); attr(g.node,"data-projection-hidden",""); replaced.add(g.node); }
    const cursor: Partial<Record<GuideBinding["kind"], Element>> = {};
    values.forEach((v, i) => {
      const pixel = projectWith(fit, v);
      if (!Number.isFinite(pixel) || pixel < lo - 1e-6 || pixel > hi + 1e-6) return;
      for (const kind of ["tick", "tick-label", "gridline"] as const) {
        const reuse=manifest.layout?.supported?guides.find(g=>g.kind===kind&&Math.abs(g.value-v)<=1e-9*Math.max(1e-300,Math.abs(g.value),Math.abs(v))):undefined;
        const tpl = reuse??templates[kind];
        if (!tpl) continue;
        const source=plan.templates.get(tpl.node)??tpl.node,sourceId=source.getAttribute("id")??tpl.leaf;
        const clone = source.cloneNode(true) as Element;
        // Projection clones are disposable. Keep the semantic id for retained
        // values while parking the original until restoreProjection runs.
        if(reuse)attr(reuse.node,"id",sourceId+".projection-original");
        clone.setAttribute("id", reuse?sourceId:`${sourceId}.view.${i}`);
        for(const child of Array.from(clone.querySelectorAll("[id]")))child.removeAttribute("id");
        clone.setAttribute("data-projection-tick", "");clone.setAttribute("data-relayout-source",tpl.leaf);clone.setAttribute("data-value",String(v));
        (clone as SVGElement).style.removeProperty("display");
        // a label (or gridline) rests at its tick's pixel plus a constant (its anchor), at the end the tick's end pixel; the base transform is
        // the template's, bound before overrides: a source leaf's nudge neither leaks into new values nor is applied twice to retained ones
        const delta = pixel - (atEnd ? tpl.anchorEnd : tpl.anchor);
        const base = source.getAttribute("transform");
        clone.setAttribute("transform", `translate(${(axis.startsWith("x") ? delta : 0).toFixed(6)} ${(axis.startsWith("x") ? 0 : delta).toFixed(6)})${base ? ` ${base}` : ""}`);
        if (kind === "tick-label") {
          const text = clone.tagName.toLowerCase() === "text" ? clone : clone.querySelector("text");
          if (text) {
            const label = labels[i];
            const native=manifest.layout?.texts[tpl.leaf],font=native?manifest.layout?.fonts[native.font]:undefined,rawLabel=table?(minor?table.minorLabels:table.labels)[i]:undefined;
            if(rawLabel?.startsWith('$')&&native&&font)writeMathLabel(clone,rawLabel,native,font);
            else if (label.exponent !== undefined) text.innerHTML = `${label.base}<tspan baseline-shift="super" style="font-size: 70%">${label.exponent}</tspan>`;
            else text.textContent = label.text;
          }
        }
        const after = cursor[kind] ?? tpl.node; // in tick order, after the template
        after.parentNode?.insertBefore(clone, after.nextSibling);
        cursor[kind] = clone;
        clones.push(clone);
      }
    });
  }
  if (clones.length){retickClones.set(root, clones);applyTickGroupOverrides(root);}
  return replaced;
}
