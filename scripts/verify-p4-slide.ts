#!/usr/bin/env -S npx tsx
// Phase 4 — Slide bug sweep. The behavioral fixes are tested against the pure ops/player; the
// DOM/WAAPI/component-bound ones are asserted present + covered by svelte-check.
//
//  SLD-8  (tested): morphCompatible gates topology — a morph pairs series by id and tweens points
//         in data space, so it's only meaningful when structure matches. Compatible iff a series
//         id is shared AND both sides are tweenable (points or a line). Disjoint ids, or a target
//         with neither points nor a line (a bar chart), are incompatible. The player now SKIPS an
//         incompatible morph (was a silent mis-tween) and AnimatePanel disables the target.
//  SLD-10 (tested): duplicateElements + pasteElements carry the source element's animation tracks
//         (retargeted to the copy, fresh track ids) so a duplicated/pasted animated element keeps
//         its animation. paste maps tracks by beat index and drops out-of-range beats.
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
const slideOps = await import("../src/lib/slide/ops");

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

// --- SLD-10: duplicate/paste carry animation tracks -----------------------------------------
console.log("SLD-10 — duplicate/paste carry animation tracks:");
const deck = slideOps.createDeck({ id: "d", title: "d" });
const sid = slideOps.addSlide(deck, { name: "s", layout: "blank" }).id;
const el = slideOps.addTextBox(deck, sid, { x: 0, y: 0, width: 100, height: 40, blocks: [slideOps.makeBlock("hi")] })!;
const beat = slideOps.addBeat(deck, sid, { label: "b1", advance: "click" })!;
slideOps.setAnimation(deck, sid, beat.id, { target: el, preset: "fade", duration: 300 });
const origTrack = slideOps.slideById(deck, sid)!.beats.find((b) => b.id === beat.id)!.tracks.find((t) => t.target === el)!;

const dupIds = slideOps.duplicateElements(deck, sid, [el]);
const beatAfter = slideOps.slideById(deck, sid)!.beats.find((b) => b.id === beat.id)!;
const carried = beatAfter.tracks.find((t) => t.target === dupIds[0]);
assert(!!carried, "duplicateElements carries the element's track onto the copy");
assert(carried!.id !== origTrack.id && carried!.preset === origTrack.preset, "the carried track has a FRESH id but the same preset");
assert(beatAfter.tracks.filter((t) => t.target === el).length === 1, "the original element's track is untouched");

// paste into a fresh slide, mapping tracks by beat index (beat 0 exists; beat 5 does not → drop)
const sid2 = slideOps.addSlide(deck, { name: "s2", layout: "blank" }).id;
const srcEl = slideOps.slideById(deck, sid)!.elements.find((e) => e.id === el)!;
const pasteIds = slideOps.pasteElements(deck, sid2, [srcEl], 24, 24, [
  { beatIndex: 0, track: origTrack },
  { beatIndex: 5, track: origTrack },
]);
const s2 = slideOps.slideById(deck, sid2)!;
const pastedTracks = s2.beats.flatMap((b) => b.tracks).filter((t) => t.target === pasteIds[0]);
assert(s2.beats.length < 6, "sanity: the target slide has fewer than 6 beats");
assert(pastedTracks.length === 1, "pasteElements re-attaches ONE track (beat 0 present; beat 5 dropped)");
assert(pastedTracks[0].id !== origTrack.id, "the pasted track has a fresh id, retargeted to the copy");

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
const [motion, player, slideMode, slideStage, animatePanel] = await Promise.all([
  read("src/lib/motion/motion.ts"),
  read("src/lib/slide/player/player.ts"),
  read("src/shell/modes/slide/SlideMode.svelte"),
  read("src/shell/modes/slide/SlideStage.svelte"),
  read("src/shell/modes/slide/AnimatePanel.svelte"),
]);
assert(/opts\.reduce \?\? prefersReducedMotion\(\)/.test(motion), "SLD-3: animate() honours an explicit reduce flag (falls back to OS)");
assert(/reduce: reduced/.test(player), "SLD-3: the player threads its reduced flag into animate()");
assert(/beat=\{Math\.max\(0, s\.beats\.length - 1\)\}/.test(slideMode), "SLD-7: the filmstrip freezes thumbnails at the last beat");
assert(/cam\.style\.transform = baseCameraTransform\(slide, stage\)/.test(slideStage), "SLD-11: the editor stage seeds the base camera pose");
assert(/morphCompatible\(selManifest, m\)/.test(animatePanel), "SLD-8: AnimatePanel gates morph targets on compatibility");

console.log("\nP4 SLIDE VERIFY: PASS");
