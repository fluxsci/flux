#!/usr/bin/env -S npx tsx
// 2026-10-21 — the cursor family is ONE parametric drawing
// (src/lib/cursor/cursorFamily.ts). This pure gate pins what makes a state
// change read as one mark changing form, and that the static defaults in
// styles/cursors.css never drift from the builder:
//   · cursors.css's generated block == the builder's default output;
//   · every state is well-formed XML at the default and extreme parameters,
//     fits the mark, and carries hotspot = size/2 and its OS fallback;
//   · REGISTRATION: the resize arms are the rest cross's own arms (identical
//     line endpoints), the press variant keeps the arms' roots, hover differs
//     from rest only by the dot;
//   · the halo is painted under the core in every scheme, none when off;
//   · `resizeStyle: "system"` resolves the transform states to OS names and
//     leaves the three cross states drawn;
//   · the three 2026-09-15 cursors are reproduced byte for byte (gates key on
//     their tokens: y1='4' for press, <circle> for hover).
//   node scripts/run-verifies.mjs --tier pure --only cursor-family
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCursorFamily,
  clampCursorParams,
  cursorCssBlock,
  cursorGeometry,
  cursorVar,
  drawCursor,
  isDefaultCursorParams,
  CURSOR_DEFAULTS,
  CURSOR_FALLBACK,
  CURSOR_PRESETS,
  CURSOR_STATES,
  cursorPresetOf,
  svgColor,
  CURSOR_SIZE_RANGE,
  type CursorParams,
  type CursorState,
} from "../src/lib/cursor/cursorFamily";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const assert = (c: unknown, m: string) => (c ? ok(m) : (console.error("  ✗ FAIL:", m), failures++));
const root = path.join(import.meta.dirname, "..");

// --- 1. cursors.css carries exactly the builder's defaults -------------------
const css = readFileSync(path.join(root, "src/styles/cursors.css"), "utf8");
const BEGIN = "/* @generated-cursors-begin";
const END = "/* @generated-cursors-end */";
const b = css.indexOf(BEGIN);
const e = css.indexOf(END);
assert(b > 0 && e > b, "cursors.css has the generated block markers");
const block = css.slice(css.indexOf("\n", b) + 1, e);
assert(block === cursorCssBlock(), "the generated block equals the builder's default output (run scripts/gen-cursors.mjs)");
for (const s of CURSOR_STATES) assert(block.includes(`  ${cursorVar(s)}: url("data:image/svg+xml,`), `cursors.css declares ${cursorVar(s)} as a hardware svg cursor`);

// --- 2. the 2026-09-15 cursors, byte for byte --------------------------------
const legacy = {
  cross: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><line x1='12' y1='1.5' x2='12' y2='9' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='12' y1='15' x2='12' y2='22.5' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='1.5' y1='12' x2='9' y2='12' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='15' y1='12' x2='22.5' y2='12' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='12' y1='1.5' x2='12' y2='9' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/><line x1='12' y1='15' x2='12' y2='22.5' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/><line x1='1.5' y1='12' x2='9' y2='12' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/><line x1='15' y1='12' x2='22.5' y2='12' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/></svg>") 12 12, crosshair`,
};
const fam = buildCursorFamily();
assert(fam.cross.css === legacy.cross, "the resting crosshair is the 2026-09-15 drawing byte for byte");
assert(/y1='4'/.test(fam["cross-press"].css) && /<circle/.test(fam["cross-press"].css), "press: contracted arms (y1='4') + dot — the tokens verify-cursor-gui keys on");
assert(/<circle/.test(fam["cross-hover"].css) && !/y1='4'/.test(fam["cross-hover"].css), "hover: the dot without contraction");
assert(!/<circle/.test(fam.cross.css), "rest: no dot");

