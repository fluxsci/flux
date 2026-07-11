#!/usr/bin/env -S npx tsx
// WS-3.3 (fortify plan) — the present-shell core keymap contract. Drives
// reducePresentKey through the full clicker battery and asserts the state
// transitions + effects both hosts rely on (PresentOverlay applies "close";
// the export runtime maps it to none — everything else is identical).
//   npx tsx scripts/verify-present-core.ts

import {
  reducePresentKey,
  hudModel,
  panelModel,
  clockText,
  NEXT_W,
  type PresentState,
  type PresentNav,
} from "../src/lib/slide/present/core";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

function navRecorder(): { nav: PresentNav; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    nav: {
      next: () => calls.push("next"),
      prev: () => calls.push("prev"),
      nextSlide: () => calls.push("nextSlide"),
      prevSlide: () => calls.push("prevSlide"),
      goTo: (s, b) => calls.push(`goTo:${s},${b}`),
    },
  };
}
const S0: PresentState = { blank: "", showNotes: false, digits: "", reducedMotion: false };
const TOTAL = 12;

// ---- navigation keys ----------------------------------------------------------
for (const [key, plain, shifted] of [
  ["ArrowRight", "next", "nextSlide"],
  [" ", "next", "nextSlide"],
  ["PageDown", "next", "nextSlide"],
  ["ArrowLeft", "prev", "prevSlide"],
  ["Backspace", "prev", "prevSlide"],
  ["PageUp", "prev", "prevSlide"],
] as const) {
  const a = navRecorder();
  const ra = reducePresentKey(key, false, S0, a.nav, TOTAL);
  const b = navRecorder();
  const rb = reducePresentKey(key, true, S0, b.nav, TOTAL);
  assert(
    a.calls.join() === plain && b.calls.join() === shifted && ra.preventDefault && rb.preventDefault,
    `${JSON.stringify(key)}: ${plain} / shift → ${shifted}, preventDefault`,
  );
}
{
  const a = navRecorder();
  reducePresentKey("ArrowDown", false, S0, a.nav, TOTAL);
  const b = navRecorder();
  reducePresentKey("ArrowUp", false, S0, b.nav, TOTAL);
  assert(a.calls.join() === "nextSlide" && b.calls.join() === "prevSlide", "ArrowDown/ArrowUp = slide steps");
}
{
  const a = navRecorder();
  reducePresentKey("Home", false, S0, a.nav, TOTAL);
  reducePresentKey("End", false, S0, a.nav, TOTAL);
  assert(a.calls.join() === "goTo:0,0,goTo:11,0", "Home/End jump to first/last slide");
}

// ---- blank screen ---------------------------------------------------------------
{
  const { nav } = navRecorder();
  let r = reducePresentKey("b", false, S0, nav, TOTAL);
  assert(r.state.blank === "black", "b blanks black");
  r = reducePresentKey("b", false, r.state, nav, TOTAL);
  assert(r.state.blank === "", "b again un-blanks");
  r = reducePresentKey("w", false, S0, nav, TOTAL);
  assert(r.state.blank === "white", "w blanks white");
  r = reducePresentKey("B", false, r.state, nav, TOTAL);
  assert(r.state.blank === "black", "B while white → black (blank keys never fall through the clear guard)");
  r = reducePresentKey("ArrowRight", false, { ...S0, blank: "black" }, nav, TOTAL);
  assert(r.state.blank === "", "any other key un-blanks");
  r = reducePresentKey("Escape", false, { ...S0, blank: "black" }, nav, TOTAL);
  assert(r.state.blank === "" && r.effect.kind === "close", "Escape un-blanks AND closes (runtime maps close→none)");
}

