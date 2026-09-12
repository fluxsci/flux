#!/usr/bin/env -S npx tsx
// Paper TEXT SIZE — the hermetic half of the contract.
//
//   (A) the MECHANISM: the type scale is declared for `:root, .ts-scaled` (not
//       :root alone) and every --ts-* token multiplies through var(--ts-scale).
//       This is not style policing — a custom property's var()s are substituted
//       on the element that DECLARES them, so dropping `.ts-scaled` from that
//       selector list silently turns every panel scale into a no-op while
//       everything still compiles and renders. The editor theme likewise must
//       carry no bare px font-size, or the manuscript's own type would ignore
//       the slider.
//   (B) the ladder: clamp, rounding, and Ctrl+/− stepping (incl. from a value
//       the slider dragged BETWEEN rungs).
//   (C) scope: which panels the slider drives, the refusal to empty the scope,
//       and the independence of scope from size.
//   (D) persistence input is untrusted — normalize never throws and never
//       yields an unusable state.
//
// The rendered half (real computed font sizes, the status-bar control, the
// chords, persistence across a reload) is verify-paper-textsize-gui.mjs.
//   npx tsx scripts/verify-paper-textscale.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { harness } from "./lib/harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const h = harness("verify-paper-textscale");

const {
  PAPER_PANELS,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEPS,
  TEXT_SCALE_CLASS,
  allTargeted,
  clampScale,
  DEFAULT_TEXT_SCALE,
  normalizeTextScale,
  panelScaleStyle,
  representativeScale,
  resetTargets,
  scalePercent,
  setAllTargets,
  setScale,
  setTarget,
  stepScale,
  stepTargets,
  targetPanels,
  targetsMixed,
} = await import("../src/shell/modes/paper/view-mode/paperTextScale");

type State = ReturnType<typeof normalizeTextScale>;
const fresh = (): State => normalizeTextScale(undefined);

// ---- (A) the mechanism lives where it has to ---------------------------------
{
  const tokens = readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8");
  const block = tokens.match(/:root,\s*\.ts-scaled\s*\{([^}]*)\}/);
  h.ok(!!block, "tokens.css declares the type scale for `:root, .ts-scaled`, not :root alone");
  const body = block?.[1] ?? "";
  const TOKENS = ["--ts-xs", "--ts-sm", "--ts-base", "--ts-md", "--ts-lg", "--ts-xl", "--ts-2xl"];
  for (const t of TOKENS) {
    const line = body.split("\n").find((l) => l.trim().startsWith(`${t}:`)) ?? "";
    h.ok(
      /calc\(\s*[\d.]+px\s*\*\s*var\(--ts-scale\)\s*\)/.test(line),
      `${t} multiplies through var(--ts-scale)`,
    );
  }
  const rootStart = tokens.indexOf(":root {");
  const rootBody = tokens.slice(rootStart, tokens.indexOf("}", rootStart));
  h.ok(
    /--ts-scale:\s*1;/.test(rootBody),
    "--ts-scale defaults to 1 on :root, so every unscaled surface is unchanged",
  );
  h.ok(TEXT_SCALE_CLASS === "ts-scaled", "the core exports the class name the CSS block matches");

  const theme = readFileSync(join(ROOT, "src/shell/modes/paper/flux-theme.ts"), "utf8");
  const barePx = [...theme.matchAll(/fontSize:\s*"(\d[\d.]*px[^"]*)"/g)].map((m) => m[1]);
  h.ok(
    barePx.length === 0,
    `the editor theme carries no bare px font-size (found ${JSON.stringify(barePx)})`,
  );
  const scaled = [...theme.matchAll(/calc\(\d[\d.]*px \* var\(--ts-scale, 1\)\)/g)].length;
  h.ok(scaled >= 8, `editor theme sizes ride --ts-scale (${scaled} scaled declarations)`);
}

// ---- (B) the ladder ----------------------------------------------------------
{
  h.ok(clampScale(0.01) === SCALE_MIN && clampScale(99) === SCALE_MAX, "clamp pins both ends");
  h.ok(clampScale(Number.NaN) === 1, "a non-finite scale falls back to 100%, never NaN");
  h.ok(clampScale(1.0000001) === 1, "clamp rounds float noise out of the persisted value");
  h.ok(scalePercent(1.1) === 110 && scalePercent(0.5) === 50, "the readout is a whole percent");

  h.ok(stepScale(1, 1) === 1.1 && stepScale(1, -1) === 0.9, "one rung up / down from 100%");
  h.ok(stepScale(SCALE_MAX, 1) === SCALE_MAX, "stepping up at the ceiling stays put");
  h.ok(stepScale(SCALE_MIN, -1) === SCALE_MIN, "stepping down at the floor stays put");
  // The slider is finer than the ladder, so "current" is regularly off-rung.
  h.ok(stepScale(1.03, 1) === 1.1, "from between rungs, Ctrl+= moves to the next rung ABOVE");
  h.ok(stepScale(1.03, -1) === 1, "from between rungs, Ctrl+− moves to the next rung BELOW");
  h.ok(stepScale(1.1, -1) === 1, "stepping back down returns exactly to 100%");
  const monotonic = SCALE_STEPS.every((v, i) => i === 0 || v > SCALE_STEPS[i - 1]);
  h.ok(monotonic, "the ladder is strictly increasing");
  h.ok(
    SCALE_STEPS[0] === SCALE_MIN && SCALE_STEPS[SCALE_STEPS.length - 1] === SCALE_MAX,
    "the ladder spans exactly the slider's range",
  );
  h.ok(SCALE_STEPS.includes(1), "100% is a rung, so Ctrl+/− always passes back through it");

  h.ok(panelScaleStyle(1.25) === "--ts-scale:1.25", "the panel style sets --ts-scale");
  h.ok(panelScaleStyle(9) === `--ts-scale:${SCALE_MAX}`, "the panel style clamps too");
}

