// The one attribute writer for static plot views and animated data/view changes.
// All identities, fits and guide values bind once; frames reuse numeric buffers.
import type { PlotView } from "../types";
import type { FluxPlotManifest, FluxPlotSeries } from "./types";
import { partDomId } from "./parse";
import { axisFit, blendFit, guideAxes, guideData, pairVertices, projectWith, sampleSeries,
  seriesAxes, seriesVertices, seriesTweenable, viewFits, lerpData, type Fit, type Fits, type MorphPoint } from "./project";

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
/** Restore only the fields projection wrote. Compensation must be restored first. */
export function restoreProjection(root: Element): void {
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
}
interface Panel {
  from: Fits; to: Fits; rawA: Fits; rawB: Fits;
  fits: Fits;
  xRange: [number, number]; yRange: [number, number];
  xEndRange: [number, number]; yEndRange: [number, number];
}
interface SeriesBinding {
  panel: Panel;
  pairs: ReturnType<typeof pairVertices>;
  vertices: MorphPoint[];
  line: Element | null;
  topology?: { a: MorphPoint[]; b: MorphPoint[]; common: MorphPoint[][];
    outgoing: Element; incoming: Element; paint: string[]; aRuns: MorphPoint[][]; bRuns: MorphPoint[][] };
  markers: { node: Element; vertex: number; ox: number; oy: number; ex: number; ey: number }[];
}
interface GuideBinding {
  node: Element; panel: Panel; axis: "x" | "y"; value: number; endValue: number;
  origin: number; end: number; delta: { dx?: number; dy?: number };
}
interface Projection {
  series: SeriesBinding[]; guides: GuideBinding[]; panels: Panel[];
  interpolated: boolean;
}
interface CachedProjection { manifest: FluxPlotManifest; view: PlotView | undefined; opts: PlotViewOptions | undefined; plan: Projection }
const plans = new WeakMap<Element, CachedProjection[]>();

function bind(root: Element, manifest: FluxPlotManifest, view: PlotView | undefined, elId: string, opts?: PlotViewOptions): Projection {
  if (!manifest.axes?.length || !manifest.series?.length || opts?.toManifest && (!opts.toManifest.axes?.length || !opts.toManifest.series?.length)) return { series: [], guides: [], panels: [], interpolated: false };
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
  for (const ax of manifest.axes ?? []) {
    const rawA = viewFits(manifest, undefined, ax.panelId);
    const rawB = viewFits(opts?.toManifest ?? manifest, undefined, ax.panelId);
    const from = (manifest.axes.length === 1 ? opts?.from : undefined) ?? viewFits(manifest, opts?.fromView, ax.panelId);
    const to = (manifest.axes.length === 1 ? opts?.to : undefined) ?? viewFits(opts?.toManifest ?? manifest, view, ax.panelId);
    const endAxes = (opts?.toManifest ?? manifest).axes.find(a => a.panelId === ax.panelId);
    if (!rawA || !rawB || !from || !to || !endAxes) continue;
    const range = (key: "x" | "y", axes = ax): [number, number] => {
      const fit = axisFit(axes[key]);
      return [projectWith(fit, axes[key].domain[0]), projectWith(fit, axes[key].domain[1])];
    };
    panels.set(ax.panelId, { from, to, rawA, rawB, fits: { x: { ...from.x }, y: { ...from.y } },
      xRange: range("x"), yRange: range("y"), xEndRange: range("x", endAxes), yEndRange: range("y", endAxes) });
  }
  const series: SeriesBinding[] = [];
  for (const a of manifest.series ?? []) {
    const panel = panels.get(a.panelId), b = opts?.series?.(a) ?? null;
    if (!panel || a.rasterized || a.capabilities?.dataMorph === false || a.roles?.some(r => !["line", "point"].includes(r))) continue;
    if (opts?.series && (!b || !seriesTweenable(a, b, seriesAxes(manifest, a), seriesAxes(opts.toManifest ?? manifest, b)))) continue;
    const pairs = pairVertices(a, b);
    if (!pairs.length || pairs.some(p =>
      (panel.from.x.log || panel.to.x.log) && (p.a.x <= 0 || p.b.x <= 0) ||
      (panel.from.y.log || panel.to.y.log) && (p.a.y <= 0 || p.b.y <= 0))) continue;
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
      const rawStart = aPoints.has(p.svgId) ? panel.rawA : panel.rawB;
      markers.push({ node, vertex, ox: projectWith(rawStart.x, start.x), oy: projectWith(rawStart.y, start.y),
        ex: projectWith(panel.rawB.x, end.x), ey: projectWith(panel.rawB.y, end.y) });
    }
    const binding: SeriesBinding = { panel, pairs, vertices: pairs.map(p => ({ ...p.a })), line, markers };
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
  const guides: GuideBinding[] = [];
  const data = guideData(manifest, opts?.sourceRoot ?? root, opts?.sourceRoot ? "" : elId);
  const targetData = opts?.targetRoot ? guideData(opts.toManifest ?? manifest, opts.targetRoot) : data;
  for (const [leaf, g] of new Map([...targetData, ...data])) {
    const axes = guideAxes(manifest, leaf), panel = panels.get(axes?.panelId), node = q(leaf);
    if (!axes || !panel || !node) continue;
    reserve(node, ["transform"], ["opacity"]);
    guides.push({ node, panel, axis: g.axis, value: g.value, endValue: targetData.get(leaf)?.value ?? g.value, origin: projectWith((data.has(leaf) ? panel.rawA : panel.rawB)[g.axis], g.value),
      end: projectWith(panel.rawB[g.axis], targetData.get(leaf)?.value ?? g.value), delta: g.axis === "x" ? { dx: 0 } : { dy: 0 } });
  }
  return { series, guides, panels: [...panels.values()], interpolated: opts?.geometryInterpolated ?? false };
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
  }
  for (const s of plan.series) {
    sampleSeries(s.pairs, s.panel.from, s.panel.to, t, s.vertices, s.panel.fits);
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
  const progress = opts?.raw ?? t;
  const atRest = !!opts?.assetChange && (progress >= 1 && !view || progress <= 0 && !opts.fromView);
  for (const g of plan.guides) {
    const p = g.panel, fit = p.fits[g.axis], raw = p.rawA[g.axis];
    // Unchanged guides keep their original bytes, including ticks at the edge.
    if (fit.m === raw.m && fit.c === raw.c && fit.log === raw.log && fit.linear === undefined && (!plan.interpolated || g.origin === g.end)) continue;
    const pixel = projectWith(fit, lerpData(g.value, g.endValue, t, p.from[g.axis].log && p.to[g.axis].log));
    const a = g.axis === "x" ? p.xRange : p.yRange, b = g.axis === "x" ? p.xEndRange : p.yEndRange;
    const edge0 = a[0] + (b[0] - a[0]) * t, edge1 = a[1] + (b[1] - a[1]) * t;
    const lo = Math.min(edge0, edge1), hi = Math.max(edge0, edge1);
    const fade = atRest ? 1 : Number.isFinite(pixel) ? Math.max(0, Math.min(1, (pixel - lo) / ((hi - lo) * .04), (hi - pixel) / ((hi - lo) * .04))) : 0;
    g.delta[g.axis === "x" ? "dx" : "dy"] = Number.isFinite(pixel) ? pixel - (g.origin + (plan.interpolated ? (g.end - g.origin) * t : 0)) : 0;
    writeGuide(g.node, g.delta, fade);
  }
}