// ---- digit jump ------------------------------------------------------------------
{
  const rec = navRecorder();
  let r = reducePresentKey("1", false, S0, rec.nav, TOTAL);
  r = reducePresentKey("0", false, r.state, rec.nav, TOTAL);
  assert(r.state.digits === "10", "digits accumulate");
  // the buffer SURVIVES bare modifiers (PresentOverlay behavior, adopted in both)
  r = reducePresentKey("Shift", false, r.state, rec.nav, TOTAL);
  assert(r.state.digits === "10", "digit buffer survives a bare Shift");
  r = reducePresentKey("Enter", false, r.state, rec.nav, TOTAL);
  assert(rec.calls.join() === "goTo:9,0" && r.state.digits === "", "Enter jumps to slide 10 (index 9) and clears");
  const rec2 = navRecorder();
  let r2 = reducePresentKey("9", false, S0, rec2.nav, TOTAL);
  r2 = reducePresentKey("9", false, r2.state, rec2.nav, TOTAL);
  r2 = reducePresentKey("Enter", false, r2.state, rec2.nav, TOTAL);
  assert(rec2.calls.join() === `goTo:${TOTAL - 1},0`, "digit jump clamps to the last slide");
  const rec3 = navRecorder();
  let r3 = reducePresentKey("5", false, S0, rec3.nav, TOTAL);
  r3 = reducePresentKey("x", false, r3.state, rec3.nav, TOTAL);
  assert(r3.state.digits === "", "a non-modifier key clears the buffer");
}

// ---- toggles + effects ------------------------------------------------------------
{
  const { nav } = navRecorder();
  let r = reducePresentKey("s", false, S0, nav, TOTAL);
  assert(r.state.showNotes === true && r.effect.kind === "none", "s toggles notes");
  r = reducePresentKey("S", false, r.state, nav, TOTAL);
  assert(r.state.showNotes === false, "S toggles back");
  r = reducePresentKey("f", false, S0, nav, TOTAL);
  assert(r.effect.kind === "fullscreen", "f → fullscreen effect");
  r = reducePresentKey("r", false, S0, nav, TOTAL);
  assert(r.effect.kind === "resetTimer", "r → resetTimer effect");
  r = reducePresentKey("m", false, S0, nav, TOTAL);
  assert(r.state.reducedMotion === true && r.effect.kind === "rebuild", "m → reducedMotion + rebuild effect");
  r = reducePresentKey("Escape", false, S0, nav, TOTAL);
  assert(r.effect.kind === "close" && !r.preventDefault, "Escape → close effect");
}

// ---- view-models -------------------------------------------------------------------
{
  const h = hudModel({ slide: 2, beat: 1, totalBeats: 4, totalSlides: 12 });
  assert(h.counter === "3 / 12", "hud counter");
  assert(JSON.stringify(h.dots) === JSON.stringify([true, true, false, false]), "hud dots (≤ beat on)");
  const pm = panelModel({ slide: 2, beat: 1, totalSlides: 12, totalBeats: 4, notes: "", elapsedSec: 65, reducedMotion: false, stageWidth: 1200 });
  assert(pm.clock === "1:05" && clockText(65) === "1:05", "clock format m:ss");
  assert(pm.pos === "slide 3/12 · beat 2/4", "pos string");
  assert(pm.nextIdx === 3 && pm.nextLabel === "Next" && pm.nextScale === NEXT_W / 1200, "next preview model");
  assert(pm.notes === "No notes for this slide.", "empty notes fallback");
  assert(pm.hint.includes("M motion on"), "hint reflects motion state");
  const end = panelModel({ slide: 11, beat: 0, totalSlides: 12, totalBeats: 1, notes: "x", elapsedSec: 0, reducedMotion: true, stageWidth: 1200 });
  assert(end.nextIdx === -1 && end.nextLabel === "End of deck" && end.hint.includes("M motion off"), "end-of-deck model");
  assert(NEXT_W === 300, "NEXT_W unified at 300");
}

console.log(failures ? `\nPRESENT CORE: FAIL (${failures})` : "\nPRESENT CORE: PASS");
process.exit(failures ? 1 : 0);
