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
  ARROW_HOTSPOT,
  ARROW_SHAPE,
  ARROW_UNIT,
  arrowCanvas,
  arrowOrigin,
  arrowPoints,
  arrowTipInset,
  buildCursorFamily,
  buildCursorFamilyDark,
  clampCursorParams,
  cursorGeometry,
  roundedPolygonPath,
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
for (const s of CURSOR_STATES) assert(block.includes(`  ${cursorVar(s, "light")}: url("data:image/svg+xml,`) && block.includes(`  ${cursorVar(s, "dark")}: url("data:image/svg+xml,`) && block.includes(`  ${cursorVar(s)}: var(${cursorVar(s, "dark")});`), `cursors.css declares ${cursorVar(s)} in both tones and points the bare name at the dark-surface set`);
assert(block.includes(".cursor-on-light {") && block.includes(".cursor-on-dark {"), "the two tone classes are generated");

// --- 2. the 2026-09-15 cursors, byte for byte --------------------------------
const legacy = {
  cross: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><line x1='12' y1='1.5' x2='12' y2='9' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='12' y1='15' x2='12' y2='22.5' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='1.5' y1='12' x2='9' y2='12' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='15' y1='12' x2='22.5' y2='12' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-opacity='.92'/><line x1='12' y1='1.5' x2='12' y2='9' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/><line x1='12' y1='15' x2='12' y2='22.5' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/><line x1='1.5' y1='12' x2='9' y2='12' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/><line x1='15' y1='12' x2='22.5' y2='12' stroke='%23151515' stroke-width='1.3' stroke-linecap='round'/></svg>") 12 12, crosshair`,
};
const CROSS = { style: "crosshair" as const };
const fam = buildCursorFamily(CROSS); // the crosshair: adaptive, no halo (light-surface drawing)
const famO = buildCursorFamily({ ...CROSS, ...CURSOR_PRESETS.outlined }); // the 2026-09-15 look
// The OUTLINED preset is the 2026-09-15 drawing in every respect but one: since the
// pixel audit (2026-10-21) the mark is centred on the hot pixel's CENTRE (12.5), not
// the canvas midpoint (12), so a 1 px arm fills one column and the drawing is
// mirror-symmetric about the pixel the click lands on. Compare modulo that shift.
{
  const shift = (css: string) => css.replace(/'(\d+(?:\.\d+)?)'/g, (_, n) => `'${+(+n + 0.5).toFixed(2)}'`);
  const stripNums = (css: string) => css.replace(/\d+(?:\.\d+)?/g, "#");
  assert(stripNums(famO.cross.css) === stripNums(legacy.cross), "the crosshair's OUTLINED preset is the 2026-09-15 drawing's structure (same elements, order, colours, widths)");
  const gO = cursorGeometry(clampCursorParams({ ...CURSOR_DEFAULTS, ...CROSS, ...CURSOR_PRESETS.outlined }));
  assert(lines(famO.cross.svg).length === lines(legacy.cross).length && gO.c === 12.5 && famO.cross.svg.includes(`x1='12.5' y1='${+(gO.c - gO.outer).toFixed(2)}'`) && /stroke='%23fff'/.test(famO.cross.svg), "…its arms are the legacy arms moved to the pixel centre, under the halo");
  assert(gO.outer < cursorGeometry(clampCursorParams({ ...CURSOR_DEFAULTS, ...CROSS })).outer && gO.c + gO.outer + gO.haloWidth / 2 <= 24, "a halo shortens the arms by its own half width so its round caps never leave the canvas");
  void shift;
}
assert(lines(fam.cross.svg).length === 4 && fam.cross.svg.includes("stroke='%23151515'") && !fam.cross.svg.includes("%23fff"), "the adaptive resting crosshair has no halo: four dark-ink arms for light surfaces");
const famD = buildCursorFamilyDark(CROSS);
assert(lines(famD.cross.svg).length === 4 && famD.cross.svg.includes("stroke='%23fffcf0'"), "…and its dark-surface twin is the same drawing in paper-white");
assert(famD.cross.svg.replace(/%23fffcf0/g, "%23151515") === fam.cross.svg, "the two tones differ ONLY in the core colour");

