#!/usr/bin/env -S npx tsx
// Animation rework §5 — the Trim Paths dash math (src/lib/slide/player/trim.ts).
// A reference evaluator samples the stroke coverage a (dasharray, dashoffset)
// pair produces — including WAAPI's numeric list interpolation BETWEEN
// keyframes — and asserts every mode × direction × anchor class grows exactly
// the windows the spec documents: open/closed, partial from/to, clamped
// spill knees (mid-keyframes), pathLength scaling, named-anchor resolution,
// and exit reversal. Defaults are pinned legacy-identical (isDefaultTrim).
// Run: npx tsx scripts/verify-trim.ts
import { trimKeyframes, resolveAnchor, isDefaultTrim, type TrimSpec, type TrimKeyframe } from "../src/lib/slide/player/trim";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const near = (a: number, b: number, eps = 0.51) => Math.abs(a - b) <= eps;

// --- reference evaluator ------------------------------------------------------
// Is arc position s (0..L) inside a dash of the repeating pattern?
function visibleAt(s: number, dashes: number[], offset: number): boolean {
  const total = dashes.reduce((a, b) => a + b, 0);
  if (total <= 0) return true; // all-zero pattern renders solid per SVG
  let p = (s + offset) % total;
  if (p < 0) p += total;
  let acc = 0;
  for (let i = 0; i < dashes.length; i++) {
    acc += dashes[i];
    if (p < acc - 1e-9) return i % 2 === 0;
  }
  return dashes.length % 2 === 0 ? false : true;
}
// The covered fraction + [first, last] visible arc position on a path of length L.
function coverage(kf: { strokeDasharray: string; strokeDashoffset: number }, L: number) {
  const dashes = kf.strokeDasharray.split(/\s+/).map(Number);
  const N = 2000;
  let count = 0, first = -1, last = -1;
  const vis: boolean[] = [];
  for (let i = 0; i < N; i++) {
    const s = ((i + 0.5) / N) * L;
    const v = visibleAt(s, dashes, kf.strokeDashoffset);
    vis.push(v);
    if (v) {
      count++;
      if (first < 0) first = s;
      last = s;
    }
  }
  return { frac: count / N, first, last, vis };
}
// WAAPI-style interpolation between two keyframes at u ∈ [0,1] (equal-length lists).
function lerpKf(a: TrimKeyframe, b: TrimKeyframe, u: number): { strokeDasharray: string; strokeDashoffset: number } {
  const da = a.strokeDasharray.split(/\s+/).map(Number);
  const db = b.strokeDasharray.split(/\s+/).map(Number);
  assert(da.length === db.length, `dasharray lists keep one length across keyframes (${da.length} vs ${db.length})`);
  return {
    strokeDasharray: da.map((v, i) => v + (db[i] - v) * u).join(" "),
    strokeDashoffset: a.strokeDashoffset + (b.strokeDashoffset - a.strokeDashoffset) * u,
  };
}
// Evaluate a full keyframe list at eased progress p (piecewise by offset).
function atProgress(frames: TrimKeyframe[], p: number) {
  const offs = frames.map((f, i) => f.offset ?? (i === 0 ? 0 : i === frames.length - 1 ? 1 : NaN));
  for (let i = 0; i < frames.length - 1; i++) {
    const o0 = offs[i], o1 = offs[i + 1];
    if (p >= o0 - 1e-9 && p <= o1 + 1e-9) return lerpKf(frames[i], frames[i + 1], o1 === o0 ? 0 : (p - o0) / (o1 - o0));
  }
  return lerpKf(frames[frames.length - 1], frames[frames.length - 1], 0);
}

const L = 100;
const spec = (over: Partial<TrimSpec>): TrimSpec => ({
  len: L, closed: false, anchor: 0, direction: "forward", mode: "single", from: 0, to: 1, ...over,
});

// --- defaults are the legacy compile path ------------------------------------
assert(isDefaultTrim(undefined) && isDefaultTrim({}) && isDefaultTrim({ anchor: 0, direction: "forward", mode: "single", from: 0, to: 1 }), "default/absent params → legacy drawOn compile (byte-identical old decks)");
assert(isDefaultTrim({ anchor: "start" }), "anchor 'start' is still the legacy default");
assert(!isDefaultTrim({ anchor: 0.3 }) && !isDefaultTrim({ mode: "both-ends" }) && !isDefaultTrim({ to: 0.5 }) && !isDefaultTrim({ direction: "reverse" }), "any real trim param engages the trim engine");

