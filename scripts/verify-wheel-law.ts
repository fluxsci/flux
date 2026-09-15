#!/usr/bin/env -S npx tsx
// 2026-09-15 surface redesign — the ONE wheel → steps law (src/lib/interact/wheelLaw.ts)
// gates hermetically: every wheel dialect a Chromium window can deliver reads
// as "one notch = one step, a spin moves further, a trackpad scrubs".
//   Run: npx tsx scripts/verify-wheel-law.ts
import { WheelStepper, wheelDelta, wheelMultiplier } from "../src/lib/interact/wheelLaw";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const run = (samples: { deltaY: number; deltaMode?: number; time: number }[]) => {
  const w = new WheelStepper();
  return samples.map((s) => w.steps(s));
};
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// (1) Windows mouse: 100px per notch, slow roll → exactly one step per notch, up = increase.
{
  const r = run([{ deltaY: -100, time: 0 }, { deltaY: -100, time: 200 }, { deltaY: 100, time: 400 }]);
  assert(r.join(",") === "1,1,-1", `slow 100px notches step one at a time (${r})`);
}
// (2) a flick (notches < 45 ms apart) doubles; the first notch of the flick is still one.
{
  const r = run([{ deltaY: -100, time: 0 }, { deltaY: -100, time: 20 }, { deltaY: -100, time: 40 }]);
  assert(r.join(",") === "1,2,2", `a flick doubles the step (${r})`);
}
// (3) a spun macOS mouse: bigger accelerated deltas move further.
{
  const r = run([{ deltaY: -60, time: 0 }, { deltaY: -160, time: 100 }, { deltaY: -320, time: 200 }]);
  assert(r.join(",") === "1,2,3", `spin magnitude scales the step (${r})`);
}
// (4) a SLOW macOS mouse: 4px per notch, one event per notch — still one step each;
//     a moderate roll (12px notches 35 ms apart) is still one step per notch.
{
  const r = run([{ deltaY: -4, time: 0 }, { deltaY: -4, time: 150 }, { deltaY: 4, time: 400 }, { deltaY: -10, time: 460 }]);
  assert(r.join(",") === "1,1,-1,1", `4px macOS notches are one step each (${r})`);
  const mid = run([{ deltaY: -12, time: 0 }, { deltaY: -12, time: 35 }, { deltaY: -12, time: 70 }]);
  assert(mid.join(",") === "1,1,1", `12px notches 35 ms apart are one step each (${mid})`);
}
// (5) a stream (trackpad / smooth-scroll mouse): first touch is a notch, then every 40px accumulated.
{
  const stream = [{ deltaY: -3, time: 0 }];
  for (let i = 1; i <= 10; i++) stream.push({ deltaY: -8, time: i * 8 });
  const r = run(stream);
  assert(r[0] === 1 && sum(r) === 3, `a 3+80px two-finger drag = 1 + floor(80/40) = 3 steps (${r})`);
  const burst = run([{ deltaY: -6, time: 0 }, { deltaY: -14, time: 8 }, { deltaY: -12, time: 16 }, { deltaY: -8, time: 24 }, { deltaY: -4, time: 32 }]);
  assert(sum(burst) === 1, `a 44px smooth-scroll notch burst is one step, not five (${burst})`);
  const back = run([{ deltaY: -3, time: 0 }, { deltaY: -20, time: 8 }, { deltaY: 20, time: 16 }, { deltaY: 20, time: 24 }, { deltaY: 20, time: 32 }]);
  assert(sum(back) === 0 && back[4] === -1, `reversing inside a stream unwinds the accumulator (${back})`);
}
// (6) lines and pages.
{
  const r = run([{ deltaY: -1, deltaMode: 1, time: 0 }, { deltaY: -3, deltaMode: 1, time: 10 }, { deltaY: 1, deltaMode: 2, time: 20 }]);
  assert(r.join(",") === "1,3,-3", `line/page deltas are notches (${r})`);
}
// (7) zero / NaN deltas are ignored; reset forgets the stream.
{
  const w = new WheelStepper();
  assert(w.steps({ deltaY: 0, time: 0 }) === 0 && w.steps({ deltaY: NaN, time: 1 }) === 0, "empty deltas are no-ops");
  w.steps({ deltaY: -3, time: 100 });
  w.steps({ deltaY: -20, time: 108 });
  w.reset();
  assert(w.steps({ deltaY: -3, time: 116 }) === 1, "reset() makes the next small delta a fresh notch");
}
// (8) helpers: dominant axis and per-gesture multiplier.
{
  assert(wheelDelta({ deltaX: -50, deltaY: 10 }) === -50 && wheelDelta({ deltaX: 5, deltaY: 10 }) === 10, "wheelDelta picks the dominant axis");
  assert(wheelMultiplier({ shiftKey: true, altKey: false }) === 10 && wheelMultiplier({ shiftKey: false, altKey: true }) === 0.1 && wheelMultiplier({ shiftKey: false, altKey: false }) === 1, "Shift ×10, Alt ×0.1");
}
console.log("VERIFY-WHEEL-LAW PASS");
