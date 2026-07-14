#!/usr/bin/env -S npx tsx
// Phase 4 — Slide bug sweep. The behavioral fixes are tested against the pure ops/player; the
// DOM/WAAPI/component-bound ones are asserted present + covered by svelte-check.
//
//  SLD-8  (tested): morphCompatible gates topology — a morph pairs series by id and tweens points
//         in data space, so it's only meaningful when structure matches. Compatible iff a series
//         id is shared AND both sides are tweenable (points or a line). Disjoint ids, or a target
//         with neither points nor a line (a bar chart), are incompatible. The player now SKIPS an
//         incompatible morph (was a silent mis-tween) and AnimatePanel disables the target.
//  SLD-10 — SUPERSEDED by slides-are-figures (slide_migration): the slide-side
//         duplicateElements/pasteElements ops were deleted (static editing is the
//         figure editor's clipboard/duplicate). The one remaining slide-side clone
//         op that must retarget tracks — duplicateSlide — is covered by
//         verify-slide-trackid.ts.
//  SLD-11 (tested): baseCameraTransform → "" for the identity camera, a translate+scale for a
//         zoomed pose; the editor stage now seeds it (it used to reset to identity, so an
//         agent-authored zoomed slide looked wrong while editing).
//  SLD-3  (presence): animate() honours an explicit `reduce` flag that the player threads through,
//         so Present/Export force-motion + the `M` toggle work (the OS setting no longer wins).
//  SLD-7  (presence): the filmstrip freezes each thumbnail at its LAST beat, not blank beat 0.
//   Run: npx tsx scripts/verify-p4-slide.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHTML, DOMParser } from "linkedom";
import type { FluxPlotManifest, FluxPlotSeries } from "../src/lib/plot/types";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { morphCompatible } = await import("../src/lib/slide/player/morph");
const { baseCameraTransform } = await import("../src/lib/slide/player/player");

function assert(c: unknown, m: string) {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ok:", m);
}

// --- SLD-8: morphCompatible -----------------------------------------------------------------
const S = (id: string, points: boolean, line: boolean): FluxPlotSeries => ({
  id,
  svg: line ? { line: `${id}.line` } : {},
  points: points ? [{ index: 0, svgId: `${id}.p0`, x: 1, y: 1 }] : [],
});
const M = (series: FluxPlotSeries[]): FluxPlotManifest => ({
  spec: "fluxplot", schemaVersion: "1", plotType: "line", svg: "",
  size: { width: 1, height: 1, unit: "px" }, axes: [], series,
});
console.log("SLD-8 — morph topology compatibility:");
assert(morphCompatible(M([S("a", true, true)]), M([S("a", true, true)])), "shared series with points → compatible");
assert(!morphCompatible(M([S("a", true, true)]), M([S("b", true, true)])), "disjoint series ids → incompatible");
assert(!morphCompatible(M([S("a", true, true)]), M([S("a", false, false)])), "shared id but target has no points/line (bar-like) → incompatible");
assert(!morphCompatible(M([]), M([S("a", true, true)])), "empty source series → incompatible");
assert(!morphCompatible(undefined, M([S("a", true, true)])), "missing manifest → incompatible");

// --- SLD-11: base camera transform ----------------------------------------------------------
console.log("SLD-11 — base camera transform:");
const stage = { width: 1280, height: 720 };
assert(baseCameraTransform({ camera: undefined } as never, stage) === "", "no camera → empty transform");
assert(baseCameraTransform({ camera: { x: 640, y: 360, zoom: 1 } } as never, stage) === "", "identity camera (centre, zoom 1) → empty transform");
const z = baseCameraTransform({ camera: { x: 300, y: 200, zoom: 2 } } as never, stage);
assert(/scale\(2\)/.test(z) && /translate\(/.test(z), "zoomed camera → translate + scale");

// --- presence of the DOM/component-bound fixes ----------------------------------------------
console.log("presence of the DOM/component-bound fixes:");
const read = (p: string) => fs.readFile(path.join(import.meta.dirname, "..", p), "utf8");
const [motion, player, slideThumb, animatePanel] = await Promise.all([
  read("src/lib/motion/motion.ts"),
  read("src/lib/slide/player/player.ts"),
  read("src/shell/modes/slide/SlideThumb.svelte"),
  read("src/shell/modes/slide/AnimatePanel.svelte"),
]);
assert(/opts\.reduce \?\? prefersReducedMotion\(\)/.test(motion), "SLD-3: animate() honours an explicit reduce flag (falls back to OS)");
assert(/reduce: reduced/.test(player), "SLD-3: the player threads its reduced flag into animate()");
assert(/Math\.max\(0, (slide|cur)\.beats\.length - 1\)/.test(slideThumb), "SLD-7: the filmstrip freezes thumbnails at the last beat");
assert(/morphCompatible\(selManifest, m\)/.test(animatePanel), "SLD-8: AnimatePanel gates morph targets on compatibility");

console.log("\nP4 SLIDE VERIFY: PASS");
