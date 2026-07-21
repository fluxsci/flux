// Caret-feel lab guard (hermetic, pure tier) — caret-feel branch experiments.
//
// The lab adds overlay caret motion models (monkeytype/chase/chase-trail),
// soft blink, and smooth line scroll behind Settings toggles. This gate pins
// the invariants that make the experiments safe to carry:
//
//   1. DEFAULTS ARE THE SHIPPED BEHAVIOR — mode "classic", both polish
//      toggles off. Flipping a default is a deliberate product decision, not a
//      side effect (and verify-writer-latency.ts separately pins the classic
//      CSS glide itself).
//   2. NO AMBIENT ANIMATION LOOP — the ticker must self-terminate (the E43
//      lesson: a continuous rAF loop deepens the compositor pipeline and adds
//      ~50ms editor INP). No setInterval, and the rAF reschedule must be
//      conditional on in-flight work.
//   3. VIM/MULTI-CURSOR SAFETY — the overlay only ever replaces the thin
//      stock-layer caret: the hide rule must exclude the vim cursor layer,
//      and vim-mode/multi-cursor bail to stock.
//   4. MOTION IS NEVER GATED ON prefers-reduced-motion (guide §9: this
//      desktop's real Chrome/Electron reports `reduce`).
//
// Run: npx tsx scripts/verify-caret-feel.ts

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

// ---- 1. Settings: keys exist, defaults are the shipped behavior --------------
const settings = read("src/lib/settings.ts");
assert(
  /paperCaretFeel:\s*PaperCaretFeel/.test(settings),
  "Settings type declares paperCaretFeel: PaperCaretFeel",
);
assert(
  /"classic"\s*\|\s*"monkeytype"\s*\|\s*"chase"\s*\|\s*"chase-trail"/.test(settings),
  "PaperCaretFeel enumerates classic|monkeytype|chase|chase-trail",
);
assert(/paperCaretFeel:\s*"classic"/.test(settings), 'paperCaretFeel default is "classic" (shipped behavior)');
assert(/paperCaretSoftBlink:\s*false/.test(settings), "paperCaretSoftBlink defaults off");
assert(/paperSmoothLineScroll:\s*false/.test(settings), "paperSmoothLineScroll defaults off");

// ---- 2. The plugin: transient ticker, safety rails ---------------------------
const cf = read("src/shell/modes/paper/editing/caretFeel.ts");
assert(!/setInterval/.test(cf), "no setInterval anywhere in caretFeel");
assert(
  /this\.raf = busy \? requestAnimationFrame\(this\.step\) : 0;/.test(cf),
  "the ticker reschedules ONLY while work is in flight (self-terminating, E43)",
);
assert(/if \(this\.raf\) cancelAnimationFrame\(this\.raf\);/.test(cf), "destroy() cancels a pending frame");
assert(
  !/matchMedia|@media \(prefers-reduced-motion/.test(cf),
  "motion is not gated on prefers-reduced-motion (no matchMedia / @media query)",
);
assert(
  /\.cm-cursorLayer:not\(\.cm-vimCursorLayer\) \.cm-cursor-primary/.test(cf),
  "the overlay hide rule is scoped to the stock layer's primary cursor (vim fat cursor untouched)",
);
assert(/cm-vimMode/.test(cf) && /cursors\.length !== 1/.test(cf), "vim mode and multi-cursor bail to the stock caret");
assert(/this\.view\.composing/.test(cf), "IME composition teleports instead of animating");
assert(/GATE_DY_LINES/.test(cf) && /GATE_DX_PX/.test(cf), "large jumps teleport (distance gates exist)");
assert(/MT_DUR_MS = 90/.test(cf) && /MT_EASE_EXP = 1\.25/.test(cf), "monkeytype mode: 90ms inOut(1.25) tween constants");
assert(/SCROLL_MAX_LINES/.test(cf), "smooth line scroll is bounded to small typing jumps");
assert(
  /write: \(\) => this\.syncFromLayer\(\)/.test(cf),
  "overlay geometry is read in the measure WRITE phase (after the cursor layer's write)",
);

// ---- 3. Wiring: extension registered, UI exposed -----------------------------
const setup = read("src/shell/modes/paper/markdown-setup.ts");
assert(/caretFeel\(\)/.test(setup), "markdown-setup registers caretFeel()");
assert(
  setup.indexOf("drawSelection()") < setup.indexOf("caretFeel()"),
  "caretFeel sits after drawSelection in the extension tree (measure ordering)",
);

const ui = read("src/lib/Settings.svelte");
assert(/paperCaretFeel/.test(ui), "Settings UI exposes the caret-feel mode picker");
assert(/paperCaretSoftBlink/.test(ui) && /paperSmoothLineScroll/.test(ui), "Settings UI exposes both polish toggles");

// ---- report ------------------------------------------------------------------
console.log(failed === 0 ? "\nCARET-FEEL GUARD: PASS" : `\nCARET-FEEL GUARD: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
