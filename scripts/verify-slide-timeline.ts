#!/usr/bin/env -S npx tsx
// Deterministic inspected frames, property composition, content chains, and
// clock cancellation. The same renderer/bindings run in the offline browser gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-timeline");
function check(value: unknown, label: string) { h.ok(value, label); assert.ok(value, label); }
const rect = { id: "r", type: "rect" as const, x: 50, y: 60, width: 90, height: 70, rotation: 35, opacity: .6, fill: "#4385be", stroke: "#222222", strokeWidth: 1 };
const text = { id: "t", type: "text" as const, x: 220, y: 60, width: 280, height: 40, rotation: 0, text: "Alpha", fontFamily: "Arial", fontSize: 24, fontWeight: 400, fontStyle: "normal" as const, align: "left" as const, color: "#fff", sizing: "fixed" as const };
const host = document.createElement("div") as unknown as HTMLElement;
function build(slide: Slide) { const rendered = renderSlide(host, slide, stage, opts); return { rendered, specs: computeSlideAnims(slide, rendered, host, stage, opts) }; }
function paintedTexts(): string[] {
  // Unpainted = an ancestor at opacity 0 (crossfade layers) or hidden (the text
  // morph's idle A / span / B layers, 2026-10-02).
  return Array.from(host.querySelectorAll("text")).filter((el) => { for (let p: Element | null = el; p && p !== host; p = p.parentElement) if ((p as HTMLElement).style?.opacity === "0" || (p as HTMLElement).style?.visibility === "hidden") return false; return true; }).map((e) => e.textContent ?? "");
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
  const manifest = JSON.parse(readFileSync("scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.fluxplot.json", "utf8"));
  const plot = { id: "boxplot", type: "plot" as const, assetId: "boxes", x: 260, y: 40, width: 240, height: 180, rotation: 0 };
  const destination = { element: plot.id, parts: ["axis.x.spine", "axis.y.spine"] };
  const become = { id: "handoff", target: "r", preset: "transform" as const, start: 100, duration: 600, easing: "linear" as const,
    to: { become: { ref: destination, mode: "handoff" as const, pair: "auto" as const, reveal: "flip" as const }, state: {} } };
  const handoff: Slide = { id: "handoff", elements: [{ ...rect, rotation: 0 }, plot, text], beats: [
    { id: "base", tracks: [] }, { id: "before", tracks: [] }, { id: "land", tracks: [become] },
    { id: "dim", tracks: [{ id: "dim-spines", target: plot.id, parts: destination.parts, preset: "dim", duration: 300 }] },
    { id: "later", tracks: [] },
  ] };
  const options = { plotManifest: () => manifest }, plan = compileSlide(handoff, stage, options);
  const state = (beat: number, ms = Infinity) => plan.sample(beat, ms);
  const visible = (beat: number, ms: number, source: boolean, dest: boolean) => {
    const f = state(beat, ms);
    check((f.presentation.elementStates.r?.visible ?? true) === source && destination.parts.every(p => f.partStates[plot.id][p].visible === dest), `hand-off source/destination visibility at ${beat}:${ms} is ${source}/${dest}`);
  };
  visible(0, Infinity, true, false); visible(1, Infinity, true, false);
  visible(2, 99, true, false); visible(2, 100, true, false); visible(2, 400, false, false);
  visible(2, 700, false, true); visible(4, Infinity, false, true);
  visible(0, Infinity, true, false); visible(2, 400, false, false); visible(2, 700, false, true);
  // Curve and raw progress travel together through the real compiler.
  for (const jump of ["start", "end"] as const) {
    const stepped = structuredClone(handoff);
    stepped.beats[2].tracks[0].curve = { kind: "steps", n: 1, jump };
    const compiled = compileSlide(stepped, stage, options);
    for (const [ms, source, dest] of [[100, true, false], [101, false, false], [400, false, false], [699, false, false], [700, false, true], [100, true, false]] as const) {
      const frame = compiled.sample(2, ms);
      check(frame.presentation.elementStates.r.visible === source && destination.parts.every(p => frame.partStates[plot.id][p].visible === dest), `steps(1,${jump}) hand-off visibility reads raw progress at ${ms}ms, including reverse seek`);
    }
  }
  check(destination.parts.every(p => Math.abs(state(3).partStates[plot.id][p].opacity - .3) < 1e-12), "a later dim composes with the hand-off's visible destination");
  check(JSON.stringify(plan.preState("r", 4)) === JSON.stringify(handoff.elements[0]) && JSON.stringify(state(2, 400).elements[0]) === JSON.stringify(handoff.elements[0]), "hand-off preserves source props before, during and after flight");
  check(plan.handoffs.length === 1 && plan.handoffs[0].trackId === "handoff" && plan.handoffs[0].beat === 2 && plan.handoffs[0].source[0].elementId === "r" && plan.handoffs[0].destination[0].partIds?.join() === destination.parts.join(), "the public compiled handoffs field exposes the resolved source and destination once");
  const partSource = structuredClone(handoff);
  partSource.beats[2].tracks[0] = { ...become, target: plot.id, part: "peaches.box", to: { state: {}, become: { ref: { element: "r" }, mode: "handoff" } } };
  const partPlan = compileSlide(partSource, stage, options);
  check(partPlan.sample(0).presentation.elementStates.r.visible === false && partPlan.sample(2).partStates[plot.id]["peaches.box"].visible === false && partPlan.sample(2).presentation.elementStates.r.visible === true && !partPlan.sample(2).presentation.elementStates[plot.id], "part-set sources hide only their leaves, retaining the owning plot");
  const prior = structuredClone(handoff);
  prior.beats[1].tracks = [{ target: plot.id, parts: destination.parts, preset: "fade" }];
  const priorPlan = compileSlide(prior, stage, options);
  check(priorPlan.issues.length === 0 && destination.parts.every(p => priorPlan.sample(1).partStates[plot.id][p].visible), "an earlier enter may reveal the destination before a later hand-off without an issue");
  const emphasis = structuredClone(handoff);
  emphasis.beats[1].tracks = [{ target: plot.id, parts: destination.parts, preset: "dim" }];
  emphasis.beats[3].tracks = [{ target: "r", preset: "dim" }];
  const emphasisPlan = compileSlide(emphasis, stage, options);
  check(!emphasisPlan.sample(1).partStates[plot.id][destination.parts[0]].visible && !emphasisPlan.sample(3).presentation.elementStates.r.visible, "emphasis cannot reveal an unlanded destination or a departed source");
  emphasis.beats[3].tracks = [{ target: "r", preset: "fade" }];
  check(compileSlide(emphasis, stage, options).sample(3).presentation.elementStates.r.visible, "a later entrance may explicitly reveal the departed source again");
  const reverse = structuredClone(handoff);
  reverse.beats[3].tracks = [{ id: "reverse", target: plot.id, parts: destination.parts, preset: "transform", to: { state: {}, become: { ref: { element: "r" }, mode: "handoff" } } }];
  const reversePlan = compileSlide(reverse, stage, options);
  check(reversePlan.sample(0).presentation.elementStates.r.visible && reversePlan.sample(3).presentation.elementStates.r.visible && !reversePlan.sample(3).partStates[plot.id][destination.parts[0]].visible, "Become back preserves the original source baseline and restores it at the reverse landing");
  const disabled = structuredClone(handoff); disabled.beats[2].tracks[0].disabled = true;
  const disabledPlan = compileSlide(disabled, stage, options);
  check(disabledPlan.handoffs.length === 0 && !disabledPlan.sample(0).presentation.elementStates.r && disabledPlan.sample(0).partStates[plot.id][destination.parts[0]].visible, "disabled hand-offs never claim a destination baseline or hide the source");
  const zero = structuredClone(handoff); zero.beats[2].tracks[0].duration = 0;
  check(compileSlide(zero, stage, options).sample(2, 100).partStates[plot.id][destination.parts[0]].visible, "a zero-duration hand-off lands at its start time");
  const issuesFor = (s: Slide) => compileSlide(s, stage, options).issues.map(i => i.reason).join("\n");
  const missing = structuredClone(handoff); missing.elements = missing.elements.filter(e => e.id !== plot.id);
  check(/Destination parts not found. Retarget this Become./.test(issuesFor(missing)), "missing destination element is diagnosed");
  const missingParts = structuredClone(handoff); missingParts.beats[2].tracks[0].to!.become!.ref.parts = ["absent"];
  check(/Destination parts not found/.test(issuesFor(missingParts)), "missing literal destination leaves are diagnosed against the manifest");
  const overlap = structuredClone(handoff);
  overlap.beats[2].tracks.push({ ...structuredClone(become), id: "second", target: "t", to: { state: {}, become: { ref: { element: plot.id, parts: ["axis.x"] }, mode: "handoff" } } });
  check(/already lands/.test(issuesFor(overlap)) && compileSlide(overlap, stage, options).handoffs.length === 1, "a second landing on an overlapping expanded leaf set is diagnosed and excluded");
  const unborn = structuredClone(handoff); unborn.beats[3].tracks = [{ id: "birth", target: plot.id, ghostFrom: "r", preset: "transform", to: { state: {} } }];
  check(/destination is not yet born/.test(issuesFor(unborn)), "a destination born at a later step is diagnosed");
  const textPair: Slide = { id: "text-pair", elements: [text, { ...text, id: "other" }], beats: [{ id: "b0", tracks: [] }, { id: "b1", tracks: [{ id: "text-flight", target: "t", preset: "transform", to: { state: {}, become: { ref: { element: "other" }, mode: "handoff" } } }] }] };
  // Superseded 2026-10-02 (oct2 W3): two whole texts play the glyph-matched text
  // morph; text ↔ raster below still reports the box fade.
  check(!/Neither side of this Become has an outline/.test(issuesFor(textPair)), "a text ↔ text hand-off is a text morph, not a reported crossfade");
  const imagePair = structuredClone(textPair); imagePair.elements[1] = { id: "other", type: "image", assetId: "image", x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  check(/Neither side/.test(issuesFor(imagePair)), "text-to-raster also reports the non-outline fallback");
  const labelOnly = structuredClone(handoff);
  labelOnly.beats[2].tracks[0] = { id: "labels", target: "t", preset: "transform", to: { state: {}, become: { ref: { element: plot.id, parts: ["axis.y.title"] }, mode: "handoff" } } };
  const { preparePlot } = await import("../src/lib/plot/parse");
  const prepared = preparePlot(readFileSync("scripts/fixtures/plots/mpl_boxplot_FLUXPLOT.svg", "utf8"), manifest);
  const labelPlan = compileSlide(labelOnly, stage, { ...options, plotRoot: () => prepared.root ?? undefined });
  check(labelPlan.issues.some(i => /Neither side/.test(i.reason)), "prepared plot text parts use the geometry bridge's informational crossfade diagnostic");
  imagePair.elements[0] = { ...rect, id: "t" };
  check(!/Neither side/.test(issuesFor(imagePair)), "one drawn outline is sufficient to avoid the both-sides diagnostic");
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
{
  const deck = createDeck({ withTitleSlide: false });
  deck.animStyles = [{ id: "shared", name: "Fade", family: "appearance", track: { preset: "fade", duration: 200, easing: "linear" } }];
  const anchored: Slide = { id: "anchors", elements: [{ ...rect, rotation: 0 }], beats: [{ id: "base", tracks: [] }, { id: "cue", tracks: [
    { id: "prior", target: "r", preset: "transform", duration: 100, to: { state: { x: 80 } } },
    { id: "follower", target: "r", styleId: "shared", anchor: { trackId: "prior", edge: "end" } },
  ] }] };
  deck.slides = [anchored];
  const options = { ...opts, animStyles: deck.animStyles };
  const compiled = compileSlide(anchored, stage, options);
  const rendered = renderSlide(host, compiled.resolvedSlide, stage, options);
  // Explicit compiled input must be the only timing/preset source of the binding.
  const specs = computeSlideAnims(anchored, rendered, host, stage, options, compiled);
  const effect = rendered.elements.get("r")!.querySelector(".sl-effects") as HTMLElement;
  applyAt(specs, 1, 99); check(effect.style.opacity === "0", "anchored entrance is hidden at its anchor end minus 1ms");
  applyAt(specs, 1, 101); check(Math.abs(Number(effect.style.opacity) - .005) < 1e-9, "anchored entrance begins at the resolved end plus 1ms");
  check(compiled.cues[1].duration === 300 && specs.find(s => s.trackId === "follower")?.duration === 200, "compiler and binding inherit the styled duration");
  applyAt(specs, 1, 99); check(effect.style.opacity === "0", "reverse seek across an anchor restores the pre-start state");
}
// M2 channel law through the public compiler: the box overshoots, data does not.
{
  const spring = { kind: "spring", bounce: .8 } as const;
  const springSlide: Slide = { id: "spring-compile", elements: [
    { ...rect, x: 400, rotation: 350, opacity: 0, fill: "#000000" },
    { id: "plot", type: "plot", assetId: "data", x: 0, y: 0, width: 100, height: 80, rotation: 0, contentScale: 1, view: { x: { domain: [0, 10] } } },
    { ...text, text: "100%" },
  ], beats: [{ id: "base", tracks: [] }, { id: "spring", tracks: [
    { target: "r", preset: "transform", duration: 1000, curve: spring, to: { state: { x: 600, rotation: 10, width: 0, height: 0, opacity: 1, fill: "#ffffff", strokeWidth: 0 } } },
    { target: "plot", preset: "transform", duration: 1000, curve: spring, to: { state: { contentScale: .01, view: { x: { domain: [2, 4] } } } } },
    { target: "plot", part: "data.point", preset: "fade", duration: 1000, curve: spring },
    { target: "t", preset: "countUp", duration: 1000, curve: spring, params: { to: 100 } },
    { target: "@camera", preset: "camera", duration: 1000, curve: spring, to: { x: 0, y: 0, zoom: .01 } },
  ] }] };
  const manifest = { axes: [], series: [], parts: { id: "figure", children: [{ id: "data.point", role: "point" }] } } as unknown as FluxPlotManifest;
  const compiled = compileSlide(springSlide, stage, { plotManifest: () => manifest });
  let peak = 0, bounded = true, cameraPositive = true, cameraOvershoots = false, positiveBox = true, rotationOvershoots = false, scaleFloor = false;
  for (let i = 0; i < 60; i++) {
    const f = compiled.sample(1, 1000 * i / 59), r = f.elements[0], p = f.elements[1] as import("../src/lib/types").SemanticPlotElement;
    peak = Math.max(peak, r.x); rotationOvershoots ||= r.rotation > 370;
    positiveBox &&= r.width >= 0 && r.height >= 0; scaleFloor ||= p.contentScale === .01 && r.x > 600;
    const domain = p.view!.x!.domain!, alpha = f.partStates.plot["data.point"].opacity;
    bounded &&= r.opacity! >= 0 && r.opacity! <= 1 && /^#[0-9a-f]{6}$/i.test((r as any).fill) && (r as any).strokeWidth >= 0 && (r as any).strokeWidth <= 1 &&
      domain[0] >= 0 && domain[0] <= 2 && domain[1] >= 4 && domain[1] <= 10 && alpha >= 0 && alpha <= 1 &&
      Number((f.elements[2] as any).text.replace("%", "")) <= 100;
    // The camera is a physical channel (§1.4): geometric zoom takes the unclamped
    // curve, so it may pass its target, but zoom never reaches 0.
    cameraPositive &&= f.camera!.zoom > 0 && Number.isFinite(f.camera!.x) && Number.isFinite(f.camera!.y);
    cameraOvershoots ||= f.camera!.zoom < .01;
  }
  check(peak >= 605 && rotationOvershoots, `compiler extrapolates only box motion with shortest-arc rotation (x peak ${peak.toFixed(3)})`);
  check(bounded, "compiler spring opacity, colour, stroke, parts, countUp and plot view stay bounded at 60 samples");
  check(positiveBox && scaleFloor, "compiler floors extrapolated size at zero and contentScale at .01");
  check(cameraPositive && cameraOvershoots, "the spring camera zooms past its .01 target and zoom stays positive (geometric, unclamped curve)");
  const end = compiled.sample(1).elements[0];
  check(end.x === 600 && end.rotation === 10 && end.width === 0 && end.height === 0, "compiler lands on exact authored endpoints");
  const { overshootBox } = await import("../src/lib/slide/tween");
  check([0, .25, 1].every(u => overshootBox(end, springSlide.elements[0], end, u) === end), "overshootBox preserves the same sampled reference in range");
}
// M6: sample and the exported player share curved box motion and raw discrete decisions.
{
  for (const arc of [-1, 0, 1]) {
    const source = { ...rect, x: 100, y: 100, rotation: 0, flipX: false };
    const slide: Slide = { id: "arc", elements: [source], beats: [{ id: "base", tracks: [] }, { id: "motion", tracks: [
      { id: "arc", target: source.id, preset: "transform", arc, easing: "linear", duration: 1000, to: { state: { x: 300, flipX: true } } },
    ] }] };
    const d = createDeck({ withTitleSlide: false, stage }); d.defaults.transition = "none"; d.slides = [slide];
    const mount = document.createElement("div") as unknown as HTMLElement;
    const p = createPlayer(mount, d, { ...opts, reducedMotion: true });
    const compiled = compileSlide(slide, stage);
    for (const time of [500, 1000, 0, 750, 250]) {
      p.seek(0, 1, time);
      const box = mount.querySelector<HTMLElement>('[data-el-id="r"]')!, el = compiled.sample(1,time).elements[0];
      // At the discrete flip the wrapper is centre-conjugated; use the model for
      // position, and assert the actual composite branch/flip on the live node.
      check((time === 0 || time === 1000) || box.style.transform.includes("translate"), "arc flight stays on the composite placement path");
      check(box.style.transform.includes("scaleX(-1)") === (time >= 500), "player flips the wrapper at raw halfway");
      check(Math.abs(el.x - (100 + 200*time/1000)) < 1e-9 && Math.abs(el.y - (100 + arc*200*(time/1000)*(1-time/1000))) < 1e-9, "compiler samples the quadratic position");
    }
    const curve = { kind: "bezier", p: [.3,2,.7,-1] } as const;
    p.destroy();
    slide.beats[1].tracks[0].curve = curve as any;
    const saved = JSON.parse(JSON.stringify(d));
    const q = createPlayer(mount, saved, { ...opts, reducedMotion: true });
    const c = compileSlide(saved.slides[0], stage);
    const observed: boolean[] = [];
    for (let i=0; i<60; i++) {
      const raw = i/59; q.seek(0,1,raw*1000);
      observed.push(mount.querySelector<HTMLElement>('[data-el-id="r"]')!.style.transform.includes("scaleX(-1)"));
      check(c.sample(1,raw*1000).elements[0].flipX === (raw >= .5), "persisted non-monotone curve keeps compiler discrete state raw");
    }
    check(observed.every((v,i) => v === (i/59 >= .5)) && observed.slice(1).filter((v,i) => v !== observed[i]).length === 1, "real player flips exactly once over 60 non-monotone frames");
    q.destroy();
  }
}

// Integration regression: M6 raw discrete state must reach E2's attribute bindings.
{
  const line = { id: "raw-cap", type: "line" as const, x: 100, y: 100, width: 200, height: 20, rotation: 0, x1: 0, y1: 0, x2: 200, y2: 20, stroke: "#222222", strokeWidth: 3, arrowStart: false, arrowEnd: false, cap: "butt" as const };
  const slide: Slide = { id: "raw-content", elements: [line], beats: [{ id: "base", tracks: [] }, { id: "motion", tracks: [
    { id: "raw-cap", target: line.id, preset: "transform", duration: 1000, curve: { kind: "bezier", p: [.3, 2, .7, -1] }, to: { state: { cap: "round" } } },
  ] }] };
  const d = createDeck({ withTitleSlide: false, stage }); d.defaults.transition = "none"; d.slides = [slide];
  const mount = document.createElement("div") as unknown as HTMLElement;
  const p = createPlayer(mount, d, { ...opts, reducedMotion: true }), c = compileSlide(slide, stage);
  const frames = Array.from({ length: 60 }, (_, i) => {
    const raw = i / 59; p.seek(0, 1, raw * 1000);
    return { raw, model: (c.sample(1, raw * 1000).elements[0] as any).cap, painted: mount.querySelector('line')?.getAttribute('stroke-linecap') };
  });
  p.destroy();
  const flips = frames.slice(1).filter((f, i) => f.painted !== frames[i].painted).length;
  check(flips === 1 && frames.every(f => f.painted === f.model), `painted discrete cap agrees with raw compiler state, one flip (observed ${flips})`);
}

console.log(`\nSLIDE TIMELINE: PASS (${h.checks} assertions)`);

await h.done();
