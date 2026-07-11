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
//   2. The caret glide is user-configurable via --flux-caret-ms with the tuned
//      70ms default preserved (owner unlocked configurability July 2026).
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

// ---- 2. Caret glide: configurable via --flux-caret-ms, default 70ms ----------
const theme = read("src/shell/modes/paper/flux-theme.ts");
assert(
  /transition:\s*"left var\(--flux-caret-ms,\s*70ms\) ease-out, top var\(--flux-caret-ms,\s*70ms\) ease-out"/.test(theme),
  "flux-theme .cm-cursor transition reads var(--flux-caret-ms, 70ms) (default preserved)",
);

const settings = read("src/lib/settings.ts");
assert(/paperCaretMs:\s*number/.test(settings), "Settings type declares paperCaretMs: number");
assert(/paperCaretMs:\s*70\b/.test(settings), "paperCaretMs default is the tuned 70ms");

const pm = read("src/shell/modes/paper/PaperMode.svelte");
assert(
  /--flux-caret-ms:\s*\{?\$settings\.paperCaretMs\}?ms/.test(pm),
  "PaperMode sets --flux-caret-ms from $settings.paperCaretMs on section.paper",
);

const settingsUi = read("src/lib/Settings.svelte");
assert(/paperCaretMs/.test(settingsUi), "Settings UI exposes a paperCaretMs control");

// ---- report ------------------------------------------------------------------
console.log(failed === 0 ? "\nWRITER-LATENCY GUARD: PASS" : `\nWRITER-LATENCY GUARD: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
