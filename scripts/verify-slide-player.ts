#!/usr/bin/env -S npx tsx
// P2 — the player's deterministic engine (§5.2). With a linkedom DOM (no WAAPI),
// verify the parts that export frame-stepping + thumbnails depend on: the slide's
// tracks flatten to the right per-node specs, stagger spreads delays, and the
// static-state at any beat reveals exactly the right set (an element/block is
// hidden until its intro beat, shown after — accumulated per property).
// Run: npx tsx scripts/verify-slide-player.ts
import { parseHTML } from "linkedom";
import { computeSlideAnims, applyStatic, applyAt, resolveEasing } from "../src/lib/slide/player/player";
import { PRESETS } from "../src/lib/slide/player/presets";
import { FLUX_DARK } from "../src/lib/slide/theme";
import type { Track } from "../src/lib/slide/types";
import type { RenderedSlide } from "../src/lib/slide/player/render";
import type { Slide, StageSize } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";

import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-player");
function assert(cond: unknown, msg: string) {
  if (!h.ok(cond, msg)) throw new Error("FAIL: " + msg);
}

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const stage: StageSize = { width: 1280, height: 720 };
const opts = { theme: FLUX_DARK } as const;

// A fake rendered slide: a title wrapper + three bullet TEXT elements
// (slides-are-figures: per-line reveal = one figure text element per line).
function el(id: string): HTMLElement {
  const d = document.createElement("div");
  d.dataset.elId = id;
  return d as unknown as HTMLElement;
}
const title = el("t_title");
const b1 = el("t_b1"), b2 = el("t_b2"), b3 = el("t_b3");
const rendered: RenderedSlide = { elements: new Map([["t_title", title], ["t_b1", b1], ["t_b2", b2], ["t_b3", b3]]) };
const camera = el("camera");

