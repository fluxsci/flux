// An asset Change onto OTHER UNITS (owner deck 2026-10-25, slide "Plot Transforms": a paired meanmark on a log ratio axis became the same
// figure in percentage points on a linear axis, and "visually it is a mess"). Pure (linkedom), on real fluxplot output
// (fixtures/fluxplot03/make_meanmark_units.py). Pins the laws that fixed it (docs/SLIDE_TRANSFORMS.md, "The pixel law"):
//   - every projected mark walks the straight line between its two rest pixels (project.lerpPixel); a constant value's walk IS the
//     blended fit, so a view Change is unchanged;
//   - a mean dot is a marker: its bytes are kept (never a curve's control points chained into a polygon) and it is moved whole;
//   - a path is re-projected only when every command is an absolute M / L / C / Q / Z;
//   - the y ticks hand off when a shared tick index stands for another value in each version, matched in log units only when both
//     ends are log (the end's ticks at or below zero survive), and rest on each version's own ticks at t = 0 and t = 1; a category axis
//     whose categories keep their places is never pooled;
//   - a guide fades only by how far its tick has left the axis range (the first category's label stays).
import { readFileSync } from "node:fs";
import { DOMParser, parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { PlotView } from "../src/lib/types";
import { viewFits, projectWith, blendFit, lerpPixel, dataOfPixel, type Fit } from "../src/lib/plot/project";
import { applyPlotView, preparePlotView, restoreProjection, type PlotViewOptions } from "../src/lib/plot/projectDom";
import { preparePlot } from "../src/lib/plot/parse";
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const h = harness("verify-plot-units-change");
const load = (name: string) => {
  const base = new URL(`./fixtures/fluxplot03/${name}`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(`${base}.fluxplot.json`), "utf8")) as FluxPlotManifest;
  const svg = readFileSync(new URL(`${base}.svg`), "utf8");
  return { manifest, root: () => preparePlot(svg, manifest).root! };
};
const R = load("meanmark-ratio"), P = load("meanmark-pp");
const node = (root: Element, id: string) => root.querySelector(`[id="${id}"]`)!;
const pathD = (root: Element, id: string) => { const n = node(root, id); return (n.tagName.toLowerCase() === "path" ? n : n.querySelector("path"))!.getAttribute("d") ?? ""; };
const pathOf = (root: Element, id: string) => { const n = node(root, id); return (n.tagName.toLowerCase() === "path" ? n : n.querySelector("path"))! as SVGElement; };
const ys = (d: string) => { const v = (d.match(/-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number); return v.filter((_, i) => i % 2 === 1); };
const eff = (n: Element) => {
  let op = 1; for (let e: Element | null = n; e && e.tagName?.toLowerCase() !== "svg"; e = e.parentElement) {
    const st = (e as SVGElement).style; if (st?.display === "none") return 0; const o = st?.opacity; if (o) op *= Number(o);
  } return op;
};

h.section("the pixel law (project.lerpPixel)");
{
  const a: Fit = { m: -120, c: 400, log: true }, b: Fit = { m: -9, c: 60, log: false };
  h.ok(Math.abs(lerpPixel(a, b, 1.1, -4, .5) - (projectWith(a, 1.1) + projectWith(b, -4)) / 2) < 1e-9, "half-way is the midpoint of the two rest pixels");
  h.ok(lerpPixel(a, b, 1.1, -4, 0) === projectWith(a, 1.1) && lerpPixel(a, b, 1.1, -4, 1) === projectWith(b, -4), "the ends are the rests exactly");
  const c: Fit = { m: -11, c: 70, log: false };
  const blended = blendFit(b, c, .3);
  h.ok(Math.abs(lerpPixel(b, c, 2.5, 2.5, .3) - projectWith(blended, 2.5)) < 1e-9, "a value that does not change walks the blended fit (a view Change is unchanged)");
}

const opts = (from: typeof R, to: typeof P): PlotViewOptions => {
  const bSeries = new Map(to.manifest.series.map(s => [s.id, s]));
  return { t: 0, raw: 0, from: viewFits(from.manifest) ?? undefined, to: viewFits(to.manifest) ?? undefined, geometryInterpolated: true, assetChange: true,
    tickHandoff: true, toManifest: to.manifest, sourceRoot: from.root(), targetRoot: to.root(), series: (a) => bSeries.get(a.id) ?? null };
};

h.section("ratio (log) -> percentage points (linear): marks stay between their rests");
{
  const root = R.root(), o = opts(R, P), sA = R.root(), sB = P.root();
  preparePlotView(root, R.manifest, undefined, "", o);
  const frame = (t: number) => { o.t = t; o.raw = t; applyPlotView(root, R.manifest, undefined, "", o); };
  const arms = ["wake", "nrem", "rem"].flatMap(c => [`panel.main.${c}.error-low`, `panel.main.${c}.error-high`]);
  let inside = true, worst = 0;
  for (const t of [.1, .25, .5, .75, .9]) {
    frame(t);
    for (const id of arms) {
      const a = ys(pathD(sA, id)), b = ys(pathD(sB, id)), now = ys(pathD(root, id));
      now.forEach((y, i) => { const lo = Math.min(a[i], b[i]) - 1e-6, hi = Math.max(a[i], b[i]) + 1e-6; if (y < lo || y > hi) { inside = false; worst = Math.max(worst, lo - y, y - hi); } });
    }
  }
  h.ok(inside, `every error arm vertex stays between its two rest pixels in flight (worst excursion ${worst.toFixed(2)} px; data lerped through a lerped fit swung ~200 px)`);
  frame(.5);
  const id = "panel.main.nrem.error-high", a = ys(pathD(sA, id)), b = ys(pathD(sB, id)), mid = ys(pathD(root, id));
  h.ok(mid.every((y, i) => Math.abs(y - (a[i] + b[i]) / 2) < 1e-3), "half-way, an arm is the midpoint of its two rests");
  for (const c of ["wake", "nrem", "rem"]) {
    const d0 = pathD(sA, `panel.main.${c}.mean`), now = pathD(root, `panel.main.${c}.mean`);
    h.ok(now === d0 && /C/.test(now), `${c}: the mean dot keeps its own circle bytes (never its control points chained into a polygon)`);
    const tr = pathOf(root, `panel.main.${c}.mean`).style.getPropertyValue("translate");
    h.ok(!tr || /^0(\.0+)?px( 0(\.0+)?px)?$/.test(tr.replace(/-0\.00px/g, "0.00px")), `${c}: with no view the content binder moves it; the projection adds nothing (translate "${tr}")`);
  }
  // the y ticks: index pairing would put "1.1" on "-4"; handed off, the end's ticks at or below zero arrive
  h.ok(root.querySelectorAll('[data-projection-flight][id*="axis.y."]').length > 0, "the y axis is pooled (a shared tick index stands for another value in each version)");
  h.eq(root.querySelectorAll('[data-projection-flight][id*="axis.x."]').length, 0, "the category x axis is not (its categories keep their places)");
  frame(.9);
  const shown = Array.from(root.querySelectorAll('[data-projection-flight][id*="axis.y.ticklabel."]')).filter(n => eff(n) > .5).map(n => (n.textContent ?? "").trim());
  h.ok(shown.includes("−6") && shown.includes("−4"), `at t = .9 the end's ticks at or below zero are shown (${shown.join(" ")}; matched in log units they were dropped)`);
  const ownBytes = Array.from(root.querySelectorAll('[data-projection-flight][id*="axis.y.ticklabel."]')).filter(n => eff(n) > .5);
  frame(1 - 1e-9);
  h.ok(ownBytes.every(n => Math.abs(Number(/translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(n.getAttribute("transform") ?? "")?.[2] ?? 1)) < 1e-3),
    "at the last flight frame each arriving label is the end's own bytes at their own place (the identity: the rest paints the same)");
  for (const t of [0, 1]) {
    frame(t);
    h.eq(Array.from(root.querySelectorAll("[data-projection-flight]")).filter(n => eff(n) > 0).length, 0, `t = ${t}: no pooled tick is drawn (the version's own ticks rest)`);
  }
  frame(0);
  h.ok(Array.from(root.querySelectorAll('[id*="axis.y.ticklabel."]')).filter(n => eff(n) > .5).map(n => (n.textContent ?? "").trim()).join(" ") === "0.9 1 1.1", "t = 0: the start's own y labels");
  frame(.5);
  const first = node(root, "panel.main.axis.x.ticklabel.0");
  h.ok(eff(first) > .999, "half-way, the first category's label is fully shown (a guide fades only once its tick leaves the range)");
  restoreProjection(root);
}

h.section("a view on the ratio plot: the mean dot is moved whole, the arms re-projected");
{
  const root = R.root(), view: PlotView = { y: { domain: [0.95, 1.12] } };
  const o: PlotViewOptions = { t: 1, from: viewFits(R.manifest) ?? undefined, to: viewFits(R.manifest, view) ?? undefined, geometryInterpolated: true, assetChange: false, tickHandoff: true };
  preparePlotView(root, R.manifest, view, "", o);
  applyPlotView(root, R.manifest, view, "", o);
  const raw = viewFits(R.manifest)!.y, zoom = viewFits(R.manifest, view)!.y, pristine = R.root();
  const d0 = pathD(pristine, "panel.main.nrem.mean"), dot = pathOf(root, "panel.main.nrem.mean");
  h.ok(pathD(root, "panel.main.nrem.mean") === d0, "the dot's bytes are untouched (its size is a marker's, in points)");
  const centre = (d: string) => { const y = ys(d); return (Math.min(...y) + Math.max(...y)) / 2; };
  const moved = Number(/([-\d.]+)px$/.exec(dot.style.getPropertyValue("translate"))?.[1] ?? NaN);
  const want = projectWith(zoom, dataOfPixel(raw, centre(d0))) - centre(d0);
  h.ok(Math.abs(moved - want) < 0.05, `it is translated to its centre's new pixel (${moved.toFixed(2)} vs ${want.toFixed(2)} px)`);
  const arm = ys(pathD(root, "panel.main.nrem.error-high")), armRaw = ys(pathD(pristine, "panel.main.nrem.error-high"));
  h.ok(arm.every((y, i) => Math.abs(y - projectWith(zoom, dataOfPixel(raw, armRaw[i]))) < 1e-3), "each arm vertex is re-projected through the view's fit");
  restoreProjection(root);
}
await h.done();
