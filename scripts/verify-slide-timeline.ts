#!/usr/bin/env -S npx tsx
// Deterministic inspected frames, property composition, content chains, and
// clock cancellation. The same renderer/bindings run in the offline browser gate.
import assert from "node:assert/strict";
import { parseHTML, DOMParser } from "linkedom";
const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, DOMParser });
const { createPlayer, computeSlideAnims, applyAt, applyStatic, renderStaticAt, resolveEasingFn } = await import("../src/lib/slide/player/player");
const { renderSlide } = await import("../src/lib/slide/player/render");
const { compileSlide } = await import("../src/lib/slide/compile");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
const { cachePlot } = await import("../src/lib/plot/store");
const { createDeck } = await import("../src/lib/slide/ops");
const { transformPreState } = await import("../src/lib/slide/tween");
const { compilePtTrueBindings, compensatePtTrue, restorePtTrue } = await import("../src/lib/plot/compensate");
import type { Slide } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";
const stage = { width: 640, height: 360 }, opts = { theme: FLUX_DARK };
let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log("  ok:", label); }
const rect = { id: "r", type: "rect" as const, x: 50, y: 60, width: 90, height: 70, rotation: 35, opacity: .6, fill: "#4385be", stroke: "#222222", strokeWidth: 1 };
const text = { id: "t", type: "text" as const, x: 220, y: 60, width: 280, height: 40, rotation: 0, text: "Alpha", fontFamily: "Arial", fontSize: 24, fontWeight: 400, fontStyle: "normal" as const, align: "left" as const, color: "#fff", sizing: "fixed" as const };
const host = document.createElement("div") as unknown as HTMLElement;
function build(slide: Slide) { const rendered = renderSlide(host, slide, stage, opts); return { rendered, specs: computeSlideAnims(slide, rendered, host, stage, opts) }; }
function paintedTexts(): string[] {
  return Array.from(host.querySelectorAll("text")).filter((el) => { for (let p: Element | null = el; p && p !== host; p = p.parentElement) if ((p as HTMLElement).style?.opacity === "0") return false; return true; }).map((e) => e.textContent ?? "");
}
const slide: Slide = { id: "s", elements: [rect, text], beats: [
  { id: "base", tracks: [] },
  { id: "one", tracks: [
    { id: "fade", target: "r", preset: "fadeRise", start: 100, duration: 400, easing: "linear" },
    { id: "move", target: "r", preset: "transform", duration: 800, easing: "linear", to: { state: { x: 350, rotation: 60, opacity: .4 } } },
    { id: "beta", target: "t", preset: "transform", to: { state: { text: "Beta" } } },
  ] },
  { id: "two", tracks: [{ id: "gamma", target: "t", preset: "transform", to: { state: { text: "Gamma" } } }] },
] };
{
  const { rendered, specs } = build(slide);
  const r = rendered.elements.get("r")!, effect = r.querySelector(".sl-effects") as HTMLElement;
  applyStatic(specs, 0);
  check(r.style.transform === "rotate(35deg)" && r.style.opacity === "0.6" && effect.style.opacity === "0", "future entrance retains document rotation and opacity");
  applyAt(specs, 1, 300);
  check(effect.style.opacity === "0.5" && r.style.transform.includes("translate"), "delayed entrance and spatial Change compose at the same time");
  applyStatic(specs, 2); check(paintedTexts().includes("Gamma"), "random seek to second text change paints Gamma");
  applyStatic(specs, 1); check(paintedTexts().includes("Beta") && !paintedTexts().includes("Gamma"), "reverse seek from Gamma restores Beta");
  applyStatic(specs, 0); check(paintedTexts().includes("Alpha") && !paintedTexts().includes("Gamma"), "reverse seek restores initial text");
  applyStatic(specs, 1); check(r.style.left === "350px" && r.style.transform === "rotate(60deg)" && r.style.opacity === "0.4" && effect.style.opacity === "1", "endpoint retains every authored property beneath appearance");
}
{
  const sequenced: Slide = { id: "sequence", elements: [rect], beats: [{ id: "base", tracks: [] }, { id: "cue", tracks: [
    { target: "r", preset: "fade", duration: 100, easing: "linear" },
    { target: "r", preset: "fadeOut", start: 200, duration: 100, easing: "linear" },
    { target: "r", preset: "fade", start: 400, duration: 100, easing: "linear" },
  ] }] };
  const { rendered, specs } = build(sequenced); const effect = rendered.elements.get("r")!.querySelector(".sl-effects") as HTMLElement;
  for (const [time, expected] of [[500, "1"], [300, "0"], [100, "1"], [0, "0"], [250, "0.5"], [450, "0.5"]] as const) { applyAt(specs, 1, time); check(effect.style.opacity === expected, `sequential same-cue effects seek ${time}ms → opacity ${expected}`); }
  check(compileSlide(sequenced, stage).issues.length === 0, "nonoverlapping sequential effects have no conflict diagnostic");
}
{
  const axes = [{ x: { scale: "linear", domain: [0, 1], anchors: [{ data: 0, svg: 0 }, { data: 1, svg: 100 }] }, y: { scale: "linear", domain: [0, 10], anchors: [{ data: 0, svg: 100 }, { data: 10, svg: 0 }] } }];
  const manifests: Record<string, FluxPlotManifest> = {};
  for (const [id, value, label] of [["A", 2, "Before"], ["B", 8, "During"], ["C", 4, "After"]] as const) {
    const manifest = { spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", svg: "", size: { width: 100, height: 100, unit: "px" }, axes, series: [{ id: "series", points: [{ index: 0, svgId: "p0", x: .5, y: value }] }] } as FluxPlotManifest;
    manifests[id] = manifest;
    cachePlot(id, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle id="p0" cx="50" cy="${100-value*10}" r="2"/><text id="label" x="5" y="95">${label}</text></svg>`, manifest);
  }
  const plotSlide: Slide = { id: "data", elements: [{ id: "p", type: "plot", assetId: "A", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "b", tracks: [{ target: "p", preset: "transform", to: { assetId: "B" }, easing: "linear", duration: 1000 }] }, { id: "c", tracks: [{ target: "p", preset: "transform", to: { assetId: "C" }, easing: "linear", duration: 1000 }] }] };
  const options = { ...opts, plotManifest: (id: string) => manifests[id] };
  const rendered = renderSlide(host, plotSlide, stage, options), specs = computeSlideAnims(plotSlide, rendered, host, stage, options);
  applyStatic(specs, 1); const point = host.querySelector('[id="p__p0"]')!;
  check(point.getAttribute("cy") === "20.00", "A→B ends at B's data");
  applyAt(specs, 2, 0); check(point.getAttribute("cy") === "20.00", "B→C starts exactly at B");
  applyAt(specs, 2, 500); check(point.getAttribute("cy") === "40.00", "B→C has the correct data midpoint");
  applyStatic(specs, 2); check(host.querySelector('[id="p__label"]')!.textContent === "After", "complete destination labels accompany data endpoint");
  applyStatic(specs, 0); check(point.getAttribute("cy") === "80.00" && host.querySelector('[id="p__label"]')!.textContent === "Before", "random reverse restores original data and labels");
  check((transformPreState(plotSlide, "p", 2) as { assetId: string }).assetId === "B", "effective source identity follows prior content changes");
  const saved = JSON.stringify(plotSlide); const frame = compileSlide(plotSlide, stage, options).sample(2);
  check((frame.elements[0] as { assetId: string }).assetId === "C" && JSON.stringify(plotSlide) === saved, "editor state resolves destination asset without mutating document");
}
{
  const multiline: Slide = { id: "text-layout", elements: [{ ...text, text: "Count 10\nunits", fontWeight: 300 }], beats: [{ id: "base", tracks: [] }, { id: "value", tracks: [{ target: "t", preset: "transform", duration: 1000, easing: "linear", to: { state: { text: "Count 30\nunits", fontWeight: 600, fontSize: 30 } } }] }] };
  const { specs } = build(multiline);
  applyAt(specs, 1, 500);
  const node = host.querySelector("text")!;
  check(Array.from(node.querySelectorAll("tspan")).map((s) => s.textContent).join("|") === "Count 20|units", "numeric multiline text keeps each line distinct at the midpoint");
  check(node.getAttribute("font-weight") === "500" && node.getAttribute("font-size") === "27", "compiled text uses sampled discrete weight and continuous size");
  const firstSpan = node.firstElementChild;
  applyAt(specs, 1, 600);
  check(node.firstElementChild === firstSpan && firstSpan?.textContent === "Count 22", "text frame updates preserve DOM identity");
}
{
  const manifests: Record<string, FluxPlotManifest> = {};
  for (const [id, value, domain] of [["markerA", 2, 10], ["markerB", 8, 20]] as const) {
    const cy = 100 - value * 100 / domain;
    const manifest = { spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", svg: "", size: { width: 100, height: 100, unit: "px" }, axes: [{ x: { scale: "linear", domain: [0, 1], anchors: [{ data: 0, svg: 0 }, { data: 1, svg: 100 }] }, y: { scale: "linear", domain: [0, domain], anchors: [{ data: 0, svg: 100 }, { data: domain, svg: 0 }] } }], series: [{ id: "series", points: [{ index: 0, svgId: "p0", x: .5, y: value }] }] } as FluxPlotManifest;
    manifests[id] = manifest;
    cachePlot(id, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect id="p0" x="48" y="${cy - 2}" width="4" height="4"/><text id="tick" x="5" y="10">${domain}</text></svg>`, manifest);
  }
  const data: Slide = { id: "noncircle", elements: [{ id: "p", type: "plot", assetId: "markerA", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "show", tracks: [{ target: "p", part: "p0", preset: "fade" }] }, { id: "data", tracks: [{ target: "p", preset: "transform", duration: 1000, easing: "linear", to: { assetId: "markerB" } }] }] };
  const options = { ...opts, plotManifest: (id: string) => manifests[id] };
  const rendered = renderSlide(host, data, stage, options), specs = computeSlideAnims(data, rendered, host, stage, options);
  applyAt(specs, 2, 500); const marker = host.querySelector('[id="p__p0"]') as unknown as SVGElement;
  check(marker.getAttribute("y") === "68" && marker.style.translate === "0.00px -7.50px" && marker.style.opacity === "1", "noncircle data-space midpoint composes with prior part entrance and axis rescale");
  applyStatic(specs, 2);
  check(marker.getAttribute("y") === "58" && marker.style.translate === "0.00px 0.00px" && host.querySelector('[id="p__tick"]')?.textContent === "20", "complete noncircle geometry and axis label reach target without double motion");
  applyStatic(specs, 0);
  check(marker.getAttribute("y") === "78" && marker.style.translate === "0.00px 0.00px" && marker.style.opacity === "0", "reverse seek restores marker geometry and future part hidden state");
}
{
  const counts: Slide = { id: "counts", elements: [{ ...text, text: "Participants\n42 sites" }], beats: [{ id: "base", tracks: [] }, { id: "one", tracks: [{ target: "t", preset: "countUp", easing: "linear", duration: 1000, params: { from: 5 } }] }, { id: "two", tracks: [{ target: "t", preset: "countUp", easing: "linear", duration: 1000, params: { from: 20 } }] }] };
  const { specs } = build(counts); const plan = compileSlide(counts, stage);
  for (const [beat, ms, expected] of [[0, Infinity, "5"], [2, 0, "20"], [1, 1000, "42"], [0, Infinity, "5"]] as const) {
    applyAt(specs, beat, ms);
    const displayed = host.querySelector("text")!.textContent;
    const sampled = plan.sample(beat, ms).elements[0] as typeof text;
    check(displayed === `Participants${expected} sites` && sampled.text === `Participants\n${expected} sites`, `count sequence runtime/authoring agree at step ${beat}, ${ms}ms without future baseline leakage`);
  }
}
{
  const manifests: Record<string, FluxPlotManifest> = {};
  for (const [assetId, part] of [["partsA", "first"], ["partsB", "second"]] as const) {
    const manifest = { spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", size: { width: 100, height: 100, unit: "px" }, axes: [], series: [{ id: part, points: [{ index: 0, svgId: part, x: .5, y: .5 }] }], parts: { id: "figure", role: "figure", children: [{ id: "points", role: "group", children: [{ id: part, role: "point" }] }] } } as unknown as FluxPlotManifest;
    manifests[assetId] = manifest;
    cachePlot(assetId, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle id="${part}" cx="50" cy="50" r="3"/></svg>`, manifest);
  }
  const changedParts: Slide = { id: "parts", elements: [{ id: "p", type: "plot", assetId: "partsA", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "change", tracks: [{ target: "p", preset: "transform", to: { assetId: "partsB" } }] }, { id: "build", tracks: [{ target: "p", part: "points", preset: "fade", duration: 1000, easing: "linear" }] }] };
  const options = { ...opts, plotManifest: (id: string) => manifests[id] }, plan = compileSlide(changedParts, stage, options);
  const rendered = renderSlide(host, changedParts, stage, options), specs = computeSlideAnims(changedParts, rendered, host, stage, options);
  check(plan.cues[2].tracks[0].parts.join() === "second", "part-group compiler resolves effective destination manifest after A→B");
  applyAt(specs, 2, 500); const part = host.querySelector('[id="p__second"]') as unknown as SVGElement;
  check(part?.style.opacity === "0.5" && plan.sample(2, 500).partStates.p.second.opacity === .5, "B-only semantic part reveal is bound in runtime and authoring on a fresh seek");
  applyStatic(specs, 1);
  check(part.style.opacity === "0" && !plan.sample(1).partStates.p.second.visible, "reverse seek hides the destination part before its reveal");
  const missing = structuredClone(changedParts); missing.beats[2].tracks = [{ target: "p", selector: { series: "missing" }, preset: "fadeOut" }];
  const missingPlan = compileSlide(missing, stage, options);
  check(missingPlan.issues.some((i) => /No matching plot parts/.test(i.reason)) && !missingPlan.sample(2).presentation.elementStates.p, "missing semantic selection is diagnosed and never hides the entire plot");
}
{
  const parts = [5, 1, 3, 2, 4].map((x, index) => ({ index, svgId: `p${index}`, x, y: 1 }));
  const manifest = { spec: "fluxplot", schemaVersion: "0.2.0", size: { width: 100, height: 100, unit: "px" }, axes: [], series: [{ id: "points", points: parts }] } as unknown as FluxPlotManifest;
  cachePlot("stagger-points", `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${parts.map((p) => `<circle id="${p.svgId}" cx="${p.x*10}" cy="50" data-x="${p.x}" r="3"/>`).join("")}</svg>`, manifest);
  const staggered: Slide = { id: "stagger", elements: [{ id: "p", type: "plot", assetId: "stagger-points", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "show", tracks: [{ target: "p", selector: { series: "points", role: "point" }, preset: "fade", duration: 320, easing: "linear", stagger: { from: "center", by: "x", perMs: 100 } }] }] };
  const options = { ...opts, plotManifest: () => manifest }, plan = compileSlide(staggered, stage, options);
  const rendered = renderSlide(host, staggered, stage, options), specs = computeSlideAnims(staggered, rendered, host, stage, options);
  check(plan.cues[1].duration === 520 && Math.max(...specs.map((s) => s.delay+s.duration)) === 520, "center stagger compiler and runtime end at 520ms, not a fictitious 720ms");
  applyAt(specs, 1, 50); const frame = plan.sample(1, 50);
  check(parts.every((p) => Number((host.querySelector(`[id="p__${p.svgId}"]`) as unknown as SVGElement).style.opacity) === frame.partStates.p[p.svgId].opacity), "spatial center stagger has identical per-part runtime and inspected state");
  const changed: Slide = { id: "composite", elements: [{ ...rect, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "cue", tracks: [{ target: "r", preset: "move", to: { x: 10 } }, { target: "r", preset: "transform", to: { state: { x: 100 } } }] }] };
  check(compileSlide(changed, stage).sample(1).elements[0].x === 110, "legacy appearance movement composes after Change in inspected state");
}
{
  const manifest = { spec: "fluxplot", schemaVersion: "0.2.0", size: { width: 100, height: 100, unit: "px" }, axes: [], series: [{ id: "points", points: [{ index: 0, svgId: "styled", x: 1, y: 1 }] }] } as unknown as FluxPlotManifest;
  for (const styling of ['style="opacity:0.4"', 'opacity="0.4"']) {
    cachePlot("styled-part", `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle id="styled" cx="50" cy="50" r="3" ${styling}/></svg>`, manifest);
    const styled: Slide = { id: "styled", elements: [{ id: "p", type: "plot", assetId: "styled-part", x: 0, y: 0, width: 100, height: 100, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "show", tracks: [{ target: "p", part: "styled", preset: "fade", duration: 1000, easing: "linear" }] }] };
    const options = { ...opts, plotManifest: () => manifest }, rendered = renderSlide(host, styled, stage, options), specs = computeSlideAnims(styled, rendered, host, stage, options);
    const part = host.querySelector('[id="p__styled"]') as unknown as SVGElement;
    applyAt(specs, 1, 500); check(part.style.opacity === "0.2", `part entrance factors authored ${styling} at midpoint`);
    applyStatic(specs, 1); check(part.style.opacity === "0.4", "part entrance restores authored opacity at its endpoint");
  }
  const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><defs><path d="M0 0L1 1" stroke="black"/></defs><g><text x="20" y="30" transform="rotate(20 20 30)">Label</text><g data-flux-glyph="1" transform="translate(50 40)"><path d="M-2 0L2 0" stroke="black"/></g><path id="stroke" d="M0 0L100 20" stroke="blue" stroke-width="2" stroke-dasharray="4 2"/><circle cx="50" cy="50" r="3" stroke="red" stroke-width="1"/></g></svg>', 'image/svg+xml').documentElement;
  const bound = svg.cloneNode(true) as unknown as Element, bindings = compilePtTrueBindings(bound);
  for (const [elW, elH] of [[400, 200], [300, 180], [100, 250], [200, 100]]) {
    restorePtTrue(svg); restorePtTrue(bound, bindings);
    const sizing = { elW, elH, intrinsic: { w: 200, h: 100 } };
    compensatePtTrue(svg, sizing); compensatePtTrue(bound, sizing, bindings);
    check(svg.outerHTML === bound.outerHTML, `compiled compensation matches static shared renderer exactly at ${elW}×${elH}`);
  }
}
{
  check(Math.abs(resolveEasingFn("enter")(.25) - .825623) < .0001, "custom geometry uses the named enter curve, identical to native effects");
  const invalid = structuredClone(slide); invalid.beats[1].tracks = [{ target: "r", keyframes: [{ at: 0, props: { opacity: 0 } }] }];
  const compiled = compileSlide(invalid, stage);
  check(compiled.issues.some((i) => /Custom keyframes/.test(i.reason)) && compiled.cues[1].tracks.length === 0, "unsupported custom keyframes are diagnosed, never substituted with fade");
  const { specs } = build(invalid); check(specs.length === 1, "unsupported track produces no runtime effect (unrelated valid text cue retained)");
  host.style.transform = "scale(0.2)";
  renderStaticAt(host, { ...slide, camera: { x: 100, y: 100, zoom: 2 } }, stage, 0, opts);
  check(host.style.transform === "scale(0.2)" && (host.querySelector(".sl-camera") as HTMLElement).style.transform === "translate(120px, -20px) scale(2)", "thumbnail fit scale and camera compose on separate layers");
}
{
  // A controlled clock proves restart/cancel semantics without sleeps or a
  // machine-dependent frame budget. Exactly one scheduled callback per player.
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame, oldPerf = globalThis.performance;
  let now = 0, next = 0; const scheduled = new Map<number, FrameRequestCallback>();
  Object.assign(globalThis, { performance: { now: () => now }, requestAnimationFrame: (cb: FrameRequestCallback) => { scheduled.set(++next, cb); return next; }, cancelAnimationFrame: (id: number) => scheduled.delete(id) });
  const deck = createDeck({ withTitleSlide: false }); deck.slides = [slide]; deck.defaults.transition = "none";
  const player = createPlayer(host, deck, { ...opts, reducedMotion: false });
  const frame = (time: number) => { now = time; const pending = [...scheduled.values()]; scheduled.clear(); for (const cb of pending) cb(now); };
  player.play({ slide: 0, fromBeat: 1, toBeat: 2 }); check(scheduled.size === 1, "all effects use exactly one playback clock");
  frame(200); player.pause(); const stopped = player.state().time; check(!scheduled.size && !player.state().playing, "pause cancels clock and keeps the inspected frame");
  now = 500; player.resume(); frame(600); check(player.state().time === stopped + 100, "resume excludes paused wall time");
  player.play({ slide: 0, fromBeat: 2, toBeat: 2 }); player.stop(); frame(2000); check(!player.state().playing && player.state().time === 0 && scheduled.size === 0, "stop/restart cannot receive a stale advance");
  player.destroy(); check(scheduled.size === 0, "destroy leaves no animation callback");
  Object.assign(globalThis, { requestAnimationFrame: oldRaf, cancelAnimationFrame: oldCancel, performance: oldPerf });
}
console.log(`\nSLIDE TIMELINE: PASS (${checks} assertions)`);