// --- 3. well-formed, in bounds, hotspot and fallback at the extremes ----------
function lines(svg: string): [number, number, number, number][] {
  return [...svg.matchAll(/<line x1='([-\d.]+)' y1='([-\d.]+)' x2='([-\d.]+)' y2='([-\d.]+)'/g)].map((m) => [+m[1], +m[2], +m[3], +m[4]]);
}
function numbersIn(svg: string): number[] {
  return [...svg.matchAll(/(?:x1|y1|x2|y2|cx|cy)='([-\d.]+)'/g)].map((m) => +m[1]);
}
const extremes: Partial<CursorParams>[] = [
  {},
  { size: CURSOR_SIZE_RANGE.min, stroke: 2.5, gap: 6 },
  { size: CURSOR_SIZE_RANGE.max, stroke: 0.8, gap: 0, haloWidth: 0 },
  { size: 30, stroke: 3, gap: 6, haloWidth: 6, ...CURSOR_PRESETS.paper },
  { size: 32, ...CURSOR_PRESETS.paper, centre: "ring", hoverDot: false, pressContract: false },
  { ...CURSOR_PRESETS.accent, centre: "dot", haloWidth: 2.3 },
  { coreColor: "#aa2200", haloColor: "#ffee00", haloWidth: 1.5, haloOpacity: 0.6, dotColor: "#00aa00" },
];
for (const params of extremes) {
  const p = clampCursorParams({ ...CURSOR_DEFAULTS, ...params });
  const f = buildCursorFamily(params);
  let allOk = true;
  for (const s of CURSOR_STATES) {
    const d = f[s];
    const svgOk = d.svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg'") && d.svg.endsWith("</svg>") && !/["\n]/.test(d.svg);
    const hot = d.hotspot[0] === p.size / 2 && d.hotspot[1] === p.size / 2;
    const fb = d.css.endsWith(`, ${CURSOR_FALLBACK[s]}`) || d.css === CURSOR_FALLBACK[s];
    const inBounds = numbersIn(d.svg).every((n) => n >= -0.01 && n <= p.size + 0.01);
    const sizeOk = p.size <= 32 && p.size % 2 === 0; // Chromium shows >32 px custom cursors only when they fit the viewport; even = integer hotspot
    if (!(svgOk && hot && fb && inBounds && sizeOk)) {
      allOk = false;
      console.error(`    ${s} @ ${JSON.stringify(params)}: svg=${svgOk} hotspot=${hot} fallback=${fb} inBounds=${inBounds}`);
    }
  }
  assert(allOk, `every state is well formed, in bounds, hotspot = size/2, OS fallback @ ${JSON.stringify(params)}`);
}

// --- 4. registration: the family shares one arm geometry ----------------------
{
  const g = cursorGeometry(CURSOR_DEFAULTS);
  const rest = lines(fam.cross.svg);
  const core = rest.slice(rest.length / 2); // halo pass then core pass
  const key = (l: number[]) => l.map((v) => Math.round(v * 100)).join(",");
  const restArms = new Set(core.map(key));
  const nsCore = lines(fam["resize-ns"].svg);
  const nsArms = nsCore.filter((l) => l[0] === l[2] && Math.abs(l[1] - l[3]) > g.head + 0.5); // the vertical arms (heads are short)
  assert(nsArms.length >= 2 && nsArms.every((l) => restArms.has(key(l))), "resize-ns keeps the rest cross's vertical arms (identical endpoints) — the morph only removes the horizontal arms and adds heads");
  const ewArms = lines(fam["resize-ew"].svg).filter((l) => l[1] === l[3] && Math.abs(l[0] - l[2]) > g.head + 0.5);
  assert(ewArms.length >= 2 && ewArms.every((l) => restArms.has(key(l))), "resize-ew keeps the rest cross's horizontal arms");
  const pressArmsAll = lines(fam["cross-press"].svg);
  const pressCore = new Set(pressArmsAll.slice(pressArmsAll.length / 2).map(key));
  const moveArms = lines(fam.move.svg).filter((l) => (l[0] === l[2] || l[1] === l[3]) && Math.hypot(l[2] - l[0], l[3] - l[1]) > g.pressHead + 0.5);
  assert(moveArms.length >= 4 && moveArms.every((l) => pressCore.has(key(l))) && /<circle/.test(fam.move.svg), "move is the PRESS cross (contracted arms + dot) with heads — a drag that starts from a press adds heads only, nothing jumps");
  assert(fam["move-copy"].svg.startsWith(fam.move.svg.slice(0, fam.move.svg.length - 6)), "move-copy is move plus the badge");
  assert(/rotate\(-45 12 12\)/.test(fam["resize-nwse"].svg) && /rotate\(45 12 12\)/.test(fam["resize-nesw"].svg), "the diagonal resize cursors are the ns drawing rotated ±45° about the hotspot");
  const press = lines(fam["cross-press"].svg);
  const pressCoreLines = press.slice(press.length / 2);
  const roots = (ls: number[][]) => new Set(ls.map((l) => key([Math.min(Math.abs(l[0] - 12), Math.abs(l[2] - 12)), Math.min(Math.abs(l[1] - 12), Math.abs(l[3] - 12))])));
  assert([...roots(pressCoreLines)].every((r) => roots(core).has(r)), "the press contraction keeps the arms' roots (only the tips move in)");
  const hoverNoDot = fam["cross-hover"].svg.replace(/<circle[^>]*\/>/g, "");
  assert(hoverNoDot === fam.cross.svg, "hover differs from rest only by the dot");
  const arcs = (["rotate-n", "rotate-ne", "rotate-se", "rotate-sw", "rotate-nw"] as CursorState[]).map((s) => fam[s].svg);
  assert(arcs.every((svg) => /<path d='M[^']*A[^']*'/.test(svg) && /<circle/.test(svg)), "every rotate cursor is an arc about the hotspot with the centre dot");
}

