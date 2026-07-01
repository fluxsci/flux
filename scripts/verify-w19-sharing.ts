#!/usr/bin/env -S npx tsx
// W19 slide hot-path fixes (store-level):
//  • SLD-4: commitDeck reuses the object reference of every UNCHANGED slide, so a
//    single-slide edit doesn't invalidate (and re-render) the whole filmstrip.
//  • SLD-5: coalesced commits (same key) fold into ONE undo step.
//   Run: npx tsx scripts/verify-w19-sharing.ts
import { get } from "svelte/store";
import { deck, commitDeck, undoDeck, canUndo } from "../src/lib/slide/store";
import * as ops from "../src/lib/slide/ops";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// A 3-slide deck.
const d = ops.createDeck({ title: "W19" });
ops.addSlide(d, { name: "two" });
ops.addSlide(d, { name: "three" });
deck.set(d);

// --- SLD-4: structural sharing ---------------------------------------------
const before = get(deck).slides;
const [r0, r1, r2] = before;
const id1 = r1.id;

commitDeck((dd) => {
  const s = dd.slides.find((x) => x.id === id1);
  if (s) s.name = "two-edited";
});

const after = get(deck).slides;
assert(after.find((s) => s.id === id1)?.name === "two-edited", "the edit landed on slide 2");
assert(after[1] !== r1, "SLD-4: the EDITED slide got a fresh object reference (re-renders)");
assert(after[0] === r0, "SLD-4: untouched slide 1 keeps its reference (no thumbnail re-render)");
assert(after[2] === r2, "SLD-4: untouched slide 3 keeps its reference (no thumbnail re-render)");

// A multi-slide op (reorder) still works and moved slides keep identity.
commitDeck((dd) => ops.reorderSlides(dd, [dd.slides[2].id, dd.slides[0].id, dd.slides[1].id]));
const reordered = get(deck).slides;
assert(reordered[0].id === r2.id && reordered[2].id === id1, "reorder-slides reordered correctly");

// --- SLD-5: coalesced commits = one undo step ------------------------------
const sid = get(deck).slides[0].id;
// Three commits with the SAME coalesce key → one undo entry.
for (const v of [0.9, 0.8, 0.7]) {
  commitDeck((dd) => {
    const s = ops.slideById(dd, sid);
    if (s) s.background = `rgba(0,0,0,${v})`;
  }, { coalesce: `bg:${sid}` });
}
const bgAfter = ops.slideById(get(deck), sid)?.background;
assert(bgAfter === "rgba(0,0,0,0.7)", "coalesced edits applied (last value wins)");
assert(get(canUndo), "there is something to undo");
undoDeck(); // should revert ALL THREE coalesced edits at once
const bgUndone = ops.slideById(get(deck), sid)?.background;
assert(bgUndone !== "rgba(0,0,0,0.7)" && bgUndone !== "rgba(0,0,0,0.8)", "SLD-5: one undo reverted the whole coalesced run");

console.log("\nW19 SHARING VERIFY: PASS");
