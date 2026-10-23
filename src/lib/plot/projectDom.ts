// The one attribute writer for static plot views and animated data/view changes.
// All identities, fits and guide values bind once; frames reuse numeric buffers.
import type { PlotView, PlotAxisKey } from "../types";
import type { FluxPlotManifest, FluxPlotSeries, FluxPlotAxis } from "./types";
import { partDomId } from "./parse";
import { axisFit, blendFit, guideAxes, guideData, matchTickSets, pairVertices, projectWith, sampleSeries, seriesFits, dataOfPixel, filledLeaves, retickable, tickFlightLaw, type TickSpec,
  seriesAxes, seriesVertices, seriesTweenable, viewFits, lerpData, type Fit, type Fits, type MorphPoint } from "./project";
import { transformToAncestor } from "./svgMatrix";
import { ticksFor, scalarLabels, formatTick } from "./ticks";
import { effectiveScale, parseColormap, slotFor, normalize, INDEX_KINDS, rgbHex, shortFloat } from "./colorscale";
import { colormapLut } from "../color/colormapLuts";
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
  /** The same anchor in the END version's geometry (an asset Change moves a guide's own natural place from `origin` to `end` while the
   *  binder lerps it; a pooled tick is placed against the lerped anchor). Equal to `anchor` when the Change keeps the asset. */
  anchorEnd: number;
  /** Which plot version carries this guide: the start's, the end's (both for a Change that keeps the asset). */
  inA: boolean; inB: boolean;
  /** The leaf id (unprefixed) and its guide kind, for re-ticking (F4). */
  leaf: string; kind: "tick" | "tick-label" | "gridline";
}
/** A filled mark (a bar, a heatmap cell, a hexagon, a contour band, a box or violin body)
 *  re-projected vertex by vertex: its path's vertices in DATA units, read once through the
 *  generated fits, written each frame through the view's (F4). Polygons only (M / L / Z). */
interface ShapeBinding {
  node: Element; panel: Panel; from: Fits; to: Fits; fits: Fits;
  subpaths: { x: Float64Array; y: Float64Array; closed: boolean }[];
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
  /** last template inline style copied onto the pool, per kind (a per-leaf override reaches the clones) */
  css: Partial<Record<"tick" | "tick-label" | "gridline", string>>;
}
interface Projection {
  series: SeriesBinding[]; guides: GuideBinding[]; panels: Panel[]; shapes: ShapeBinding[];
  interpolated: boolean;
  /** Pooled hand-off ticks per re-ticked axis (a view Change in flight; see buildFlight). */
  flight: FlightAxis[];
  /** every node buildFlight cloned for this plan (they live in the plot's own SVG and go with it) */
  flightNodes: Element[];
  /** Per panel and axis key: the view axis' tick scheme, for re-ticking at rest. */
  axesInfo: Map<string | undefined, Record<string, { locator?: string; formatter?: string; scale: string }>>;
}

/** Parse an absolute M / L / Z path into subpaths; null when it holds any other command. */
function polygonSubpaths(d: string | null): { x: number[]; y: number[]; closed: boolean }[] | null {
  if (!d) return null;
  const tokens = d.match(/[MLZmlz]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) return null;
  const out: { x: number[]; y: number[]; closed: boolean }[] = [];
  let cur: { x: number[]; y: number[]; closed: boolean } | null = null, i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];
    if (t === "M" || t === "L") {
      if (t === "M") { cur = { x: [], y: [], closed: false }; out.push(cur); }
      if (!cur) return null;
      while (i + 1 < tokens.length + 1 && i + 1 <= tokens.length && /^[-+.\d]/.test(tokens[i] ?? "") && /^[-+.\d]/.test(tokens[i + 1] ?? "")) {
        cur.x.push(Number(tokens[i])); cur.y.push(Number(tokens[i + 1])); i += 2;
      }
    } else if (t === "Z" || t === "z") { if (cur) cur.closed = true; }
    else return null; // relative or curve commands: not a polygon we rewrite
  }
  return out.length && out.every((sp) => sp.x.length >= 2) ? out : null;
}

