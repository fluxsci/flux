#!/usr/bin/env -S npx tsx
// W4 delivery — the player's step/rewind semantics that Present relies on:
// with-prev folding (one click plays a whole group) and, crucially, prev() never
// resting on a partial mid-group frame (B2). createPlayer runs headlessly here
// with reducedMotion:true (no WAAPI calls). Run: npx tsx scripts/verify-slide-present.ts
import { parseHTML } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const { createPlayer } = await import("../src/lib/slide/player/player");
const ops = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// deck: one slide, beats [base, b1(click), b2(with-prev), b3(click)] + a 2nd slide.
// (skip the default title slide so slide 0 IS our fixture.)
const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false });
const s = ops.addSlide(deck, { name: "s", layout: "blank" });
const sid = s.id;
ops.addSlideText(deck, sid, { text: "a\nb\nc", x: 0, y: 0, width: 400, height: 200 });
ops.addBeat(deck, sid, { label: "b1", advance: "click" });
ops.addBeat(deck, sid, { label: "b2", advance: "with-prev" });
ops.addBeat(deck, sid, { label: "b3", advance: "click" });
const s2 = ops.addSlide(deck, { name: "s2", layout: "blank" });
deck.slides[1].transition = "slide"; // exercise a directional transition path
ops.addSlideText(deck, s2.id, { text: "z", x: 0, y: 0, width: 400, height: 200 });

const mount = document.createElement("div") as unknown as HTMLElement;
const player = createPlayer(mount, deck, { theme: FLUX_DARK, reducedMotion: true, plotManifest: () => undefined });

assert(player.state().beat === 0 && player.state().slide === 0, "starts at slide 0 / beat 0");

player.next();
assert(player.state().beat === 2, `next folds the with-prev beat into ONE step → lands on the group end (beat 2), got ${player.state().beat}`);

player.next();
assert(player.state().beat === 3, `next advances to the next click beat (3), got ${player.state().beat}`);

player.prev();
assert(player.state().beat === 2, `prev from a click beat lands on the previous group-end (2), got ${player.state().beat}`);

player.prev();
assert(player.state().beat === 0, `prev from a with-prev group-end rewinds past the WHOLE group to 0 — not a partial mid-group frame (B2), got ${player.state().beat}`);

// cross-slide nav + setMediaPaused API (blank-screen pause, B15) must not throw.
player.nextSlide();
assert(player.state().slide === 1, "nextSlide moves to slide 2");
player.setMediaPaused(true);
player.setMediaPaused(false);
assert(true, "setMediaPaused is a no-throw no-op with no videos");

player.prevSlide();
assert(player.state().slide === 0 && player.state().beat === deck.slides[0].beats.length - 1,
  "prevSlide returns to slide 1 at its fully-built last beat");

player.destroy();
console.log("\nSLIDE PRESENT (W4 with-prev / prev-rewind) REGRESSION PASSED");
