#!/usr/bin/env -S npx tsx
// W5 playback-correctness fixes: 0-beat guard (B24), base-camera at rest (B14),
// transform composition (B11: move+scale keep both), and auto-advance firing on
// slide ENTRY not just after a manual step (B9). createPlayer runs under linkedom
// with reducedMotion (no WAAPI). Run: npx tsx scripts/verify-slide-playback.ts
import { parseHTML } from "linkedom";
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const { createPlayer, computeSlideAnims, applyStatic } = await import("../src/lib/slide/player/player");
const { renderSlide } = await import("../src/lib/slide/player/render");
const ops = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stage = { width: 1280, height: 720 }; // fixtures predate the 640×360 default — pinned explicitly
// reducedMotion:true → the player never calls WAAPI animate() (absent in linkedom).
const opts = { theme: FLUX_DARK, plotManifest: () => undefined, reducedMotion: true } as const;

// --- B24: a 0-beat slide still reports one (resting) beat -----------------------
{
  const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false, stage });
  const s = ops.addSlide(deck, { name: "s", layout: "blank" });
  s.beats = []; // pathological: no beats at all
  const mount = document.createElement("div") as unknown as HTMLElement;
  const p = createPlayer(mount, deck, opts);
  assert(p.state().totalBeats === 1, `0-beat slide reports totalBeats 1, not 0 (B24) — got ${p.state().totalBeats}`);
  p.destroy();
}

// --- B14: the slide's base camera is applied at rest ----------------------------
{
  const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false, stage });
  const s = ops.addSlide(deck, { name: "s", layout: "blank" });
  s.camera = { x: 400, y: 300, zoom: 2 }; // tx=640-800=-160, ty=360-600=-240
  ops.addSlideText(deck, s.id, { text: "hi", x: 0, y: 0, width: 200, height: 80 });
  const mount = document.createElement("div") as unknown as HTMLElement;
  createPlayer(mount, deck, opts);
  const cam = (mount.querySelector(".sl-camera") as HTMLElement).style.transform;
  assert(/scale\(2\)/.test(cam) && /-160px/.test(cam), `base camera pose applied at rest (B14) — got "${cam}"`);
}

// --- B11: move THEN scale on the same element compose (translate + scale) --------
{
  const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false, stage });
  const s = ops.addSlide(deck, { name: "s", layout: "blank" });
  const el = ops.addSlideText(deck, s.id, { text: "x", x: 100, y: 100, width: 200, height: 80 })!;
  const b1 = ops.addBeat(deck, s.id, { label: "move", advance: "click" })!;
  ops.setAnimation(deck, s.id, b1.id, { target: el, preset: "move", to: { x: 50, y: 30 }, duration: 300 });
  const b2 = ops.addBeat(deck, s.id, { label: "scale", advance: "click" })!;
  ops.setAnimation(deck, s.id, b2.id, { target: el, preset: "scale", to: { scale: 2 }, duration: 300 });
  const host = document.createElement("div") as unknown as HTMLElement;
  const rendered = renderSlide(host, s, stage, { theme: FLUX_DARK });
  const specs = computeSlideAnims(s, rendered, host, stage, opts);
  applyStatic(specs, 2); // both beats passed
  const tf = (rendered.elements.get(el) as HTMLElement).style.transform;
  assert(/translate\(50px,\s*30px\)/.test(tf), `move survives a later scale (B11) — got "${tf}"`);
  assert(/scale\(2\)/.test(tf), `scale applied alongside the move (B11) — got "${tf}"`);
}

// --- B9: an auto beat fires on slide ENTRY (not only after a manual next) --------
{
  const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false, stage });
  const s = ops.addSlide(deck, { name: "s", layout: "blank" });
  ops.addSlideText(deck, s.id, { text: "a\nb", x: 0, y: 0, width: 200, height: 80 });
  const b1 = ops.addBeat(deck, s.id, { label: "auto", advance: "auto", autoDelayMs: 40 })!;
  ops.setAnimation(deck, s.id, b1.id, { target: "@stage", preset: "fade", duration: 100 });
  const mount = document.createElement("div") as unknown as HTMLElement;
  const p = createPlayer(mount, deck, { ...opts, reducedMotion: true });
  assert(p.state().beat === 0, "player lands on beat 0 at entry");
  await sleep(120);
  assert(p.state().beat === 1, `auto beat auto-advances on entry within its delay (B9) — got ${p.state().beat}`);
  p.destroy();
}

console.log("\nSLIDE PLAYBACK (W5 correctness) REGRESSION PASSED");
