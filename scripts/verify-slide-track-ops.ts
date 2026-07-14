#!/usr/bin/env -S npx tsx
// WS2 — the timeline's direct-manipulation ops + the NON-DESTRUCTIVE tri-state.
// Pure model tests (no DOM): move/duplicate/reorder/enable tracks, beat guards,
// mask-disables-instead-of-deletes, setPartStyle, per-kind element tracks,
// morph authoring + the shared compatibility gate.
// Run: npx tsx scripts/verify-slide-track-ops.ts
import * as ops from "../src/lib/slide/ops";
import { suggestElementTrack, animateElement, animatePart, listMorphCandidates } from "../src/lib/slide/autobuild";
import type { Track } from "../src/lib/slide/types";
import type { Element as SlideElement } from "../src/lib/types";
import type { FluxPlotManifest } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const deck = ops.createDeck({ id: "t", title: "Track ops" });
const sid = ops.addSlide(deck, { name: "S1" }).id;
const slide = ops.slideById(deck, sid)!;

// --- beat guards -------------------------------------------------------------
const bAt0 = ops.addBeat(deck, sid, { label: "sneaky", at: 0 })!;
assert(slide.beats[0].id !== bAt0.id && slide.beats[1].id === bAt0.id, "addBeat at:0 is clamped — resting beat 0 stays first");
const b1 = bAt0; // index 1
const b2 = ops.addBeat(deck, sid, { label: "B2" })!;
const b3 = ops.addBeat(deck, sid, { label: "B3" })!;
ops.reorderBeats(deck, sid, [b3.id, slide.beats[0].id, b1.id, b2.id]); // tries to demote beat 0
assert(slide.beats[0].tracks !== undefined && slide.beats.map((b) => b.id).join(",") === [slide.beats[0].id, b3.id, b1.id, b2.id].join(","), "reorderBeats pins beat 0, permutes the rest");
ops.reorderBeats(deck, sid, [b1.id]); // partial permutation → unlisted keep order at tail
assert(slide.beats.map((b) => b.id).slice(1).join(",") === [b1.id, b3.id, b2.id].join(","), "partial reorder keeps unlisted beats' relative order");

// --- track ops ---------------------------------------------------------------
const mkTrack = (over: Partial<Track> = {}): Track => ({ id: undefined, target: "el-x", preset: "fade", duration: 300, start: 0, ...over });
ops.setAnimation(deck, sid, b1.id, mkTrack({ start: 0 }));
ops.setAnimation(deck, sid, b1.id, mkTrack({ target: "el-y", start: 100, duration: 400, easing: "smooth" }));
const [tA, tB] = b1.tracks;
assert(!!tA.id && !!tB.id && tA.id !== tB.id, "setAnimation stamps fresh stable ids");

const dupId = ops.duplicateTrack(deck, sid, tA.id!)!;
assert(dupId && dupId !== tA.id, "duplicateTrack returns a fresh id");
assert(b1.tracks[1].id === dupId && b1.tracks.length === 3, "duplicate lands right after the original");
assert(b1.tracks[1].duration === tA.duration && b1.tracks[1].target === tA.target, "duplicate copies the payload");

assert(ops.moveTrackToBeat(deck, sid, dupId, b2.id), "moveTrackToBeat succeeds");
assert(b1.tracks.length === 2 && b2.tracks[0]?.id === dupId, "track moved across beats");
assert(b2.tracks[0].duration === 300, "timing travels untouched");
ops.moveTrackToBeat(deck, sid, tB.id!, b2.id, 0);
assert(b2.tracks[0].id === tB.id && b2.tracks[1].id === dupId, "at index places the moved track in the lane order");

ops.reorderTracks(deck, sid, b2.id, [dupId, tB.id!]);
assert(b2.tracks.map((t) => t.id).join(",") === [dupId, tB.id].join(","), "reorderTracks sets lane order");
ops.reorderTracks(deck, sid, b2.id, [tB.id!]); // partial → dup keeps tail position
assert(b2.tracks.map((t) => t.id).join(",") === [tB.id, dupId].join(","), "partial track reorder keeps unlisted at tail");

assert(ops.setTrackEnabled(deck, sid, dupId, false), "setTrackEnabled(false)");
assert(b2.tracks[1].disabled === true, "track carries disabled:true");
ops.setTrackEnabled(deck, sid, dupId, true);
assert(!("disabled" in b2.tracks[1]), "re-enable deletes the flag (clean JSON)");

assert(ops.findTrack(deck, tB.id!)?.beat.id === b2.id, "findTrack locates beat by track id");

