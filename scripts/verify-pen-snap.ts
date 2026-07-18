#!/usr/bin/env -S npx tsx
// Pen placement-assist core (pure): close radius + close flag, shift 0/45/90
// constraint, h/v alignment to nodes AND edge midpoints, equal-edge-length
// snapping (free / axis-pinned / along-ray), alt bypass — the constructions
// that make a perfect square or a 45-45-90 triangle trivial with the pen.
import { penSnap, PEN_CLOSE_PX } from "../src/lib/interact/penSnap";
import type { VectorNode } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) <= t;
const N = (x: number, y: number): VectorNode => ({ x, y, type: "corner" });

// 1. close-the-shape
{
  const nodes = [N(0, 0), N(100, 0)];
  const r = penSnap(nodes, { x: 10, y: 8 }, { zoom: 1 });
  assert(r.close && r.pt.x === 0 && r.pt.y === 0, "within close radius of first node → close + pt snaps onto it");
  assert(!penSnap(nodes, { x: PEN_CLOSE_PX + 4, y: PEN_CLOSE_PX + 4 }, { zoom: 1 }).close, "outside the radius → no close");
  assert(!penSnap(nodes, { x: 10, y: 8 }, { zoom: 1, disable: true }).close, "alt bypass suppresses close (can place a node beside the start)");
  assert(penSnap(nodes, { x: 4, y: 4 }, { zoom: 2 }).close, "radius is screen-px (still closes when zoomed in)");
  assert(!penSnap([N(0, 0)], { x: 2, y: 2 }, { zoom: 1 }).close, "a single placed node never closes");
}

// 2. shift constrains to 0/45/90 from the last node (length preserved by constrain45)
{
  const r = penSnap([N(0, 0)], { x: -3, y: 105 }, { zoom: 1, shift: true });
  assert(near(r.pt.x, 0, 1e-9) && r.pt.y > 100, "near-vertical + shift → exactly vertical");
  const d = penSnap([N(0, 0)], { x: 70, y: 74 }, { zoom: 1, shift: true });
  assert(near(d.pt.x, d.pt.y, 1e-9), "near-diagonal + shift → exact 45° (dx === dy)");
}

// 3. free alignment: nodes and edge midpoints, x/y independent, zoom-scaled tol
{
  const nodes = [N(0, 0), N(100, 0)];
  let r = penSnap(nodes, { x: 99, y: 60 }, { zoom: 1 });
  assert(r.pt.x === 100 && r.pt.y === 60, "x snaps to a node's x, y left free");
  assert(r.guides.some((g) => g.kind === "align" && g.from.x === 100 && g.from.y === 0), "align guide anchored at the matched node");
  r = penSnap(nodes, { x: 49, y: -80 }, { zoom: 1 });
  assert(r.pt.x === 50, "x snaps to the EDGE MIDPOINT (perpendicular-bisector placement)");
  r = penSnap(nodes, { x: 98, y: 50 }, { zoom: 4 });
  assert(r.pt.x === 98, "tolerance is screen-px: 2px off at zoom 4 (=8 screen px) does NOT snap");
  r = penSnap(nodes, { x: 99, y: 60 }, { zoom: 1, disable: true });
  assert(r.pt.x === 99 && r.guides.length === 0, "alt bypass → raw point, no guides");
}

// 4. equal edge length — free-angle rescale
{
  const nodes = [N(0, 0), N(100, 0)];
  const r = penSnap(nodes, { x: 172, y: 71 }, { zoom: 1 });
  const L = Math.hypot(r.pt.x - 100, r.pt.y - 0);
  assert(near(L, 100, 1e-9), `prospective edge rescaled to the existing edge's length (|v|=${L.toFixed(3)})`);
  assert(r.guides.some((g) => g.kind === "equal"), "equal-length guide emitted (tick both edges)");
}

// 5. equal length with one axis pinned by alignment → the perfect corner
{
  const nodes = [N(0, 0), N(100, 0)];
  const r = penSnap(nodes, { x: 99, y: -95 }, { zoom: 1 });
  assert(r.pt.x === 100 && near(r.pt.y, -100, 1e-9), "x-aligned + equal-length solves y → exact square corner");
  assert(r.guides.some((g) => g.kind === "align") && r.guides.some((g) => g.kind === "equal"), "both guides shown");
}

// 6. shift + equal length along the ray (square with shift held)
{
  const nodes = [N(0, 0), N(100, 0)];
  const r = penSnap(nodes, { x: 97, y: 105 }, { zoom: 1, shift: true });
  assert(near(r.pt.x, 100, 1e-9) && near(r.pt.y, 100, 1e-9), "shift-vertical + equal-length → exactly (100,100)");
  assert(r.guides.length === 1 && r.guides[0].kind === "equal", "one equal guide under shift");
}

// 7. shift + alignment crossing along the ray (closing side of the square)
{
  const nodes = [N(0, 0), N(100, 0), N(100, 100)];
  const r = penSnap(nodes, { x: -4, y: 101 }, { zoom: 1, shift: true });
  assert(near(r.pt.x, 0, 1e-9) && near(r.pt.y, 100, 1e-6), "shift-horizontal from (100,100) snaps t to the vertical through (0,0)");
  assert(r.guides.some((g) => g.kind === "align"), "align guide under shift");
}

// 8. both axes aligned → fully determined, no length adjustment fights it
{
  const nodes = [N(0, 0), N(100, 0), N(100, 100)];
  const r = penSnap(nodes, { x: 1, y: 99 }, { zoom: 1 });
  assert(r.pt.x === 0 && r.pt.y === 100, "double alignment pins the point exactly");
  assert(r.guides.filter((g) => g.kind === "align").length === 2, "two align guides");
}

