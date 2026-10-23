#!/usr/bin/env -S npx tsx
// R2 follow-up F3 — the hand-over of a shape flight to the real renders at its two ends (player/shapeHandover.ts), and the join a round-capped line brings
// to a Become. Pure. The browser behaviour (first moving frame and landing frame equal the rest render, on the seek and the compositor domains) is
// pinned by the settle corpus decks `become_corners`, `become_stroked` and `set_flights`; this gate pins the law itself:
//   • the three layer weights sum to 1, are all in [0, 1], and are a pure function of the two distances (seek purity);
//   • the first moving frame is the start render and the landing frame the end render, whatever the travel;
//   • the window is a DISTANCE: the flight owns the picture once it has moved HANDOVER_EPS stage px from both ends, and a flight whose whole travel is
//     shorter than the window crossfades start into end directly (the weights stay normalised);
//   • the weights move monotonically with the distance (no frame hands back what an earlier frame handed over);
//   • `maxShift` over `pathPoints` is the furthest travel of an anchor OR a handle end (the distance both drivers measure: a circle becoming its inscribed
//     diamond moves handles alone), and a look change counts as travelling (LOOK_TRAVEL);
//   • the text hand-over (textMorph.ts, lane F2) is the same law: one ease, and a short travel is normalised the same way (weights sum to 1);
//   • a ROUND-capped line carries a round join into the join law (a ring collapsing into it lands on half-disc ends); butt / square lines and the other kinds
//     keep their old preference.
import assert from "node:assert/strict";
import { shapeWeights, snapWeights, SNAP, maxShift, pathPoints, LOOK_TRAVEL, HANDOVER_EPS } from "../src/lib/slide/player/shapeHandover";
import { handoverEase, handoverWeights } from "../src/lib/slide/player/textMorph";
import { cornerJoinOf, morphJoin, pairJoin } from "../src/lib/strokeStyle";
let checks = 0;
const check = (v: unknown, label: string) => { assert.ok(v, label); checks++; console.log("  ok:", label); };
const section = (s: string) => console.log(`\n── ${s} ──`);
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

section("the three weights");
{
  let sumOk = true, rangeOk = true;
  for (const away of [0, 1e-6, 0.1, 0.375, 0.75, 3, 400]) for (const settle of [0, 1e-6, 0.1, 0.375, 0.75, 3, 400]) {
    const w = shapeWeights(away, settle);
    if (!near(w.a + w.m + w.b, 1, 1e-12)) sumOk = false;
    if (![w.a, w.m, w.b].every(v => v >= 0 && v <= 1 + 1e-12)) rangeOk = false;
  }
  check(sumOk, "the weights of A, the flight and B sum to 1 for every pair of distances (they are ADDED, plus-lighter)");
  check(rangeOk, "every weight is in [0, 1]");
  check(JSON.stringify(shapeWeights(0.2, 5)) === JSON.stringify(shapeWeights(0.2, 5)), "a weight is a pure function of its distances (forward == reverse == shuffled seeks)");
}

section("the ends belong to the real renders");
{
  const first = shapeWeights(0, 120), last = shapeWeights(120, 0);
  check(first.a === 1 && first.m === 0 && first.b === 0, "the first moving frame (nothing travelled, 120 px to go) is exactly the start render");
  check(last.a === 0 && last.m === 0 && last.b === 1, "the landing frame (120 px travelled, nothing to go) is exactly the end render");
  const mid = shapeWeights(60, 60);
  check(mid.m === 1 && mid.a === 0 && mid.b === 0, "far from both ends the flight owns the picture");
  check(shapeWeights(HANDOVER_EPS, 50).a === 0 && shapeWeights(50, HANDOVER_EPS).b === 0, "the flight has all of it once it is HANDOVER_EPS px from an end (the window is a distance)");
}

section("monotone, symmetric, and short travels crossfade");
{
  let monotone = true, prev = shapeWeights(0, 100).a;
  for (let i = 1; i <= 100; i++) { const a = shapeWeights(i * HANDOVER_EPS / 100, 100).a; if (a > prev + 1e-12) monotone = false; prev = a; }
  check(monotone, "A's weight only falls as the flight leaves the start");
  prev = shapeWeights(100, 100).b; let landing = true;
  for (let i = 100; i >= 0; i--) { const b = shapeWeights(100, i * HANDOVER_EPS / 100).b; if (b < prev - 1e-12) landing = false; prev = b; }
  check(landing, "B's weight only rises as the flight approaches the end");
  check(near(shapeWeights(0.3, 100).a, shapeWeights(100, 0.3).b), "the entry and the landing are mirror images");
  const short = shapeWeights(0.2, 0.2);
  check(near(short.a, short.b) && near(short.a + short.m + short.b, 1) && short.a > 0.3, `a whole travel shorter than the window (0.4 px) crossfades A into B (a ${short.a.toFixed(3)}, m ${short.m.toFixed(3)}, b ${short.b.toFixed(3)})`);
}

