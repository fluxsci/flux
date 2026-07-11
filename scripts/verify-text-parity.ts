#!/usr/bin/env -S npx tsx
// WS-12 (fortify plan) — the text-layout cross-surface guard. Headless edits
// can't measure fonts, so wrapping elements (sizing auto-h/fixed) lose their
// wrap cache and render UNWRAPPED until a GUI re-measures. The guard makes
// that divergence VISIBLE instead of silent:
//   · pure ops + the headless applyTextLayout seam set `needsLayout`;
//   · "auto"-sizing elements (hard lines render directly) are never flagged;
//   · the flag round-trips through the flux-core save/load;
//   · flux-core's render probe + validate() warn, NAMING the element;
//   · a (mock-)measuring applyTextLayout clears the flag — the GUI heal.
//   npx tsx scripts/verify-text-parity.ts

import "./lib/cssStub.mjs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const ops = await import("../src/lib/ops");
const { applyTextLayout } = await import("../src/lib/text");
const core = await import("../flux-core/index");
type Project = import("../src/lib/types").Project;
type TextElement = import("../src/lib/types").TextElement;

const textEl = (id: string, sizing: "auto" | "auto-h" | "fixed", extra: Partial<TextElement> = {}): TextElement =>
  ({
    id,
    type: "text",
    name: `T-${id}`,
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    rotation: 0,
    text: "the quick brown fox jumps over the lazy dog",
    fontFamily: "Inter",
    fontSize: 12,
    fontWeight: 400,
    fontStyle: "normal",
    align: "left",
    color: "#000000",
    sizing,
    lines: ["the quick brown fox", "jumps over the lazy dog"], // a GUI-computed cache
    ...extra,
  }) as TextElement;

const proj = (els: TextElement[]): Project =>
  ({
    version: 2,
    name: "t",
    canvases: [{ id: "c1", name: "C1" }],
    figures: [{ id: "fig1", canvasId: "c1", name: "Fig 1", x: 0, y: 0, width: 300, height: 200, elements: els }],
    assets: [],
    palette: [],
  }) as unknown as Project;

// ---- 1. pure ops flag wrapping elements, never "auto" -------------------------
{
  const p = proj([textEl("wrapped", "auto-h"), textEl("hugged", "auto")]);
  ops.toggleTextStyle(p, ["wrapped", "hugged"], "bold");
  const [w, h] = p.figures[0].elements as TextElement[];
  assert(w.needsLayout === true && !w.lines, "bold toggle on auto-h: cache dropped + needsLayout set");
  assert(h.needsLayout === undefined, '"auto" element is NEVER flagged (hard lines render directly)');

  const p2 = proj([textEl("fixed1", "fixed")]);
  ops.toggleTextStyle(p2, ["fixed1"], "italic");
  assert((p2.figures[0].elements[0] as TextElement).needsLayout === true, "italic toggle on fixed: flagged too");

  // underline does NOT change metrics — must not flag.
  const p3 = proj([textEl("u1", "auto-h")]);
  ops.toggleTextStyle(p3, ["u1"], "underline");
  assert((p3.figures[0].elements[0] as TextElement).needsLayout === undefined, "underline (metrics-neutral) does not flag");
}

// ---- 2. the headless applyTextLayout seam flags wrapping elements --------------
{
  const e = textEl("seam", "auto-h");
  applyTextLayout(e); // no `document` here
  assert(e.needsLayout === true && !e.lines, "headless applyTextLayout: cache dropped + flagged");
  const auto = textEl("seam-auto", "auto");
  applyTextLayout(auto);
  assert(auto.needsLayout === undefined, 'headless applyTextLayout leaves "auto" unflagged');
}

// ---- 3. a measuring applyTextLayout CLEARS the flag (the GUI heal) --------------
{
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      getContext: () => ({
        font: "",
        measureText: (s: string) => ({ width: s.length * 7 }),
      }),
    }),
  };
  const e = textEl("healed", "auto-h", { needsLayout: true, lines: undefined });
  applyTextLayout(e);
  assert(e.needsLayout === undefined, "measured applyTextLayout clears needsLayout");
  assert(Array.isArray(e.lines) && e.lines.length >= 2, `wrap cache rebuilt (${e.lines?.length} lines at width 120)`);
  const hug = textEl("healed-auto", "auto", { needsLayout: true });
  applyTextLayout(hug);
  assert(hug.needsLayout === undefined, 'measured applyTextLayout clears the flag on "auto" too (defensive)');
  delete (globalThis as Record<string, unknown>).document;
}

// ---- 4. flag round-trips the flux-core save/load + the probes NAME the element --
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-textpar-"));
try {
  await core.scaffold(root, { title: "TextParity" });
  {
    const m = await core.loadFigModel(root);
    m.project.figures.push({
      id: "figT",
      canvasId: m.project.canvases[0]?.id ?? "canvas-1",
      name: "Fig T",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      elements: [textEl("warned", "auto-h")],
    } as Project["figures"][number]);
    await core.saveFigModel(root, m.project, m.index);
  }
  // Headless style edit through the real verb path (mutateFigModel → ops).
  {
    const m = await core.loadFigModel(root);
    ops.toggleTextStyle(m.project, ["warned"], "bold");
    const el = m.project.figures.find((f) => f.id === "figT")!.elements[0] as TextElement;
    assert(el.needsLayout === true, "verb-style headless edit flags the element");
    await core.saveFigModel(root, m.project, m.index);
  }
  {
    const m = await core.loadFigModel(root);
    const el = m.project.figures.find((f) => f.id === "figT")!.elements[0] as TextElement;
    assert(el.needsLayout === true, "needsLayout SURVIVES the save/load round-trip");
  }

  const probeOne = await core.textLayoutProbe(root, { figureId: "figT" });
  assert(probeOne.length === 1 && /figT/.test(probeOne[0]) && /warned/.test(probeOne[0]) && /UNWRAPPED/.test(probeOne[0]),
    `render probe names figure + element (${probeOne[0]?.slice(0, 60)}…)`);
  assert((await core.textLayoutProbe(root, { figureId: "no-such" })).length === 0, "probe scoped to a clean figure is silent");

  const v = await core.validate(root);
  assert((v.warnings ?? []).some((w) => /warned/.test(w) && /UNWRAPPED/.test(w)), "flux validate reports the flagged element as a warning");

  const r = await core.materializeRenders(root);
  assert(r.warnings.some((w) => /warned/.test(w)), "materializeRenders carries the warning (compile/CLI channel)");

  // Renders still PROCEED — a cosmetic wrap must not break agent pipelines.
  const svg = await core.renderFigureSvg(root, "figT");
  assert(svg.includes("<svg"), "render still proceeds despite the flag (warn, don't refuse)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nTEXT PARITY: FAIL (${failures})` : "\nTEXT PARITY: PASS");
process.exit(failures ? 1 : 0);
