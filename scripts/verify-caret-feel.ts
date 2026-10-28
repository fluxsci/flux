// Caret-motion guard (hermetic, pure tier).
//
// The October 27 owner request supersedes the old two-mode lab contract:
// Chase is the sole built-in behavior. Keep its transient ticker, Vim/IME/
// multi-cursor safeguards, exact cursor geometry and finite soft blink.

import { readFileSync } from "node:fs";
import { decodeSettings } from "../src/lib/settings";

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

// ---- 1. Chase is now unconditional (owner October 27 issue list).
const settings = read("src/lib/settings.ts");
assert(!/paperCaretFeel:\s*PaperCaretFeel/.test(settings), "no configurable caret mode remains");
const decoded = decodeSettings({ paperCaretFeel: "smooth", paperCaretMs: 90, paperLocalCorrections: false }) as unknown as Record<string, unknown>;
assert(!("paperCaretFeel" in decoded) && !("paperCaretMs" in decoded) && decoded.paperLocalCorrections === false, "old caret-mode preferences are discarded safely");

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
assert(!/SMOOTH_|smoothEase|this\.mode|settings\.subscribe/.test(cf), "only Chase motion remains, with no settings subscription");
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
assert(!/paperCaretFeel|caretFeels/.test(ui), "Settings no longer exposes a caret-motion picker");
assert(
  !/paperCaretMs|paperCaretSoftBlink|paperSmoothLineScroll/.test(ui),
  "Settings UI does not expose the retired lab settings",
);

// ---- report ------------------------------------------------------------------
console.log(failed === 0 ? "\nCARET-FEEL GUARD: PASS" : `\nCARET-FEEL GUARD: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
