#!/usr/bin/env -S npx tsx
// WS-3.2 (fortify plan) — bit-for-bit battery for the extracted interaction
// core (src/lib/interact/*). The ORACLES below are verbatim copies of the
// Canvas.svelte implementations as they stood before extraction (SlideStage's
// were verified byte-identical); every output must match EXACTLY over a
// coordinate grid. Corrected edge-shrink and fixed-anchor clamping contracts
// replace the old buggy outputs; every unaffected result stays byte-identical.
//   npx tsx scripts/verify-interact-core.ts

import { HANDLES, handlePos, cursorFor, resizeAxisFor, resizeCursorVar, rotateCursorVar, selectionHitZones, hitZoneAt, clipZones, zoneClipForFrame, ZONE_DEFAULTS, ZONE_TITLEBAR_GAP, CORNERS, EDGES, type Handle } from "../src/lib/interact/handles";
import { computeResizeBox, resizeAboutCentre } from "../src/lib/interact/gestureMath";
import { snap, boxSnapTargets } from "../src/lib/interact/snap";
import { nodeMoveAxes, constrainDelta } from "../src/lib/interact/nodeAxis";
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
        // The original implementation moved the fixed edge when crossing it,
        // and compared an inactive axis to 1 under aspect lock. Pin invariants
        // for those documented fixes; retain the old oracle elsewhere.
        const horizontal = h.includes("w") || h.includes("e");
        const vertical = h.includes("n") || h.includes("s");
        const rw = h.includes("w") ? ob.x + ob.w - lp.x : h.includes("e") ? lp.x - ob.x : ob.w;
        const rh = h.includes("n") ? ob.y + ob.h - lp.y : h.includes("s") ? lp.y - ob.y : ob.h;
        const corrected = rw < 1 || rh < 1 || (shift && horizontal !== vertical);
        const near = (x: number, y: number) => Math.abs(x-y) < 1e-8;
        // 2026-10-21: an EDGE drag that keeps the aspect centres the inactive axis
        // (the opposite edge's midpoint is the anchor) instead of pinning top/left.
        const edgeAspect = shift && horizontal !== vertical && ob.w > 0 && ob.h > 0;
        const fixedX = edgeAspect && !horizontal ? near(b.x + b.w / 2, ob.x + ob.w / 2) : h.includes("w") ? near(b.x+b.w, ob.x+ob.w) : near(b.x,ob.x);
        const fixedY = edgeAspect && !vertical ? near(b.y + b.h / 2, ob.y + ob.h / 2) : h.includes("n") ? near(b.y+b.h, ob.y+ob.h) : near(b.y,ob.y);
        const aspect = !shift || ob.w <= 0 || ob.h <= 0 || near(b.w/b.h,ob.w/ob.h);
        const valid = fixedX && fixedY && aspect && b.w >= 1 && b.h >= 1;
        if (!(corrected ? valid : eq(a,b))) {
          bad++;
          if (bad < 3) fail(`computeResizeBox contract ${JSON.stringify({ ob, h, lp, shift, a, b })}`);
        }
      }
assert(bad === 0, `computeResizeBox fixed anchors, proportions and unchanged legacy cases across ${n} inputs`);

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