// --- open path, single forward from start (the default shape, trim form) -----
{
  const f = trimKeyframes(spec({}), true);
  assert(f.length === 2, "anchor-at-edge forward growth is fully linear (2 keyframes)");
  assert(near(coverage(f[0], L).frac, 0), "p=0 → nothing visible");
  assert(near(coverage(f[1], L).frac, 1), "p=1 → fully drawn");
  const mid = coverage(atProgress(f, 0.5), L);
  assert(near(mid.frac, 0.5, 0.01) && near(mid.first, 0, 1) && near(mid.last, 50, 1), "p=.5 → the first half [0,50) drawn (grows from the start)");
}

// --- open path, single from an interior anchor: spill knee -------------------
{
  const f = trimKeyframes(spec({ anchor: 0.75 }), true);
  assert(f.length === 3 && near(f[1].offset ?? -1, 0.25, 0.001), "interior anchor forward → knee keyframe at the saturation instant (p=.25)");
  const knee = coverage(atProgress(f, 0.25), L);
  assert(near(knee.first, 75, 1) && near(knee.last, 100, 1), "at the knee the forward side has filled [75,100)");
  const mid = coverage(atProgress(f, 0.625), L);
  assert(near(mid.first, 37.5, 1) && near(mid.last, 100, 1), "after the knee the remainder spills backward ([37.5,100) at p=.625)");
  const done = coverage(atProgress(f, 1), L);
  assert(near(done.frac, 1), "…and the whole path is covered at p=1");
}

// --- open path, single reverse from the end ----------------------------------
{
  const f = trimKeyframes(spec({ anchor: 1, direction: "reverse" }), true);
  const mid = coverage(atProgress(f, 0.5), L);
  assert(near(mid.first, 50, 1) && near(mid.last, 100, 1), "reverse from the end draws [50,100) at p=.5");
}

// --- open path, both-ends meet in the middle ---------------------------------
{
  const f = trimKeyframes(spec({ mode: "both-ends" }), true);
  assert(f.length === 2, "both-ends is fully linear");
  const mid = coverage(atProgress(f, 0.5), L);
  assert(near(mid.frac, 0.5, 0.01) && near(mid.first, 0, 1) && near(mid.last, 100, 1), "p=.5 → both end quarters drawn ([0,25)+[75,100))");
  const c = coverage(atProgress(f, 0.5), L);
  const gapStart = c.vis.findIndex((v, i) => !v && i > 0);
  assert(near((gapStart / 2000) * L, 25, 1.5), "…with the gap opening at 25");
  assert(near(coverage(atProgress(f, 1), L).frac, 1), "p=1 → met in the middle, fully drawn");
}

// --- open path, middle-out (centered anchor: linear; off-center: knee) -------
{
  const f = trimKeyframes(spec({ mode: "middle-out", anchor: 0.5 }), true);
  assert(f.length === 2, "centered middle-out has no knee");
  const mid = coverage(atProgress(f, 0.5), L);
  assert(near(mid.first, 25, 1) && near(mid.last, 75, 1), "p=.5 → the middle half [25,75)");
  const g = trimKeyframes(spec({ mode: "middle-out", anchor: 0.25 }), true);
  assert(g.length === 3 && near(g[1].offset ?? -1, 0.5, 0.001), "off-center middle-out knees when the short side saturates (p=.5)");
  const gm = coverage(atProgress(g, 0.5), L);
  assert(near(gm.first, 0, 1) && near(gm.last, 50, 1), "at the knee: [0,50) — the left side just saturated");
  const g75 = coverage(atProgress(g, 0.75), L);
  assert(near(g75.first, 0, 1) && near(g75.last, 75, 1), "after the knee only the right side grows ([0,75) at p=.75)");
}

// --- partial trims (from/to) --------------------------------------------------
{
  const f = trimKeyframes(spec({ from: 0.2, to: 0.6 }), true);
  const done = coverage(atProgress(f, 1), L);
  assert(near(done.first, 20, 1) && near(done.last, 60, 1) && near(done.frac, 0.4, 0.01), "final window is exactly [from,to] = [20,60)");
  const mid = coverage(atProgress(f, 0.5), L);
  assert(near(mid.first, 20, 1) && near(mid.last, 40, 1), "growth happens WITHIN the window (anchor clamped to its start)");
}