const tEl = (id: string, y: number): Slide["elements"][number] =>
  ({ type: "text", id, x: 0, y, width: 800, height: 40, rotation: 0, text: id, fontFamily: "Arial", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#fff", sizing: "auto" });

// A slide: beat0 base, beat1 fadeRise the title, beat2 three staggered bullets
// (one track per element, with-prev style starts 0/100/200).
const slide: Slide = {
  id: "s1",
  elements: [tEl("t_title", 0), tEl("t_b1", 120), tEl("t_b2", 170), tEl("t_b3", 220)],
  beats: [
    { id: "k0", label: "base", tracks: [] },
    { id: "k1", label: "title", tracks: [{ target: "t_title", preset: "fadeRise", start: 0, duration: 320 }] },
    { id: "k2", label: "bullets", tracks: [
      { target: "t_b1", preset: "fadeRise", start: 0, duration: 320 },
      { target: "t_b2", preset: "fadeRise", start: 100, duration: 320 },
      { target: "t_b3", preset: "fadeRise", start: 200, duration: 320 },
    ] },
  ],
};

const specs = computeSlideAnims(slide, rendered, camera, stage, opts);

// --- spec shape --------------------------------------------------------------
assert(specs.length === 4, "4 specs (1 title + 3 bullet elements)");
const titleSpec = specs.find((s) => s.node === title)!;
assert(titleSpec.beatIndex === 1 && titleSpec.enter, "title spec is an enter on beat 1");
const blockSpecs = specs.filter((s) => s.node !== title).sort((a, b) => a.delay - b.delay);
assert(blockSpecs.length === 3 && blockSpecs.every((s) => s.beatIndex === 2 && s.enter), "3 bullet enter specs on beat 2");
assert(JSON.stringify(blockSpecs.map((s) => s.delay)) === JSON.stringify([0, 100, 200]), "per-track starts spread delays 0/100/200ms");

const opacity = (n: HTMLElement) => (n.style as unknown as { opacity?: string }).opacity ?? "";

// --- static state determinism (the export/thumbnail substrate) ---------------
applyStatic(specs, 0);
assert(opacity(title) === "0" && opacity(b1) === "0", "beat 0: title + bullets hidden (before their intro)");

applyStatic(specs, 1);
assert(opacity(title) === "1", "beat 1: title shown");
assert(opacity(b1) === "0", "beat 1: bullets still hidden (intro is beat 2)");

applyStatic(specs, 2);
assert(opacity(title) === "1" && opacity(b3) === "1", "beat 2: title + all bullets shown");

// back-nav determinism: re-applying an earlier beat re-hides
applyStatic(specs, 0);
assert(opacity(b3) === "0", "back to beat 0 re-hides the bullets (reversible/O(1))");

// --- draw-on static-state regression (anim 0.3 / seam-proof compile) ---------
// A draw-on part must rest UNDRAWN before its beat and SEAM-FREE after it.
// The compile animates a [dash, gap] pair at offset 0: hidden = "0 G" (zero
// dash), drawn = "G 0" (zero gap) — endpoints exact even where the browser's
// getTotalLength undershoots the painted arc (ellipse/circle, ~0.6%), which
// used to leave a pre-beat sliver + a resting seam notch.
// WS3: drawOn drills to REAL geometry only; a geometry-less target now falls
// back to a fade (covered below + in verify-slide-exits) instead of dashing a div.
const lineNode = el("ln_line");
const svgNS = "http://www.w3.org/2000/svg";
const linePath = document.createElementNS(svgNS, "path");
linePath.setAttribute("d", "M 0 0 L 100 0");
linePath.setAttribute("stroke", "#fff");
linePath.setAttribute("fill", "none"); // faithful to elementToSvg output — bare paths default-fill black and take the opacity reveal instead
lineNode.appendChild(linePath);
const drawSlide: Slide = {
  id: "s2",
  elements: [{ type: "line", id: "ln_line", x: 0, y: 0, width: 100, height: 0, rotation: 0, x1: 0, y1: 0, x2: 100, y2: 0, stroke: "#fff", strokeWidth: 2, arrowStart: false, arrowEnd: false }],
  beats: [
    { id: "d0", label: "base", tracks: [] },
    { id: "d1", label: "draw", tracks: [{ target: "ln_line", preset: "drawOn", start: 0, duration: 800 }] },
  ],
};
const drawSpecs = computeSlideAnims(drawSlide, { elements: new Map([["ln_line", lineNode]]) }, camera, stage, opts);
const geoNode = linePath as unknown as HTMLElement;
const dash = (n: HTMLElement) => (n.style as unknown as { strokeDasharray?: string }).strokeDasharray ?? "";
const offset = (n: HTMLElement) => (n.style as unknown as { strokeDashoffset?: string }).strokeDashoffset ?? "";
assert(drawSpecs.some((s) => s.node === (linePath as never)), "drawOn drilled to the real path geometry");
applyStatic(drawSpecs, 0);
assert(dash(geoNode) !== "" && offset(geoNode) !== "" && offset(geoNode) !== "0", "beat 0: draw-on part rests UNDRAWN (offset = G; no zero-dash cap dots)");
// linkedom has no getTotalLength (length falls back to 1) — assert the
// overshoot FORMULA (len + max(4, 5%) = 5 here); the real-browser overshoot
// is pinned by verify-slide-export-transform against a painted ellipse.
assert(parseFloat(dash(geoNode)) >= 5, `…with the dasharray OVERSHOT past the measured length (seam-proof: ${dash(geoNode)} >= 5)`);
applyStatic(drawSpecs, 1);
assert(offset(geoNode) === "" && dash(geoNode) === "", "beat 1: draw-on removes its temporary dash window and restores the authored full stroke");
applyStatic(drawSpecs, 0);
assert(offset(geoNode) !== "0" && offset(geoNode) !== "", "back to beat 0 re-hides the draw (reversible)");

// geometry-less target → the fade fallback keeps enter semantics (never a no-op)
const bareNode = el("ln_bare");
const bareSpecs = computeSlideAnims(
  { ...drawSlide, elements: [{ ...drawSlide.elements[0], id: "ln_bare" }], beats: [drawSlide.beats[0], { id: "d1", tracks: [{ target: "ln_bare", preset: "drawOn", duration: 800 }] }] } as Slide,
  { elements: new Map([["ln_bare", bareNode]]) }, camera, stage, opts,
);
applyStatic(bareSpecs, 0);
assert((bareNode.style as unknown as { opacity?: string }).opacity === "0", "geometry-less drawOn target rests HIDDEN before its beat (fade fallback)");
applyStatic(bareSpecs, 1);
assert((bareNode.style as unknown as { opacity?: string }).opacity === "1", "…and shown after (no silent visible-before-beat no-op)");

// --- parts-tree group targeting (anim 1.1) -----------------------------------
// track.part naming a GROUP id expands to ALL its leaf members via resolveTargets
// (the only path that reaches axis parts — they aren't in the series part-index).
const plotWrap = el("p_plot");
for (const id of ["s.point.0", "s.point.1", "s.point.2"]) {
  const m = document.createElement("div");
  m.setAttribute("id", `p_plot__${id}`);
  plotWrap.appendChild(m);
}
const treeManifest = {
  schemaVersion: "0.2.0",
  parts: { id: "figure", role: "figure", children: [
    { id: "s.points", role: "group", groupRole: "point", members: ["s.point.0", "s.point.1", "s.point.2"] },
  ] },
} as unknown as FluxPlotManifest;
const plotEl = { type: "plot", id: "p_plot", assetId: "plotA", x: 0, y: 0, width: 400, height: 300, rotation: 0 } as unknown as Slide["elements"][number];
const plotOpts = { theme: FLUX_DARK, plotManifest: (id: string) => (id === "plotA" ? treeManifest : undefined) };
const plotMap = { elements: new Map([["p_plot", plotWrap]]) };
const groupSlide: Slide = {
  id: "s3", elements: [plotEl],
  beats: [{ id: "p0", label: "base", tracks: [] }, { id: "p1", label: "points", tracks: [{ target: "p_plot", part: "s.points", preset: "fade", start: 0, duration: 300 }] }],
};
const groupSpecs = computeSlideAnims(groupSlide, plotMap, camera, stage, plotOpts);
assert(groupSpecs.filter((s) => s.beatIndex === 1).length === 3, "1.1: track.part GROUP id expands to its 3 leaf member nodes (parts tree)");
const leafSlide: Slide = {
  id: "s3", elements: [plotEl],
  beats: [{ id: "p0", label: "base", tracks: [] }, { id: "p1", label: "one", tracks: [{ target: "p_plot", part: "s.point.1", preset: "fade", start: 0, duration: 300 }] }],
};
const leafSpecs = computeSlideAnims(leafSlide, plotMap, camera, stage, plotOpts);
assert(leafSpecs.filter((s) => s.beatIndex === 1).length === 1, "1.1: a single leaf part id still resolves to exactly one node (back-compat)");

// --- spatial stagger by x (anim 1.2) -----------------------------------------
// Points emitted OUT of x-order, staggered by:"x", must fire left→right by their
// data-x — NOT by array/emission order. (The scatter "left to right" reveal.)
const sx = el("p_sx");
const xs: Record<string, number> = { "g.point.0": 5, "g.point.1": 1, "g.point.2": 3 }; // emission ≠ x order
for (const [id, x] of Object.entries(xs)) {
  const m = document.createElement("div");
  m.setAttribute("id", `p_sx__${id}`);
  m.setAttribute("data-x", String(x));
  sx.appendChild(m);
}
const sxManifest = { schemaVersion: "0.2.0", parts: { id: "figure", role: "figure", children: [
  { id: "g.points", role: "group", groupRole: "point", members: ["g.point.0", "g.point.1", "g.point.2"] },
] } } as unknown as FluxPlotManifest;
const sxEl = { type: "plot", id: "p_sx", assetId: "plotS", x: 0, y: 0, width: 400, height: 300, rotation: 0 } as unknown as Slide["elements"][number];
const sxSlide: Slide = { id: "sx", elements: [sxEl], beats: [
  { id: "x0", label: "base", tracks: [] },
  { id: "x1", label: "pts", tracks: [{ target: "p_sx", part: "g.points", preset: "fade", start: 0, duration: 200, stagger: { perMs: 100, by: "x", from: "start" } }] },
] };
const sxSpecs = computeSlideAnims(sxSlide, { elements: new Map([["p_sx", sx]]) }, camera, stage, { theme: FLUX_DARK, plotManifest: (id: string) => (id === "plotS" ? sxManifest : undefined) });
const delayById = new Map(sxSpecs.filter((s) => s.beatIndex === 1).map((s) => [(s.node as unknown as { getAttribute(n: string): string }).getAttribute("id"), s.delay]));
assert(delayById.get("p_sx__g.point.1") === 0, "1.2: by:x — smallest data-x (point.1, x=1) fires first (delay 0)");
assert(delayById.get("p_sx__g.point.2") === 100, "1.2: by:x — middle data-x (point.2, x=3) fires at 100ms");
assert(delayById.get("p_sx__g.point.0") === 200, "1.2: by:x — largest data-x (point.0, x=5) fires last (200ms)");

// --- drawOn drills into wrapper <g> to the geometry (anim 1.5) ----------------
// FluxPlot wraps each part in a <g id>; the strokable path lives inside. drawOn
// must dash the PATH (by its length), not the empty <g> (which would do nothing).
const gWrap = document.createElement("g");
const gp1 = document.createElement("path"), gp2 = document.createElement("path");
for (const gp of [gp1, gp2]) { gp.setAttribute("stroke", "#fff"); gp.setAttribute("fill", "none"); }
gWrap.appendChild(gp1); gWrap.appendChild(gp2);
const drawTrack = { target: "p", preset: "drawOn" } as Track;
const drawAnims = PRESETS.drawOn([gWrap as unknown as HTMLElement], drawTrack, { theme: FLUX_DARK, stage });
assert(drawAnims.length === 2, "1.5 drawOn: a <g> wrapper yields one anim per geometry child");
assert(drawAnims.every((a) => (a.node as Element).tagName?.toLowerCase() === "path"), "1.5 drawOn: anims target the PATH children, not the <g>");
drawAnims.forEach((a) => a.prep?.());
assert((gp1 as unknown as HTMLElement).style.strokeDasharray !== "", "1.5 drawOn: prep sets the (overshot) stroke-dasharray on the path child");
assert(!(gWrap as unknown as HTMLElement).style.strokeDasharray, "1.5 drawOn: the wrapper <g> is left untouched");
const barePath = document.createElement("path");
barePath.setAttribute("stroke", "#fff");
barePath.setAttribute("fill", "none");
const bareDraw = PRESETS.drawOn([barePath as unknown as HTMLElement], drawTrack, { theme: FLUX_DARK, stage });
assert(bareDraw.length === 1, "1.5 drawOn: a bare path (already geometry) stays a single anim");

// --- easing resolution -------------------------------------------------------
assert(resolveEasing("smooth").startsWith("linear("), "smooth → manim smoothstep linear() string");
assert(resolveEasing("linear") === "linear" && resolveEasing(undefined).startsWith("cubic-bezier"), "linear + default easings resolve");

// Springs use the real player, including reverse seeks and endpoint settlement.
// Curve is type-only until M3: these decks never pass through disk validation.
const { createPlayer } = await import("../src/lib/slide/player/player");
const { createDeck } = await import("../src/lib/slide/ops");
const { resolveCurve } = await import("../src/lib/slide/curves");
// Named colors have no numeric interpolation. Their fallback must use raw time,
// even when the timing curve crosses the midpoint three times.
{
  const node = el("discrete-color");
  const spec = { ...titleSpec, node, keyframes: [{ color: "red" }, { color: "blue" }],
    duration: 1000, delay: 0, ease: resolveCurve({ curve: { kind: "bezier", p: [.3, 2, .7, -1] } }) };
  const colors: string[] = [];
  for (let i = 0; i < 60; i++) { applyAt([spec], 1, 1000 * i / 59); colors.push(node.style.color); }
  const switches = colors.slice(1).filter((v, i) => v !== colors[i]).length;
  assert(switches === 1 && colors.every((v, i) => v === (i / 59 < .5 ? "red" : "blue")),
    `named-color fallback switches once at raw halfway over 60 samples (got ${switches})`);
}

const { overshootBox } = await import("../src/lib/slide/tween");
const { staggerDelay } = await import("../src/lib/slide/stagger");
const core = await import("../flux-core/index");
assert(core.overshootBox === overshootBox && core.staggerDelay === staggerDelay, "box extrapolation and stagger have identical GUI/headless exports");
const spring = { kind: "spring", bounce: .5 } as const;
const springSlide: Slide = { id: "spring", elements: [
  { type: "rect", id: "box", x: 400, y: 100, width: 80, height: 60, rotation: 0, opacity: .2, fill: "#000000", stroke: "#000000", strokeWidth: 2 },
  { type: "rect", id: "plain", x: 400, y: 200, width: 80, height: 60, rotation: 0, opacity: .2, fill: "#000000", stroke: "none", strokeWidth: 0 },
  { ...tEl("count", 250), text: "100%" },
  { ...tEl("exact-count", 275), text: "000100%" },
  { ...tEl("fade", 300) }, { ...tEl("rise", 350) },
], beats: [{ id: "base", tracks: [] }, { id: "bounce", tracks: [
  { id: "box", target: "box", preset: "transform", duration: 1000, curve: spring, to: { state: { type: "ellipse", x: 600, opacity: .8, fill: "#ffffff" } } },
  { id: "plain", target: "plain", preset: "transform", duration: 1000, curve: spring, to: { state: { x: 600, opacity: .8, fill: "#ffffff" } } },
  { id: "count", target: "count", preset: "countUp", duration: 1000, curve: { kind: "spring", bounce: .8 }, params: { to: 100 } },
  { target: "exact-count", preset: "countUp", duration: 1000, curve: { kind: "spring", bounce: .8 } },
  { id: "fade", target: "fade", preset: "fade", duration: 1000, curve: spring },
  { id: "rise", target: "rise", preset: "fadeRise", duration: 1000, curve: spring },
] }] };
const springDeck = createDeck({ withTitleSlide: false, stage }); springDeck.defaults.transition = "none"; springDeck.slides = [springSlide];
const springHost = document.createElement("div") as unknown as HTMLElement;
const player = createPlayer(springHost, springDeck, { ...opts, reducedMotion: true });
const wrapper = springHost.querySelector('[data-el-id="box"]') as HTMLElement;
const layers = Array.from(wrapper.children) as HTMLElement[];
const samples = Array.from({ length: 60 }, (_, i) => i / 59);
let peakX = 0, layersStable = true, bounded = true, countBounded = true, countExact = true, rawText = true, sawLanding = false;
const countCurve = resolveCurve({ curve: { kind: "spring", bounce: .8 } });
for (const raw of samples) {
  player.seek(0, 1, raw * 1000);
  const dx = /translate\(([-\d.]+)px/.exec(wrapper.style.transform ?? "");
  peakX = Math.max(peakX, parseFloat(wrapper.style.left) + Number(dx?.[1] ?? 0));
  layersStable &&= layers.length === 3 && layers.every((layer, i) => (layer.style.visibility !== "hidden") === (raw <= 0 ? i === 0 : raw >= 1 ? i === 2 : i === 1));
  bounded &&= Number(wrapper.style.opacity) >= .2 && Number(wrapper.style.opacity) <= .8;
  if (raw > 0 && raw < 1) {
    const fill = layers[1].querySelector("path")!.getAttribute("fill")!;
    bounded &&= /^#[0-9a-f]{6}$/i.test(fill);
  }
  const count = Number(springHost.querySelector('[data-el-id="count"] tspan')!.textContent!.replace("%", ""));
  countBounded &&= count >= 0 && count <= 100;
  countExact &&= count === Number((100 * countCurve.clamped(raw)).toFixed(0));
  const exact = springHost.querySelector('[data-el-id="exact-count"] tspan')!.textContent;
  rawText &&= raw === 1 ? exact === "000100%" : exact !== "000100%";
  sawLanding ||= raw < 1 && count === 100;
}
assert(peakX >= 605, `spring transform overshoots the 400→600 box (peak ${peakX.toFixed(3)})`);
assert(layersStable, "60 raw samples keep A/M/B visibility tied only to raw endpoints");
assert(bounded, "spring opacity stays between .2 and .8 and outline colours stay in gamut");
assert(countBounded && sawLanding && countExact, "spring(.8) countUp reaches 100 before settling and never exceeds its target");
assert(rawText, "countUp restores authored endpoint formatting only at raw=1");
player.seek(0, 1, 310); player.seek(0, 1, 1000);
assert(wrapper.style.left === "600px" && wrapper.style.width === "80px" && wrapper.style.transform === "", "static seek(1) after overshoot restores the exact end box");
player.destroy();

// Native WAAPI and sampled frames share the same resolved spring. The fadeRise
// spec contains transform AND opacity, so its opacity must use the clamp channel.
const { build } = await import("esbuild");
const { readFile, mkdir } = await import("node:fs/promises");
const { dirname } = await import("node:path");
const { launch } = await import("./lib/driver.mjs");
const bundle = await build({ stdin: { contents: `
  import { createPlayer } from './src/lib/slide/player/player';
  import { FLUX_DARK } from './src/lib/slide/theme';
  window.springPlayer = (host, deck) => createPlayer(host, deck, { theme: FLUX_DARK, reducedMotion: false });
`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser", plugins: [{ name: "observe-countup-input", setup(build) {
  build.onLoad({ filter: /player[\\/]countup\.ts$/ }, async ({ path }) => {
    const source = await readFile(path, "utf8"), boundary = /return \(t, raw = t\) => (.*);/;
    assert(boundary.test(source), "countUp observer binds the real formatter");
    return { contents: source.replace(boundary, 'return (t, raw = t) => { (globalThis as any).__countProgress?.push(t); return $1; };'), loader: "ts", resolveDir: dirname(path) };
  });
} }] });
const { browser, page } = await launch();
try {
  await page.setContent('<html><body><div id="host"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const native = await page.evaluate(`(deck => {
    let clock = 0, callback;
    const original = { now: performance.now.bind(performance), raf: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
    Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
    window.requestAnimationFrame = cb => { callback = cb; return 1; }; window.cancelAnimationFrame = () => { callback = undefined; };
    window.__countProgress = [];
    const player = window.springPlayer(document.getElementById("host"), deck);
    const fade = document.querySelector('[data-el-id="fade"] .sl-effects');
    const rise = document.querySelector('[data-el-id="rise"] .sl-effects');
    const frames = [];
    try {
      for (let i = 0; i < 60; i++) player.seek(0, 1, 1000 * i / 59);
      for (let i = 1; i <= 20; i++) {
        const raw = i / 21;
        player.seek(0, 1, raw * 1000);
        const seek = Number(fade.style.opacity);
        player.play({ slide: 0, fromBeat: 1, toBeat: 1 }); clock += raw * 1000; callback(clock);
        frames.push({ raw, native: Number(getComputedStyle(fade).opacity), sampled: Number(rise.style.opacity), seek,
          easing: fade.getAnimations()[0]?.effect?.getTiming().easing ?? "", transform: rise.style.transform, paintedX: document.querySelector('[data-el-id="plain"] rect').getBoundingClientRect().left - document.getElementById("host").getBoundingClientRect().left });
        player.pause();
      }
    } finally { player.destroy(); Object.defineProperty(performance, "now", { configurable: true, value: original.now }); window.requestAnimationFrame = original.raf; window.cancelAnimationFrame = original.cancel; }
    return { frames, counts: window.__countProgress };
  })(${JSON.stringify(springDeck)})`) as { frames: { raw: number; native: number; sampled: number; seek: number; easing: string; transform: string; paintedX: number }[]; counts: number[] };
  assert(native.counts.length >= 60 && native.counts.every(t => t >= 0 && t <= 1), "real-player countUp formatter receives only [0,1] under spring(.8)");
  const ease = resolveCurve({ curve: spring });
  assert(native.frames.every(f => f.easing.startsWith("linear(")), "native WAAPI receives the spring linear() easing");
  const error = Math.max(...native.frames.map(f => Math.max(Math.abs(f.native - f.sampled), Math.abs(f.native - f.seek), Math.abs(f.native - ease.clamped(f.raw)))));
  assert(error <= .005, `native and sampled spring frames agree within 0.5% at 20 times (max ${error})`);
  assert(native.frames.every(f => Math.abs(f.paintedX - (400 + 200 * ease.fn(f.raw))) < .001), "painted same-kind content follows the overshooting wrapper without cancelling its motion");
  assert(native.frames.some(f => /translateY\(([-\d.]+)px/.test(f.transform) && Number(/translateY\(([-\d.]+)(?:px)?/.exec(f.transform)![1]) < 0), "mixed keyframes extrapolate transform while clamping opacity");
  // Named paints use the non-interpolable fallback through real SVG bindings.
  const colorDeck = createDeck({ withTitleSlide: false, stage }); colorDeck.defaults.transition = "none";
  colorDeck.slides = [{ id: "raw-color", elements: [{ type: "rect", id: "raw-color", x: 100, y: 100, width: 80, height: 60, rotation: 0, fill: "red", stroke: "none", strokeWidth: 0, cornerRadius: 0 }], beats: [
    { id: "base", tracks: [] }, { id: "change", tracks: [{ target: "raw-color", preset: "transform", duration: 1000, curve: { kind: "bezier", p: [.3, 2, .7, -1] }, to: { state: { fill: "blue" } } }] },
  ] }];
  const paints = await page.evaluate(deck => {
    const host = document.getElementById("host")!, player = (window as any).springPlayer(host, deck);
    const frames = Array.from({ length: 60 }, (_, i) => {
      player.seek(0, 1, 1000 * i / 59);
      return host.querySelector("rect")!.getAttribute("fill");
    });
    player.destroy(); return frames;
  }, colorDeck);
  const paintFlips = paints.slice(1).filter((paint, i) => paint !== paints[i]).length;
  assert(paintFlips === 1 && paints.every((paint, i) => paint === (i / 59 < .5 ? "red" : "blue")),
    `real browser named paint follows raw .5 once over 60 non-monotone samples (flips ${paintFlips})`);
  const { compileSlide } = await import("../src/lib/slide/compile");
  const compiledColor = compileSlide(colorDeck.slides[0], stage);
  assert(paints.every((paint, i) => (compiledColor.sample(1, 1000 * i / 59).elements[0] as any).fill === paint), "named-paint compiler and real SVG player agree on all 60 raw samples");
  for (const contentChange of [false, true]) for (const arc of [-1, 0, 1]) {
    const arcDeck = createDeck({ withTitleSlide: false, stage }); arcDeck.defaults.transition = "none";
    arcDeck.slides = [{ id: "arc", elements: [{ type: "rect", id: "arc", x: 100, y: 100, width: 80, height: 60, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 }], beats: [
      { id: "base", tracks: [] }, { id: "move", tracks: [{ id: "arc", target: "arc", preset: "transform", arc, easing: "linear", duration: 1000, to: { state: { x: 300, ...(contentChange ? { fill: "#d0a215", width: 120 } : {}) } } }] },
    ] }];
    const midpoint = await page.evaluate(deck => {
      const host = document.getElementById("host")!;
      const player = (window as any).springPlayer(host, deck); player.seek(0,1,500);
      const wrap = host.querySelector<HTMLElement>('[data-el-id="arc"]')!, box = wrap.getBoundingClientRect(), origin = host.getBoundingClientRect();
      const painted = wrap.querySelector("rect")!.getBoundingClientRect();
      const frame = { x: box.x-origin.x, y: box.y-origin.y, paintedX: painted.x-origin.x, paintedY: painted.y-origin.y, left: wrap.style.left, top: wrap.style.top };
      player.destroy(); return frame;
    }, arcDeck);
    assert(Math.abs(midpoint.x - 200) < .001 && Math.abs(midpoint.y - (100+50*arc)) < .001, `real browser player paints arc ${arc} apex at t=.5`);
    assert(Math.abs(midpoint.paintedX - 200) < .001 && Math.abs(midpoint.paintedY - (100+50*arc)) < .001, `painted content follows arc ${arc} with content change=${contentChange}`);
    assert(midpoint.left === "100px" && midpoint.top === "100px", "arc preserves the frozen layout box");
    await page.evaluate(deck => { (window as any).__arcPlayer?.destroy(); (window as any).__arcPlayer = (window as any).springPlayer(document.getElementById("host"), deck); (window as any).__arcPlayer.seek(0,1,500); }, arcDeck);
    await mkdir("notes/flux_animation_v2/workers/out/shots/M6", { recursive: true });
    await page.screenshot({ path: `notes/flux_animation_v2/workers/out/shots/M6/arc-${arc}-${contentChange ? "content" : "box"}.png` });
    await page.evaluate(() => (window as any).__arcPlayer.destroy());
  }
  // 2026-10-06: several transforms of ONE element share its content nodes. A later geometry
  // tween, reset to its start by the beat-change sweep (and materialized once at build), used
  // to leave its own position baked into the content's translate while an earlier transform
  // that never moved the box had no binding to repaint it — on the DNA slide half the bases
  // rested 38 px below their strand. Endpoints now paint the complete state, and a transform
  // repaints whenever another one wrote the content since.
  const seg = (y: number, h: number) => ({ y, height: h, nodes: [{ x: 0, y: 0, type: "corner" as const }, { x: 0, y: h, type: "corner" as const }], d: `M 0 0 L 0 ${h}` });
  const sharedDeck = createDeck({ withTitleSlide: false, stage }); sharedDeck.defaults.transition = "none";
  sharedDeck.slides = [{ id: "shared", elements: [{ type: "path", id: "base", x: 195, width: 0.001, rotation: 0, fill: "none", stroke: "#bc5215", strokeWidth: 2.2, closed: false, cap: "butt", ...seg(200, 17) }], beats: [
    { id: "b0", tracks: [] },
    { id: "b1", tracks: [{ id: "t1", target: "base", preset: "transform", duration: 1000, easing: "linear", to: { state: { ...seg(200, 26) } } }] },   // geometry only: the box never moves
    { id: "b2", tracks: [{ id: "t2", target: "base", preset: "transform", duration: 1000, easing: "linear", to: { state: { y: 238 } } }] },            // a pure move
    { id: "b3", tracks: [{ id: "t3", target: "base", preset: "transform", duration: 1000, easing: "linear", to: { state: { ...seg(272, 14) } } }] },   // geometry + move, same node orientation
  ] }];
  // (a string body: tsx wraps named inner functions in `__name`, which the page does not have)
  const shared = await page.evaluate(`(deck => {
    const host = document.getElementById("host"), player = window.springPlayer(host, deck), origin = host.getBoundingClientRect();
    const frames = [];
    const probe = label => { const p = host.querySelector('[data-el-id="base"] path'), r = p.getBoundingClientRect(); frames.push({ label, top: r.top - origin.top, height: r.height }); };
    player.seek(0, 1, 1000); probe("b1 end");
    player.seek(0, 3, 1000); probe("b3 end");
    player.seek(0, 1, 500); probe("b1 mid");
    player.seek(0, 1, 1000); probe("b1 end again");
    player.seek(0, 2, 1000); probe("b2 end");
    player.seek(0, 1, 0); probe("b1 start");
    player.seek(0, 2, 500); probe("b2 mid");
    player.destroy(); return frames;
  })(${JSON.stringify(sharedDeck)})`) as { label: string; top: number; height: number }[];
  const expect: Record<string, [number, number]> = { "b1 end": [200, 26], "b3 end": [272, 14], "b1 mid": [200, 21.5], "b1 end again": [200, 26], "b2 end": [238, 26], "b1 start": [200, 17], "b2 mid": [219, 26] };
  for (const f of shared) assert(Math.abs(f.top - expect[f.label][0]) < .01 && Math.abs(f.height - expect[f.label][1]) < .01, `shared content: ${f.label} paints the path at y ${expect[f.label][0]} × ${expect[f.label][1]} (got ${f.top.toFixed(2)} × ${f.height.toFixed(2)})`);
} finally { await browser.close(); }

console.log("\nALL SLIDE-PLAYER (P2) TESTS PASSED");

await h.done();