// 9. full square walk-through (the user story): shift all the way
{
  const A = { x: 0, y: 0 };
  const s1 = penSnap([N(A.x, A.y)], { x: 121, y: 2 }, { zoom: 1, shift: true });
  const B = s1.pt; // horizontal
  assert(near(B.y, 0, 1e-9), "square: AB horizontal under shift");
  const s2 = penSnap([N(A.x, A.y), N(B.x, B.y)], { x: B.x - 2, y: 118 }, { zoom: 1, shift: true });
  const C = s2.pt;
  assert(near(C.x, B.x, 1e-9) && near(C.y, Math.hypot(B.x - A.x, B.y - A.y), 1e-9), "square: BC vertical + |BC|=|AB|");
  const s3 = penSnap([N(A.x, A.y), N(B.x, B.y), N(C.x, C.y)], { x: 1, y: C.y + 2 }, { zoom: 1, shift: true });
  const D = s3.pt;
  assert(near(D.x, A.x, 1e-9) && near(D.y, C.y, 1e-9), "square: CD lands exactly above A");
  const s4 = penSnap([N(A.x, A.y), N(B.x, B.y), N(C.x, C.y), N(D.x, D.y)], { x: 3, y: 4 }, { zoom: 1 });
  assert(s4.close, "square: click near A closes");
}

// 9. grid quantization (visible-grid pen restriction) + precedence
{
  const G = 8;
  // First node of a draft quantizes (the old early-return bypassed empty drafts).
  let r = penSnap([], { x: 13, y: 18 }, { zoom: 1, grid: G });
  assert(r.pt.x === 16 && r.pt.y === 16 && r.onGrid === true, "first draft node lands on the nearest vertex");
  // Subsequent nodes quantize and skip align/equal assists entirely.
  const nodes = [N(0, 0), N(100, 0)];
  r = penSnap(nodes, { x: 99, y: 59 }, { zoom: 1, grid: G });
  assert(r.pt.x === 96 && r.pt.y === 56 && r.guides.length === 0, "grid beats align assists (no 99→100 pull, no guides)");
  // Close still beats grid (a path must be closable from off-lattice).
  r = penSnap(nodes, { x: 3, y: 2 }, { zoom: 1, grid: G });
  assert(r.close && r.pt.x === 0 && r.pt.y === 0, "close beats grid");
  // Alt kills grid too.
  r = penSnap(nodes, { x: 13, y: 18 }, { zoom: 1, grid: G, disable: true });
  assert(r.pt.x === 13 && r.pt.y === 18 && !r.onGrid, "alt bypass → raw point even with grid on");
  // Shift + grid: direction wins exactly; h/v rays land on the lattice.
  r = penSnap([N(4, 4)], { x: 61, y: 7 }, { zoom: 1, grid: G, shift: true });
  assert(near(r.pt.y, 4, 1e-9), "shift+grid horizontal ray: y stays exactly on the ray");
  assert(near(r.pt.x, 64, 1e-9), "shift+grid horizontal ray: moving axis lands on n·G");
  const d = penSnap([N(0, 0)], { x: 70, y: 74 }, { zoom: 1, grid: G, shift: true });
  assert(near(d.pt.x, d.pt.y, 1e-9), "shift+grid 45° ray: direction exact (dx === dy)");
}

// 10. anchors (path-edit pen sub-mode): exact landing, endpoint > mid, radius zoom-scaled
{
  const A = (x: number, y: number, role: "endpoint-start" | "endpoint-end" | "mid", i: number) => ({ pt: { x, y }, role, i });
  const anchors = [A(0, 0, "endpoint-start", 0), A(50, 3, "mid", 1), A(100, 0, "endpoint-end", 2)];
  // Nearest-in-radius, exact landing, no grid/assist re-snap.
  let r = penSnap([], { x: 47, y: 7 }, { zoom: 1, grid: 8, anchors });
  assert(r.anchor?.i === 1 && r.pt.x === 50 && r.pt.y === 3 && !r.onGrid, "anchor lands EXACTLY on the node (grid does not re-snap it)");
  // An endpoint beats a nearer mid.
  r = penSnap([], { x: 95, y: 1 }, { zoom: 1, anchors: [A(94, 0, "mid", 1), A(100, 0, "endpoint-end", 2)] });
  assert(r.anchor?.role === "endpoint-end", "endpoint anchor preferred over a nearer mid");
  // Radius is screen-px (zoom-scaled); outside → no anchor.
  r = penSnap([], { x: 50 + PEN_CLOSE_PX + 2, y: 3 }, { zoom: 1, anchors });
  assert(!r.anchor, "outside the radius → no anchor");
  assert(penSnap([], { x: 50 + 10, y: 3 }, { zoom: 2, anchors }).anchor == null, "zoom 2 shrinks the world-space radius (10 > 14/2)");
  // Self-close beats anchors on a free draft…
  const draft = [N(0, 0), N(60, 0)];
  r = penSnap(draft, { x: 2, y: 1 }, { zoom: 1, anchors });
  assert(r.close && !r.anchor, "self-close beats anchors");
  // …but noClose (seeded sub-mode draft) suppresses it, letting anchors/raw win.
  r = penSnap(draft, { x: 2, y: 1 }, { zoom: 1, anchors, noClose: true });
  assert(!r.close && r.anchor?.role === "endpoint-start", "noClose: seed-adjacent click resolves to the anchor instead of closing");
}

console.log(fails === 0 ? "\nPEN-SNAP ALL PASS" : `\nPEN-SNAP ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
