// The one attribute writer for static plot views and animated data/view changes.
// All identities, fits and guide values bind once; frames reuse numeric buffers.
import type { PlotView, PlotAxisKey } from "../types";
import type { FluxPlotManifest, FluxPlotSeries, FluxPlotAxis } from "./types";
import { partDomId } from "./parse";
import { axisFit, blendFit, guideAxes, guideData, pairVertices, projectWith, sampleSeries, seriesFits, dataOfPixel, filledLeaves,
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
interface Projection {
  series: SeriesBinding[]; guides: GuideBinding[]; panels: Panel[]; shapes: ShapeBinding[];
  interpolated: boolean;
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

function bind(root: Element, manifest: FluxPlotManifest, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): Projection {
  if (!manifest.axes?.length || !manifest.series?.length || opts?.toManifest && (!opts.toManifest.axes?.length || !opts.toManifest.series?.length)) return { series: [], guides: [], panels: [], shapes: [], interpolated: false, axesInfo: new Map() };
  const nodes = roots.get(root) ?? new Set<Element>(); roots.set(root, nodes);
  const index = new Map<string, Element>();
  // One lookup per leaf, including unusual punctuation in semantic IDs.
  const q = (leaf: string): Element | null => {
    const id = elId ? partDomId(elId, leaf) : leaf;
    const prior = index.get(id); if (prior) return prior;
    const node = root.querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`);
    if (node) { index.set(id, node); nodes.add(node); }
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
    for (const leaf of filledLeaves(a)) {
      const found = q(leaf);
      const path = pathOf(found);
      if (!path) continue;
      const subpaths = polygonInData(path, root, sRaw);
      if (!subpaths) continue;
      const binding: ShapeBinding = { node: path, panel, from: sFrom, to: sTo, fits: sFits, subpaths };
      if (b && sRawB && opts?.targetRoot) {
        const key = found!.getAttribute("data-key") ?? path.getAttribute("data-key");
        const twin = (key ? bByKey.get(key) : undefined) ?? bById.get(leaf);
        const twinPath = twin ? pathOf(twin) : null;
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
    guides.push({ node, panel, axis: g.axis, value: g.value, endValue: targetData.get(leaf)?.value ?? g.value, origin: projectWith(rawFitA, g.value),
      end: projectWith(rawFitB, targetData.get(leaf)?.value ?? g.value), delta: g.axis.startsWith("x") ? { dx: 0 } : { dy: 0 }, leaf, kind });
  }
  return { series, guides, panels: [...panels.values()], shapes, interpolated: opts?.geometryInterpolated ?? false, axesInfo };
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
  const atRest = !!opts?.assetChange && (progress >= 1 && !view || progress <= 0 && !opts.fromView);
  // at rest with a view, an axis whose domain or scale changed gets ticks generated for the new
  // domain (its own scheme: nice 1·2·5 steps or decades) in place of the generated ones (F4)
  const reticked = !opts && !!view ? retick(root, plan, view) : new Set<Element>();
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
    const fade = atRest ? 1 : Number.isFinite(pixel) ? Math.max(0, Math.min(1, (pixel - lo) / ((hi - lo) * .04), (hi - pixel) / ((hi - lo) * .04))) : 0;
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
function retick(root: Element, plan: Projection, view: PlotView): Set<Element> {
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
    if (!patch?.domain && !patch?.scale) continue;
    const fit = panel.fits[axis], raw = panel.rawA[axis];
    if (!fit || !raw || (fit.m === raw.m && fit.c === raw.c && fit.log === raw.log)) continue;
    const panelId = [...(plan.axesInfo.keys())][Number(panelIndex)];
    const scheme = plan.axesInfo.get(panelId)?.[axis];
    const locator = scheme?.locator ?? "auto", formatter = scheme?.formatter ?? "plain";
    if (!["auto", "multiple", "log"].includes(locator) || !["plain", "log"].includes(formatter)) continue;
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
        const delta = pixel - tpl.origin;
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
