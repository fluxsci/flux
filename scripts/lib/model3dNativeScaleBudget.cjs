'use strict';
// Frame-timing budgets for the native 3D qualification harnesses (review R1/R2).
//
// Evidence (2026-09-28, the owner's 59.97 Hz desktop): the display's vsync is
// 16.674 ms and an EMPTY Figure control measured a raw frame-gap p95 of
// 16.702 ms. The former native orbit rule "raw p95 <= 16.7 ms" therefore fails
// with no model on screen at all; it measured the display, not Flux. The rule
// now uses the house frame budget (p95 <= 17 ms, the same bound as
// verify-scale-slide.mjs) PLUS a dropped-frame criterion relative to an idle
// vsync control recorded in the same run. The owner approved this definition in the Stage 2 prompt (2026-09-29).
const HOUSE_FRAME_BUDGET_MS = 17;
// A steady gap longer than 1.5 idle vsyncs means at least one display refresh
// passed without a new frame.
const DROPPED_FRAME_FACTOR = 1.5;
// At most 2 % of the steady gaps (never fewer than one) may be dropped frames.
const MAX_DROPPED_FRACTION = 0.02;
const MIN_IDLE_FRAMES = 30;

function samples(values, label) {
  if (!Array.isArray(values) || !values.length || values.some(v => !Number.isFinite(v) || v <= 0)) throw Error(`${label} needs finite positive raw frame gaps`);
  return [...values].sort((a, b) => a - b);
}
/** Same percentile rule as the native orbit harness always used. */
function p95(values) { const sorted = samples(values, 'p95'); return sorted[Math.ceil(sorted.length * .95) - 1]; }
/** The idle vsync is the median gap of an idle requestAnimationFrame control. */
function idleVsyncMs(gaps) {
  const sorted = samples(gaps, 'Idle vsync control');
  if (sorted.length < MIN_IDLE_FRAMES) throw Error(`Idle vsync control needs at least ${MIN_IDLE_FRAMES} frames (got ${sorted.length})`);
  return sorted[Math.floor(sorted.length / 2)];
}
/** Native orbit qualification: house p95 budget and bounded dropped frames. */
function orbitFrameQualification({ steadyGaps, idleGaps }) {
  const steady = samples(steadyGaps, 'Orbit qualification');
  const vsync = idleVsyncMs(idleGaps), threshold = DROPPED_FRAME_FACTOR * vsync;
  const p95Ms = p95(steady), dropped = steady.filter(gap => gap > threshold).length;
  const allowedDropped = Math.max(1, Math.floor(steady.length * MAX_DROPPED_FRACTION));
  const p95Ok = p95Ms <= HOUSE_FRAME_BUDGET_MS, droppedOk = dropped <= allowedDropped;
  return { p95Ms, budgetMs: HOUSE_FRAME_BUDGET_MS, idleVsyncMs: vsync, idleP95Ms: p95(idleGaps), droppedThresholdMs: threshold, dropped, allowedDropped, steadyGaps: steady.length, p95Ok, droppedOk, ok: p95Ok && droppedOk };
}
module.exports = { HOUSE_FRAME_BUDGET_MS, DROPPED_FRAME_FACTOR, MAX_DROPPED_FRACTION, MIN_IDLE_FRAMES, p95, idleVsyncMs, orbitFrameQualification };