// --- 5. halo under core per preset; explicit colours and widths; none when 0 ---
for (const [preset, colours] of Object.entries(CURSOR_PRESETS)) {
  const f = buildCursorFamily(colours);
  const svg = f.cross.svg;
  const strokes = [...svg.matchAll(/stroke='([^']+)' stroke-width='([\d.]+)'/g)].map((m) => ({ c: m[1], w: +m[2] }));
  const half = strokes.length / 2;
  const haloFirst = strokes.slice(0, half).every((s) => s.w > strokes[half].w) && new Set(strokes.slice(0, half).map((s) => s.c)).size === 1;
  assert(haloFirst, `${preset}: the halo pass (wider) is painted before the core pass`);
  const expect = { ink: ["%23fff", "%23151515"], paper: ["%23151515", "%23fff"], accent: ["%23fff", "%234385be"] }[preset]!;
  assert(strokes[0].c === expect[0] && strokes[half].c === expect[1], `${preset}: halo ${expect[0]}, core ${expect[1]}`);
  assert(cursorPresetOf(colours) === preset, `${preset} is recognised from its colours`);
}
assert(lines(buildCursorFamily({ haloWidth: 0 }).cross.svg).length === 4, "halo width 0 paints only the four core arms");
assert(/stroke-width='2\.3'/.test(buildCursorFamily({ haloWidth: 2.3 }).cross.svg), "the halo width is the user's number");
{
  const custom = { coreColor: "#aa2200", haloColor: "#ffee00", haloWidth: 1.5, haloOpacity: 0.6, dotColor: "#00aa00" };
  const f = buildCursorFamily(custom);
  assert(cursorPresetOf(custom) === "custom", "colours off every preset read as custom");
  // (#aa2200 → %23a20, #ffee00 → %23fe0, #00aa00 → %230a0: svgColor compresses doubled pairs)
  assert(f.cross.svg.includes("stroke='%23a20' stroke-width='1.3'") && f.cross.svg.includes("stroke='%23fe0' stroke-width='1.5'") && f.cross.svg.includes("stroke-opacity='.6'"), "the crosshair and halo take the user's colours, widths and opacity");
  assert(f["cross-hover"].svg.includes("fill='%230a0'") && f["cross-hover"].svg.includes("fill='%23fe0'"), "the dot takes the dot colour over a disc of the halo colour");
  assert(f["move-copy"].svg.includes("fill='%230a0' stroke='%23fe0'"), "the duplicate badge follows the dot and halo colours");
  assert(svgColor("#ffffff") === "%23fff" && svgColor("#aabbcc") === "%23abc" && svgColor("#151515") === "%23151515" && svgColor("#4385be") === "%234385be", "svgColor compresses doubled hex pairs (the defaults stay byte-identical)");
  assert(clampCursorParams({ coreColor: "red" as never, haloWidth: 99, haloOpacity: 0 }).coreColor === "#151515" && clampCursorParams({ haloWidth: 99 }).haloWidth === 6 && clampCursorParams({ haloOpacity: 0 }).haloOpacity === 0.2, "colours must be 6-digit hex; halo width and opacity are bounded");
}

// --- 6. system resize style, defaults predicate, clamping ---------------------
{
  const f = buildCursorFamily({ resizeStyle: "system" });
  assert(f["resize-ns"].css === "ns-resize" && f["rotate-se"].css === "grab" && f.move.css === "move" && f["move-copy"].css === "copy", "system style resolves the transform states to the OS cursors");
  assert(f.cross.css.startsWith('url("data:') && f["cross-hover"].css.startsWith('url("data:'), "…and keeps the cross states drawn");
  assert(isDefaultCursorParams({}) && isDefaultCursorParams({ size: 24 }) && !isDefaultCursorParams({ size: 28 }) && !isDefaultCursorParams({ hoverDot: false }), "isDefaultCursorParams tells the theme writer when to clear :root");
  const c = clampCursorParams({ size: 999, stroke: -1, gap: 99, centre: "neon" as never, dotColor: "red" });
  assert(c.size === CURSOR_SIZE_RANGE.max && c.stroke === 0.8 && c.gap === 6 && c.centre === "none" && c.dotColor === "#4385be", "clampCursorParams bounds numbers and falls back on unknown enums / colours");
  assert(clampCursorParams({ size: 27 }).size === 28 && clampCursorParams({ size: 21 }).size === 22 && clampCursorParams({ size: 23 }).size === 24 && clampCursorParams({ size: 40 }).size === 32 && CURSOR_SIZE_RANGE.max === 32, "sizes round to even and cap at 32 (Chromium's large-cursor viewport rule)");
  assert(drawCursor("cross", { gap: 0 }).svg.includes("y2='12'") || drawCursor("cross", { gap: 0 }).svg.includes("y2='9'"), "gap 0 still draws (arms meet the centre)");
}

if (failures) {
  console.error(`VERIFY-CURSOR-FAMILY FAIL (${failures})`);
  process.exit(1);
}
console.log("VERIFY-CURSOR-FAMILY PASS");
