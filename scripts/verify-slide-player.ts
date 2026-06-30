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

// --- easing resolution -------------------------------------------------------
assert(resolveEasing("smooth").startsWith("linear("), "smooth → manim smoothstep linear() string");
assert(resolveEasing("linear") === "linear" && resolveEasing(undefined).startsWith("cubic-bezier"), "linear + default easings resolve");

console.log("\nALL SLIDE-PLAYER (P2) TESTS PASSED");