// --- 2b. the DEFAULT family is the classic arrow (owner, 2026-10-21) --------------
{
  const arrow = buildCursorFamily();
  const arrowD = buildCursorFamilyDark();
  const ARROW_STATES: CursorState[] = ["cross", "cross-hover", "cross-press", "move", "move-copy"];
  for (const st of ARROW_STATES) {
    const d = arrow[st];
    assert(/<path d='M[^']*Z'/.test(d.svg) && d.svg.includes("paint-order='stroke'") && d.svg.includes("fill='%23151515'") && d.svg.includes("stroke='%23fff'"), `${st}: a dark-filled arrow with the outline painted underneath`);
    assert(d.hotspot[0] === ARROW_HOTSPOT[0] && d.hotspot[1] === ARROW_HOTSPOT[1] && d.css.endsWith(st === "move-copy" ? ", copy" : ", default"), `${st}: the hotspot is the tip and the fallback the system arrow`);
    assert(d.svg.includes("<feDropShadow") && d.svg.includes("filter='url(%23s)'"), `${st}: the drop shadow is applied`);
    assert(arrowD[st].svg === d.svg, `${st}: identical in both tones (the outline provides the contrast)`);
  }
  assert(arrow.cross.svg === arrow["cross-hover"].svg && arrow.cross.svg === arrow["cross-press"].svg && arrow.cross.svg === arrow.move.svg, "rest, hover, press and move are the same arrow (Figma keeps its pointer)");
  assert(arrow["move-copy"].svg.includes("<circle") && arrow["move-copy"].svg.includes("fill='%234385be'"), "move-copy adds the dot-coloured badge");
  for (const st of ["resize-ns", "resize-nwse", "rotate-se"] as CursorState[]) {
    const d = arrow[st];
    const strokes = [...d.svg.matchAll(/stroke='([^']+)' stroke-width='([\d.]+)'/g)].map((m) => ({ c: m[1], w: +m[2] }));
    assert(strokes[0].c === "%23fff" && strokes[0].w === 3.9 && strokes[strokes.length - 1].c === "%23151515" && !/stroke-opacity='0?\.\d/.test(d.svg), `${st}: drawn in the arrow's fill under its outline (1.3 + 2 × 1.3 wide, opaque)`);
    assert(d.hotspot[0] === 12 && d.hotspot[1] === 12, `${st}: keeps the centred hotspot`);
  }
  const c = arrowCanvas(clampCursorParams(CURSOR_DEFAULTS));
  assert(c.w <= 32 && c.h <= 32 && c.w >= 24, `the arrow canvas is tight and within Chromium's 32 px rule (${c.w} × ${c.h})`);
  for (const size of [16, 20, 23]) {
    const cc = arrowCanvas(clampCursorParams({ ...CURSOR_DEFAULTS, arrowSize: size, arrowShadow: 1, arrowOutlineWidth: 2.5 }));
    assert(cc.w <= 32 && cc.h <= 32, `size ${size} with the strongest shadow and outline still fits 32 px (${cc.w} × ${cc.h})`);
  }
  const pd = clampCursorParams(CURSOR_DEFAULTS);
  const pts = arrowPoints(pd, 0, 0);
  assert(pts.length === 4 && pts[0][0] === 0 && pts[0][1] === 0 && pts[3][1] > pts[1][1] && pts[1][0] > pts[3][0], "the arrow's vertices: tip at the origin, the right barb higher and further right than the tail");
  assert(ARROW_UNIT.length === 4 && ARROW_UNIT[0][0] === 0 && ARROW_UNIT[0][1] === 0 && ARROW_UNIT[2][0] === 0 && ARROW_UNIT[1][0] === -ARROW_UNIT[3][0] && ARROW_UNIT[1][1] === ARROW_UNIT[3][1], "the unit arrow is symmetric about its axis by construction: the notch on the axis, the barbs exact mirrors");
  // …and so are the rotated vertices: reflect the right barb across the tip→notch axis and land on the left barb
  for (const tilt of [0, 17, -30]) {
    const q = arrowPoints(clampCursorParams({ ...CURSOR_DEFAULTS, arrowTilt: tilt }), 5, 7);
    const [tip, right, notch, left] = q;
    const ax = notch[0] - tip[0], ay = notch[1] - tip[1];
    const len = Math.hypot(ax, ay);
    const ux = ax / len, uy = ay / len;
    const rx = right[0] - tip[0], ry = right[1] - tip[1];
    const dot = rx * ux + ry * uy;
    const mirror = [tip[0] + 2 * dot * ux - rx, tip[1] + 2 * dot * uy - ry];
    assert(Math.abs(mirror[0] - left[0]) < 1e-9 && Math.abs(mirror[1] - left[1]) < 1e-9, `tilt ${tilt}: the left barb is the exact mirror of the right barb across the arrow's axis`);
  }
  // the visible tip (the outline's apex) is the hot pixel's centre
  {
    const o = arrowOrigin(pd);
    const inset = arrowTipInset(pd);
    const a = ((pd.arrowTilt - ARROW_SHAPE.lean) * Math.PI) / 180;
    const vis = [o.ox + inset * -Math.sin(a), o.oy + inset * Math.cos(a)];
    assert(Math.abs(vis[0] - (ARROW_HOTSPOT[0] + 0.5)) < 1e-9 && Math.abs(vis[1] - (ARROW_HOTSPOT[1] + 0.5)) < 1e-9, "the outline's tip lands on the centre of the hot pixel");
    assert(inset < 0 && inset > -1, `at the defaults the outline's tip sits just outside the geometric tip (${inset.toFixed(2)} px)`);
  }
  const sharp = roundedPolygonPath([[0, 0], [10, 0], [10, 10]], 0);
  const round = roundedPolygonPath([[0, 0], [10, 0], [10, 10]], 1);
  assert(sharp === "M0 0L10 0L10 10Z" && round.startsWith("M") && (round.match(/Q/g) || []).length === 3 && round.endsWith("Z"), "rounding 0 is the sharp polygon; a radius fillets every corner with a quadratic");
  const tilted = buildCursorFamily({ arrowTilt: 15 });
  assert(tilted.cross.svg !== arrow.cross.svg, "tilt rotates the arrow about its tip");
  const noShadow = buildCursorFamily({ arrowShadow: 0 });
  assert(!noShadow.cross.svg.includes("feDropShadow") && !noShadow.cross.svg.includes("filter="), "shadow 0 draws no filter at all");
  const noOutline = buildCursorFamily({ arrowOutlineWidth: 0 });
  assert(!noOutline.cross.svg.includes("stroke="), "outline width 0 draws the bare fill");
  const custom = buildCursorFamily({ arrowFill: "#aa2200", arrowOutline: "#ffee00" });
  assert(custom.cross.svg.includes("fill='%23a20'") && custom.cross.svg.includes("stroke='%23fe0'"), "fill and outline take the user's colours");
}
assert(/y1='4\.83'/.test(fam["cross-press"].css) && /<circle/.test(fam["cross-press"].css) && /y1='2\.5'/.test(fam.cross.css), "press: contracted arms (y1='4.83'; the full arm starts at 2.5) + dot — the tokens verify-cursor-gui keys on");
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
  { style: "crosshair" },
  { arrowSize: 23, arrowShadow: 1, arrowOutlineWidth: 2.5, arrowRounding: 3, arrowTilt: 30 },
  { arrowSize: 16, arrowShadow: 0, arrowOutlineWidth: 0, arrowRounding: 0, arrowTilt: -30 },
  { style: "crosshair", size: CURSOR_SIZE_RANGE.min, stroke: 2.5, gap: 6 },
  { style: "crosshair", size: CURSOR_SIZE_RANGE.max, stroke: 0.8, gap: 0, haloWidth: 0 },
  { style: "crosshair", size: 30, stroke: 3, gap: 6, haloWidth: 6, ...CURSOR_PRESETS.outlined },
  { style: "crosshair", size: 32, ...CURSOR_PRESETS.outlined, centre: "ring", hoverDot: false, pressContract: false },
  { style: "crosshair", ...CURSOR_PRESETS.accent, centre: "dot", haloWidth: 2.3 },
  { style: "crosshair", coreColor: "#aa2200", haloColor: "#ffee00", haloWidth: 1.5, haloOpacity: 0.6, dotColor: "#00aa00" },
];
for (const params of extremes) {
  const p = clampCursorParams({ ...CURSOR_DEFAULTS, ...params });
  const f = buildCursorFamily(params);
  let allOk = true;
  for (const s of CURSOR_STATES) {
    const d = f[s];
    const svgOk = d.svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg'") && d.svg.endsWith("</svg>") && !/["\n]/.test(d.svg);
    const arrowState = p.style === "classic" && ["cross", "cross-hover", "cross-press", "move", "move-copy"].includes(s);
    const hot = arrowState ? d.hotspot[0] === ARROW_HOTSPOT[0] && d.hotspot[1] === ARROW_HOTSPOT[1] : d.hotspot[0] === Math.floor(p.size / 2) && d.hotspot[1] === Math.floor(p.size / 2);
    const fb = arrowState ? d.css.endsWith(s === "move-copy" ? ", copy" : ", default") : d.css.endsWith(`, ${CURSOR_FALLBACK[s]}`) || d.css === CURSOR_FALLBACK[s];
    const canvas = arrowState ? Math.max(arrowCanvas(p).w, arrowCanvas(p).h) : p.size;
    const inBounds = numbersIn(d.svg).every((n) => n >= -0.01 && n <= canvas + 0.01);
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
  // registration is checked on the outlined family (halo pass then core pass, the
  // 2026-09-15 structure) and the halo-less default (core pass only)
  const rest = lines(famO.cross.svg);
  const core = rest.slice(rest.length / 2); // halo pass then core pass
  const restNoHalo = lines(fam.cross.svg);
  // the outlined core pass is the halo-less arms with their tips pulled in by the
  // halo's half width (the margin rule: a halo's round caps never leave the canvas)
  const dOut = cursorGeometry(clampCursorParams({ ...CURSOR_DEFAULTS, ...CROSS })).outer - cursorGeometry(clampCursorParams({ ...CURSOR_DEFAULTS, ...CROSS, ...CURSOR_PRESETS.outlined })).outer;
  const sameButTip = (a: number[], b: number[]) => {
    const diffs = a.map((v, k) => Math.abs(v - b[k])).filter((d) => d > 1e-9);
    return diffs.length === 1 && Math.abs(diffs[0] - dOut) < 0.011;
  };
  assert(restNoHalo.length === 4 && dOut > 0 && restNoHalo.every((l, i) => sameButTip(l as number[], core[i] as number[])), `without a halo the default's four arms ARE the outlined core pass, tips ${dOut.toFixed(2)} px longer (no halo cap to make room for)`);
  const key = (l: number[]) => l.map((v) => Math.round(v * 100)).join(",");
  const restArms = new Set(core.map(key));
  const nsCore = lines(famO["resize-ns"].svg);
  const nsArms = nsCore.filter((l) => l[0] === l[2] && Math.abs(l[1] - l[3]) > g.head + 0.5); // the vertical arms (heads are short)
  assert(nsArms.length >= 2 && nsArms.every((l) => restArms.has(key(l))), "resize-ns keeps the rest cross's vertical arms (identical endpoints) — the morph only removes the horizontal arms and adds heads");
  const ewArms = lines(famO["resize-ew"].svg).filter((l) => l[1] === l[3] && Math.abs(l[0] - l[2]) > g.head + 0.5);
  assert(ewArms.length >= 2 && ewArms.every((l) => restArms.has(key(l))), "resize-ew keeps the rest cross's horizontal arms");
  const pressArmsAll = lines(famO["cross-press"].svg);
  const pressCore = new Set(pressArmsAll.slice(pressArmsAll.length / 2).map(key));
  const moveArms = lines(famO.move.svg).filter((l) => (l[0] === l[2] || l[1] === l[3]) && Math.hypot(l[2] - l[0], l[3] - l[1]) > g.pressHead + 0.5);
  assert(moveArms.length >= 4 && moveArms.every((l) => pressCore.has(key(l))) && /<circle/.test(famO.move.svg), "move is the PRESS cross (contracted arms + dot) with heads — a drag that starts from a press adds heads only, nothing jumps");
  assert(famO["move-copy"].svg.startsWith(famO.move.svg.slice(0, famO.move.svg.length - 6)), "move-copy is move plus the badge");
  assert(/rotate\(-45 12\.5 12\.5\)/.test(fam["resize-nwse"].svg) && /rotate\(45 12\.5 12\.5\)/.test(fam["resize-nesw"].svg), "the diagonal resize cursors are the ns drawing rotated ±45° about the hot pixel's centre");
  const press = lines(famO["cross-press"].svg);
  const pressCoreLines = press.slice(press.length / 2);
  const roots = (ls: number[][]) => new Set(ls.map((l) => key([Math.min(Math.abs(l[0] - 12), Math.abs(l[2] - 12)), Math.min(Math.abs(l[1] - 12), Math.abs(l[3] - 12))])));
  assert([...roots(pressCoreLines)].every((r) => roots(core).has(r)), "the press contraction keeps the arms' roots (only the tips move in)");
  const hoverNoDot = fam["cross-hover"].svg.replace(/<circle[^>]*\/>/g, "");
  assert(hoverNoDot === fam.cross.svg && famO["cross-hover"].svg.replace(/<circle[^>]*\/>/g, "") === famO.cross.svg, "hover differs from rest only by the dot (both looks)");
  const arcs = (["rotate-n", "rotate-ne", "rotate-se", "rotate-sw", "rotate-nw"] as CursorState[]).map((s) => fam[s].svg);
  assert(arcs.every((svg) => /<path d='M[^']*A[^']*'/.test(svg) && /<circle/.test(svg)), "every rotate cursor is an arc about the hotspot with the centre dot");
}

// --- 5. the presets; halo under core when drawn; explicit colours and widths ----
for (const [preset, colours] of Object.entries(CURSOR_PRESETS)) {
  const f = buildCursorFamily({ ...CROSS, ...colours });
  const fd = buildCursorFamilyDark({ ...CROSS, ...colours });
  const svg = f.cross.svg;
  const strokes = [...svg.matchAll(/stroke='([^']+)' stroke-width='([\d.]+)'/g)].map((m) => ({ c: m[1], w: +m[2] }));
  if (colours.haloWidth > 0) {
    const half = strokes.length / 2;
    const haloFirst = strokes.slice(0, half).every((s) => s.w > strokes[half].w) && new Set(strokes.slice(0, half).map((s) => s.c)).size === 1;
    assert(haloFirst && strokes[0].c === "%23fff" && strokes[half].c === "%23151515", `${preset}: the halo pass (wider, white) is painted before the dark core pass`);
  } else {
    assert(strokes.length === 4 && new Set(strokes.map((s) => s.c)).size === 1, `${preset}: no halo — four core arms only`);
  }
  const expect = { adaptive: ["%23151515", "%23fffcf0"], outlined: ["%23151515", "%23151515"], accent: ["%234385be", "%234385be"] }[preset]!;
  const coreOf = (x: string) => [...x.matchAll(/stroke='([^']+)' stroke-width='1\.3'/g)][0]?.[1];
  assert(coreOf(f.cross.svg) === expect[0] && coreOf(fd.cross.svg) === expect[1], `${preset}: light-surface core ${expect[0]}, dark-surface core ${expect[1]}`);
  assert(cursorPresetOf(colours) === preset, `${preset} is recognised from its colours`);
}
assert(cursorPresetOf({ ...CURSOR_PRESETS.adaptive, haloColor: "#123456", haloOpacity: 0.5 }) === "adaptive", "a halo colour or opacity does not count while the halo is off");
assert(cursorPresetOf({ ...CURSOR_PRESETS.adaptive, coreColorDark: "#ffffff" }) === "custom", "a different dark-surface colour is custom");
assert(lines(buildCursorFamily({ ...CROSS, haloWidth: 0 }).cross.svg).length === 4, "halo width 0 paints only the four core arms");
assert(/stroke-width='2\.3'/.test(buildCursorFamily({ ...CROSS, haloWidth: 2.3 }).cross.svg), "the halo width is the user's number");
{
  const custom = { ...CROSS, coreColor: "#aa2200", haloColor: "#ffee00", haloWidth: 1.5, haloOpacity: 0.6, dotColor: "#00aa00" };
  const f = buildCursorFamily(custom);
  assert(cursorPresetOf({ ...CURSOR_DEFAULTS, ...custom }) === "custom", "colours off every preset read as custom");
  // (#aa2200 → %23a20, #ffee00 → %23fe0, #00aa00 → %230a0: svgColor compresses doubled pairs)
  assert(f.cross.svg.includes("stroke='%23a20' stroke-width='1.3'") && f.cross.svg.includes("stroke='%23fe0' stroke-width='1.5'") && f.cross.svg.includes("stroke-opacity='.6'"), "the crosshair and halo take the user's colours, widths and opacity");
  assert(f["cross-hover"].svg.includes("fill='%230a0'") && f["cross-hover"].svg.includes("fill='%23fe0'"), "the dot takes the dot colour over a disc of the halo colour");
  assert(f["move-copy"].svg.includes("fill='%230a0' stroke='%23fe0'"), "the duplicate badge follows the dot and halo colours");
  assert(svgColor("#ffffff") === "%23fff" && svgColor("#aabbcc") === "%23abc" && svgColor("#151515") === "%23151515" && svgColor("#4385be") === "%234385be", "svgColor compresses doubled hex pairs (the defaults stay byte-identical)");
  assert(clampCursorParams({ coreColor: "red" as never, haloWidth: 99, haloOpacity: 0 }).coreColor === "#151515" && clampCursorParams({ haloWidth: 99 }).haloWidth === 6 && clampCursorParams({ haloOpacity: 0 }).haloOpacity === 0.2, "colours must be 6-digit hex; halo width and opacity are bounded");
}

// --- 6. system resize style, defaults predicate, clamping ---------------------
{
  const f = buildCursorFamily({ ...CROSS, resizeStyle: "system" });
  assert(f["resize-ns"].css === "ns-resize" && f["rotate-se"].css === "grab" && f.move.css === "move" && f["move-copy"].css === "copy", "system style resolves the transform states to the OS cursors");
  assert(f.cross.css.startsWith('url("data:') && f["cross-hover"].css.startsWith('url("data:'), "…and keeps the cross states drawn");
  const fa = buildCursorFamily({ resizeStyle: "system" });
  assert(fa["resize-ns"].css === "ns-resize" && fa.cross.css.startsWith('url("data:') && fa.move.css.startsWith('url("data:'), "under the classic arrow, system style keeps the arrow for rest/hover/press/move and hands the resize/rotate states to the OS");
  assert(isDefaultCursorParams({}) && isDefaultCursorParams({ size: 24 }) && !isDefaultCursorParams({ size: 28 }) && !isDefaultCursorParams({ hoverDot: false }) && !isDefaultCursorParams({ coreColorDark: "#ffffff" }), "isDefaultCursorParams tells the theme writer when to clear :root");
  const c = clampCursorParams({ size: 999, stroke: -1, gap: 99, centre: "neon" as never, dotColor: "red" });
  assert(c.size === CURSOR_SIZE_RANGE.max && c.stroke === 0.8 && c.gap === 6 && c.centre === "none" && c.dotColor === "#4385be", "clampCursorParams bounds numbers and falls back on unknown enums / colours");
  assert(clampCursorParams({ size: 27 }).size === 28 && clampCursorParams({ size: 21 }).size === 22 && clampCursorParams({ size: 23 }).size === 24 && clampCursorParams({ size: 40 }).size === 32 && CURSOR_SIZE_RANGE.max === 32, "sizes round to even and cap at 32 (Chromium's large-cursor viewport rule)");
  assert(drawCursor("cross", { ...CROSS, gap: 0 }).svg.includes("y2='12.5'"), "gap 0 still draws (arms meet the hot pixel's centre)");
}

// --- 7. the tone law (cursor/cursorTone.ts) -------------------------------------
{
  const { relativeLuminance, toneOfColor, figureTone, elementTone, chromeTone } = await import("../src/lib/cursor/cursorTone");
  assert(relativeLuminance("#ffffff") === 1 && relativeLuminance("#000000") === 0 && relativeLuminance("white") === 1, "relative luminance: white 1, black 0");
  assert(toneOfColor("#fffcf0") === "light" && toneOfColor("#151515") === "dark" && toneOfColor("#808080") === "dark" && toneOfColor("#c0c0c0") === "light" && toneOfColor("#fff") === "light" && toneOfColor("rgb(20, 20, 20)") === "dark", "tone by luminance (0.4 threshold), short hex and rgb() accepted");
  assert(toneOfColor("transparent") === null && toneOfColor("none", "dark") === "dark" && toneOfColor(undefined, "light") === "light", "unreadable colours fall back");
  assert(figureTone({ background: "#ffffff" }) === "light" && figureTone({ background: "#202020" }) === "dark" && figureTone({ background: "transparent" }) === "dark" && figureTone(null) === "dark", "a figure's paper tone; transparent shows the dark canvas");
  const rect = (fill: string) => ({ type: "rect", id: "r", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill, stroke: "#000", strokeWidth: 1 }) as never;
  assert(elementTone(rect("#000000")) === "dark" && elementTone(rect("#ffffff")) === "light" && elementTone(rect("none")) === null && elementTone(rect("transparent")) === null, "a solid rect fill decides; an unfilled one shows the paper");
  assert(elementTone({ ...rect("#000000"), fillMap: { stops: [] } } as never) === null, "a gradient fill does not decide");
  assert(elementTone({ type: "path", id: "p", x: 0, y: 0, width: 1, height: 1, rotation: 0, d: "M0 0", fill: "#000000", stroke: "#000", strokeWidth: 1, closed: false } as never) === null, "an open path shows the paper");
  assert(elementTone({ type: "path", id: "p", x: 0, y: 0, width: 1, height: 1, rotation: 0, d: "M0 0", fill: "#000000", stroke: "#000", strokeWidth: 1, closed: true } as never) === "dark", "a closed filled path decides");
  assert(elementTone({ type: "text", id: "t", x: 0, y: 0, width: 1, height: 1, rotation: 0, text: "x", fontSize: 12, fill: "#000" } as never) === null, "text shows the paper through its glyph cells");
  assert(elementTone({ type: "image", id: "i", x: 0, y: 0, width: 1, height: 1, rotation: 0, assetId: "a" } as never) === null, "an image's content is unknown: the paper's tone");
  const plot = { type: "plot", id: "pl", x: 0, y: 0, width: 1, height: 1, rotation: 0, assetId: "a" } as never;
  assert(elementTone(plot, { style: { tokens: { paper: "#111111" } } } as never) === "dark" && elementTone(plot, { style: { tokens: { paper: "#ffffff" } } } as never) === "light" && elementTone(plot, null) === null && elementTone(plot, {} as never) === null, "a plot follows its manifest's paper token when present");
  const fig = { background: "#ffffff" };
  assert(chromeTone(fig, [rect("#000000")], () => null) === "dark" && chromeTone(fig, [rect("none")], () => null) === "light" && chromeTone(fig, [rect("#000000"), rect("#000000")], () => null) === "light", "the chrome takes a single selected element's tone, else the figure's");
}

if (failures) {
  console.error(`VERIFY-CURSOR-FAMILY FAIL (${failures})`);
  process.exit(1);
}
console.log("VERIFY-CURSOR-FAMILY PASS");