section("snapped weights: no layer state changes before a layer has a visible share");
{
  const near1 = snapWeights({ a: 1 - SNAP / 2, m: SNAP / 2, b: 0 });
  check(near1.a === 1 && near1.m === 0 && near1.b === 0, "a layer within a thousandth of owning the picture owns it (an effect layer rounds a gradient a level or two differently)");
  const split = snapWeights({ a: 0.6, m: 0.4, b: 0 });
  check(split.a === 0.6 && split.m === 0.4 && split.b === 0, "a real split is untouched");
  const dust = snapWeights({ a: 0.9, m: 0.0005, b: 0.0995 });
  check(dust.m === 0 && dust.a === 0.9 && dust.b === 0.0995, "a share under a thousandth is not drawn");
  check(snapWeights({ a: 0, m: 0, b: 1 }).b === 1, "an exact end stays exact");
}

section("distances");
{
  check(maxShift([0, 0, 10, 10], [0, 0, 10, 10]) === 0, "no anchor moved: 0");
  check(near(maxShift([0, 0, 13, 14], [0, 0, 10, 10]), 5), "the furthest anchor wins (3-4-5)");
  check(maxShift([1, 1], [1, 1, 5, 5]) === 0, "only the anchors both lists hold are compared");
  const circle = [{ x: 0, y: -100, type: "smooth" as const, hIn: { dx: -55, dy: 0 }, hOut: { dx: 55, dy: 0 } }, { x: 100, y: 0, type: "smooth" as const, hIn: { dx: 0, dy: -55 }, hOut: { dx: 0, dy: 55 } }];
  const diamond = circle.map(n => ({ x: n.x, y: n.y, type: "corner" as const }));
  check(pathPoints(circle).length === 12 && pathPoints(circle, 10, 20)[0] === 10 && pathPoints(circle, 10, 20)[1] === -80, "a path's points are every anchor and both handle ends (an absent handle sits on its anchor), offset by the element's origin");
  check(near(maxShift(pathPoints(diamond), pathPoints(circle)), 55), "anchors that coincide but handles that differ are 55 px apart (a circle and its inscribed diamond): a change that lives in the handles counts");
  check(maxShift(pathPoints(circle), pathPoints(circle)) === 0, "the same curve is no distance");
  check(LOOK_TRAVEL > HANDOVER_EPS, "a look change in place (a colour) is a travel longer than the window, so it hands over within the flight");
}

section("one law for text and shapes");
{
  let same = true, sums = true;
  for (const d of [0, 0.01, 0.2, 0.375, 0.75, 4]) for (const e of [0, 0.01, 0.2, 0.375, 0.75, 4]) {
    const t = handoverWeights({ entry: handoverEase(d), landing: 1 - handoverEase(e) }), s = shapeWeights(d, e);
    if (JSON.stringify(t) !== JSON.stringify(s)) same = false;
    if (!near(t.a + t.m + t.b, 1, 1e-12)) sums = false;
  }
  check(same, "shapeWeights is the text hand-over's weights of the same ease (one law, one implementation)");
  check(sums, "the text weights sum to 1 for every pair of distances, a travel shorter than the two windows included (0.2 px each way summed 1.65 before the normalisation)");
  const short = handoverWeights({ entry: handoverEase(0.2), landing: 1 - handoverEase(0.2) });
  check(near(short.a, 0.5) && near(short.b, 0.5) && short.m === 0, "a short text travel crossfades A into B at half and half");
  check(handoverEase(0) === 0 && handoverEase(HANDOVER_EPS) === 1 && handoverEase(9) === 1, "the ease is 0 at no distance and 1 from HANDOVER_EPS on");
}

section("the join law with a round-capped line");
{
  check(cornerJoinOf({ type: "line" }) === "round" && cornerJoinOf({ type: "line", cap: "round" }) === "round", "a line with round caps (the default) rests on round ends: join round");
  check(cornerJoinOf({ type: "line", cap: "butt" }) === null && cornerJoinOf({ type: "line", cap: "square" }) === null, "a butt or square line ends flat as a mitre tip does: no preference");
  check(cornerJoinOf({ type: "rect" }) === "miter" && cornerJoinOf({ type: "path" }) === "round" && cornerJoinOf({ type: "ellipse" }) === null, "rect, path and ellipse keep their joins");
  check(morphJoin({ type: "rect" }, { type: "line", cap: "round" }, 1) === "round", "a rect that becomes a round-capped line lands on a round join (the caps no longer appear at the landing)");
  check(morphJoin({ type: "line", cap: "round" }, { type: "rect" }, 0) === "round", "a round-capped line that becomes a rect starts on a round join");
  check(morphJoin({ type: "rect" }, { type: "line", cap: "butt" }, 1) === "miter", "a butt line keeps the rect's mitre all the way (flat tips)");
  check(pairJoin(null, null, 0.3) === "round", "no preference on either side falls back to round");
}
console.log(`verify-slide-shape-handover: PASS (${checks} checks)`);
