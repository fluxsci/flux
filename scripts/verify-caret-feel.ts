// Caret-motion guard (hermetic, pure tier).
//
// The overlay caret (src/shell/modes/paper/editing/caretFeel.ts) is the paper
// caret: chase (default) | smooth motion, built-in soft blink. Shipped
// 2026-07-21 from the caret-feel lab (owner A/B decision); it SUPERSEDED the
// old .cm-cursor CSS transition + --flux-caret-ms/paperCaretMs setting — this
// gate replaced verify-writer-latency.ts's section 2 pins of that contract.
// Invariants pinned here:
//
//   1. THE CONTRACT — modes are exactly chase|smooth, default "chase"; the
//      retired lab settings (paperCaretMs, paperCaretSoftBlink,
//      paperSmoothLineScroll) stay gone and their persisted values migrate.
//   2. NO AMBIENT ANIMATION LOOP — the ticker must self-terminate (the E43
//      lesson: a continuous rAF loop deepens the compositor pipeline and adds
//      ~50ms editor INP). No setInterval, and the rAF reschedule must be
//      conditional on in-flight work.
//   3. VIM/MULTI-CURSOR SAFETY — the overlay only ever replaces the thin
//      stock-layer caret: the hide rule must exclude the vim cursor layer,
//      and vim-mode/multi-cursor bail to stock.
//   4. MOTION IS NEVER GATED ON prefers-reduced-motion (guide §9: this
//      desktop's real Chrome/Electron reports `reduce`).
//   5. THE OLD CSS GLIDE STAYS RETIRED — no --flux-caret-ms / .cm-cursor
//      transition anywhere in the paper module.
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

// ---- 1. Settings: the chase|smooth contract ---------------------------------
const settings = read("src/lib/settings.ts");
assert(
  /paperCaretFeel:\s*PaperCaretFeel/.test(settings),
  "Settings type declares paperCaretFeel: PaperCaretFeel",
);
assert(
  /PaperCaretFeel = "chase" \| "smooth"/.test(settings),
  "PaperCaretFeel is exactly chase|smooth",
);
assert(/paperCaretFeel:\s*"chase"/.test(settings), 'paperCaretFeel default is "chase"');
for (const gone of ["paperCaretMs", "paperCaretSoftBlink", "paperSmoothLineScroll"]) {
  assert(
    !new RegExp(`${gone}:\\s*(number|boolean)`).test(settings),
    `retired setting ${gone} is not declared`,
  );
}
assert(
  /paperCaretFeel === "monkeytype"\) out\.paperCaretFeel = "smooth"/.test(settings),
  'migration maps persisted "monkeytype" → "smooth"',
);
assert(
  /delete out\.paperCaretMs/.test(settings) &&
    /delete out\.paperCaretSoftBlink/.test(settings) &&
    /delete out\.paperSmoothLineScroll/.test(settings),
  "migration deletes the retired lab keys",
);

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
assert(/SMOOTH_DUR_MS = 90/.test(cf) && /SMOOTH_EASE_EXP = 1\.25/.test(cf), "smooth mode: 90ms inOut(1.25) tween constants");
assert(
  /write: \(\) => this\.syncFromLayer\(\)/.test(cf),
  "overlay geometry is read in the measure WRITE phase (after the cursor layer's write)",
);
// Soft blink is built-in, not a setting.
assert(/scrollDOM\.classList\.add\("cf-softblink"\)/.test(cf), "soft blink is applied unconditionally");
assert(/cf-soft-blink 1\.15s ease-in-out 8/.test(cf), "soft blink pulses finitely (8 cycles), then rests solid");
assert(!/cf-hard-blink/.test(cf), "no hard-blink path remains");

// ---- 3. The old CSS glide stays retired --------------------------------------
const theme = read("src/shell/modes/paper/flux-theme.ts");
assert(!/--flux-caret-ms|transition:\s*"left/.test(theme), "flux-theme has no .cm-cursor transition / --flux-caret-ms");
const pm = read("src/shell/modes/paper/PaperMode.svelte");
assert(!/--flux-caret-ms/.test(pm), "PaperMode no longer sets --flux-caret-ms");

// ---- 4. Wiring: extension registered, UI exposed -----------------------------
const setup = read("src/shell/modes/paper/markdown-setup.ts");
assert(/caretFeel\(\)/.test(setup), "markdown-setup registers caretFeel()");
assert(
  setup.indexOf("drawSelection()") < setup.indexOf("caretFeel()"),
  "caretFeel sits after drawSelection in the extension tree (measure ordering)",
);

const ui = read("src/lib/Settings.svelte");
assert(/paperCaretFeel/.test(ui), "Settings UI exposes the caret-motion picker");
assert(
  !/paperCaretMs|paperCaretSoftBlink|paperSmoothLineScroll/.test(ui),
  "Settings UI does not expose the retired lab settings",
);

// ---- report ------------------------------------------------------------------
console.log(failed === 0 ? "\nCARET-FEEL GUARD: PASS" : `\nCARET-FEEL GUARD: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
