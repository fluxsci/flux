#!/usr/bin/env -S npx tsx
// P2 — the player's deterministic engine (§5.2). With a linkedom DOM (no WAAPI),
// verify the parts that export frame-stepping + thumbnails depend on: the slide's
// tracks flatten to the right per-node specs, stagger spreads delays, and the
// static-state at any beat reveals exactly the right set (an element/block is
// hidden until its intro beat, shown after — accumulated per property).
// Run: npx tsx scripts/verify-slide-player.ts
import { parseHTML } from "linkedom";
import { computeSlideAnims, applyStatic, resolveEasing } from "../src/lib/slide/player/player";
import { PRESETS } from "../src/lib/slide/player/presets";
import { FLUX_DARK } from "../src/lib/slide/theme";
import type { Track } from "../src/lib/slide/types";
import type { RenderedSlide } from "../src/lib/slide/player/render";
import type { Slide, StageSize } from "../src/lib/slide/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
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
assert(offset(geoNode) === "0", "beat 1: draw-on part fully drawn (offset 0, overshot dash covers the true perimeter)");
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

console.log("\nALL SLIDE-PLAYER (P2) TESTS PASSED");