// ---- (C) scope ---------------------------------------------------------------
{
  const d = fresh();
  h.ok(d.targets.editor && !d.targets.sidebar && !d.targets.margin, "the manuscript is the default scope");
  h.ok(PAPER_PANELS.every((p) => d.scale[p] === 1), "every panel starts at 100%");

  // Scale reaches the scoped panels and NOTHING else.
  const editorOnly = setScale(d, 1.5);
  h.ok(editorOnly.scale.editor === 1.5, "the slider resizes the scoped panel");
  h.ok(
    editorOnly.scale.sidebar === 1 && editorOnly.scale.margin === 1,
    "an out-of-scope panel keeps its own size",
  );

  const all = setAllTargets(editorOnly, true);
  h.ok(allTargeted(all), "'All panels together' scopes all three");
  h.ok(
    all.scale.editor === 1.5 && all.scale.sidebar === 1,
    "re-scoping alone resizes nothing — scope and size are independent",
  );
  h.ok(targetsMixed(all), "a scope whose panels disagree reports mixed");
  h.ok(representativeScale(all) === 1.5, "the readout follows the manuscript when it is in scope");
  const harmonized = setScale(all, 1.25);
  h.ok(
    PAPER_PANELS.every((p) => harmonized.scale[p] === 1.25) && !targetsMixed(harmonized),
    "one slider move harmonizes a mixed scope",
  );

  // Stepping a mixed scope lands everyone on one rung.
  const stepped = stepTargets(all, 1);
  h.ok(
    PAPER_PANELS.every((p) => stepped.scale[p] === 1.75),
    "Ctrl+= on a mixed scope steps from the representative panel and harmonizes",
  );
  h.ok(
    PAPER_PANELS.every((p) => resetTargets(stepped).scale[p] === 1),
    "Ctrl+0 returns every scoped panel to 100%",
  );

  // Sidebar-only: the readout must follow the panel actually being driven.
  let sideOnly = setTarget(d, "sidebar", true);
  sideOnly = setTarget(sideOnly, "editor", false);
  h.ok(targetPanels(sideOnly).join() === "sidebar", "a single non-editor panel can hold the scope");
  h.ok(
    representativeScale(setScale(sideOnly, 0.9)) === 0.9,
    "the readout follows the scoped panel when the manuscript is out of scope",
  );
  h.ok(
    setScale(sideOnly, 0.9).scale.editor === 1,
    "resizing the sidebar alone leaves the manuscript alone",
  );

  // The scope can never be emptied — a slider wired to nothing is a dead control.
  const emptied = setTarget(sideOnly, "sidebar", false);
  h.ok(emptied === sideOnly, "unchecking the LAST panel is refused (identity, no state churn)");
  h.ok(targetPanels(emptied).length >= 1, "the scope is never empty");
}

// ---- (D) untrusted persisted state -------------------------------------------
{
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "1.5"],
    ["an empty object", {}],
    ["a partial object", { scale: { editor: 1.5 } }],
    ["an out-of-range scale", { scale: { editor: 40, sidebar: -3, margin: Number.NaN } }],
    ["a wrong-typed target", { targets: { editor: "yes", sidebar: 1 } }],
    ["an all-false scope", { targets: { editor: false, sidebar: false, margin: false } }],
    ["an unknown panel", { scale: { nope: 2 }, targets: { nope: true } }],
  ];
  for (const [label, raw] of cases) {
    let s: State | null = null;
    try {
      s = normalizeTextScale(raw);
    } catch (e) {
      h.ok(false, `normalize survives ${label} (threw: ${(e as Error).message})`);
      continue;
    }
    const sane =
      PAPER_PANELS.every(
        (p) =>
          typeof s!.scale[p] === "number" &&
          s!.scale[p] >= SCALE_MIN &&
          s!.scale[p] <= SCALE_MAX &&
          typeof s!.targets[p] === "boolean",
      ) && targetPanels(s).length >= 1;
    h.ok(sane, `normalize yields a usable state from ${label}`);
    h.ok(Object.keys(s.scale).length === PAPER_PANELS.length, `normalize drops unknown panels (${label})`);
  }
  h.ok(
    normalizeTextScale({ scale: { editor: 40 } }).scale.editor === SCALE_MAX,
    "an out-of-range persisted scale is clamped, not discarded",
  );
  h.ok(
    normalizeTextScale({ targets: { editor: false, sidebar: false, margin: false } }).targets.editor,
    "an all-false persisted scope heals to the manuscript",
  );
  h.ok(
    JSON.stringify(normalizeTextScale(JSON.parse(JSON.stringify(DEFAULT_TEXT_SCALE)))) ===
      JSON.stringify(DEFAULT_TEXT_SCALE),
    "the default state round-trips through JSON unchanged",
  );
}

await h.done();
