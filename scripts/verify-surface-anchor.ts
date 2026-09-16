#!/usr/bin/env -S npx tsx
// 2026-09-15 surface redesign — the ONE placement law behind every popover
// that opens "at the selection" (property menu, X-ray): ui/anchor.ts is pure,
// so its contract gates hermetically here.
//   · beside the avoided box: right first, then left, below, above
//   · aligned to the pointer along the free axis, clamped to the viewport
//   · never covers the avoided box while any side has room
//   · pointer-only and centre fallbacks; re-clamp after a resize
//   Run: npx tsx scripts/verify-surface-anchor.ts
import { anchorPanel, overlapArea, reclampPanel, reanchorPanel, unionRects } from "../src/lib/ui/anchor";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
const inside = (r: { x: number; y: number; w: number; h: number }, vp: { w: number; h: number }, m = 8) =>
  r.x >= m && r.y >= m && r.x + r.w <= vp.w - m && r.y + r.h <= vp.h - m;

const vp = { w: 1400, h: 900 };
const size = { w: 330, h: 420 };

// (1) room on the right → right of the box, top aligned to the pointer.
{
  const avoid = { x: 300, y: 200, w: 200, h: 150 };
  const r = anchorPanel({ avoid, point: { x: 420, y: 260 }, size, viewport: vp });
  assert(r.side === "right" && r.x === 300 + 200 + 12, `right of the box (x=${r.x})`);
  assert(r.y === 260 - 28, `aligned to the pointer (y=${r.y})`);
  assert(!overlaps({ ...r, ...size }, avoid) && inside({ ...r, ...size }, vp), "never covers the box; inside the viewport");
}
// (2) no room on the right → left.
{
  const avoid = { x: 1100, y: 200, w: 250, h: 150 };
  const r = anchorPanel({ avoid, point: { x: 1200, y: 300 }, size, viewport: vp });
  assert(r.side === "left" && r.x === 1100 - 12 - size.w, `left of the box when the right is full (x=${r.x})`);
  assert(!overlaps({ ...r, ...size }, avoid), "left placement does not cover the box");
}
// (3) neither side → below; (4) nor below → above.
{
  const wide = { x: 40, y: 100, w: 1320, h: 200 };
  const r = anchorPanel({ avoid: wide, point: { x: 700, y: 150 }, size, viewport: vp });
  assert(r.side === "below" && r.y === 100 + 200 + 12, `below a full-width box (y=${r.y})`);
  assert(!overlaps({ ...r, ...size }, wide), "below placement does not cover the box");
  const low = { x: 40, y: 500, w: 1320, h: 380 };
  const r2 = anchorPanel({ avoid: low, point: { x: 700, y: 600 }, size, viewport: vp });
  assert(r2.side === "above" && r2.y === 500 - 12 - size.h, `above a box that fills the bottom (y=${r2.y})`);
  assert(!overlaps({ ...r2, ...size }, low), "above placement does not cover the box");
}
// (5) nothing fits whole → the side that covers the LEAST of the box, never "on the pointer".
{
  const all = { x: 0, y: 0, w: 1400, h: 900 };
  const r = anchorPanel({ avoid: all, point: { x: 1300, y: 850 }, size, viewport: vp });
  assert(r.side !== "pointer" && r.side !== "center" && inside({ ...r, ...size }, vp), `a box filling the screen still yields a side, inside the viewport (${r.side} ${r.x},${r.y})`);
  // A tall selection through the middle: no side has full room for a 616-wide
  // panel; the panel hugs the right edge and overlaps only the box's margin.
  const tall = { x: 500, y: 40, w: 400, h: 820 };
  const wide = { w: 616, h: 420 };
  const t = anchorPanel({ avoid: tall, point: { x: 700, y: 300 }, size: wide, viewport: vp });
  assert(t.side === "right" && t.x === vp.w - 8 - wide.w, `the least-overlap side wins (${t.side} x=${t.x})`);
  assert(overlapArea({ ...t, ...wide }, tall) < wide.w * wide.h * 0.25, "…and it covers less than a quarter of the panel's area of the box");
  assert(inside({ ...t, ...wide }, vp), "…inside the viewport");
}
// (6) no box: at the pointer's right, or its left near the edge; no pointer: centred.
{
  const r = anchorPanel({ point: { x: 100, y: 100 }, size, viewport: vp });
  assert(r.side === "pointer" && r.x === 112 && r.y === 72, `pointer-only opens to the pointer's right (${r.x},${r.y})`);
  const r2 = anchorPanel({ point: { x: 1380, y: 100 }, size, viewport: vp });
  assert(r2.x + size.w <= vp.w - 8 && r2.x < 1380, "near the right edge it opens to the pointer's left");
  const c = anchorPanel({ size, viewport: vp });
  assert(c.side === "center" && Math.abs(c.x - (vp.w - size.w) / 2) < 1, "no inputs → centred");
}
// (7) pointer above the top edge / below the bottom edge clamps the free axis.
{
  const avoid = { x: 300, y: 10, w: 200, h: 100 };
  const r = anchorPanel({ avoid, point: { x: 400, y: 12 }, size, viewport: vp });
  assert(r.y === 8, `top clamp (y=${r.y})`);
  const r2 = anchorPanel({ avoid: { x: 300, y: 700, w: 200, h: 150 }, point: { x: 400, y: 880 }, size, viewport: vp });
  assert(r2.y === vp.h - 8 - size.h, `bottom clamp (y=${r2.y})`);
}
// (8) a panel taller than the viewport pins to the margin instead of going negative.
{
  const r = anchorPanel({ point: { x: 400, y: 400 }, size: { w: 300, h: 2000 }, viewport: vp });
  assert(r.y === 8, "an oversize panel pins to the top margin");
}
// (9) reclamp keeps the origin unless the new size leaves the viewport.
{
  const p = reclampPanel({ x: 1200, y: 700 }, { w: 330, h: 420 }, vp);
  assert(p.x === 1400 - 8 - 330 && p.y === 900 - 8 - 420, `reclamp pulls a grown panel back on screen (${p.x},${p.y})`);
  const y = reclampPanel({ x: 1000, y: 700 }, { w: 330, h: 420 }, vp);
  assert(y.x === 1000 && y.y === 900 - 8 - 420, `reclamp moves only the axis that overflows (${y.x},${y.y})`);
  const same = reclampPanel({ x: 100, y: 100 }, { w: 330, h: 420 }, vp);
  assert(same.x === 100 && same.y === 100, "reclamp leaves a fitting panel alone");
}
// (10) unionRects ignores empty rects and unions the rest.
{
  const u = unionRects([{ x: 10, y: 10, w: 0, h: 0 }, { x: 20, y: 30, w: 40, h: 10 }, { x: 50, y: 5, w: 10, h: 10 }]);
  assert(u && u.x === 20 && u.y === 5 && u.w === 40 && u.h === 35, `union (${JSON.stringify(u)})`);
  assert(unionRects([]) === null, "empty union is null");
}
// (11) a larger picker preserves a safe origin, or finds a less obstructive side.
{
  const avoid = { x: 600, y: 200, w: 200, h: 150 };
  const point = { x: 700, y: 260 };
  const initial = anchorPanel({ avoid, point, size, viewport: vp });
  const grown = { w: 620, h: 420 };
  const next = reanchorPanel(initial, { avoid, point, size: grown, viewport: vp });
  assert(!overlaps({ ...next, ...grown }, avoid) && inside({ ...next, ...grown }, vp), "growing a picker moves below when clamping sideways would cover the selection");
  const kept = reanchorPanel(next, { avoid, point, size, viewport: vp });
  assert(kept.x === next.x && kept.y === next.y, "shrinking a safe panel does not jump it back under the pointer");
}
// (12) a selected object may be outside the viewport after panning.
{
  for (const avoid of [
    { x: -2000, y: 200, w: 100, h: 100 },
    { x: 2000, y: 200, w: 100, h: 100 },
    { x: 0, y: -2000, w: 1400, h: 100 },
    { x: 0, y: 2000, w: 1400, h: 100 },
  ]) {
    const r = anchorPanel({ avoid, point: { x: 700, y: 450 }, size, viewport: vp });
    assert(inside({ ...r, ...size }, vp), `offscreen selection cannot place the menu offscreen (${avoid.x},${avoid.y})`);
  }
}
console.log("VERIFY-SURFACE-ANCHOR PASS");
