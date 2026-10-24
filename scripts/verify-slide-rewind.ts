#!/usr/bin/env -S npx tsx
// WP 4.1 (manim study, W1): animated Back. Back plays the beat in reverse through the SAME pure sampler on an ease-out clock
// (timing.ts rewindTime: time = from·(1−x)²), lands exactly where a jump lands (a `seek`: identical DOM), is bounded (REWIND_CAP_MS),
// interruptible, and never loses a press. One clock mode with the interrupt settle (X14): Back while settling rewinds from the current
// time; Next while rewinding replays the undone beat and never settles.
// Headless Present-mode harness: linkedom + a fake performance.now / rAF driving the REAL player.
// Run: npx tsx scripts/verify-slide-rewind.ts
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-rewind");
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
let now = 1000; const queue = new Map<number, (t: number) => void>(); let rid = 0;
(globalThis as any).performance = { now: () => now };
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => { queue.set(++rid, cb); return rid; };
(globalThis as any).cancelAnimationFrame = (i: number) => { queue.delete(i); };
const FRAME = 1000 / 60;
/** `ms` of 60 Hz frames (at least one) */
const step = (ms: number) => { const n = Math.max(1, Math.round(ms / FRAME)); for (let i = 0; i < n; i++) { now += FRAME; const cbs = [...queue.values()]; queue.clear(); cbs.forEach(cb => cb(now)); } };
/** time passes with no frames (separates presses from the burst window) */
const idle = (ms: number) => { now += ms; };

const { createPlayer } = await import("../src/lib/slide/player/player");
const { REWIND_CAP_MS, BACK_BURST_MS, BACK_SCALE_DEFAULT, rewindTime, rewindRate, SETTLE_MAX_MS } = await import("../src/lib/slide/timing");
const ops = await import("../src/lib/slide/ops");
const { FLUX_DARK } = await import("../src/lib/slide/theme");

/** beat 1: 600 ms fade of A; beat 2: fade of B (600 ms, or `longMs`); beat 3 with-prev (joins 2); beat 4 click. */
function makeDeck(longMs = 0, extra?: (deck: any, slideId: string) => void) {
  const deck = ops.createDeck({ id: "d", title: "d", withTitleSlide: false } as never);
  const s = ops.addSlide(deck, { name: "s", layout: "blank" } as never);
  ops.addSlideText(deck, s.id, { text: "a", x: 0, y: 0, width: 400, height: 200 } as never);
  ops.addSlideText(deck, s.id, { text: "b", x: 0, y: 100, width: 400, height: 200 } as never);
  for (let i = 0; i < 4; i++) ops.addBeat(deck, s.id, { label: "b" + (i + 1), advance: i === 2 ? "with-prev" : "click" } as never);
  const sl = deck.slides[0], ids = sl.elements.map((e: any) => e.id);
  sl.beats[1].tracks = [{ target: ids[0], preset: "fade", duration: 600, start: 0 } as any];
  sl.beats[2].tracks = [{ target: ids[1], preset: "fade", duration: longMs || 600, start: 0 } as any];
  sl.beats[3].tracks = [{ target: ids[0], preset: "fadeOut", duration: 300, start: 0 } as any];
  sl.beats[4].tracks = [{ target: ids[1], preset: "fadeOut", duration: 600, start: 0 } as any];
  extra?.(deck, s.id);
  return deck;
}
const mk = (deck: any, o: Record<string, unknown> = {}) => {
  const mount = document.createElement("div") as unknown as HTMLElement;
  const p = createPlayer(mount, deck, { theme: FLUX_DARK, plotManifest: () => undefined, backAnimates: true, ...o } as any);
  return { p, mount, html: () => (mount as any).innerHTML as string };
};
const deck = makeDeck();

