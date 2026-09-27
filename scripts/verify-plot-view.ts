// Real fluxplot fixtures through the shared applier, mutation and tween paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser, parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { PlotView, SemanticPlotElement, Project } from "../src/lib/types";
import { viewFits, projectWith, dataOfPixel, blendFit, seriesVertices, projectSeries, guideData, seriesAxes, seriesTweenable, plotViewIssues } from "../src/lib/plot/project";
import { applyPlotView, restoreProjection, preparePlotView } from "../src/lib/plot/projectDom";
import { preparePlot, prefixIds } from "../src/lib/plot/parse";
import { setPlotView } from "../src/lib/ops";
import { applyState, diffState, lerpElement, contentPlan } from "../src/lib/slide/tween";
import { listMorphCandidates } from "../src/lib/slide/autobuild";
import { compileSlide } from "../src/lib/slide/compile";
import { compensatePtTrue, restorePtTrue, svgIntrinsicPx } from "../src/lib/plot/compensate";
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const h = harness("verify-plot-view");
const load = (name: string, folder = "plots") => {
  const base = new URL(`./fixtures/${folder}/${name}`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(`${base}.fluxplot.json`), "utf8")) as FluxPlotManifest;
  const svg = readFileSync(new URL(`${base}.svg`), "utf8");
  return { manifest, svg, root: () => preparePlot(svg, manifest).root! };
};
const sine = load("mpl_sine_waves_FLUXPLOT"), scatter = load("mpl_scatter_FLUXPLOT"), bars = load("mpl_bars_FLUXPLOT");
const zoom: PlotView = { x: { domain: [2, 4] } };
const fits = viewFits(sine.manifest, zoom)!;
const sourceFits = viewFits(sine.manifest)!;
const near = (a: number, b: number, msg: string, eps = 1e-5) => h.ok(Number.isFinite(a) && Math.abs(a - b) < eps, `${msg}: ${a} ≈ ${b}`);
const xy = (root: Element, id: string) => (root.querySelector(`[id="${id}"] path`)?.getAttribute("d") ?? root.querySelector(`[id="${id}"]`)?.getAttribute("d") ?? "").match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);

h.section("line projection and original-anchor inverse");
const root = sine.root();
const originalGuides = guideData(sine.manifest, root);
applyPlotView(root, sine.manifest, zoom, "");
const v = seriesVertices(sine.manifest.series[0])[0];
// Hand-computed from the real manifest's first/last x anchors, independent of viewFits.
const expectedX = 21.0802 + (v.x - 2) * (356.9998 - 21.0802) / 2;
near(xy(root, "2hz.line")[0], expectedX, "zoomed vertex from manifest anchors");
near(xy(root, "2hz.line")[0], projectWith(fits.x, v.x), "line agrees with shared fit");
near(dataOfPixel(sourceFits.x, projectWith(sourceFits.x, 3)), 3, "linear inverse");

h.section("scatter markers, bare and prefixed roots");
const point = scatter.manifest.series[0].points![17], scatterFits = viewFits(scatter.manifest, zoom)!;
for (const id of ["", "placed"] as const) {
  const r = scatter.root(); if (id) prefixIds(r, id);
  applyPlotView(r, scatter.manifest, zoom, id);
  const n = r.querySelector(`[id="${id ? `${id}__` : ""}${point.svgId}"]`)! as SVGElement;
  const dx = parseFloat(n.style.getPropertyValue("translate"));
  near(projectWith(viewFits(scatter.manifest)!.x, point.x) + dx, projectWith(scatterFits.x, point.x), "marker translated to projected datum", .00501);
}