// --- non-destructive tri-state on a plot part ---------------------------------
const plotId = ops.addElement(deck, sid, {
  type: "plot", id: "el-plot", x: 0, y: 0, width: 400, height: 300, rotation: 0,
  assetId: "demo/plot",
} as unknown as SlideElement)!;
const custom: Track = { id: "t-custom", target: plotId, part: "axis.x.ticks", preset: "drawOn", duration: 777, start: 123, easing: "smooth" };
ops.setAnimation(deck, sid, b1.id, custom);
ops.setPartVisibility(deck, plotId, "axis.x.ticks", "mask");
const el = ops.findElement(deck, plotId)!.el as { overrides?: Record<string, { hidden?: boolean }> };
assert(el.overrides?.["axis.x.ticks"]?.hidden === true, "mask sets the hidden override");
const masked = b1.tracks.find((t) => t.id === "t-custom")!;
assert(masked && masked.disabled === true, "mask DISABLES the part's tracks (not deleted)");
assert(masked.duration === 777 && masked.start === 123, "authored timing survives the mask");
const biBack = animatePart(deck, sid, plotId, "axis.x.ticks", undefined);
assert(el.overrides?.["axis.x.ticks"] === undefined, "animate clears the mask override");
assert(masked.disabled === undefined && biBack === 1, "animate RE-ENABLES the surviving track (no duplicate added)");
assert(slide.beats.flatMap((b) => b.tracks).filter((t) => t.target === plotId && t.part === "axis.x.ticks").length === 1, "exactly one track for the part after M→A round-trip");
ops.setPartVisibility(deck, plotId, "axis.x.ticks", "show");
assert(masked.disabled === true && el.overrides?.["axis.x.ticks"] === undefined, "show = visible from beat 0, tracks disabled");

// --- setPartStyle --------------------------------------------------------------
ops.setPartStyle(deck, plotId, "fit.line", { stroke: "#bc5215", strokeWidth: 2 });
const readOv = () => (ops.findElement(deck, plotId)!.el as { overrides?: Record<string, Record<string, unknown>> }).overrides!;
let ov = readOv();
assert(ov["fit.line"].stroke === "#bc5215" && ov["fit.line"].strokeWidth === 2, "style patch merged into the part override");
ops.setPartStyle(deck, plotId, "fit.line", { stroke: null, opacity: 0.5 });
ov = readOv();
assert(!("stroke" in ov["fit.line"]) && ov["fit.line"].opacity === 0.5, "null deletes a key; others merge");
ops.setPartStyle(deck, plotId, "fit.line", { strokeWidth: null, opacity: null });
assert(!("fit.line" in ((ops.findElement(deck, plotId)!.el as { overrides?: object }).overrides ?? {})), "an emptied override is removed");

// --- per-kind element tracks (figure element union — slides-are-figures) ---------
const textId = ops.addSlideText(deck, sid, { text: "One\nTwo\nThree", x: 0, y: 0, width: 300, height: 200 })!;
const textEl = ops.findElement(deck, textId)!.el;
const tText = suggestElementTrack(textEl);
assert(tText.preset === "fadeRise" && !tText.selector, "text → fadeRise (one unit; per-line reveal returns with rich text, plan §8)");
const line = { type: "line", id: "el-line", x: 0, y: 0, width: 200, height: 0, rotation: 0, x1: 0, y1: 0, x2: 200, y2: 0, stroke: "#000", strokeWidth: 2, arrowStart: false, arrowEnd: false } as unknown as SlideElement;
assert(suggestElementTrack(line).preset === "drawOn", "line → drawOn");
const rect = { type: "rect", id: "el-rect", x: 0, y: 0, width: 100, height: 80, rotation: 0, fill: "#123", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as unknown as SlideElement;
assert(suggestElementTrack(rect).preset === "popIn", "rect → popIn (div-rendered, NOT drawOn)");
assert(suggestElementTrack(rect, { exit: true }).preset === "popOut", "rect exit → popOut");
assert(suggestElementTrack(line, { exit: true }).preset === "drawOff", "line exit → drawOff");
assert(suggestElementTrack(textEl, { exit: true }).preset === "fadeOut", "default exit → fadeOut");

const rIn = animateElement(deck, sid, textId, {})!;
assert(rIn && rIn.beatIndex > 0, "animateElement lands on a build beat");
const rOut = animateElement(deck, sid, textId, { exit: true, beatIndex: 2 })!;
assert(rOut.beatIndex === 2, "explicit beatIndex honoured for the exit");
const outTrack = ops.findTrack(deck, rOut.trackId)!.track;
assert(outTrack.preset === "fadeOut" && !outTrack.selector, "exit track fades the whole element out");

// --- morph authoring + gate ------------------------------------------------------
const mkManifest = (series: { id: string; n: number }[]): FluxPlotManifest =>
  ({ axes: [], series: series.map((s) => ({ id: s.id, points: Array.from({ length: s.n }, (_, i) => ({ x: i, y: i })) })) }) as unknown as FluxPlotManifest;
const A = mkManifest([{ id: "control", n: 5 }]);
const B = mkManifest([{ id: "control", n: 5 }]);
const C = mkManifest([{ id: "other", n: 5 }]);
const cands = listMorphCandidates(A, [
  { assetId: "b", manifest: B },
  { assetId: "c", manifest: C },
  { assetId: "none", manifest: undefined },
]);
assert(cands.find((x) => x.assetId === "b")!.compatible, "shared tweenable series → compatible");
assert(!cands.find((x) => x.assetId === "c")!.compatible, "disjoint series ids → incompatible");
assert(!cands.find((x) => x.assetId === "none")!.compatible, "missing manifest → incompatible");
assert(ops.setMorphTrack(deck, sid, b2.id, plotId, "demo/other", { duration: 900 }), "setMorphTrack authors on the beat");
const morphT = b2.tracks.find((t) => t.preset === "morph")!;
assert(morphT.to?.assetId === "demo/other" && morphT.duration === 900 && morphT.easing === "smooth", "morph track shape (to.assetId, duration, smooth default)");

console.log("\nSLIDE TRACK-OPS (WS2) TESTS PASSED");
