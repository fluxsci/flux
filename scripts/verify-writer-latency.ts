// Writer-latency regression guard (hermetic, pure tier).
// presence: the source-shape half is main-process/not headless-drivable (WS-7.5).
//
// This is the always-on tripwire for the two writer-responsiveness invariants
// that were hand-won on Electron 43 / Chromium 150 — asserted against source so
// they can never be silently undone in a refactor. The *live* measurement lives
// in scripts/perf/writer-latency.mjs (CDP INP probe) and the electron-tier
// scripts/verify-writer-latency-inp.mjs gate; this file guards the shape those
// probes exist to protect, and runs in `npm test` with zero flakiness. The live
// end-to-end gate is scripts/verify-writer-latency-inp.mjs (launches the real
// app, measures the ambient-ON−OFF INP delta).
//
//   1. The ambient DynamicBackground loop is setTimeout-paced, NOT rAF-driven.
//      A continuous main-thread requestAnimationFrame loop pulls the page into a
//      deep frame pipeline that added ~50ms of input→paint latency to every
//      keystroke in the adjacent editor (measured 88ms rAF vs 40ms setTimeout).
//      The background must stay ALWAYS-ON (owner spec) but OFF the rAF lifecycle.
//   2. (retired 2026-07-21) The --flux-caret-ms CSS caret glide was superseded
//      by the overlay caret (editing/caretFeel.ts, owner decision out of the
//      caret-feel lab; measured 16ms BETTER keystroke-INP p95 than the CSS
//      transition). Its invariants — incl. the E43 no-ambient-rAF discipline
//      for the caret ticker — are pinned by scripts/verify-caret-feel.ts.
//
// Run: npx tsx scripts/verify-writer-latency.ts

import { readFileSync } from "node:fs";

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

const read = (p: string) => readFileSync(p, "utf8");

// ---- 1. Ambient background: setTimeout-paced, never a continuous rAF loop ----
const bg = read("src/shell/modes/paper/margin/DynamicBackground.svelte");
assert(/setTimeout\(tick,\s*16\)/.test(bg), "DynamicBackground schedules its tick via setTimeout(tick, 16)");
assert(
  !/requestAnimationFrame\s*\(\s*tick\s*\)/.test(bg),
  "DynamicBackground never drives its continuous loop with requestAnimationFrame(tick)",
);
// The pacing rationale must survive as an inline invariant, not just as a commit.
assert(/PACING\b/.test(bg) && /setTimeout, NOT requestAnimationFrame/i.test(bg), "the setTimeout-vs-rAF pacing rationale is documented in-file");
// Cleanup must clear the timer (a leftover cancelAnimationFrame would leak the loop).
assert(/clearTimeout\(timer\)/.test(bg), "the loop teardown clears the setTimeout handle");
assert(!/cancelAnimationFrame/.test(bg), "no stale cancelAnimationFrame (which cannot cancel a setTimeout handle)");
// The dev-only loop control the INP probe/gate depend on.
assert(/pause:\s*\(\)\s*=>\s*stopLoop\(\)/.test(bg) && /resume:\s*\(\)\s*=>\s*startLoop\(\)/.test(bg), "dev-only __fluxMargin.bg.pause()/resume() are exposed for the INP probe");

// ---- 2. Caret motion: owned by the overlay caret (see header) ----------------
// The CSS-glide pins that lived here are retired; verify-caret-feel.ts is the
// caret contract gate. Keep one negative pin so the old mechanism can't creep
// back in beside the overlay (double animation = double latency).
const theme = read("src/shell/modes/paper/flux-theme.ts");
assert(!/--flux-caret-ms/.test(theme), "the retired --flux-caret-ms CSS glide has not crept back into flux-theme");

// ---- report ------------------------------------------------------------------
console.log(failed === 0 ? "\nWRITER-LATENCY GUARD: PASS" : `\nWRITER-LATENCY GUARD: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