h.section("guide motion and edge fade");
const guide = [...originalGuides].find(([id, g]) => id.includes("axis.x.tick.") && g.value > 2.8 && g.value < 3.2)!;
const guideNode = root.querySelector(`[id="${guide[0]}"]`)! as SVGElement;
const delta = Number((guideNode.getAttribute("transform") ?? "").match(/translate\(([-\d.]+)/)?.[1] ?? NaN);
near(projectWith(sourceFits.x, guide[1].value) + delta, projectWith(fits.x, guide[1].value), "guide moves by its recovered data value");
const outside = [...originalGuides].find(([id, g]) => id.includes("axis.x.tick.") && g.value < 1)!;
h.ok((root.querySelector(`[id="${outside[0]}"]`)! as SVGElement).style.opacity === "0", "outside tick fades to zero");
const label = [...originalGuides].find(([id]) => id === guide[0].replace(".tick.", ".ticklabel."))!;
near(label[1].value, guide[1].value, "tick and transformed label recover the same datum");

h.section("restoration, real compensation and no frame selectors");
const bytes = root.toString();
for (let i = 0; i < 3; i++) { restoreProjection(root); applyPlotView(root, sine.manifest, zoom, ""); h.ok(root.toString() === bytes, `restore/reapply cycle ${i + 1} is byte-identical`); }
const pristine = sine.root(), untouched = pristine.toString();
applyPlotView(pristine, sine.manifest, undefined, ""); h.ok(pristine.toString() === untouched, "absent view is a byte no-op");
const compensated = sine.root(), intrinsic = svgIntrinsicPx(compensated);
preparePlotView(compensated, sine.manifest, zoom, "");
let compensatedBytes = "";
for (let i = 0; i < 4; i++) {
  restorePtTrue(compensated); restoreProjection(compensated);
  applyPlotView(compensated, sine.manifest, zoom, "");
  compensatePtTrue(compensated, { elW: 200, elH: 100, contentScale: 1.3, intrinsic });
  if (!i) compensatedBytes = compensated.toString(); else h.ok(compensated.toString() === compensatedBytes, "projection + pt-true does not compound");
}
const oldQuery = root.querySelector;
root.querySelector = () => { throw new Error("selector on frame path"); };
applyPlotView(root, sine.manifest, zoom, ""); root.querySelector = oldQuery;
h.ok(root.toString() === bytes, "bound application needs no selectors");

h.section("log switch and explicit invalid-data issue");
const positive = structuredClone(sine.manifest);
for (const s of positive.series) s.data!.y = s.data!.y.map(y => y === null ? null : y + 2);
positive.axes[0].y.domain = [.9, 3.1]; positive.axes[0].y.anchors = [{ data: .9, svg: 92.3074 }, { data: 3.1, svg: 3.0002 }];
const logView: PlotView = { y: { scale: "log" } }, logFits = viewFits(positive, logView)!;
const logRoot = sine.root(); applyPlotView(logRoot, positive, logView, "");
near(xy(logRoot, "2hz.line")[1], projectWith(logFits.y, positive.series[0].data!.y[0]!), "positive data projects through log fit");
near(dataOfPixel(logFits.y, projectWith(logFits.y, 2)), 2, "log inverse");
const mid = blendFit(viewFits(positive)!.y, logFits.y, .5);
near(projectWith(mid, 2), (projectWith(viewFits(positive)!.y, 2) + projectWith(logFits.y, 2)) / 2, "scale switch continuously blends projection functions");
near(dataOfPixel(mid, projectWith(mid, 2)), 2, "mixed-fit inverse");
const invalid = structuredClone(positive); invalid.series[0].data!.y[0] = 0;
const invalidRoot = sine.root(), originalLine = xy(invalidRoot, "2hz.line").join();
applyPlotView(invalidRoot, invalid, logView, "");
h.ok(xy(invalidRoot, "2hz.line").join() === originalLine, "non-positive series is refused, never written as NaN");
h.ok(plotViewIssues(invalid, logView).some(x => x.includes("non-positive")), "refused log series has a documented issue");

h.section("filled marks stay unchanged");
const barRoot = bars.root(), barIds = bars.manifest.series[0].svg.bars!;
const barBytes = barIds.map(id => barRoot.querySelector(`[id="${id}"]`)!.toString());
applyPlotView(barRoot, bars.manifest, { y: { domain: [2, 4] } }, "");
h.ok(barIds.every((id, i) => barRoot.querySelector(`[id="${id}"]`)!.toString() === barBytes[i]), "bar paths are untouched");
h.ok(plotViewIssues(bars.manifest, zoom).some(x => x.includes("filled marks")), "filled-mark limitation is explicit");

h.section("model merge/delete, shallow state capture and interpolation");
const el: SemanticPlotElement = { id: "p", type: "plot", assetId: "sine", x: 0, y: 0, width: 480, height: 144, rotation: 0 };
const project = { figures: [{ elements: [el] }] } as Project;
setPlotView(project, "p", zoom); const firstView = el.view;
setPlotView(project, "p", { y: { domain: [1, 10], scale: "log" } });
h.ok(el.view !== firstView && el.view?.x?.domain?.join() === "2,4", "copy-on-write merge preserves the other axis");
setPlotView(project, "p", { y: { domain: [2, 20] } });
h.ok(el.view?.y?.scale === "log", "domain patch preserves scale");
setPlotView(project, "p", { x: { domain: sine.manifest.axes[0].x.domain } }, sine.manifest.axes[0]);
h.ok(!el.view?.x && !!el.view?.y, "generator domain prunes only the default axis");
setPlotView(project, "p", { y: {} }); h.ok(!el.view, "empty axis resets the view to absence");
setPlotView(project, "p", zoom); setPlotView(project, "p", null); h.ok(!el.view, "null resets the view");
const a = { ...el, view: { x: { domain: [0, 10] as [number, number] }, y: { domain: [1, 100] as [number, number], scale: "log" as const } } };
const b = { ...el, view: { x: { domain: [2, 4] as [number, number] }, y: { domain: [100, 10000] as [number, number], scale: "log" as const } } };
const halfway = lerpElement(a, b, .5) as SemanticPlotElement;
assert.deepEqual(halfway.view!.x!.domain, [1, 7]); h.ok(true, "linear domain ends interpolate");
near(halfway.view!.y!.domain![0], 10, "log domain midpoint"); near(halfway.view!.y!.domain![1], 1000, "log upper midpoint");
assert.deepEqual(applyState(a, diffState(a, b)), b); h.ok(true, "diffState/applyState capture view shallowly");
assert.deepEqual((applyState(a, { view: zoom }) as SemanticPlotElement).view, zoom); h.ok(true, "state view replaces the complete property");
h.ok(contentPlan(a, b).contentDirty && contentPlan(a, b).geometryDirty, "view dirties content and geometry");

h.section("panel ownership and per-series eligibility");
const pa = load("panels-a", "fluxplot03"), pb = load("panels-b", "fluxplot03");
for (const s of pa.manifest.series) {
  const other = pb.manifest.series.find(x => x.id === s.id)!;
  h.ok(seriesTweenable(s, other, seriesAxes(pa.manifest, s), seriesAxes(pb.manifest, other)), `shared series ${s.id} tweens despite different ticks`);
}
h.ok(listMorphCandidates(pa.manifest, [{ assetId: "b", manifest: pb.manifest }])[0].compatible, "candidate picker accepts at least one shared tweenable series");
const partially = structuredClone(pb.manifest); partially.series[0].capabilities = { dataMorph: false };
const diagnostics = compileSlide({ id: "s", elements: [el], beats: [{ id: "base", tracks: [] }, { id: "change", tracks: [{ id: "t", target: "p", preset: "transform", to: { assetId: "b" } }] }] }, undefined, { plotManifest: id => id === "sine" ? pa.manifest : partially }).issues;
h.ok(diagnostics.some(i => i.reason.includes(`Series ‹${partially.series[0].id}›`) && i.reason.includes("crossfades")), "compiler reports incompatible series individually");
const sampled = projectSeries(sine.manifest.series[0], null, sourceFits, fits, .5);
near(sampled[0].x, projectWith(blendFit(sourceFits.x, fits.x, .5), v.x), "view-only sample equals blended fit");
h.section("canvas view invalidation and authored dashes");
const { cachePlot } = await import("../src/lib/plot/store");
const { mountPlot } = await import("../src/lib/plot/mount");
cachePlot("sine", sine.svg, sine.manifest);
const canvasHost = document.createElementNS("http://www.w3.org/2000/svg", "g") as unknown as SVGGElement;
const canvasElement = { ...el };
const action = mountPlot(canvasHost, { element: canvasElement });
const initialSvg = canvasHost.firstElementChild;
setPlotView({ figures: [{ elements: [canvasElement] }] } as Project, "p", zoom);
action.update({ element: canvasElement });
h.ok(initialSvg !== canvasHost.firstElementChild, "view change invalidates canvas content even when the element object is retained");
near(xy(canvasHost, "p__2hz.line")[0], expectedX, "canvas mount applies data view");
const dashed = sine.root();
const dashedLine = dashed.querySelector('[id="2hz.line"] path')! as SVGElement;
dashedLine.style.strokeDasharray = "2 3";
applyPlotView(dashed, sine.manifest, zoom, "");
h.ok(dashedLine.style.strokeDasharray === "2 3", "static view preserves authored line dashes");
action.destroy();

h.section("one player writer for data plus view, and chained reverse seeks");
const { createDeck, addSlide, addElement, addBeat, setTransform } = await import("../src/lib/slide/ops");
const { createPlayer } = await import("../src/lib/slide/player/player");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const mb = structuredClone(sine.manifest), rb = sine.root();
for (const s of mb.series) {
  s.data!.y = s.data!.y.map(v => v === null ? null : v * .5 + .25);
  const projected = projectSeries(s, null, viewFits(mb)!, viewFits(mb)!, 1);
  rb.querySelector(`[id="${s.svg.line}"] path`)!.setAttribute("d", projected.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" "));
}
cachePlot("sine-b", rb.toString(), mb);
const deck = createDeck({ withTitleSlide: false }), slide = addSlide(deck, { layout: "blank" });
const preView: PlotView = { x: { domain: [1, 4] } };
addElement(deck, slide.id, { ...el, view: preView });
const beat = addBeat(deck, slide.id)!;
setTransform(deck, slide.id, beat.id, el.id, { toAssetId: "sine-b", state: { view: zoom, x: 100, width: 600 }, duration: 1000, easing: "linear" });
const returnBeat = addBeat(deck, slide.id)!;
setTransform(deck, slide.id, returnBeat.id, el.id, { toAssetId: "sine", state: { view: null }, duration: 1000, easing: "linear" });
const host = document.createElement("div") as unknown as HTMLElement;
const player = createPlayer(host, deck, { theme: FLUX_DARK, reducedMotion: true, plotManifest: id => id === "sine" ? sine.manifest : mb });
for (const [beat, time] of [[1, 500], [2, 500], [2, 1000], [1, 0], [1, 500]]) {
  player.seek(0, beat, time);
  const expected = beat === 1 ? projectSeries(sine.manifest.series[0], mb.series[0], viewFits(sine.manifest, preView)!, viewFits(mb, zoom)!, time / 1000)[0]
    : projectSeries(mb.series[0], sine.manifest.series[0], viewFits(mb, zoom)!, viewFits(sine.manifest)!, time / 1000)[0];
  const actual = xy(host, "p__2hz.line");
  near(actual[0], expected.x, `data+view step ${beat} at ${time}ms x`);
  near(actual[1], expected.y, `data+view step ${beat} at ${time}ms y`);
}
player.destroy();
h.section("a fixed data view keeps the box-only fast path");
const moveDeck = createDeck({ withTitleSlide: false }), moveSlide = addSlide(moveDeck, { layout: "blank" });
addElement(moveDeck, moveSlide.id, { ...el, view: zoom });
const moveBeat = addBeat(moveDeck, moveSlide.id)!;
setTransform(moveDeck, moveSlide.id, moveBeat.id, el.id, { state: { x: 100 }, duration: 1000, easing: "linear" });
const mover = createPlayer(host, moveDeck, { theme: FLUX_DARK, reducedMotion: true, plotManifest: () => sine.manifest });
const fixedLine = host.querySelector('[id="p__2hz.line"] path')!;
const setAttribute = fixedLine.setAttribute.bind(fixedLine);
let lineWrites = 0;
fixedLine.setAttribute = (name, value) => { lineWrites++; setAttribute(name, value); };
mover.seek(0, 1, 500);
h.ok(lineWrites === 0, "moving an unchanged view never rewrites plot geometry");
mover.destroy();
await h.done();
