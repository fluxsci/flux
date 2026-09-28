// Real fluxplot fixtures through the shared applier, mutation and tween paths.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser, parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { PlotView, SemanticPlotElement, Project } from "../src/lib/types";
import { viewFits, projectWith, dataOfPixel, blendFit, seriesVertices, projectSeries, guideData, seriesAxes, seriesTweenable, plotViewIssues, hasTweenableSeries } from "../src/lib/plot/project";
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
h.section("spring data and view channels through the real player");
beat.tracks[0].curve = { kind: "spring", bounce: .8 };
// Observe the writer's input before its own defensive clamp. The probe bundles
// the production player unchanged, adding only a call-boundary observation.
const { build } = await import("esbuild");
const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join, dirname } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const probeDir = await mkdtemp(join(tmpdir(), "flux-view-curve-"));
const observed: number[] = [];
(globalThis as any).__viewProgress = observed;
const probeBundle = await build({ stdin: { contents: 'export { createPlayer } from "./src/lib/slide/player/player";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", plugins: [{ name: "observe-view-input", setup(build) {
    build.onLoad({ filter: /projectDom\.ts$/ }, ({ path }) => {
      const source = readFileSync(path, "utf8"), marker = "export function applyPlotView(";
      const start = source.indexOf(marker), at = source.indexOf("\n", start);
      assert.ok(start >= 0 && at > start, "projection observer binds the real writer");
      return { contents: source.slice(0, at) + '\n  if (opts) (globalThis as any).__viewProgress.push(opts.t);' + source.slice(at), loader: "ts", resolveDir: dirname(path) };
    });
  } }] });
const probeFile = join(probeDir, "player.mjs"); await writeFile(probeFile, probeBundle.outputFiles[0].text);
const { createPlayer: observedPlayer } = await import(pathToFileURL(probeFile).href);
const springPlayer = observedPlayer(host, deck, { theme: FLUX_DARK, reducedMotion: true, plotRoot: (id: string) => id === "sine" ? sine.root() : rb, plotManifest: (id: string) => id === "sine" ? sine.manifest : mb });
const { resolveCurve } = await import("../src/lib/slide/curves");
const curve = resolveCurve(beat.tracks[0]);
let clampedView = true, reachedClamp = false;
for (let i = 0; i < 60; i++) {
  const raw = i / 59, t = curve.clamped(raw);
  springPlayer.seek(0, 1, raw * 1000);
  const expected = projectSeries(sine.manifest.series[0], mb.series[0], viewFits(sine.manifest, preView)!, viewFits(mb, zoom)!, t)[0];
  const actual = xy(host, "p__2hz.line");
  clampedView &&= t >= 0 && t <= 1 && Math.abs(actual[0] - expected.x) < 1e-5 && Math.abs(actual[1] - expected.y) < 1e-5;
  reachedClamp ||= curve.fn(raw) > 1 && Math.abs(actual[0] - expected.x) < 1e-5;
}
h.ok(clampedView && reachedClamp && observed.length >= 60 && observed.every(t => t >= 0 && t <= 1), "60 spring(.8) player samples pass only clamped data/view progress to the projection writer");
springPlayer.destroy(); delete (globalThis as any).__viewProgress; await rm(probeDir, { recursive: true, force: true });
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
h.section("authored paint survives projected frames at a non-intrinsic size");
// The driver binds neutral (intrinsic-size) endpoint renders against the live,
// pt-compensated plot, so a style string equal at both endpoints still differs
// from the live node and gets a binding. That constant must be written back
// verbatim: re-stringifying its "numbers" turned stroke #4169e1 into #41690 (the
// line vanished mid-flight, 2026-09-27 QA screenshot). 720x216 = 1.5x intrinsic.
const authored = sine.root().querySelector('[id="2hz.line"] path')!.getAttribute("style")!;
h.ok(authored.includes("#4169e1"), "fixture line is authored with stroke #4169e1");
for (const [label, patch] of [["view Change", { state: { view: zoom } }], ["data Become", { toAssetId: "sine-b" }]] as const) {
  const paintDeck = createDeck({ withTitleSlide: false }), paintSlide = addSlide(paintDeck, { layout: "blank" });
  addElement(paintDeck, paintSlide.id, { ...el, width: 720, height: 216 });
  const paintBeat = addBeat(paintDeck, paintSlide.id)!;
  setTransform(paintDeck, paintSlide.id, paintBeat.id, el.id, { ...patch, duration: 1000, easing: "linear" });
  const painter = createPlayer(host, paintDeck, { theme: FLUX_DARK, reducedMotion: true, plotManifest: id => id === "sine" ? sine.manifest : mb });
  const styles: string[] = [];
  for (const time of [250, 500, 750]) { painter.seek(0, 1, time); styles.push(host.querySelector('[id="p__2hz.line"] path')!.getAttribute("style") ?? ""); }
  h.ok(styles.every(s => /(^|;)\s*stroke:\s*#4169e1\s*(;|$)/.test(s)), `${label}: the line keeps its authored stroke colour mid-flight (${styles[1]})`);
  painter.destroy();
}
h.section("one SVG transform reader");
// B1 landed plot/svgMatrix.ts as the shared SVG affine reader (targetGeometry uses it).
// Guide recovery must read ancestor transforms through it, not a second parser.
const projectSource = readFileSync(new URL("../src/lib/plot/project.ts", import.meta.url), "utf8");
h.ok(/from "\.\/svgMatrix"/.test(projectSource) && /transformToAncestor\(/.test(projectSource) && !/skew[XY]/i.test(projectSource),
  "plot/project.ts reads guide ancestor transforms through plot/svgMatrix (no second transform parser)");
h.section("manifests without series keep the base behaviour");
// A custom/legacy manifest may carry no series or axes (verify-v020-slide-paint's
// compound-hole plot). The retired morphCompatible answered false for it; the
// transform driver never read its series. Neither may throw now.
const bare = { specVersion: "1.0.0", plotType: "custom", size: { width: 200, height: 200 }, parts: [] } as unknown as FluxPlotManifest;
const noThrow = (fn: () => unknown) => { try { return { value: fn() }; } catch (e) { return { error: String(e) }; } };
const eligibility = noThrow(() => [hasTweenableSeries(bare, sine.manifest), hasTweenableSeries(sine.manifest, bare), listMorphCandidates(bare, [{ assetId: "sine", manifest: sine.manifest }])[0].compatible]);
h.ok(!("error" in eligibility) && (eligibility.value as boolean[]).every(v => v === false), `a series-less manifest is never tweenable and never throws (${JSON.stringify(eligibility)})`);
const holeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><path id="ring-shape" fill="#f00" d="M0 0H200V200H0Z"/></svg>';
cachePlot("bare-art", holeSvg, bare);
const bareDeck = createDeck({ withTitleSlide: false }), bareSlide = addSlide(bareDeck, { layout: "blank" });
addElement(bareDeck, bareSlide.id, { id: "bare", type: "plot", assetId: "bare-art", x: 100, y: 100, width: 200, height: 200, rotation: 0 });
const bareBeat = addBeat(bareDeck, bareSlide.id)!;
setTransform(bareDeck, bareSlide.id, bareBeat.id, "bare", { state: { x: 300, width: 300, height: 300 }, duration: 1000, easing: "linear" });
const bareRun = noThrow(() => { const p = createPlayer(host, bareDeck, { theme: FLUX_DARK, reducedMotion: true, plotManifest: () => bare }); p.seek(0, 1, 500); p.destroy(); });
h.ok(!("error" in bareRun), `a frame Change of a series-less plot plays through the real player (${JSON.stringify(bareRun)})`);
await h.done();
