#!/usr/bin/env -S npx tsx
// WS-3.2 (fortify plan) — bit-for-bit battery for the extracted interaction
// core (src/lib/interact/*). The ORACLES below are verbatim copies of the
// Canvas.svelte implementations as they stood before extraction (SlideStage's
// were verified byte-identical); every output must match EXACTLY over a
// coordinate grid — resize feel is part of the locked editor character.
//   npx tsx scripts/verify-interact-core.ts

import { HANDLES, handlePos, cursorFor, type Handle } from "../src/lib/interact/handles";
import { computeResizeBox } from "../src/lib/interact/gestureMath";
import { snap, boxSnapTargets } from "../src/lib/interact/snap";
import { elementBBox, selectionBBox, rectIntersectsElement, rotatedAABB, type Rect } from "../src/lib/geometry";
import type { Element, LineElement, RectElement } from "../src/lib/types";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- ORACLES: Canvas.svelte's pre-extraction bodies, verbatim --------------
function oracleComputeResizeBox(ob: Rect, h: Handle, lp: { x: number; y: number }, shift: boolean): Rect {
  let x = ob.x,
    y = ob.y,
    w = ob.w,
    hh = ob.h;
  const right = ob.x + ob.w;
  const bottom = ob.y + ob.h;
  if (h.includes("w")) {
    x = lp.x;
    w = right - lp.x;
  }
  if (h.includes("e")) w = lp.x - ob.x;
  if (h.includes("n")) {
    y = lp.y;
    hh = bottom - lp.y;
  }
  if (h.includes("s")) hh = lp.y - ob.y;
  if (shift && ob.w > 0 && ob.h > 0) {
    const s = Math.max(w / ob.w, hh / ob.h);
    w = ob.w * s;
    hh = ob.h * s;
    if (h.includes("w")) x = right - w;
    if (h.includes("n")) y = bottom - hh;
  }
  return { x, y, w: Math.max(1, w), h: Math.max(1, hh) };
}
function oracleSnap(edges: number[], targets: number[], thr: number) {
  let best = thr;
  let off = 0;
  let line: number | null = null;
  for (const edge of edges)
    for (const t of targets) {
      const d = t - edge;
      if (Math.abs(d) < best) {
        best = Math.abs(d);
        off = d;
        line = t;
      }
    }
  return { off, line };
}
function oracleHandlePos(h: Handle, b: Rect): [number, number] {
  const map: Record<Handle, [number, number]> = {
    nw: [b.x, b.y],
    n: [b.x + b.w / 2, b.y],
    ne: [b.x + b.w, b.y],
    e: [b.x + b.w, b.y + b.h / 2],
    se: [b.x + b.w, b.y + b.h],
    s: [b.x + b.w / 2, b.y + b.h],
    sw: [b.x, b.y + b.h],
    w: [b.x, b.y + b.h / 2],
  };
  return map[h];
}
// Canvas.svelte's snapTargets(fig, excludeIds), verbatim shape
function oracleSnapTargets(fig: { width: number; height: number; elements: Element[]; guides?: { x?: number[]; y?: number[] } }, excludeIds: Set<string>) {
  const xs = [0, fig.width, fig.width / 2];
  const ys = [0, fig.height, fig.height / 2];
  for (const el of fig.elements) {
    if (excludeIds.has(el.id)) continue;
    const b = elementBBox(el);
    xs.push(b.x, b.x + b.w, b.x + b.w / 2);
    ys.push(b.y, b.y + b.h, b.y + b.h / 2);
  }
  if (fig.guides?.x) xs.push(...fig.guides.x);
  if (fig.guides?.y) ys.push(...fig.guides.y);
  return { xs, ys };
}

// ---- grids -------------------------------------------------------------------
const boxes: Rect[] = [
  { x: 0, y: 0, w: 100, h: 60 },
  { x: -35.5, y: 12.25, w: 3, h: 240 },
  { x: 40, y: 40, w: 0, h: 0 }, // degenerate
  { x: 7.7, y: -9.1, w: 55.25, h: 55.25 },
];
const points = [
  { x: -50, y: -50 },
  { x: 0, y: 0 },
  { x: 12.5, y: 90 },
  { x: 130.75, y: 20.25 },
  { x: 60, y: 60 },
];