// ---- nodeAxis: shift-constrained node dragging (2026-07-18) ----------------
{
  const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) <= t;
  const N = (x: number, y: number): import("../src/lib/types").VectorNode => ({ x, y, type: "corner" });
  // zigzag: node 1 sits between two diagonal segments (+45° in, −45° out)
  const zig = [N(0, 100), N(100, 0), N(200, 100)];
  const axes1 = nodeMoveAxes(zig, false, 1);
  assert(axes1.length === 4, `interior zigzag node: H + V + two distinct tangents (${axes1.length})`);
  // a smooth node's mirrored tangents dedupe to ONE axis
  const smooth = [N(0, 0), { x: 100, y: 50, type: "smooth" as const, hIn: { dx: -30, dy: -15 }, hOut: { dx: 30, dy: 15 } }, N(200, 100)];
  assert(nodeMoveAxes(smooth, false, 1).length === 3, "smooth node: mirrored tangents dedupe (H, V, one tangent)");
  // an axis-aligned segment folds into H (no duplicate)
  assert(nodeMoveAxes([N(0, 0), N(100, 0), N(100, 100)], false, 1).length === 2, "H/V-aligned tangents fold into H and V");
  // open-path endpoint has only one flanking tangent
  assert(nodeMoveAxes(zig, false, 0).length === 3, "open-path endpoint: H, V, one tangent");
  // closed wrap: node 0's incoming segment is the wrap
  const sq = [N(0, 0), N(100, 0), N(100, 100), N(0, 100)];
  assert(nodeMoveAxes(sq, true, 0).length === 2, "closed square corner: wrap + outgoing both fold into H/V");
  const diamond = [N(100, 0), N(200, 100), N(100, 200), N(0, 100)];
  assert(nodeMoveAxes(diamond, true, 0).length === 4, "closed diamond corner: wrap tangent counted (H, V, two diagonals)");

  // constrainDelta: picks the closest axis, projects exactly
  const axes = nodeMoveAxes(zig, false, 1);
  const c1 = constrainDelta(50, 3, axes);
  assert(near(c1.dy, 0) && near(c1.dx, 50), "near-horizontal drag constrains to exact H (dy=0)");
  const c2 = constrainDelta(3, -60, axes);
  assert(near(c2.dx, 0) && near(c2.dy, -60), "near-vertical drag constrains to exact V");
  const c3 = constrainDelta(40, -38, axes);
  assert(near(c3.dx + c3.dy, 0, 1e-6), "near-diagonal drag rides the incoming segment direction (dx = −dy)");
  const proj = Math.abs(c3.dx) * Math.SQRT2;
  assert(near(proj, Math.abs((40 - -38) / Math.SQRT2), 1e-6), "…with the exact scalar projection");
}


