// Real prepared fluxplot fixtures → public geometry bridge (linkedom/headless).
import fs from "node:fs";
import { DOMParser, parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { preparePlot } from "../src/lib/plot/parse";
import { targetOutlines, partStageOutlines, elementStageOutlines } from "../src/lib/slide/targetGeometry";
import { pathToNodes, pathToSubpaths } from "../src/lib/path";
import { parseTransform, compose, applyToPoint, applyToNodes, transformToAncestor } from "../src/lib/plot/svgMatrix";
import { readPaint } from "../src/lib/plot/paint";
import { ptTrueFactors } from "../src/lib/plot/compensate";
import { rotatedAABB } from "../src/lib/geometry";
import { compileSlide } from "../src/lib/slide/compile";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../src/lib/slide/ops";
import type { Element as SceneElement, SemanticPlotElement } from "../src/lib/types";
import type { StageOutline } from "../src/lib/slide/stageOutline";

Object.assign(globalThis, { DOMParser, document: parseHTML("<html><body></body></html>").document });
const h = harness("verify-target-geometry");
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const fixture = (name: string) => preparePlot(fs.readFileSync(new URL(`./fixtures/plots/${name}_FLUXPLOT.svg`, import.meta.url), "utf8"), JSON.parse(fs.readFileSync(new URL(`./fixtures/plots/${name}_FLUXPLOT.fluxplot.json`, import.meta.url), "utf8")));
const box = fixture("mpl_boxplot"), scatter = fixture("mpl_scatter");
const fixtures = new Map([["box", box], ["scatter", scatter], ...["mpl_bars", "sns_bars", "mpl_sine_waves"].map((name) => [name, fixture(name)] as const)]);
const ctx = { manifest: (id: string) => fixtures.get(id)?.manifest, plotRoot: (id: string) => fixtures.get(id)?.root ?? undefined };
const plot = (extra: Partial<SemanticPlotElement> = {}): SemanticPlotElement => ({ id: "p", type: "plot", assetId: "box", x: 10, y: 20, width: 200, height: 120, rotation: 0, ...extra });
const frame = (elements: SceneElement[]) => compileSlide({ id: "s", elements, beats: [{ id: "design", tracks: [] }] }, { width: 800, height: 600 }, { plotManifest: ctx.manifest }).sample(0);
const one = (id: string, el = plot()) => targetOutlines({ element: el.id, parts: [id] }, frame([el]), ctx);
const xy = (o: StageOutline) => o.nodes.map((n) => [n.x, n.y]);

h.section("shared transforms, subpaths, paint, compensation");
const m = parseTransform("translate(3 4) rotate(90) scale(2)");
h.ok(m.every((v, i) => near(v, [0, 2, -2, 0, 3, 4][i])), "SVG sequence is [0,2,-2,0,3,4]");
h.eq(applyToPoint({ x: 2, y: 1 }, [0, 2, -2, 0, 3, 4]), { x: 1, y: 8 }, "matrix maps point by hand");
const handles = applyToNodes([{ x: 1, y: 2, type: "corner", hIn: { dx: 2, dy: 0 }, hOut: { dx: 0, dy: 3 } }], [0, 2, -2, 0, 3, 4])[0];
h.eq(handles, { x: -1, y: 6, type: "corner", hIn: { dx: 0, dy: 4 }, hOut: { dx: -6, dy: 0 } }, "points translate; handles only rotate/scale");
h.ok(near(applyToPoint({ x: 4, y: 5 }, parseTransform("rotate(90 3 5)")).y, 6), "three-argument rotate keeps pivot");
h.ok(near(applyToPoint({ x: 1, y: 2 }, parseTransform("skewX(45) skewY(45)")).x, 4), "skews compose in SVG order");
h.eq(compose([2, 0, 0, 3, 0, 0], [1, 0, 0, 1, 4, 5]), [2, 0, 0, 3, 8, 15], "compose scales translated origin");
const synthetic = preparePlot('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="outer" transform="translate(3 4)"><path id="inner" transform="scale(2)" d="M0 0L5 5"/></g></svg>')!;
h.eq(transformToAncestor(synthetic.root!.querySelector('[id="inner"]')!, synthetic.root!), [2, 0, 0, 2, 3, 4], "ancestor chain excludes root");
const multi = pathToSubpaths("M 1 2 L 3 4 Z m 10 20 l 5 0 q 3 6 6 0");
h.eq(multi.map((p) => ({ closed: p.closed, xy: p.nodes.map((n) => [n.x, n.y]) })), [{ closed: true, xy: [[1, 2], [3, 4]] }, { closed: false, xy: [[11, 22], [16, 22], [22, 22]] }], "subpaths retain closure, relative M starts from the closed subpath start");
h.eq(pathToNodes("m 1 2 l 3 4").map((n) => [n.x, n.y]), [[1, 2], [3, 4]], "legacy pathToNodes behavior is unchanged");
h.eq(pathToSubpaths("M0 0H10V20h-5v-10Z")[0].nodes.map((n) => [n.x, n.y]), [[0,0],[10,0],[10,20],[5,20],[5,10]], "SVG horizontal/vertical and relative lines");
const arc = pathToSubpaths("M10 0 A10 10 0 0 1 0 10")[0];
h.ok(arc.nodes.length === 2 && near(arc.nodes[0].hOut!.dy, 5.5228474983) && near(arc.nodes[1].x, 0), "SVG quarter arc becomes one cubic with exact endpoints");
const n = synthetic.root!.querySelector('[id="inner"]')!;
n.setAttribute("style", "fill: none; stroke: #123456; stroke-width: 3; stroke-dasharray: 2, 4; stroke-linecap: round");
h.eq(readPaint(n), { fill: "none", stroke: "#123456", strokeWidth: 3, cap: "round", dash: [2,4], opacity: 1 }, "paint reads inline declarations");
h.eq(readPaint(n, { fill: "#ff0000", strokeWidth: 5, opacity: .4 }).fill, "#ff0000", "override wins");
n.removeAttribute("style");
h.eq(readPaint(n).fill, "#000000", "unspecified SVG fill is black");
h.eq(readPaint(new DOMParser().parseFromString('<line/>', 'image/svg+xml').documentElement).fill, "none", "line never fills");
h.eq(ptTrueFactors({ elW: 120, elH: 72, intrinsic: { w: 240, h: 144 } }), { fx: 2, fy: 2, fs: 2 }, "extracted pt-true formula");
h.eq(ptTrueFactors({ elW: 120, elH: 72 }), { fx: 1, fy: 1, fs: 1 }, "unknown intrinsic leaves compensation neutral");

h.section("fixture roles and hand-computed mapping");
const b = one("peaches.box"), spine = one("axis.x.spine"), whisker = one("peaches.whisker");
h.ok(b.length === 1 && b[0].closed && b[0].nodes.length === 4, "peaches.box is one four-node ring");
h.eq([b[0].paint.fill, b[0].paint.stroke], ["#ffdab9", "#000000"], "box keeps its actual paint");
h.ok(spine.length === 1 && !spine[0].closed && spine[0].nodes.length === 2, "x spine is one two-node chain");
h.ok(whisker.length === 1 && !whisker[0].closed && whisker[0].paint.cap === "round", "whisker is one round-cap chain");
// Fixture corner (48.009122,49.829638), viewBox (0,0,180,108).
// (10 + x*10/9, 20 + y*10/9).
h.ok(near(b[0].nodes[0].x, 63.34346888888889) && near(b[0].nodes[0].y, 75.36626444444445), "200×120 @ (10,20) maps fixture corner by the published formula");
// 400×240 @ (100,50): centre (300,170); rotate offsets (-93.3130622222,-9.2674711111) 30°.
const rotated = one("peaches.box", plot({ x: 100, y: 50, width: 400, height: 240, rotation: 30 }))[0];
h.ok(near(rotated.nodes[0].x, 223.82225316619306) && near(rotated.nodes[0].y, 115.31760347782827), "400×240 rotated 30° maps corner about the box centre");
// Intrinsic is 240×144 CSS px: centre quarter crop = (60,36,120,72) → vb (45,27,90,54).
const cropped = one("peaches.box", plot({ crop: { x: 60, y: 36, width: 120, height: 72 } }))[0];
h.ok(near(cropped.nodes[0].x, 16.68693777777778) && near(cropped.nodes[0].y, 70.73252888888889), "centre-quarter crop subtracts vb.x and vb.y before mapping");
const shifted = one("peaches.box", plot({ overrides: { "peaches.box": { dx: 9, dy: -4.5, fill: "#ff0000", stroke: "#abcdef", strokeWidth: 4, opacity: .3 } } }))[0];
h.ok(near(shifted.nodes[0].x - b[0].nodes[0].x, 10) && near(shifted.nodes[0].y - b[0].nodes[0].y, -5), "dx/dy are user units before stage mapping");
h.ok(shifted.paint.fill === "#ff0000" && shifted.paint.stroke === "#abcdef" && near(shifted.paint.strokeWidth, 4.8) && shifted.paint.opacity === .3, "paint overrides and fs compensation");
h.eq(one("peaches.box", plot({ overrides: { "peaches.box": { hidden: true } } })), [], "hidden leaf has no outline");
h.ok(one("axis.x.ticklabel.0")[0].paint.text, "text is a box-only crossfade target");
const datum = scatter.manifest!.series[0].points![0], markerEl = plot({ assetId: "scatter", x: 0, y: 0, width: 240, height: 144 });
const ring = one(datum.svgId, markerEl)[0], bigRing = one(datum.svgId, { ...markerEl, contentScale: 2 })[0];
h.ok(ring.closed && ring.nodes.length === 8 && near(ring.bbox.x + ring.bbox.w / 2, 189.4573) && near(ring.bbox.y + ring.bbox.h / 2, 43.01825066666667), "scatter glyph ring is centred on its translate anchor, mapped to stage");
h.ok(near(bigRing.bbox.w, 2 * ring.bbox.w) && near(bigRing.bbox.h, 2 * ring.bbox.h) && near(bigRing.bbox.x + bigRing.bbox.w / 2, ring.bbox.x + ring.bbox.w / 2), "contentScale 2 doubles ring about anchor");
h.eq(ring.owner, { elementId: "p", partId: datum.svgId, role: "point", series: "samples", index: 0, data: { x: datum.x, y: datum.y } }, "manifest identity and exact datum survive");
for (const [assetId] of fixtures) h.ok(targetOutlines({ element: "p" }, frame([plot({ assetId })]), ctx).length > 10, `${assetId}: whole plot yields its leaf geometry`);

h.section("primitive and nested SVG geometry");
const simple = preparePlot(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <g id="nested" transform="translate(3 4)" fill="#112233" opacity="0.5">
    <rect id="rect" x="10" y="20" width="30" height="40" transform="scale(2)"/>
    <circle id="circle" cx="20" cy="30" r="5"/>
    <ellipse id="ellipse" cx="20" cy="30" rx="5" ry="10"/>
    <line id="line" x1="1" y1="2" x2="3" y2="4" stroke="#123456"/>
    <polyline id="polyline" points="0,0 10,0 10,10"/>
    <polygon id="polygon" points="0,0 10,0 10,10"/>
    <rect id="round" x="10" y="10" width="30" height="20" rx="5" ry="3"/>
    <path id="multi" d="M0 0L5 0Z M10 10L15 15"/>
    <g id="glyph" data-flux-glyph="1" transform="translate(20 40)"><circle id="glyph-ring" r="2"/></g>
    <image id="image" x="2" y="3" width="4" height="5"/>
  </g></svg>`);
const simpleCtx = { manifest: () => simple.manifest, plotRoot: () => simple.root! };
const simplePlot = plot({ x: 0, y: 0, width: 100, height: 100 });
const simplePart = (id: string, el = simplePlot) => partStageOutlines(el, [id], simpleCtx);
const pristine = simple.root!.outerHTML;
h.eq(simplePart("rect")[0].bbox, { x: 23, y: 44, w: 60, h: 80 }, "primitive transforms compose through nested ancestors");
h.eq(simplePart("circle")[0].bbox, { x: 18, y: 29, w: 10, h: 10 }, "circle ring includes its centre and radius");
h.eq(simplePart("ellipse")[0].bbox, { x: 18, y: 24, w: 10, h: 20 }, "ellipse ring preserves both radii");
h.ok(!simplePart("line")[0].closed && !simplePart("polyline")[0].closed && simplePart("polygon")[0].closed, "line/polyline/polygon retain topology");
h.ok(simplePart("round")[0].nodes.length === 8 && simplePart("round")[0].nodes.some(n => n.hOut), "rounded SVG rectangle keeps elliptical corner handles");
h.eq(simplePart("multi").map(o => o.closed), [true,false], "one path drawable emits independent subpath outlines");
h.eq(simplePart("glyph", { ...simplePlot, contentScale: 2 })[0].bbox, { x: 19, y: 40, w: 8, h: 8 }, "glyph wrapper and glyph-marked path both scale about their anchor");
h.ok(simplePart("image")[0].paint.raster && simplePart("image")[0].bbox.w === 4, "SVG image is a raster box");
h.eq(simplePart("rect")[0].paint.fill, "#112233", "paint inherits from an SVG group");
h.eq(simplePart("rect")[0].paint.opacity, .5, "group opacity composites once");
h.eq(simplePart("rect", { ...simplePlot, overrides: { nested: { hidden: true } } }), [], "hidden container removes its expanded leaves");
h.eq(simplePart("rect", { ...simplePlot, overrides: { rect: { fill: "#ff0000" }, nested: { fill: "#00ff00" } } })[0].paint.fill, "#00ff00", "authored override order matches real container paint writes");
h.eq(simple.root!.outerHTML, pristine, "geometry never modifies the pristine root");
h.eq(ring.paint.fill, "#205ea6b3", "scatter fill-opacity is retained in its paint alpha");

h.section("elements, groups, compiled state, pure export parity");
const rect: SceneElement = { type: "rect", id: "r", x: 50, y: 70, width: 80, height: 40, rotation: 30, fill: "red", stroke: "none", strokeWidth: 0, cornerRadius: 0, groupId: "child" };
const outline = elementStageOutlines(rect)[0], expected = rotatedAABB(rect);
h.ok(Object.keys(expected).every((k) => near(outline.bbox[k as keyof typeof expected], expected[k as keyof typeof expected])), "rotated rect bounds equal rotatedAABB within 1e-6");
const line: SceneElement = { type: "line", id: "l", x: 4, y: 5, x1: 10, y1: -2, x2: 30, y2: 8, width: 0, height: 0, rotation: 0, flipX: true, stroke: "blue", strokeWidth: 2, arrowStart: false, arrowEnd: true, groupId: "parent" };
h.eq(xy(elementStageOutlines(line)[0]), [[34,3],[14,13]], "line uses endpoint-box origin and bakes flip once");
h.ok(elementStageOutlines(line)[0].paint.arrowEnd, "drawn arrow carries its head paint");
const groupCtx = { ...ctx, groups: { parent: { name: "parent" }, child: { name: "child", parentId: "parent" } } };
h.eq(targetOutlines({ element: "r", group: "parent" }, frame([rect, line]), groupCtx).map((o) => o.owner.elementId), ["r","l"], "nested group is union of its members through the shared resolver");
h.ok(targetOutlines({ element: "p" }, frame([plot({ assetId: "missing" })]), ctx)[0].paint.raster, "unavailable plot root is a raster box");
const deck = createDeck({ withTitleSlide: false }), slide = addSlide(deck, { layout: "blank" });
addElement(deck, slide.id, rect);
const beat = addBeat(deck, slide.id)!;
setTransform(deck, slide.id, beat.id, "r", { state: { x: 150 }, duration: 100 });
const compiled = compileSlide(slide, deck.stage);
h.ok(near(targetOutlines({ element: "r" }, compiled.sample(1, 100), ctx)[0].bbox.x - outline.bbox.x, 100), "target geometry follows a real compiled earlier transform");
const core = await import("../flux-core/index");
h.eq(core.targetOutlines({ element: "p", parts: ["peaches.box"] }, frame([plot()]), ctx), b, "flux-core exported bridge is byte-identical to shared GUI bridge");
const ids = scatter.manifest!.series[0].points!.map((p) => p.svgId);
for (let i = 0; i < 30; i++) partStageOutlines(markerEl, ids, ctx);
const samples: number[] = [];
const markerFrame = frame([markerEl]);
for (let i = 0; i < 100; i++) { const t = performance.now(); const all = targetOutlines({ element: "p", selector: { role: "point" } }, markerFrame, ctx); samples.push(performance.now() - t); if (i === 0) h.eq(all.length, 60, "all 60 points give exactly 60 rings"); }
samples.sort((a,b) => a-b);
h.ok(samples[95] < 5, `60-point scatter warm p95 ${samples[95].toFixed(3)} ms < 5 ms (100 samples)`);
await h.done();
