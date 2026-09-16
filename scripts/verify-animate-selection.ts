#!/usr/bin/env -S npx tsx
// 2026-09-15 — addAppearanceTracks (pure): the ONE implementation behind the
// animator's Appear / Emphasize / Disappear buttons and the X-ray's "Animate
// selected". Every target (whole objects and plot parts, from any number of
// plots) gets its own track in the active step, stacked after that target's
// prior effects; step 0 never receives tracks (a first step is created).
//   Run: npx tsx scripts/verify-animate-selection.ts
import * as ops from "../src/lib/slide/ops";
import { addAppearanceTracks } from "../src/lib/slide/animateSelection";
import { familyOf } from "../src/lib/slide/family";
import type { Element as SlideElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const deck = ops.createDeck({ id: "t", title: "Animate selection" });
const sid = ops.addSlide(deck, { name: "S1", layout: "blank" }).id;
const slide = ops.slideById(deck, sid)!;
const rectId = ops.addElement(deck, sid, { type: "rect", id: "r1", x: 0, y: 0, width: 100, height: 80, rotation: 0, fill: "#eee", stroke: "#000", strokeWidth: 1, cornerRadius: 0 } as unknown as SlideElement)!;
const lineId = ops.addElement(deck, sid, { type: "line", id: "l1", x: 0, y: 0, width: 100, height: 0, rotation: 0, x1: 0, y1: 0, x2: 100, y2: 0, stroke: "#000", strokeWidth: 2 } as unknown as SlideElement)!;
const p1 = ops.addElement(deck, sid, { type: "plot", id: "p1", x: 0, y: 0, width: 400, height: 300, rotation: 0, assetId: "a" } as unknown as SlideElement)!;
const p2 = ops.addElement(deck, sid, { type: "plot", id: "p2", x: 0, y: 0, width: 400, height: 300, rotation: 0, assetId: "a" } as unknown as SlideElement)!;

// (1) resting step only → a first step is created and receives the tracks
assert(slide.beats.length === 1, "fixture starts with the resting step only");
const r1 = addAppearanceTracks(deck, sid, [{ elementId: rectId }, { elementId: lineId }], "appear", 0, {})!;
assert(r1 && r1.beatIndex === 1 && slide.beats.length === 2, "step 1 is created for the resting step");
assert(r1.trackIds.length === 2 && slide.beats[1].tracks.length === 2, "one track per target");
const [tr, tl] = slide.beats[1].tracks;
assert(tr.target === rectId && tr.preset === "popIn" && tl.target === lineId && tl.preset === "drawOn", "per-kind entrance defaults (rect pops, line draws on)");
assert(tr.start === 0 && tl.start === 0, "first effects start at 0");

// (2) a second appear on the same target stacks after the prior one
const r2 = addAppearanceTracks(deck, sid, [{ elementId: rectId }], "emphasize", 1, {})!;
const em = slide.beats[1].tracks.find((t) => t.id === r2.trackIds[0])!;
assert(em.preset === "highlight" && em.duration === 500, "emphasize = highlight 500ms");
assert(em.start === (tr.start ?? 0) + (tr.duration ?? 0), `stacked after the rect's entrance (start ${em.start})`);

// (3) parts of several plots: the x-axis of two plots + one series of the first
const r3 = addAppearanceTracks(
  deck,
  sid,
  [{ elementId: p1, partId: "axis.x" }, { elementId: p2, partId: "axis.x" }, { elementId: p1, partId: "control.line" }],
  "appear",
  1,
  {},
)!;
assert(r3.trackIds.length === 3, "three part targets → three tracks");
const partTracks = slide.beats[1].tracks.filter((t) => t.id && r3.trackIds.includes(t.id));
assert(partTracks.every((t) => familyOf(t) === "appearance" && !!t.part), "part tracks are appearances narrowed to the part");
assert(partTracks.map((t) => `${t.target}:${t.part}`).join(",") === "p1:axis.x,p2:axis.x,p1:control.line", "targets and parts preserved in order");

// (4) disappear uses the exit family; a missing element is skipped, never throws
const r4 = addAppearanceTracks(deck, sid, [{ elementId: lineId }, { elementId: "ghost-of-nothing" }], "disappear", 1, {})!;
assert(r4.trackIds.length === 1, "unknown targets are skipped");
const exit = slide.beats[1].tracks.find((t) => t.id === r4.trackIds[0])!;
assert(exit.preset === "drawOff" && exit.target === lineId, "line exit = drawOff");
assert(exit.start === (tl.start ?? 0) + (tl.duration ?? 0), `the exit stacks after the entrance (start ${exit.start})`);

// (5) a specific later step, and empty inputs
const b2 = ops.addBeat(deck, sid, { label: "Step 2", advance: "click" })!;
const r5 = addAppearanceTracks(deck, sid, [{ elementId: rectId }], "appear", 2, {})!;
assert(r5.beatIndex === 2 && b2.tracks.length === 1 && b2.tracks[0].start === 0, "lands in the requested step; a fresh target starts at 0");
assert(addAppearanceTracks(deck, sid, [], "appear", 1, {}) === null, "no targets → null");
assert(addAppearanceTracks(deck, "no-such-slide", [{ elementId: rectId }], "appear", 1, {}) === null, "unknown slide → null");

// (6) a shared row plus its individual counterpart is ONE target per action.
const r6 = addAppearanceTracks(deck, sid, [{ elementId: p1, partId: "axis.x" }, { elementId: p2, partId: "axis.x" },
  { elementId: p1, partId: "axis.x" }, { elementId: rectId }, { elementId: rectId }], "appear", 2, {})!;
assert(r6.trackIds.length === 3, "overlapping shared/individual picks create one track per unique target");
const p1Tracks = b2.tracks.filter((t) => t.target === p1 && t.part === "axis.x");
assert(p1Tracks.length === 1 && p1Tracks[0].start === 0, "duplicate part picks cannot create an unintended second entrance");
const later = addAppearanceTracks(deck, sid, [{ elementId: p1, partId: "axis.x" }], "emphasize", 2, {})!;
assert(later.trackIds.length === 1 && b2.tracks.find((t) => t.id === later.trackIds[0])!.start! > 0, "a separate explicit action still appends after the prior effect");

const emptyDeck = ops.createDeck({ id: "empty", title: "No targets" });
const emptySlide = ops.addSlide(emptyDeck, { name: "Empty", layout: "blank" });
assert(addAppearanceTracks(emptyDeck, emptySlide.id, [{ elementId: "gone" }], "appear", 0, {}) === null && emptySlide.beats.length === 1,
  "a stale pick cannot create an empty animation step");
console.log("VERIFY-ANIMATE-SELECTION PASS");