// ---- 2026-10-21: the selection's hit zones (Figma edge grab) + Alt-from-centre ----
console.log("Selection hit zones (handles.ts selectionHitZones):");
{
  const box: Rect = { x: 100, y: 100, w: 200, h: 120 };
  const z = selectionHitZones(box);
  const kindAt = (x: number, y: number) => {
    const h = hitZoneAt(z, x, y);
    return h ? `${h.kind}:${"handle" in h ? h.handle : h.zone}` : "none";
  };
  assert(z.filter((a) => a.kind === "corner").length === 4 && z.filter((a) => a.kind === "edge").length === 4, "four corner squares and four edge bands");
  assert(z.findIndex((a) => a.kind === "corner") > z.findIndex((a) => a.kind === "edge") && z.findIndex((a) => a.kind === "edge") > z.findIndex((a) => a.kind === "rotate"), "paint order rotate → edge → corner (the later zone wins where they overlap)");
  // every point along the right edge resizes east — 10 %, 50 %, 90 % of its length, inside and outside
  for (const f of [0.1, 0.5, 0.9]) {
    const y = box.y + ZONE_DEFAULTS.cornerHit / 2 + (box.h - ZONE_DEFAULTS.cornerHit) * f;
    assert(kindAt(300, y) === "edge:e" && kindAt(297, y) === "edge:e" && kindAt(305, y) === "edge:e", `the whole right edge is the e handle (${Math.round(f * 100)} %: on, 3 px inside, 5 px outside)`);
  }
  assert(kindAt(200, 100) === "edge:n" && kindAt(200, 220) === "edge:s" && kindAt(100, 160) === "edge:w", "the other three edges are their handles along their length");
  assert(kindAt(100, 100) === "corner:nw" && kindAt(300, 220) === "corner:se" && kindAt(305, 95) === "corner:ne" && kindAt(95, 225) === "corner:sw", "the corner squares win at the corners, inside and outside");
  assert(kindAt(100, 100 + ZONE_DEFAULTS.cornerIn - 0.1) === "corner:nw" && kindAt(100, 100 + ZONE_DEFAULTS.cornerIn + 0.1) === "edge:w" && kindAt(100, 100 + ZONE_DEFAULTS.cornerIn + 0.1 + 0) !== "none", "the band starts exactly where the corner square's inward reach ends (no dead strip)");
  assert(kindAt(96, 103) === "edge:w" || kindAt(96, 103) === "corner:nw", "outside the box beside a corner square's foot something still resizes");
  assert(kindAt(315, 235) === "rotate:se" && kindAt(315, 220) === "rotate:se" && kindAt(300, 240) === "rotate:se" && kindAt(85, 85) === "rotate:nw", "the L outside each corner rotates");
  assert(kindAt(200, 160) === "none" && kindAt(106, 106) === "none" && kindAt(200, 108) === "none", "the interior (beyond the 4 px inner reach) hits nothing — it is the move area");
  assert(kindAt(300, 150) === "edge:e" && kindAt(307, 150) === "none" && kindAt(295, 150) === "none" && kindAt(296, 150) === "edge:e", "the band reaches 6 px out and 4 px in, no further (the body near an edge still moves)");
  assert(kindAt(103, 103) === "corner:nw" && kindAt(105, 105) === "none", "a corner square reaches 4 px in (a plot grabbed 6 px inside its corner still moves)");
  // rotate zones never overlap the edge bands or the corner squares' own area
  const rects = (k: string) => z.filter((a) => a.kind === k).map((a) => a.rect);
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-9 && a.x + a.w > b.x + 1e-9 && a.y < b.y + b.h - 1e-9 && a.y + a.h > b.y + 1e-9;
  assert(!rects("rotate").some((r) => rects("edge").some((e) => overlap(r, e))), "rotate zones and edge bands are disjoint");
  assert(!rects("rotate").some((r) => rects("corner").some((c) => overlap(r, c))), "rotate zones and corner squares are disjoint");
  // bands and corner squares may share the strip outside the box beside a square's foot — the square (painted last) wins there
  // tiny boxes keep a free interior and lose their bands
  const tiny = selectionHitZones({ x: 0, y: 0, w: 8, h: 8 });
  assert(tiny.filter((a) => a.kind === "edge").length === 0, "an 8 px box has no edge bands (under two outer reaches on both axes)");
  assert(hitZoneAt(tiny, 4, 4) === null && hitZoneAt(tiny, 3, 3) === null && hitZoneAt(tiny, 5, 5) === null, "…and its middle half is free to move");
  assert(hitZoneAt(tiny, 1, 1) === null && hitZoneAt(tiny, -3, -3)?.kind === "corner" && hitZoneAt(tiny, 9, 9)?.kind === "corner" && hitZoneAt(tiny, 0, 0)?.kind === "corner", "…while its corners still resize from OUTSIDE (a small side has no inward reach)");
  const six = selectionHitZones({ x: 0, y: 0, w: 6, h: 6 });
  assert(hitZoneAt(six, 3, 3) === null, "a 6 px box is still movable from its centre");
  // a band's inner reach is a quarter of the side for thin boxes
  const thin = selectionHitZones({ x: 0, y: 0, w: 200, h: 16 });
  const sBand = thin.find((a) => a.kind === "edge" && a.handle === "s")!.rect;
  assert(Math.abs(sBand.y - 16) < 1e-9 && thin.filter((a) => a.kind === "edge").length === 4, "a 16 px tall box (under the 24 px small side) keeps every band OUTSIDE only");
  const oneLine = selectionHitZones({ x: 0, y: 0, w: 520, h: 20 });
  assert(oneLine.some((a) => a.kind === "edge" && a.handle === "e") && hitZoneAt(oneLine, 520, 10)?.kind === "edge" && hitZoneAt(oneLine, 523, 10)?.kind === "edge", "a one-line text (20 px tall) keeps its e/w bands: dragging its right edge to wrap it is the everyday case");
  assert(hitZoneAt(oneLine, 260, 10) === null && hitZoneAt(oneLine, 515, 10) === null && hitZoneAt(oneLine, 519, 10)?.kind === "edge", "…its e/w bands reach 4 px in along its long axis (the small-side rule is per axis), the body before that moves");
  const label = selectionHitZones({ x: 0, y: 0, w: 200, h: 10 });
  assert(label.filter((a) => a.kind === "edge" && (a.handle === "n" || a.handle === "s")).length === 0, "a 10 px label has no n/s bands (its height is under two outer reaches) — no accidental height resize");
  assert(label.filter((a) => a.kind === "edge").length === 2, "…but keeps its e/w bands (width wraps it)");
  assert(hitZoneAt(label, 100, 5) === null && hitZoneAt(label, 6, 5) === null && hitZoneAt(label, 2, 5)?.kind === "edge", "…and its body moves up to the e/w bands' 4 px inward reach");
  // every box keeps a non-empty move region at its centre — including degenerate ones
  for (const b of [
    { x: 0, y: 0, w: 0, h: 200 }, { x: 0, y: 0, w: 200, h: 0 }, { x: 0, y: 0, w: 2, h: 200 }, { x: 0, y: 0, w: 200, h: 2 },
    { x: 0, y: 0, w: 6, h: 6 }, { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 10, h: 200 }, { x: 0, y: 0, w: 500, h: 400 }, { x: 0, y: 0, w: 30, h: 30 },
  ] as Rect[]) {
    const zs = selectionHitZones(b);
    assert(hitZoneAt(zs, b.x + b.w / 2, b.y + b.h / 2) === null, `the centre of a ${b.w} × ${b.h} box is free to move`);
  }
  const row = selectionHitZones({ x: 0, y: 0, w: 300, h: 0 });
  assert([30, 150, 270].every((x) => hitZoneAt(row, x, 0) === null) && row.filter((a) => a.kind === "edge").length === 0, "a zero-height row of lines has no bands over its stroke; its length is the move area");
  const bar = selectionHitZones({ x: 0, y: 0, w: 200, h: 2 });
  assert([20, 100, 180].every((x) => hitZoneAt(bar, x, 1) === null), "a 2 px scale bar is grabbable along its whole length");
  // the frame clip: an element flush with the frame's top keeps the title bar strip above it free
  const frame: Rect = { x: 100, y: 100, w: 600, h: 400 };
  const flush = selectionHitZones({ x: 300, y: 100, w: 200, h: 120 }, { clip: zoneClipForFrame(frame) });
  assert(flush.every((a) => a.rect.y >= frame.y - ZONE_TITLEBAR_GAP - 1e-9), `with the frame clip no zone reaches more than ${ZONE_TITLEBAR_GAP} px above the frame (the title bar lives there)`);
  assert(hitZoneAt(flush, 400, 100 - 13) === null && hitZoneAt(flush, 300 - 10, 100 - 10) === null, "…the title-bar strip and the space above the corners are free");
  assert(hitZoneAt(flush, 400, 100 - 2)?.kind === "edge" && hitZoneAt(flush, 500 + 5, 100 + 60)?.kind === "edge" && hitZoneAt(flush, 500 + 12, 100 + 120 + 12)?.kind === "rotate", "…while the n band keeps its 3 px above the frame, and the right band / se rotate zone keep their full reach inside the clip");
  const clipped = clipZones([{ kind: "edge", handle: "n", rect: { x: 0, y: -10, w: 100, h: 20 } }], { x: 10, y: 0, w: 50, h: 50 });
  assert(clipped.length === 1 && JSON.stringify(clipped[0].rect) === JSON.stringify({ x: 10, y: 0, w: 50, h: 10 }), "clipZones intersects and keeps the zone identity");
  assert(clipZones([{ kind: "edge", handle: "n", rect: { x: 0, y: -10, w: 100, h: 5 } }], { x: 0, y: 0, w: 50, h: 50 }).length === 0, "…and drops zones entirely outside the clip");
  // zone geometry is screen px — independent of the box's world size (the caller converts)
  assert(z.every((a) => Number.isFinite(a.rect.x + a.rect.y + a.rect.w + a.rect.h) && a.rect.w > 0 && a.rect.h > 0), "every zone rect is finite and positive");
  assert(CORNERS.length === 4 && EDGES.length === 4 && [...CORNERS, ...EDGES].sort().join() === [...HANDLES].sort().join(), "CORNERS + EDGES partition HANDLES");
}

