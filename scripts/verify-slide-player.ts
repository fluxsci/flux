#!/usr/bin/env -S npx tsx
// P2 — the player's deterministic engine (§5.2). With a linkedom DOM (no WAAPI),
// verify the parts that export frame-stepping + thumbnails depend on: the slide's
// tracks flatten to the right per-node specs, stagger spreads delays, and the
// static-state at any beat reveals exactly the right set (an element/block is
// hidden until its intro beat, shown after — accumulated per property).
// Run: npx tsx scripts/verify-slide-player.ts
import { parseHTML } from "linkedom";
import { computeSlideAnims, applyStatic, resolveEasing } from "../src/lib/slide/player/player";
import { FLUX_DARK } from "../src/lib/slide/theme";
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

// A fake rendered slide: a title wrapper + a bullets wrapper holding 3 .sl-block.
function el(id: string): HTMLElement {
  const d = document.createElement("div");
  d.dataset.elId = id;
  return d as unknown as HTMLElement;
}
const title = el("t_title");
const bullets = el("t_body");
for (const bid of ["b1", "b2", "b3"]) {
  const b = document.createElement("div");
  b.className = "sl-block";
  b.dataset.blockId = bid;
  bullets.appendChild(b);
}
const rendered: RenderedSlide = { elements: new Map([["t_title", title], ["t_body", bullets]]) };
const camera = el("camera");

// A slide: beat0 base, beat1 fadeRise the title, beat2 stagger-reveal the bullets.
const slide: Slide = {
  id: "s1",
  elements: [
    { type: "textBox", id: "t_title", x: 0, y: 0, width: 800, height: 100, rotation: 0, blocks: [{ id: "h", text: "Title" }] },
    { type: "textBox", id: "t_body", x: 0, y: 120, width: 800, height: 300, rotation: 0, blocks: [{ id: "b1", text: "one" }, { id: "b2", text: "two" }, { id: "b3", text: "three" }] },
  ],
  beats: [
    { id: "k0", label: "base", tracks: [] },
    { id: "k1", label: "title", tracks: [{ target: "t_title", preset: "fadeRise", start: 0, duration: 320 }] },
    { id: "k2", label: "bullets", tracks: [{ target: "t_body", selector: { blocks: "all" }, preset: "stagger", start: 0, duration: 320, stagger: { perMs: 100 } }] },
  ],
};

const specs = computeSlideAnims(slide, rendered, camera, stage, opts);

// --- spec shape --------------------------------------------------------------
assert(specs.length === 4, "4 specs (1 title + 3 bullet blocks)");
const titleSpec = specs.find((s) => s.node === title)!;
assert(titleSpec.beatIndex === 1 && titleSpec.enter, "title spec is an enter on beat 1");
const blockSpecs = specs.filter((s) => s.node !== title).sort((a, b) => a.delay - b.delay);
assert(blockSpecs.length === 3 && blockSpecs.every((s) => s.beatIndex === 2 && s.enter), "3 bullet enter specs on beat 2");
assert(JSON.stringify(blockSpecs.map((s) => s.delay)) === JSON.stringify([0, 100, 200]), "stagger spreads delays 0/100/200ms");

const opacity = (n: HTMLElement) => (n.style as unknown as { opacity?: string }).opacity ?? "";

// --- static state determinism (the export/thumbnail substrate) ---------------
applyStatic(specs, 0);
assert(opacity(title) === "0" && opacity(bullets.children[0] as unknown as HTMLElement) === "0", "beat 0: title + bullets hidden (before their intro)");

applyStatic(specs, 1);
assert(opacity(title) === "1", "beat 1: title shown");
assert(opacity(bullets.children[0] as unknown as HTMLElement) === "0", "beat 1: bullets still hidden (intro is beat 2)");

applyStatic(specs, 2);
assert(opacity(title) === "1" && opacity(bullets.children[2] as unknown as HTMLElement) === "1", "beat 2: title + all bullets shown");

// back-nav determinism: re-applying an earlier beat re-hides
applyStatic(specs, 0);
assert(opacity(bullets.children[2] as unknown as HTMLElement) === "0", "back to beat 0 re-hides the bullets (reversible/O(1))");

// --- draw-on static-state regression (anim 0.3) ------------------------------
// A draw-on part must rest UNDRAWN (strokeDasharray set + strokeDashoffset=len)
// before its beat — not fully drawn. Guards the prep()-after-clearAnimStyles
// ordering in applyStatic (the bug: clear wiped prep's dash-array → drawn).
const lineNode = el("ln_line");
const drawSlide: Slide = {
  id: "s2",
  elements: [{ type: "textBox", id: "ln_line", x: 0, y: 0, width: 400, height: 100, rotation: 0, blocks: [{ id: "x", text: "line" }] }],
  beats: [
    { id: "d0", label: "base", tracks: [] },
    { id: "d1", label: "draw", tracks: [{ target: "ln_line", preset: "drawOn", start: 0, duration: 800 }] },
  ],
};
const drawSpecs = computeSlideAnims(drawSlide, { elements: new Map([["ln_line", lineNode]]) }, camera, stage, opts);
const dash = (n: HTMLElement) => (n.style as unknown as { strokeDasharray?: string }).strokeDasharray ?? "";
const offset = (n: HTMLElement) => (n.style as unknown as { strokeDashoffset?: string }).strokeDashoffset ?? "";
applyStatic(drawSpecs, 0);
assert(dash(lineNode) !== "" && offset(lineNode) !== "" && offset(lineNode) !== "0", "beat 0: draw-on part rests UNDRAWN (dasharray set + offset=len) — the static-state fix");
applyStatic(drawSpecs, 1);
assert(offset(lineNode) === "0", "beat 1: draw-on part fully drawn (offset 0)");
applyStatic(drawSpecs, 0);
assert(offset(lineNode) !== "0" && offset(lineNode) !== "", "back to beat 0 re-hides the draw (reversible)");

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

// --- easing resolution -------------------------------------------------------
assert(resolveEasing("smooth").startsWith("linear("), "smooth → manim smoothstep linear() string");
assert(resolveEasing("linear") === "linear" && resolveEasing(undefined).startsWith("cubic-bezier"), "linear + default easings resolve");

console.log("\nALL SLIDE-PLAYER (P2) TESTS PASSED");