let n = 0;
let bad = 0;
for (const ob of boxes)
  for (const h of HANDLES)
    for (const lp of points)
      for (const shift of [false, true]) {
        n++;
        const a = oracleComputeResizeBox(ob, h, lp, shift);
        const b = computeResizeBox(ob, h, lp, shift);
        if (!eq(a, b)) {
          bad++;
          if (bad < 3) fail(`computeResizeBox mismatch ${JSON.stringify({ ob, h, lp, shift, a, b })}`);
        }
      }
assert(bad === 0, `computeResizeBox bit-for-bit over ${n} grid cases`);

{
  const edges = [[0], [10, 55, 100], [-3.5, 7.25]];
  const targets = [[], [0, 50, 100], [7, 7.5, 8], [-10, 300.125]];
  let m = 0;
  let badS = 0;
  for (const e of edges)
    for (const t of targets)
      for (const thr of [0.5, 6, 24]) {
        m++;
        if (!eq(oracleSnap(e, t, thr), snap(e, t, thr))) badS++;
      }
  assert(badS === 0, `snap bit-for-bit over ${m} cases`);
}

{
  let badH = 0;
  for (const b of boxes) for (const h of HANDLES) if (!eq(oracleHandlePos(h, b), handlePos(h, b))) badH++;
  assert(badH === 0, "handlePos bit-for-bit over all handles × boxes");
  assert(
    eq(cursorFor, {
      nw: "nwse-resize",
      se: "nwse-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
    }),
    "cursorFor table identical",
  );
  assert(eq(HANDLES, ["nw", "n", "ne", "e", "se", "s", "sw", "w"]), "HANDLES order identical");
}

// ---- boxSnapTargets ≡ Canvas snapTargets (with guides) and SlideStage's (without)
{
  const rect = (id: string, x: number, y: number): RectElement =>
    ({ type: "rect", id, x, y, width: 40, height: 20, rotation: 0, fill: "#000", stroke: "#000", strokeWidth: 1, cornerRadius: 0 }) as RectElement;
  const line: LineElement = { type: "line", id: "ln", x: 10, y: 10, x1: 0, y1: 0, x2: -30, y2: 45, width: 0, height: 0, rotation: 0, stroke: "#000", strokeWidth: 2 } as LineElement;
  const els: Element[] = [rect("a", 5, 5), rect("b", 120.5, 60.25), line];
  const fig = { width: 800, height: 600, elements: els, guides: { x: [100, 200.5], y: [50] } };
  const excl = new Set(["b"]);
  assert(
    eq(oracleSnapTargets(fig, excl), boxSnapTargets(els, excl, { w: fig.width, h: fig.height }, fig.guides)),
    "boxSnapTargets ≡ Canvas snapTargets (frame + elements + guides, exclusions)",
  );
  const noG = { ...fig, guides: undefined };
  assert(
    eq(oracleSnapTargets(noG, new Set()), boxSnapTargets(els, new Set(), { w: 800, h: 600 })),
    "boxSnapTargets ≡ SlideStage snapTargets (no guides)",
  );
}

// ---- generic geometry still narrows lines structurally ------------------------
{
  const line: LineElement = { type: "line", id: "l", x: 10, y: 20, x1: 0, y1: 0, x2: 30, y2: -40, width: 0, height: 0, rotation: 0, stroke: "#000", strokeWidth: 1 } as LineElement;
  assert(eq(elementBBox(line), { x: 10, y: -20, w: 30, h: 40 }), "elementBBox line branch (structural x1/x2 detection)");
  const slideish = { id: "s1", x: 3, y: 4, width: 50, height: 25, rotation: 0, kindTag: "textbox" };
  assert(eq(elementBBox(slideish), { x: 3, y: 4, w: 50, h: 25 }), "elementBBox accepts an ElementBase-shaped slide element with NO cast");
  const rot = { id: "r1", x: 0, y: 0, width: 10, height: 10, rotation: 90 };
  const ra = rotatedAABB(rot);
  assert(Math.abs(ra.w - 10) < 1e-9 && Math.abs(ra.h - 10) < 1e-9, "rotatedAABB generic over ElementBase");
  assert(selectionBBox([slideish, rot]) !== null, "selectionBBox generic");
  assert(rectIntersectsElement({ x: 0, y: 0, w: 5, h: 5 }, slideish) === true, "rectIntersectsElement generic");
}

console.log(failures ? `\nINTERACT CORE: FAIL (${failures})` : "\nINTERACT CORE: PASS");
process.exit(failures ? 1 : 0);