// --- closed paths: pattern+offset form, always linear -------------------------
{
  // grow clockwise from anchor 0.25 (a rect's top-right-ish)
  const f = trimKeyframes(spec({ closed: true, anchor: 0.25 }), true);
  assert(f.length === 2, "closed growth is exactly linear (offset rides the pattern)");
  const mid = coverage(atProgress(f, 0.5), L);
  assert(near(mid.frac, 0.5, 0.01) && near(mid.first, 25, 1) && near(mid.last, 75, 1), "closed single-forward draws [A, A+pL) — [25,75) at p=.5");
  // reverse
  const r = trimKeyframes(spec({ closed: true, anchor: 0.25, direction: "reverse" }), true);
  const rm = coverage(atProgress(r, 0.25), L);
  assert(near(rm.first, 0, 1) && near(rm.last, 25, 1), "closed reverse grows backward from the anchor ([0,25) at p=.25)");
  // symmetric (both-ends/middle-out are the same thing on a loop)
  const s2 = trimKeyframes(spec({ closed: true, anchor: 0.5, mode: "both-ends" }), true);
  const sm = coverage(atProgress(s2, 0.5), L);
  assert(near(sm.first, 25, 1) && near(sm.last, 75, 1), "closed symmetric grows about the anchor ([25,75) at p=.5)");
  // wrap across the seam: anchor 0 symmetric → visible [75..100)+[0..25) at p=.5
  const w = trimKeyframes(spec({ closed: true, anchor: 0, mode: "middle-out" }), true);
  const wc = coverage(atProgress(w, 0.5), L);
  assert(near(wc.frac, 0.5, 0.01) && wc.vis[0] && wc.vis[1999] && !wc.vis[1000], "closed windows WRAP the seam (visible at both ends, hidden mid-path)");
  // partial arc: from/to set LENGTH on a loop, anchor sets position
  const pa = trimKeyframes(spec({ closed: true, anchor: 0.25, from: 0, to: 0.75 }), true);
  const pc = coverage(atProgress(pa, 1), L);
  assert(near(pc.frac, 0.75, 0.01) && near(pc.first, 25, 1), "closed partial: final arc length = (to−from)·L placed at the anchor");
}

// --- exits play the same math backwards ---------------------------------------
{
  const on = trimKeyframes(spec({ anchor: 0.75 }), true);
  const off = trimKeyframes(spec({ anchor: 0.75 }), false);
  assert(off.length === on.length, "drawOff keeps the keyframe count");
  assert(near(coverage(off[0], L).frac, 1) && near(coverage(off[off.length - 1], L).frac, 0), "drawOff runs full → nothing");
  assert(near(off[1].offset ?? -1, 0.75, 0.001), "…with the knee mirrored (1−p)");
}

// --- pathLength scaling --------------------------------------------------------
{
  // an explicit pathLength=1 (common for CSS tricks): all dash units scale to it
  const f = trimKeyframes(spec({ len: 1 }), true);
  const mid = coverage(atProgress(f, 0.5), 1);
  assert(near(mid.frac, 0.5, 0.01), "dash units are expressed in the caller's effective length (pathLength honored)");
}

// --- named anchors -------------------------------------------------------------
{
  const rect = { tag: "rect", width: 100, height: 50 };
  const P = 300;
  assert(resolveAnchor("corner-tl", rect) === 0, "rect corner-tl = 0 (SVG stroke origin)");
  assert(near(resolveAnchor("corner-tr", rect) * P, 100, 0.01), "rect corner-tr = w/P");
  assert(near(resolveAnchor("corner-br", rect) * P, 150, 0.01), "rect corner-br = (w+h)/P");
  assert(near(resolveAnchor("corner-bl", rect) * P, 250, 0.01), "rect corner-bl = (2w+h)/P");
  assert(near(resolveAnchor("bottom", rect) * P, 200, 0.01), "rect bottom = midpoint of the bottom edge");
  assert(resolveAnchor("bottom", { tag: "ellipse" }) === 0.25 && resolveAnchor("top", { tag: "ellipse" }) === 0.75, "ellipse: 3-o'clock origin, clockwise (bottom=.25, top=.75)");
  assert(resolveAnchor("middle", { tag: "path" }) === 0.5 && resolveAnchor("end", { tag: "path" }) === 1, "path: start/middle/end fractions");
  assert(resolveAnchor(0.37, { tag: "path" }) === 0.37 && resolveAnchor("0.4", { tag: "path" }) === 0.4, "numeric anchors pass through (string numerals too)");
  assert(resolveAnchor("nonsense", { tag: "path" }) === 0, "unknown names fall back to the start");
}

console.log("\nTRIM PATHS (dash math, every mode × direction × anchor class): PASS");