try {
  h.section("the clock (pure)");
  {
    const rate = rewindRate(600, BACK_SCALE_DEFAULT);
    h.ok(Math.abs(rate - 1 / 0.7) < 1e-12, "rate: 1/scale for a short beat (0.7 -> 1.43x)");
    h.eq(rewindRate(6000, 0.7), 6000 / REWIND_CAP_MS, "rate: a long beat is capped at REWIND_CAP_MS of wall time");
    h.eq([rewindRate(200, 0.01), rewindRate(200, 9)], [4, 1 / 1.5], "scale clamps to [0.25, 1.5]");
    h.eq([rewindTime(600, rate, 0), rewindTime(600, rate, 600 / rate), rewindTime(600, rate, 1e6), rewindTime(0, rate, 5)], [600, 0, 0, 0], "time = from at the press, exactly 0 at the landing, clamped after it");
    let mono = true; for (let e = 0; e < 420; e += 3) if (rewindTime(600, rate, e + 3) > rewindTime(600, rate, e)) mono = false;
    h.ok(mono, "time decreases monotonically");
    const first = 600 - rewindTime(600, rate, FRAME), last = rewindTime(600, rate, 420 - FRAME);
    h.ok(first > 40 && first < 55 && last < 1, `ease-out: the first frame moves ${first.toFixed(1)} ms of beat time (forward 16.7), the last ${last.toFixed(2)} ms`);
  }

  h.section("off / reduced: today's jump");
  { const { p } = mk(deck, { backAnimates: undefined }); p.seek(0, 4, Infinity); p.prev(); h.ok(!p.state().reversing && p.state().beat === 3, "backAnimates absent: prev() is a jump"); p.destroy(); }
  { const { p } = mk(deck, { reducedMotion: true }); p.seek(0, 4, Infinity); p.prev(); h.ok(!p.state().reversing && p.state().beat === 3, "reduced motion: Back jumps"); p.destroy(); }
  { const { p } = mk(deck); p.seek(0, 4, Infinity); p.prev({ animate: false }); h.ok(!p.state().reversing && p.state().beat === 3, "prev({ animate: false }) jumps"); p.destroy(); }
  { const { p } = mk(deck); p.play({ slide: 0, fromBeat: 1, toBeat: 2 }); step(100); p.prev(); h.ok(!p.state().reversing, "an Animator preview range never rewinds"); p.destroy(); }

  h.section("lands exactly where a jump lands");
  {
    const A = mk(deck), B = mk(deck); const events: string[] = [];
    A.p.on("beatStart", () => events.push("start")); A.p.on("beatEnd", () => events.push("end"));
    A.p.seek(0, 1, Infinity); B.p.seek(0, 1, Infinity); B.p.seek(0, 0, Infinity);
    A.p.prev();
    const s0 = A.p.state(); h.ok(s0.reversing && s0.playing && s0.beat === 1 && Math.round(s0.time) === 600, "Back starts a rewind at the end of the beat (time = 600)");
    step(400); h.ok(A.p.state().reversing, "still rewinding at 400 ms (600 ms beat at 0.7 = 420 ms)");
    step(60); const s1 = A.p.state();
    h.ok(!s1.reversing && !s1.playing && s1.beat === 0, "the rewind lands on beat 0 by ~460 ms");
    h.ok(A.html() === B.html(), "the resting DOM after a rewind equals the DOM after a jump");
    h.eq(events, [], "a rewind emits no beatStart / beatEnd (forward-only events)");
    A.p.destroy(); B.p.destroy();
  }
  {
    const A = mk(deck), B = mk(deck); A.p.seek(0, 1, Infinity); B.p.seek(0, 1, Infinity); A.p.prev();
    let compared = 0, same = 0;
    for (let k = 0; k < 40; k++) {
      step(FRAME); if (!A.p.state().reversing) break;
      B.p.seek(0, 1, A.p.state().time); compared++; if (A.html() === B.html()) same++;
    }
    h.ok(compared >= 20 && same === compared, `mirror law: rewind frames equal static samples at the same time (${same}/${compared})`);
    A.p.destroy(); B.p.destroy();
  }

  h.section("bounded, scaled");
  {
    const L = makeDeck(6000), { p } = mk(L); p.seek(0, 3, Infinity); p.prev(); // beat 3 is with-prev: the run 2..3 (6 s) rewinds as one
    h.ok(p.state().duration >= 6000 && p.state().reversing, "a 6 s run rewinds");
    step(REWIND_CAP_MS - 40); h.ok(p.state().reversing, "still rewinding just under the cap");
    step(80); h.ok(!p.state().reversing && p.state().beat === 1, `a 6 s run has landed by ${REWIND_CAP_MS} ms, on the beat before the run`);
    p.destroy();
  }
  { const { p } = mk(deck, { backScale: 1 }); p.seek(0, 1, Infinity); p.prev(); step(560); h.ok(p.state().reversing, "backScale 1: a 600 ms beat still runs at 560 ms"); step(80); h.ok(!p.state().reversing, "backScale 1: landed by 640 ms"); p.destroy(); }

  h.section("interruptible, never a lost press");
  {
    const { p } = mk(deck); p.seek(0, 0, Infinity); p.next(); step(200); const t = p.state().time; h.ok(t > 150 && t < 250, `a forward cue at ${Math.round(t)} ms`);
    idle(BACK_BURST_MS + 10); p.prev();
    const s = p.state(); h.ok(s.reversing && Math.abs(s.time - t) < 1e-6, "Back mid-play: the rewind starts at the current time, not the beat end");
    step(300); h.ok(!p.state().reversing && p.state().beat === 0, "...and lands on beat 0");
    p.destroy();
  }
  {
    const { p } = mk(deck); p.seek(0, 4, Infinity);
    p.prev(); step(120); idle(BACK_BURST_MS + 10); p.prev();
    h.ok(p.state().reversing && p.state().beat === 3, "a second Back settles the first rewind and rewinds the run before it");
    step(2000); h.eq(p.state().beat, 1, "two Backs from beat 4 land on beat 1 (the with-prev run 2+3 is ONE step)");
    p.destroy();
  }
  { const { p } = mk(deck); p.seek(0, 4, Infinity); p.prev(); step(60); p.prev(); h.ok(!p.state().reversing && p.state().beat === 1, "a Back inside the burst window settles and jumps: two presses, two steps"); p.destroy(); }
  {
    const { p } = mk(deck); p.seek(0, 1, Infinity); p.prev(); step(100); p.next();
    const s = p.state(); h.ok(s.beat === 1 && s.playing && !s.reversing && s.time < 20, "Next mid-rewind replays the undone beat forward from its start (never settles)");
    step(30); p.next(); h.ok(p.state().beat === 1 && p.state().playing, "...and a click on that replay settles it as usual (the mode is forward again)");
    p.destroy();
    const m = mk(deck, { manualSteps: true }); m.p.seek(0, 1, Infinity); m.p.prev(); step(100); m.p.next();
    h.ok(m.p.state().beat === 0 && !m.p.state().playing && !m.p.state().reversing, "manualSteps: Next mid-rewind settles (one more Next replays)");
    m.p.destroy();
  }
  {
    const { p } = mk(deck); p.seek(0, 0, Infinity); p.next(); step(150); p.next(); // a click mid-cue: settling
    const t = p.state().time; idle(BACK_BURST_MS + 10); p.prev();
    h.ok(p.state().reversing && Math.abs(p.state().time - t) < 1e-6 && p.state().beat === 1, "Back while settling cancels the settle and rewinds from the current time");
    step(600); h.ok(p.state().beat === 0 && !p.state().playing, "...landing on beat 0; the queued click is dropped");
    p.destroy();
  }
  {
    const { p } = mk(deck); p.seek(0, 1, Infinity); p.prev(); step(160); p.pause();
    const t = p.state().time; h.ok(p.state().reversing && !p.state().playing && t < 600 && t > 0, "pause freezes a rewind mid-way");
    step(500); h.eq(p.state().time, t, "a paused rewind does not advance");
    p.resume(); step(FRAME); h.ok(p.state().time < t && t - p.state().time < 30, "resume continues BACKWARD from where it paused");
    step(600); h.ok(p.state().beat === 0 && !p.state().reversing, "...and lands on beat 0");
    p.destroy();
  }
  {
    const { p } = mk(deck); p.seek(0, 1, Infinity); p.prev(); step(100); p.goTo(0, 1); h.ok(!p.state().reversing && p.state().beat === 1, "goTo during a rewind cancels it");
    idle(BACK_BURST_MS + 10); p.prev(); step(100); p.seek(0, 0, Infinity); h.ok(!p.state().reversing, "seek during a rewind cancels it");
    p.destroy();
  }
  { const { p } = mk(deck); p.seek(0, 0, Infinity); p.prev(); h.ok(!p.state().reversing && p.state().beat === 0, "Back at beat 0 of the first slide does nothing"); p.destroy(); }
  {
    const V = makeDeck(0, (d, sid) => {
      d.assets = [{ id: "clip", name: "clip", kind: "mp4", path: "assets/clip.mp4", naturalWidth: 160, naturalHeight: 90, durationMs: 1200, hasAudio: false }, { id: "poster", name: "poster", kind: "png", path: "assets/poster.png", naturalWidth: 160, naturalHeight: 90 }];
      h.ok(!!ops.addVideoToSlide(d, sid, { assetId: "clip", posterAssetId: "poster", durationMs: 1200 }), "a video element on the slide");
    });
    const { p } = mk(V); p.seek(0, 1, Infinity); p.prev(); h.ok(!p.state().reversing && p.state().beat === 0, "a slide with a video cuts (natives are forward-driven)"); p.destroy();
  }
  void SETTLE_MAX_MS;
} catch (err) { h.fail(String((err as Error).stack ?? err)); }
await h.done();
