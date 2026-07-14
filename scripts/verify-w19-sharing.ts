#!/usr/bin/env -S npx tsx
// W19 slide hot-path + UNIFIED HISTORY (rewritten for slides-are-figures):
//  • the old SLD-4 (commitDeck structural sharing) is SUPERSEDED — the deck
//    store no longer clones slides per commit; filmstrip invalidation is
//    figureRev-keyed + content-signed in SlideThumb (gated in the ui suite).
//  • SLD-5 lives on: coalesced commitDeckLive runs fold into ONE undo step.
//  • NEW (slide-migration §3.5): the history COMPANION — overlay edits (beats/
//    meta) ride the figure store's snapshot history, so ONE Cmd+Z restores
//    static + overlay halves together, interleaved correctly; with no
//    registered companion the history behaves exactly as before (figure mode).
//   Run: npx tsx scripts/verify-w19-sharing.ts
import { get } from "svelte/store";
import { deckOverlay, commitDeckLive, sealHistory, loadDeckModel, overlayHistoryCompanion, currentDeck } from "../src/lib/slide/store";
import { project, undo, redo, commit, registerHistoryCompanion, historyStats } from "../src/lib/store";
import * as ops from "../src/lib/slide/ops";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// A 3-slide deck, loaded into the live stores with the companion registered
// (the SlideMode lifecycle).
const d = ops.createDeck({ title: "W19", withTitleSlide: false });
const s1 = ops.addSlide(d, { name: "one" }).id;
ops.addSlide(d, { name: "two" });
ops.addSlide(d, { name: "three" });
const unregister = registerHistoryCompanion(overlayHistoryCompanion());
loadDeckModel(d);

const undoDepth = () => historyStats().past;

// --- unified history: static + overlay edits interleave under ONE stack --------
const base = undoDepth();
commit((p) => {
  const f = p.figures.find((x) => x.id === s1)!;
  f.elements.push({ type: "rect", id: "r-1", x: 10, y: 10, width: 50, height: 40, rotation: 0, fill: "#111111", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
});
assert(undoDepth() === base + 1, "a static (figure-store) edit is one history entry");
commitDeckLive((dd) => {
  ops.addBeat(dd, s1, { label: "reveal" });
  ops.setAnimation(dd, s1, dd.slides[0].beats.at(-1)!.id, { target: "r-1", preset: "fade" });
});
assert(undoDepth() === base + 2, "an overlay (deck-op) edit is one MORE entry on the SAME stack");
assert(get(deckOverlay)!.slides[0].beats.length === 2, "the beat landed");
assert(get(project).figures.find((f) => f.id === s1)!.elements.length === 1, "the rect landed");

undo(); // ← the overlay edit
assert(get(deckOverlay)!.slides[0].beats.length === 1, "undo #1 restores the OVERLAY half (beat gone)");
assert(get(project).figures.find((f) => f.id === s1)!.elements.length === 1, "…while the static half (rect) is untouched");
undo(); // ← the static edit
assert(get(project).figures.find((f) => f.id === s1)!.elements.length === 0, "undo #2 restores the STATIC half (rect gone)");
redo();
redo();
assert(get(project).figures.find((f) => f.id === s1)!.elements.length === 1 && get(deckOverlay)!.slides[0].beats.length === 2,
  "redo ×2 replays both halves in order (one unified stack)");

// --- a deck STRUCTURE op undoes atomically (figures + overlay together) ---------
const depth2 = undoDepth();
commitDeckLive((dd) => ops.duplicateSlide(dd, s1));
assert(undoDepth() === depth2 + 1, "duplicateSlide = one entry");
assert(get(deckOverlay)!.slides.length === 4 && get(project).figures.length === 4, "both halves gained the copy");
undo();
assert(get(deckOverlay)!.slides.length === 3 && get(project).figures.length === 3, "one undo removes the copy from BOTH halves");

// --- SLD-5: coalesced runs fold into one undo step -------------------------------
const depth3 = undoDepth();
commitDeckLive((dd) => ops.setDeckMeta(dd, { title: "W" }), { coalesce: "title" });
commitDeckLive((dd) => ops.setDeckMeta(dd, { title: "W1" }), { coalesce: "title" });
commitDeckLive((dd) => ops.setDeckMeta(dd, { title: "W19!" }), { coalesce: "title" });
assert(get(deckOverlay)!.title === "W19!", "coalesced edits applied");
assert(undoDepth() === depth3 + 1, "a same-key run is ONE undo entry (SLD-5)");
sealHistory();
commitDeckLive((dd) => ops.setDeckMeta(dd, { title: "W19 sealed" }), { coalesce: "title" });
assert(undoDepth() === depth3 + 2, "sealHistory starts a fresh entry for the next run");
undo();
assert(get(deckOverlay)!.title === "W19!", "undo pops the sealed run only");
undo();
assert(get(deckOverlay)!.title === "W19", "…then the whole coalesced run at once");

// --- composition sanity: the live Deck recombines both halves --------------------
const composed = currentDeck()!;
assert(composed.slides.length === 3 && composed.title === "W19", "currentDeck composes figures + overlay");

// --- figure mode: NO companion → history byte-path unchanged ---------------------
unregister();
const depth4 = undoDepth();
commit((p) => {
  p.figures[0].name = "renamed";
});
assert(undoDepth() === depth4 + 1, "without a companion, commit still pushes one plain entry");
undo();
assert(get(project).figures[0].name !== "renamed", "…and undo restores it (companion hook inert when unregistered)");

console.log("\nW19 (unified history + coalesce + companion) TESTS PASSED");