function writePolygons(node: Element, subpaths: ShapeBinding["subpaths"], fits: Fits, target?: ShapeBinding["subpaths"], t = 0, logX = false, logY = false): void {
  let d = "";
  for (const [k, sp] of subpaths.entries()) {
    const tp = target?.[k];
    for (let i = 0; i < sp.x.length; i++) {
      const dx = tp ? lerpData(sp.x[i], tp.x[i], t, logX) : sp.x[i], dy = tp ? lerpData(sp.y[i], tp.y[i], t, logY) : sp.y[i];
      const px = projectWith(fits.x, dx), py = projectWith(fits.y, dy);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return; // leave the generated bytes
      d += `${i ? " L " : (d ? " M " : "M ")}${px.toFixed(6)} ${py.toFixed(6)}`;
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
  const subpaths = polys.map((sp) => ({ x: Float64Array.from(sp.x, (px) => dataOfPixel(fits.x, px)), y: Float64Array.from(sp.y, (py) => dataOfPixel(fits.y, py)), closed: sp.closed }));
  return subpaths.some((sp) => !Array.from(sp.x).every(Number.isFinite) || !Array.from(sp.y).every(Number.isFinite)) ? null : subpaths;
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

/** `axis.x.tick.3` / `axis.x.ticklabel.3` / `axis.x.gridline.3` -> `axis.x.#3`: the three guides of one tick share it. */
const guideIndexKey = (leaf: string) => leaf.replace(/\.(?:ticklabel|tick-label|tick|gridline)\.(\d+)$/, ".#$1");

function bind(root: Element, manifest: FluxPlotManifest, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): Projection {
  if (!manifest.axes?.length || !manifest.series?.length || opts?.toManifest && (!opts.toManifest.axes?.length || !opts.toManifest.series?.length)) return { series: [], guides: [], panels: [], shapes: [], interpolated: false, axesInfo: new Map(), flight: [], flightNodes: [] };
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
    const rawA = viewFits(manifest, undefined, ax.panelId);
    const rawB = viewFits(opts?.toManifest ?? manifest, undefined, ax.panelId);
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
    if (!panel || a.rasterized || a.capabilities?.dataMorph === false || a.roles?.some(r => !["line", "point"].includes(r))) continue;
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
      if (b && sRawB && opts?.targetRoot) {
        const key = found!.getAttribute("data-key") ?? path.getAttribute("data-key");
        const twin = (key ? bByKey.get(key) : undefined) ?? bById.get(leaf);
        const twinPath = twin ? pathOf(twin) : null;
        if (twin) paired.add(twin);
        const twinPolys = twinPath ? polygonInData(twinPath, opts.targetRoot, sRawB) : null;
        if (twinPolys && twinPolys.length === subpaths.length && twinPolys.every((sp, k) => sp.x.length === subpaths[k].x.length)) binding.target = { subpaths: twinPolys };
        const va = Number(path.getAttribute("data-value") ?? found!.getAttribute("data-value")), vb = Number(twinPath?.getAttribute("data-value") ?? twin?.getAttribute("data-value"));
        if (scale && scale.recolor === "live" && Number.isFinite(va) && Number.isFinite(vb) && va !== vb) {
          binding.value = { a: va, b: vb, scale, paint: paintOfGroup(path) };
          reserve(path, ["data-value"], ["fill", "stroke", "fill-opacity", "stroke-opacity"]);
        }
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
  const data = guideData(manifest, opts?.sourceRoot ?? root, opts?.sourceRoot ? "" : elId);
  const targetData = opts?.targetRoot ? guideData(opts.toManifest ?? manifest, opts.targetRoot) : data;
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
  const flightNodes: Element[] = [];
  const flight = opts?.tickHandoff && (view || opts.fromView) ? buildFlight(manifest, view, opts, panels, guides, nodes, flightNodes, targetIndex) : [];
  return { series, guides, panels: [...panels.values()], shapes, interpolated: opts?.geometryInterpolated ?? false, axesInfo, flight, flightNodes };
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
const labelHtml = (l: { text: string; base?: string; exponent?: string }) =>
  l.exponent !== undefined ? `${l.base}<tspan baseline-shift="super" style="font-size: 70%">${l.exponent}</tspan>` : l.text;
function buildFlight(manifest: FluxPlotManifest, view: PlotView | undefined, opts: PlotViewOptions, panels: Map<string | undefined, Panel>,
  guides: GuideBinding[], nodes: Set<Element>, created: Element[], targetIndex: Map<string, Element> | null): FlightAxis[] {
  const out: FlightAxis[] = [];
  for (const [panelId, panel] of panels) for (const axis of ["x", "y", "y2", "x2"] as PlotAxisKey[]) {
    const mine = guides.filter(g => g.panel === panel && g.axis === axis);
    if (!mine.length) continue;
    // An asset Change has two manifests (and two pixel ranges): each side's set is read from its own version, so a Change that starts from
    // (or lands on) a re-ticked view hands the ticks off exactly as a view Change does, and a side with no view keeps its generated ticks.
    const endManifest = opts.toManifest ?? manifest;
    const aRet = retickable(manifest, opts.fromView, panelId, axis), bRet = retickable(endManifest, view, panelId, axis);
    if (!aRet && !bRet) continue;
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
    const generated = (side: "a" | "b"): TickSpec[] => {
      const byIndex = new Map<string, { mark?: GuideBinding; label?: GuideBinding; other?: number; html: string }>();
      const valueOf = (g: GuideBinding) => side === "a" ? g.value : g.endValue;
      // a label's exact string comes from the version it belongs to: the live node holds the START's, so an asset Change reads the end's
      // from the end's own pristine render
      const labelNode = (g: GuideBinding): Element => (side === "b" && opts.assetChange ? targetIndex?.get(g.leaf) : null) || g.node;
      for (const g of mine) {
        if (!(side === "a" ? g.inA : g.inB)) continue;
        const key = guideIndexKey(g.leaf);
        const entry = byIndex.get(key) ?? byIndex.set(key, { html: "" }).get(key)!;
        if (g.kind === "tick") entry.mark = g; else entry.other ??= valueOf(g);
        if (g.kind === "tick-label") {
          entry.label = g;
          const node = labelNode(g), text = node.tagName.toLowerCase() === "text" ? node : node.querySelector("text"); entry.html = text?.innerHTML ?? "";
        }
      }
      const gap = (e: { mark?: GuideBinding; label?: GuideBinding }) => e.label && e.mark ? side === "a" ? e.label.origin - e.mark.origin : e.label.end - e.mark.end : undefined;
      return [...byIndex.values()].map(e => ({ value: e.mark ? valueOf(e.mark) : e.other!, html: e.html, offset: gap(e) }));
    };
    const na = aRet ? nice(opts.fromView, "a") : null, nb = bRet ? nice(view, "b") : null;
    const A = na?.set ?? generated("a"), B = nb?.set ?? generated("b");
    const log = !!(na?.log ?? nb?.log ?? panel.from[axis]?.log);
    // The first guide of the kind that is shown in the plot's own state. A Change that starts from a re-ticked static view
    // binds with the generated guides already hidden by that static pass, so the display is read through the pristine
    // record (the value before projection wrote it), not off the live style.
    const template = (kind: GuideBinding["kind"]) => mine.find(g => g.kind === kind && ownDisplay(g.node) !== "none");
    const origin = { tick: template("tick"), "tick-label": template("tick-label"), gridline: template("gridline") };
    if (!origin.tick && !origin["tick-label"]) continue;
    const ticks: FlightTick[] = [];
    const cursor: Partial<Record<string, Element>> = {};
    const serial = ++flightSerial; // unique ids when two plans of a chain pool the same template
    const mk = (kind: "tick" | "tick-label" | "gridline", n: string, html?: string): Element | undefined => {
      const tpl = origin[kind]; if (!tpl) return undefined;
      const clone = tpl.node.cloneNode(true) as Element;
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
        tick: mk("tick", String(n)), grid: mk("gridline", String(n)),
        labelA: pair.a ? mk("tick-label", `${n}a`, pair.a.html) : undefined,
        labelB: pair.b && !same && (!pair.a || pair.a.html !== pair.b.html) ? mk("tick-label", `${n}b`, pair.b.html) : undefined });
      n++;
    }
    out.push({ panel, axis, guides: mine, ticks, aRet, bRet, origin, css: {} });
  }
  return out;
}
/** Place + fade the pooled ticks for this frame; returns the generated guide nodes replaced. */
function writeFlight(plan: Projection, t: number): Set<Element> {
  const replaced = new Set<Element>();
  const law = tickFlightLaw(t);
  for (const fa of plan.flight) {
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
    // an asset Change moves the template's own natural place from its start geometry to its end geometry (the binder lerps it), so the pool
    // is placed against the lerped anchor; a Change that keeps the asset has origin == end, anchor == anchorEnd (the same numbers)
    const lerped = (a: number, b: number) => plan.interpolated ? a + (b - a) * t : a;
    const put = (node: Element | undefined, tpl: GuideBinding | undefined, pixel: number, opacity: number, b: number, offset?: number) => {
      if (!node || !tpl) return;
      if (!(opacity > 0.002) || !Number.isFinite(pixel)) { style(node, "display", "none"); return; }
      const anchor = lerped(tpl.anchor, tpl.anchorEnd);
      const delta = pixel - anchor + (offset === undefined ? 0 : offset - (lerped(tpl.origin, tpl.end) - anchor)), original = tpl.node.getAttribute("transform");
      const pristineTransform = pristine.get(tpl.node)?.attrs.get("transform"), baseT = pristineTransform?.written ? pristineTransform.value : original;
      attr(node, "transform", `translate(${(isX ? delta : 0).toFixed(6)} ${(isX ? 0 : delta).toFixed(6)})${baseT ? ` ${baseT}` : ""}`);
      style(node, "opacity", String(opacity * b)); style(node, "display", "");
    };
    for (const ft of fa.ticks) {
      const value = ft.a && ft.b ? lerpData(ft.va, ft.vb, t, ft.log) : ft.a ? ft.va : ft.vb;
      const pixel = projectWith(fit, value);
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
    writePolygons(sh.node, sh.subpaths, sh.fits, sh.target?.subpaths, t, sh.from.x.log && sh.to.x.log, sh.from.y.log && sh.to.y.log);
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
  const reticked = !opts ? (view ? retick(root, plan, view, manifest) : new Set<Element>()) : plan.flight.length ? writeFlight(plan, t) : new Set<Element>();
  if (!reticked.size) dropRetick(root);
  for (const g of plan.guides) {
    if (reticked.has(g.node)) continue;
    const p = g.panel, fit = p.fits[g.axis]!, raw = p.rawA[g.axis]!;
    // Unchanged guides keep their original bytes, including ticks at the edge.
    if (fit.m === raw.m && fit.c === raw.c && fit.log === raw.log && fit.linear === undefined && (!plan.interpolated || g.origin === g.end)) continue;
    const pixel = projectWith(fit, lerpData(g.value, g.endValue, t, !!p.from[g.axis]?.log && !!p.to[g.axis]?.log));
    const a = p.ranges[g.axis] ?? (g.axis.startsWith("x") ? p.xRange : p.yRange), b = p.endRanges[g.axis] ?? (g.axis.startsWith("x") ? p.xEndRange : p.yEndRange);
    const edge0 = a[0] + (b[0] - a[0]) * t, edge1 = a[1] + (b[1] - a[1]) * t;
    const lo = Math.min(edge0, edge1), hi = Math.max(edge0, edge1);
    const fade = atRest(g.axis) ? 1 : Number.isFinite(pixel) ? Math.max(0, Math.min(1, (pixel - lo) / ((hi - lo) * .04), (hi - pixel) / ((hi - lo) * .04))) : 0;
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
function retick(root: Element, plan: Projection, view: PlotView, manifest: FluxPlotManifest): Set<Element> {
  dropRetick(root);
  const replaced = new Set<Element>();
  const clones: Element[] = [];
  const byAxis = new Map<string, GuideBinding[]>();
  for (const g of plan.guides) {
    const key = `${plan.panels.indexOf(g.panel)}|${g.axis}`;
    (byAxis.get(key) ?? byAxis.set(key, []).get(key)!).push(g);
  }
  for (const [key, guides] of byAxis) {
    const [panelIndex, axis] = key.split("|") as [string, PlotAxisKey];
    const panel = plan.panels[Number(panelIndex)];
    const patch = view[axis];
    const panelId = [...(plan.axesInfo.keys())][Number(panelIndex)];
    if (!patch || !retickable(manifest, view, panelId, axis)) continue;
    const fit = panel.fits[axis], raw = panel.rawA[axis];
    if (!fit || !raw) continue;
    const domain = patch.domain ?? [dataOfPixel(raw, (panel.ranges[axis] ?? panel.xRange)[0]), dataOfPixel(raw, (panel.ranges[axis] ?? panel.xRange)[1])];
    const log = fit.log;
    const values = ticksFor(log ? "log" : "linear", Math.min(...domain), Math.max(...domain));
    if (!values.length) continue;
    const range = panel.ranges[axis] ?? (axis.startsWith("x") ? panel.xRange : panel.yRange);
    const lo = Math.min(...range), hi = Math.max(...range);
    const labels: { text: string; base?: string; exponent?: string }[] = log ? values.map((v) => formatTick(v, "log")) : scalarLabels(values).map((text) => ({ text }));
    const template = (kind: GuideBinding["kind"]) => guides.find((g) => g.kind === kind && (g.node as SVGElement).style.getPropertyValue("display") !== "none");
    const templates = { tick: template("tick"), "tick-label": template("tick-label"), gridline: template("gridline") };
    if (!templates.tick && !templates["tick-label"]) continue;
    for (const g of guides) { style(g.node, "display", "none"); replaced.add(g.node); }
    const cursor: Partial<Record<GuideBinding["kind"], Element>> = {};
    values.forEach((v, i) => {
      const pixel = projectWith(fit, v);
      if (!Number.isFinite(pixel) || pixel < lo - 1e-6 || pixel > hi + 1e-6) return;
      for (const kind of ["tick", "tick-label", "gridline"] as const) {
        const tpl = templates[kind];
        if (!tpl) continue;
        const clone = tpl.node.cloneNode(true) as Element;
        clone.setAttribute("id", `${tpl.node.getAttribute("id") ?? tpl.leaf}.view.${i}`);
        clone.setAttribute("data-projection-tick", "");
        (clone as SVGElement).style.removeProperty("display");
        const delta = pixel - tpl.anchor;
        const original = tpl.node.getAttribute("transform");
        const pristineTransform = pristine.get(tpl.node)?.attrs.get("transform");
        const base = pristineTransform?.written ? pristineTransform.value : original;
        clone.setAttribute("transform", `translate(${(axis.startsWith("x") ? delta : 0).toFixed(6)} ${(axis.startsWith("x") ? 0 : delta).toFixed(6)})${base ? ` ${base}` : ""}`);
        if (kind === "tick-label") {
          const text = clone.tagName.toLowerCase() === "text" ? clone : clone.querySelector("text");
          if (text) {
            const label = labels[i];
            if (label.exponent !== undefined) text.innerHTML = `${label.base}<tspan baseline-shift="super" style="font-size: 70%">${label.exponent}</tspan>`;
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
  if (clones.length) retickClones.set(root, clones);
  return replaced;
}