console.log("Cursor variables per handle (handles.ts resizeCursorVar / rotateCursorVar):");
{
  assert(resizeAxisFor("n") === "ns" && resizeAxisFor("s") === "ns" && resizeAxisFor("e") === "ew" && resizeAxisFor("w") === "ew", "edges map to ns / ew");
  assert(resizeAxisFor("nw") === "nwse" && resizeAxisFor("se") === "nwse" && resizeAxisFor("ne") === "nesw" && resizeAxisFor("sw") === "nesw", "corners map to nwse / nesw");
  assert(HANDLES.every((h) => resizeCursorVar(h) === `var(--cursor-resize-${resizeAxisFor(h)})` && cursorFor[h].startsWith(resizeAxisFor(h))), "every handle's family variable agrees with its OS fallback axis");
  assert(rotateCursorVar("n") === "var(--cursor-rotate-n)" && rotateCursorVar("se") === "var(--cursor-rotate-se)", "rotate zones name their variable");
}

console.log("Alt = resize about the centre (gestureMath.ts resizeAboutCentre):");
{
  const ob: Rect = { x: 100, y: 100, w: 200, h: 100 };
  const c = (b: Rect) => [b.x + b.w / 2, b.y + b.h / 2];
  const r1 = computeResizeBox(ob, "e", { x: 320, y: 150 }, false, true);
  assert(eq(r1, { x: 80, y: 100, w: 240, h: 100 }), "dragging e 20 px out grows both sides: x 80, w 240, centre fixed");
  const r2 = computeResizeBox(ob, "n", { x: 200, y: 80 }, false, true);
  assert(eq(r2, { x: 100, y: 80, w: 200, h: 140 }), "dragging n 20 px up grows top and bottom");
  const r3 = computeResizeBox(ob, "se", { x: 320, y: 220 }, false, true);
  assert(eq(r3, { x: 80, y: 80, w: 240, h: 140 }) && eq(c(r3), c(ob)), "a corner grows both axes about the centre (the dragged corner lands on the pointer, the opposite one mirrors)");
  const r4 = computeResizeBox(ob, "se", { x: 320, y: 220 }, true, true);
  assert(eq(c(r4), c(ob)) && Math.abs(r4.w / r4.h - 2) < 1e-9 && r4.w === 280, "Shift+Alt keeps the aspect about the centre (dominant axis: 70/50 beats 120/100)");
  const r5 = computeResizeBox(ob, "e", { x: 320, y: 150 }, true, true);
  assert(eq(c(r5), c(ob)) && Math.abs(r5.w / r5.h - 2) < 1e-9, "Shift+Alt from an edge scales both axes about the centre");
  const r6 = computeResizeBox(ob, "e", { x: 150, y: 150 }, false, true);
  assert(eq(r6, { x: 150, y: 100, w: 100, h: 100 }), "a drag past the centre mirrors (no flip): the box is the pointer's distance from the centre, both ways");
  const r7 = computeResizeBox(ob, "w", { x: 200, y: 150 }, false, true);
  assert(r7.w === 1 && eq(c(r7), c(ob)), "at the centre the box floors at 1 px, centred");
  assert(eq(computeResizeBox(ob, "e", { x: 320, y: 150 }, false, false), computeResizeBox(ob, "e", { x: 320, y: 150 }, false)), "without the flag the plain law is unchanged (the oracle battery above)");
  assert(eq(resizeAboutCentre(ob, "e", { x: 320, y: 150 }, false), r1), "resizeAboutCentre is the exported law computeResizeBox delegates to");
}

console.log(failures ? `\nINTERACT CORE: FAIL (${failures})` : "\nINTERACT CORE: PASS");
process.exit(failures ? 1 : 0);
