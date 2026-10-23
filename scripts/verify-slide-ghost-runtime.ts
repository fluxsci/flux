#!/usr/bin/env -S npx tsx
import assert from "node:assert/strict";
import { parseHTML, DOMParser } from "linkedom";
import { ghostFixture } from "./lib/ghostFixture";
import type { Slide } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const { compileSlide, ghostTargetIds } = await import("../src/lib/slide/compile");
const { createPlayer } = await import("../src/lib/slide/player/player");
const { createDeck } = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const { cachePlot } = await import("../src/lib/plot/store");
let checks = 0;
const check = (v: unknown, label: string) => { assert.ok(v, label); checks++; console.log("  ok:", label); };
const near = (a: number, b: number) => Math.abs(a - b) < .00001;
const slide = ghostFixture(), saved = JSON.stringify(slide), compiled = compileSlide(slide);
check(JSON.stringify(slide) === saved, "compilation never rewrites canonical fallback elements");
check(compiled.issues.length === 0, "valid independent and chained ghosts have no diagnostics");
check(ghostTargetIds(slide).join() === "g1,g2,child", "Design can exclude every ghost independently of ordinary hidden objects");
check(compiled.sample(1).presentation.unbornElementIds?.length === 3, "all copies are unborn before the birth step");
check(compiled.sample(2, 99).presentation.unbornElementIds?.join() === "g1,child", "each result respects its independent birth delay");
check(compiled.sample(2, 100).presentation.unbornElementIds?.join() === "child", "copy is born exactly at its delayed start");
check(compiled.preState("g1", 2)?.x === 110 && near(compiled.preState("g1", 2)?.opacity ?? 0, .18), "birth captures prior Change, appearance movement and authored opacity times dim");
check(compiled.preState("g1", 2)?.name === "First copy", "resolved copy retains its own authoring identity");
check(compiled.preState("child", 3)?.x === 310, "chained ghost starts from parent endpoint before same-step parent Change");
check(compiled.sample(2, 600).elements.find(e => e.id === "g1")?.x === 210, "inspected midpoint uses captured source, not saved fallback or simultaneous source move");
const deck = createDeck({ withTitleSlide: false }); deck.slides = [slide]; deck.defaults.transition = "none";
const host = document.createElement("div") as unknown as HTMLElement;
const player = createPlayer(host, deck, { theme: FLUX_DARK, reducedMotion: true });
const node = (id: string) => host.querySelector(`[data-el-id="${id}"]`) as HTMLElement;
const first = node("g1"), child = first.firstElementChild;
check(first.style.visibility === "hidden", "offline/runtime Design hides copied fallback geometry");
player.seek(0, 2, 600);
check(first.style.visibility === "visible" && first.style.transform.includes("translate(100px, 30px)") && near(Number(first.style.opacity), .18), "runtime midpoint matches effective captured pose and inherited style");
player.seek(0, 3, 500);
check(node("child").style.transform.includes("translate(100px, 0px)"), "direct later seek starts chained ghost at correct parent endpoint");
player.seek(0, 2, 99); check(first.style.visibility === "hidden", "reverse seek before birth removes the copy");
player.seek(0, 2, 1100); check(first.style.left === "310px", "reverse then forward seek restores exact endpoint");
check(first === node("g1") && child === first.firstElementChild, "direct and reverse seeks retain the same result and content nodes");
// R2 F2, the Ghost law: a copy's ink is not doubled while it coincides with its source. Two layers of the same anti-aliased glyphs read
// 1 - (1 - c)^2 on an edge pixel (bolder: 22.6 stage px^2 on the compositor on the frame a text copy was born), so the copy's own ink EMERGES with its
// separation from the source: invisible on the birth frame, fully drawn once it has left by a stroke width or so.
{
  const { ghostSeparation, ghostEmergeSpan, ghostEmergence } = await import("../src/lib/slide/ghost");
  const rect = (x: number, y: number, extra: Record<string, unknown> = {}) => ({ id: "r", type: "rect", x, y, width: 60, height: 40, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0, ...extra }) as never;
  check(ghostSeparation(rect(10, 20), rect(10, 20)) === 0 && near(ghostSeparation(rect(10, 20), rect(40, 60)), 50), "separation: the largest corner travel (a 30 x 40 move is 50)");
  check(ghostSeparation(rect(10, 20), rect(10, 20, { rotation: 90 })) > 9, "separation: a turn in place separates the copy (a 60 x 40 box turned 90 degrees moves its corners 10 px)");
  check(ghostEmergeSpan(rect(0, 0)) === 4 && ghostEmergeSpan(rect(0, 0, { width: 400, height: 300 })) === 12 && ghostEmergeSpan(rect(0, 0, { width: 20, height: 10 })) === 3, "the emerge span is a tenth of the smaller side, 3 to 12 stage px");
  const travels = ghostEmergence(rect(10, 20), rect(110, 20));
  check(travels(rect(10, 20), 0) === 0 && travels(rect(14, 20), 0.04) === 1 && travels(rect(12, 20), 0) > 0 && travels(rect(12, 20), 0) < 1, "a copy that travels emerges by separation: 0 at the source, 1 once it has left by the span, a soft ramp between");
  check(travels(rect(13, 20), 0) > travels(rect(11, 20), 0) && travels(rect(110, 20), 1) === 1, "the ramp is monotone and the landing is the authored ink");
  const stays = ghostEmergence(rect(10, 20), rect(10, 20, { fill: "#f00" }));
  check(stays(rect(10, 20), 0) === 0 && stays(rect(10, 20), 0.25) === 1 && stays(rect(10, 20), 1) === 1, "a copy that never separates (the same place, another look) fades in over the first quarter of its flight instead");
}
player.seek(0, 2, 100);
check(first.style.visibility === "visible" && Number(first.style.opacity) > 0 && Number(first.style.opacity) < .01, "the copy is born unseen: on its birth frame its ink is a thousandth of its authored .18 (never 0: an opacity-0 node is culled and first rasterises mid-flight)");
player.seek(0, 2, 105);
check(Number(first.style.opacity) > .001 && Number(first.style.opacity) < .15, "a few ms in (the copy has left its source by about a pixel) its ink is partly drawn");
player.seek(0, 2, 250);
check(near(Number(first.style.opacity), .18) || first.style.opacity === "", "once it has left by a stroke width it is the authored copy (opacity .18 and no emergence leftover)");
player.seek(0, 2, 1100); check(first.style.left === "310px" && near(Number(first.style.opacity || .18), .18), "and it lands on the authored endpoint with the authored opacity");
player.destroy();
const disabled = structuredClone(slide); disabled.beats[2].tracks[0].disabled = true;
check(compileSlide(disabled).sample(3).presentation.unbornElementIds?.includes("g1"), "disabled birth never makes its result available");
const orphan = structuredClone(slide); orphan.elements = orphan.elements.filter(e => e.id !== "source");
const orphanPlan = compileSlide(orphan);
check(orphanPlan.preState("g1", 2)?.x === 900 && orphanPlan.issues.some(i => /saved copy/.test(i.reason)), "deleted source uses saved fallback with a visible diagnostic");
const cycle = structuredClone(slide); cycle.beats[2].tracks[0].ghostFrom = "g2";
check(compileSlide(cycle).issues.some(i => /not yet born/.test(i.reason)), "same-step dependencies are diagnosed without recursive resolution");
const changed = structuredClone(slide); changed.beats[1].tracks[0].to!.state!.x = 200;
check(compileSlide(changed).preState("g1", 2)?.x === 210 && JSON.stringify(slide) === saved, "recompile follows changed source pose while preserving the existing document");
const text: Slide = { id: "text", elements: [{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 30, rotation: 0, text: "Count 10", fontFamily: "Arial", fontSize: 20, fontWeight: 400, fontStyle: "normal", color: "#fff", align: "left", sizing: "fixed" }], beats: [{ id: "base", tracks: [] }, { id: "count", tracks: [{ target: "t", preset: "countUp", params: { from: 10, to: 30 } }] }, { id: "birth", tracks: [{ target: "copy", ghostFrom: "t", preset: "transform", to: { state: { text: "Count 50" } } }] }] };
text.elements.push({ ...text.elements[0], id: "copy" });
check((compileSlide(text).preState("copy", 2) as { text: string }).text === "Count 30", "text ghost captures effective prior countUp content");
const manifests: Record<string, FluxPlotManifest> = {};
for (const [id, y] of [["A", 20], ["B", 80]] as const) {
  manifests[id] = { spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", svg: "", size: { width: 100, height: 100, unit: "px" }, axes: [], series: [{ id: "s", points: [{ svgId: "p0", index: 0, x: .5, y }] }] } as FluxPlotManifest;
  cachePlot(id, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle id="p0" cx="50" cy="${y}" r="4" opacity="0.4"/></svg>`, manifests[id]);
}
const plot: Slide = { id: "plot", elements: [{ id: "p", type: "plot", assetId: "A", x: 0, y: 0, width: 100, height: 100, rotation: 0, source: { svgPath: "plots/A.svg" } }], beats: [{ id: "base", tracks: [] }, { id: "data", tracks: [{ target: "p", preset: "transform", to: { assetId: "B", svgPath: "plots/B.svg", manifestPath: "plots/B.json", frozen: true } }, { target: "p", part: "p0", preset: "dim" }] }, { id: "birth", tracks: [{ target: "pcopy", ghostFrom: "p", preset: "transform", duration: 1000, easing: "linear", to: { state: { x: 200, width: 200 } } }] }] };
plot.elements.push({ ...plot.elements[0], id: "pcopy" });
const options = { theme: FLUX_DARK, reducedMotion: true, plotManifest: (id: string) => manifests[id] };
const plotPlan = compileSlide(plot, undefined, options), seed = plotPlan.copySourceState("p", 2);
check(seed?.type === "plot" && seed.assetId === "B" && seed.source?.svgPath === "plots/B.svg" && seed.source?.frozen, "copied plot asset and explicit frozen source paths stay coherent after data Change");
check(near(plotPlan.sample(2).partStates.pcopy.p0.opacity, .3), "inspected ghost retains inherited per-part presentation as a factor");
deck.slides = [plot];
const plotted = createPlayer(host, deck, options);
for (const time of [0, 500, 1000, 250, 1000]) {
  plotted.seek(0, 2, time);
  const part = host.querySelector('[id="pcopy__p0"]') as SVGElement;
  check(part.getAttribute("cy") === "80" && near(Number(part.style.opacity), .12), `plot ghost ${time}ms uses B geometry and authored opacity × inherited part dim without compounding`);
}
plotted.destroy();
cachePlot("B", '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle id="p0" cx="50" cy="60" r="4" opacity="0.4"/></svg>', manifests.B);
const refreshed = createPlayer(host, deck, options); refreshed.seek(0, 2, 0);
check(host.querySelector('[id="pcopy__p0"]')?.getAttribute("cy") === "60", "newly accepted source bytes reach the ghost origin on recompilation without editing its fallback");
refreshed.destroy();
// A real line plot copy floats and zooms through the ordinary transform driver.
const { readFile } = await import("node:fs/promises");
const { addSlide, addPlotToSlide, addBeat, addGhostTransform, setTransform } = await import("../src/lib/slide/ops");
const { projectSeries, viewFits, projectWith, guideData } = await import("../src/lib/plot/project");
const { preparePlot } = await import("../src/lib/plot/parse");
const lineSvg = await readFile(new URL("./fixtures/plots/mpl_sine_waves_FLUXPLOT.svg", import.meta.url), "utf8");
const lineManifest = JSON.parse(await readFile(new URL("./fixtures/plots/mpl_sine_waves_FLUXPLOT.fluxplot.json", import.meta.url), "utf8")) as FluxPlotManifest;
cachePlot("sine", lineSvg, lineManifest);
const zoomDeck = createDeck({ withTitleSlide: false }), zoomSlide = addSlide(zoomDeck, { layout: "blank" });
const zoomSource = addPlotToSlide(zoomDeck, zoomSlide.id, { assetId: "sine", x: 20, y: 30, width: 480, height: 144 })!;
const birth = addBeat(zoomDeck, zoomSlide.id)!;
const view = { x: { domain: [2, 4] as [number, number] } };
const ghost = addGhostTransform(zoomDeck, zoomSlide.id, birth.id, zoomSource, { count: 1, duration: 1000, easing: "linear", states: [{ x: 220, y: 130, view }] })!.elementIds[0];
const next = addBeat(zoomDeck, zoomSlide.id)!;
setTransform(zoomDeck, zoomSlide.id, next.id, ghost, { duration: 1000, easing: "linear", state: { view: { x: { domain: [1, 3] } } } });
const zoomPlayer = createPlayer(host, zoomDeck, { theme: FLUX_DARK, reducedMotion: true, plotManifest: () => lineManifest });
const expected = projectSeries(lineManifest.series[0], null, viewFits(lineManifest)!, viewFits(lineManifest, view)!, .5)[0];
for (const time of [500, 1000, 0, 500]) {
  zoomPlayer.seek(0, 1, time);
  const line = host.querySelector(`[id="${ghost}__2hz.line"] path`)!;
  const xy = line.getAttribute("d")!.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
  if (time === 500) {
    check(near(xy[0], expected.x) && near(xy[1], expected.y), "floating ghost's midpoint data agrees with projectSeries");
    check(node(ghost).style.transform.includes("translate(100px, 50px)"), "ghost floats in x and y while its data view zooms");
    // WP 2.3 (tick hand-off, deliberate supersession of "remains faded"): a view Change replaces the GENERATED guides with a pool of
    // ticks that ride the blended view, so the generated tick outside the data view is hidden (display none) and judged by its
    // EFFECTIVE visibility; the check that mattered, no tick outside the view, is made on the pool, in pixels.
    const generatedTick = host.querySelector(`[id="${ghost}__axis.x.tick.1"]`) as SVGElement;
    check(generatedTick.style.display === "none" || Number(generatedTick.style.opacity || 1) === 0, "ghost guide outside the data view is not visible (hidden by the hand-off pool or faded)");
    const pooled = Array.from(host.querySelectorAll(`[id^="${ghost}__axis.x.tick."][data-projection-flight]`)) as SVGElement[];
    check(pooled.length > 0, "the ghost's view Change built its hand-off tick pool");
    const rawFit = viewFits(lineManifest)!.x, domain = (lineManifest.axes[0] as unknown as { x: { domain: [number, number] } }).x.domain;
    const bounds = domain.map(v => projectWith(rawFit, v)), lo = Math.min(...bounds), hi = Math.max(...bounds), slack = (hi - lo) * .04 + 1e-6;
    const origin = projectWith(rawFit, guideData(lineManifest, preparePlot(lineSvg, lineManifest).root!).get("axis.x.tick.1")!.value); // the tick's resting pixel, from a pristine copy
    const shown = pooled.filter(n => n.style.display !== "none" && Number(n.style.opacity || 1) > .02);
    check(shown.length > 0 && shown.every(n => { const px = origin + Number(n.getAttribute("transform")!.match(/translate\(([-\d.e+]+)/)![1]); return px >= lo - slack && px <= hi + slack; }), "every visible pooled tick of the ghost lies inside the plot's x range");
  }
}
zoomPlayer.seek(0, 2, 500);
const chainedExpected = projectSeries(lineManifest.series[0], null, viewFits(lineManifest, view)!, viewFits(lineManifest, { x: { domain: [1, 3] } })!, .5)[0];
const chainedX = Number(host.querySelector(`[id="${ghost}__2hz.line"] path`)!.getAttribute("d")!.match(/M([-\d.]+)/)![1]);
check(near(chainedX, chainedExpected.x), "a later view Change starts from the ghost's zoomed endpoint");
zoomPlayer.destroy();
console.log(`GHOST RUNTIME: PASS (${checks} assertions)`);
