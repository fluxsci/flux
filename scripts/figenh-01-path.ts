#!/usr/bin/env -S npx tsx
// Feature 1 — pure vector-path core: nodesToPath/pathToNodes round-trip, Shift
// constrain, scaleNodes, refitPath, the resizeRemap path FIX (nodes + legacy d),
// and ops.addPath/updatePath.
import { nodesToPath, pathToNodes, scaleNodes, refitPath, constrain45, nodesExtent, roundCorners, pathD, pathRender, reverseNodes, mergeNodeChains } from "../src/lib/path";
import { resizeRemap, scaleRemap } from "../src/lib/editing";
import { elementBBox } from "../src/lib/geometry";
import * as ops from "../src/lib/ops";
import type { PathElement, VectorNode, Project } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 0.01) => Math.abs(a - b) <= t;

// 1. straight segments
const straight: VectorNode[] = [
  { x: 0, y: 0, type: "corner" },
  { x: 10, y: 0, type: "corner" },
  { x: 10, y: 10, type: "corner" },
];
assert(nodesToPath(straight, false) === "M 0 0 L 10 0 L 10 10", "nodesToPath straight (L segments)");
assert(nodesToPath(straight, true) === "M 0 0 L 10 0 L 10 10 L 0 0 Z", "nodesToPath closed appends wrap + Z");

// 2. cubic
const curve: VectorNode[] = [
  { x: 0, y: 0, type: "smooth", hOut: { dx: 5, dy: 0 } },
  { x: 20, y: 0, type: "smooth", hIn: { dx: -5, dy: 0 }, hOut: { dx: 5, dy: 0 } },
  { x: 40, y: 0, type: "smooth", hIn: { dx: -5, dy: 0 } },
];
assert(nodesToPath(curve, false).includes("C "), "nodesToPath emits cubic C when handles present");

// 3. round-trip (closed cubic): re-serialize is idempotent, node count preserved
const closedCurve: VectorNode[] = [
  { x: 0, y: 0, type: "smooth", hIn: { dx: 0, dy: -6 }, hOut: { dx: 0, dy: 6 } },
  { x: 30, y: 30, type: "smooth", hIn: { dx: -6, dy: 0 }, hOut: { dx: 6, dy: 0 } },
  { x: 0, y: 60, type: "smooth", hIn: { dx: 0, dy: -6 }, hOut: { dx: 0, dy: 6 } },
];
const d1 = nodesToPath(closedCurve, true);
const back = pathToNodes(d1);
assert(nodesToPath(back, true) === d1, "pathToNodes∘nodesToPath idempotent (closed cubic)");
assert(back.length === closedCurve.length, `round-trip preserves node count (${back.length})`);
assert(back.every((n) => n.type === "smooth"), "round-trip classifies mirrored handles as smooth");

// legacy straight d becomes editable
const legacyNodes = pathToNodes("M 0 0 L 50 0 L 50 40 Z");
assert(legacyNodes.length === 3 && legacyNodes.every((n) => n.type === "corner"), "legacy d → corner nodes");

// 4. Shift constrain to 0/45/90
let c = constrain45(10, 0.5);
assert(near(c.dy, 0, 0.001) && c.dx > 9, "constrain45 → horizontal");
c = constrain45(10, 9);
assert(near(Math.abs(c.dx), Math.abs(c.dy), 0.001), "constrain45 → 45° (|dx|=|dy|)");
c = constrain45(0.5, 10);
assert(near(c.dx, 0, 0.001) && c.dy > 9, "constrain45 → vertical");

// 5. scaleNodes
const sc = scaleNodes([{ x: 0, y: 0, type: "corner" }, { x: 10, y: 20, type: "smooth", hOut: { dx: 4, dy: 2 } }], 2, 0.5);
assert(sc[1].x === 20 && sc[1].y === 10 && sc[1].hOut!.dx === 8 && sc[1].hOut!.dy === 1, "scaleNodes scales points + handles");

// 6. refitPath normalizes + sets w/h + d
const pe: PathElement = { type: "path", id: "p", x: 100, y: 100, width: 1, height: 1, rotation: 0, d: "", fill: "#ccc", stroke: "#222", strokeWidth: 2, closed: false, nodes: [{ x: 5, y: 5, type: "corner" }, { x: 25, y: 45, type: "corner" }] };
refitPath(pe);
assert(pe.nodes![0].x === 0 && pe.nodes![0].y === 0, "refitPath shifts nodes to (0,0)");
assert(pe.x === 105 && pe.y === 105, "refitPath adjusts x/y to preserve position");
assert(pe.width === 20 && pe.height === 40, `refitPath sets w/h (${pe.width}x${pe.height})`);
assert(pe.d === "M 0 0 L 20 40", "refitPath regenerates d");

// 7. resizeRemap FIX — nodes path scales geometry (was: snapped back)
const orig: PathElement = { type: "path", id: "q", x: 0, y: 0, width: 100, height: 100, rotation: 0, d: "M 0 0 L 100 0 L 100 100", fill: "#ccc", stroke: "#222", strokeWidth: 2, closed: false, nodes: [{ x: 0, y: 0, type: "corner" }, { x: 100, y: 0, type: "corner" }, { x: 100, y: 100, type: "corner" }] };
const e1: PathElement = structuredClone(orig);
const ob = elementBBox(orig);
resizeRemap(e1, orig, ob, { x: 0, y: 0, w: 200, h: 100 });
assert(e1.width === 200 && e1.d.includes("200"), `resize (nodes) rescales d + width (w=${e1.width}, d="${e1.d}")`);
assert(e1.nodes!.some((n) => near(n.x, 200)), "resize (nodes) scaled the node coords");

// legacy d resize (no nodes) — the original bug
const legacy: PathElement = { type: "path", id: "L", x: 0, y: 0, width: 100, height: 100, rotation: 0, d: "M 0 0 L 100 0 L 100 100 Z", fill: "#ccc", stroke: "#222", strokeWidth: 2, closed: true };
const e2: PathElement = structuredClone(legacy);
resizeRemap(e2, legacy, elementBBox(legacy), { x: 0, y: 0, w: 50, h: 100 });
assert(e2.d !== legacy.d && e2.d.includes("50") && e2.width === 50, `resize (legacy d) rescales d (d="${e2.d}")`);

// 8. ops.addPath / updatePath
const proj: Project = { version: 1, name: "t", canvases: [{ id: "c1", name: "C" }], figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [] }], assets: [], palette: [] };
const pid = ops.addPath(proj, "f1", { nodes: [{ x: 0, y: 0, type: "corner" }, { x: 60, y: 0, type: "smooth", hIn: { dx: -10, dy: 0 }, hOut: { dx: 10, dy: 0 } }, { x: 60, y: 40, type: "corner" }], closed: false, stroke: "#e00" });
const added = proj.figures[0].elements[0] as PathElement;
assert(pid != null && added.type === "path" && added.d.includes("C"), "ops.addPath builds a curved path element");
assert(added.width > 0 && added.height > 0, "ops.addPath sets bbox via refit");
ops.updatePath(proj, pid!, { closed: true });
assert((proj.figures[0].elements[0] as PathElement).d.trim().endsWith("Z"), "ops.updatePath closed → d ends with Z");

// 8b. Closed toggle on a LEGACY d-only path — the Inspector "Closed path"
// checkbox route: updatePath adopts nodes from d, flips closed, refits.
const lid = "p-legacy";
proj.figures[0].elements.push({ type: "path", id: lid, x: 10, y: 10, width: 120, height: 90, rotation: 0, d: "M 0 0 L 120 0 L 60 90", fill: "none", stroke: "#222", strokeWidth: 3, closed: false } as PathElement);
ops.updatePath(proj, lid, { closed: true });
const ltri = proj.figures[0].elements.find((e) => e.id === lid) as PathElement;
assert(ltri.nodes?.length === 3 && ltri.closed && ltri.d.trim().endsWith("Z"), "updatePath adopts d-only nodes + closes (Inspector toggle)");
ops.updatePath(proj, lid, { closed: false });
assert(!ltri.closed && !ltri.d.includes("Z"), "updatePath reopens (Z removed)");

// ---------------------------------------------------------------------------
// 9. Corner rounding (roundCorners / pathD) + path cap via setElementStyle
// ---------------------------------------------------------------------------
{
  const L: VectorNode[] = [
    { x: 0, y: 0, type: "corner" },
    { x: 100, y: 0, type: "corner" },
    { x: 100, y: 100, type: "corner" },
  ];
  // radius 0 → identity (the exact same array — zero cost for existing content)
  assert(roundCorners(L, false, 0) === L, "radius 0 → identity (same reference)");
  // right angle, r=10: corner replaced by two fillet nodes trimmed 10 from P
  const r10 = roundCorners(L, false, 10);
  assert(r10.length === 4, "one corner → two fillet nodes (endpoints kept)");
  assert(near(r10[1].x, 90) && near(r10[1].y, 0), "fillet entry at trim distance r/tan(45°) = 10");
  assert(near(r10[2].x, 100) && near(r10[2].y, 10), "fillet exit 10 down the outgoing leg");
  const k = (4 / 3) * Math.tan(Math.PI / 8) * 10; // cubic arc magic for a 90° turn
  assert(near(r10[1].hOut!.dx, k, 0.001) && near(r10[1].hOut!.dy, 0, 0.001), "entry handle along the incoming direction, arc-approx length");
  assert(near(r10[2].hIn!.dx, 0, 0.001) && near(r10[2].hIn!.dy, -k, 0.001), "exit handle back toward the corner");
  assert(!r10[0].hOut && !r10[3].hIn, "open-path endpoints stay sharp (never rounded)");
  // clamp: huge radius eats at most half of each adjacent leg
  const rBig = roundCorners(L, false, 500);
  assert(near(rBig[1].x, 50) && near(rBig[2].y, 50), "radius clamps to half the shorter adjacent segment");
  // collinear pass-through never fillets
  const col = roundCorners([{ x: 0, y: 0, type: "corner" }, { x: 50, y: 0, type: "corner" }, { x: 100, y: 0, type: "corner" }], false, 10);
  assert(col.length === 3, "collinear middle node passes through unrounded");
  // curve-flanked corner skipped (v1 contract: straight-straight only)
  const curveFlank = roundCorners(
    [{ x: 0, y: 0, type: "corner", hOut: { dx: 20, dy: 0 } }, { x: 50, y: 50, type: "corner" }, { x: 100, y: 0, type: "corner" }],
    false, 10,
  );
  assert(curveFlank.length === 3, "corner with a curved flank is skipped");
  // closed wrap corners round (a closed square rounds all four)
  const sq: VectorNode[] = [
    { x: 0, y: 0, type: "corner" }, { x: 100, y: 0, type: "corner" },
    { x: 100, y: 100, type: "corner" }, { x: 0, y: 100, type: "corner" },
  ];
  assert(roundCorners(sq, true, 12).length === 8, "closed square → all four corners fillet (incl. the wrap)");
  // adjacent corners on a short shared leg can't overlap (each takes ≤ half)
  const tight = roundCorners(
    [{ x: 0, y: 0, type: "corner" }, { x: 30, y: 0, type: "corner" }, { x: 30, y: 30, type: "corner" }, { x: 60, y: 30, type: "corner" }],
    false, 100,
  );
  const mid = tight.filter((n) => near(n.x, 30, 16));
  assert(mid.length === 4 && near(mid[1].y, 15) && near(mid[2].y, 15), "adjacent fillets meet at the shared leg's midpoint, never past it");

  // pathD embeds fillets; nodes stay sharp through refit; extent/x/y unchanged
  const el: PathElement = { type: "path", id: "pr", x: 5, y: 7, width: 1, height: 1, rotation: 0, d: "", fill: "none", stroke: "#222", strokeWidth: 2, closed: false, nodes: L.map((n) => ({ ...n })), cornerRadius: 10 };
  refitPath(el);
  assert(el.d.includes("C"), "refitPath emits fillet C segments for a polyline with radius");
  assert(el.nodes!.length === 3 && !el.nodes![1].hIn && !el.nodes![1].hOut, "authoritative nodes stay the SHARP skeleton");
  assert(el.width === 100 && el.height === 100 && el.x === 5 && el.y === 7, "extent from sharp nodes — box and position hold still");
  assert(pathD(L, false, 0) === nodesToPath(L, false), "pathD radius 0 === nodesToPath byte-for-byte");

  // pathRender with arrows keeps fillets (trim path re-emits from ROUNDED segs)
  const pr = pathRender({ d: el.d, nodes: el.nodes, closed: false, strokeWidth: 2, arrowEnd: true, cornerRadius: 10 });
  assert(pr.d.includes("C"), "arrow-trimmed render keeps the fillet curves");
  assert(pr.polys.length === 1, "arrowhead still emitted");

  // setElementStyle: cap + cornerRadius (incl. legacy d-only adoption + refit)
  const p2: Project = { version: 1, name: "t2", canvases: [{ id: "c1", name: "C" }], figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [] }], assets: [], palette: [] };
  p2.figures[0].elements.push({ type: "path", id: "leg", x: 0, y: 0, width: 100, height: 50, rotation: 0, d: "M 0 0 L 100 0 L 100 50", fill: "none", stroke: "#222", strokeWidth: 2, closed: false } as PathElement);
  ops.setElementStyle(p2, ["leg"], { cornerRadius: 8, cap: "butt" });
  const leg = p2.figures[0].elements[0] as PathElement;
  assert(leg.nodes?.length === 3, "cornerRadius on a legacy d-only path adopts nodes first");
  assert(leg.cornerRadius === 8 && leg.d.includes("C"), "…and refits: d re-emitted with fillets");
  assert(leg.cap === "butt", "cap applied to the path");
  ops.setElementStyle(p2, ["leg"], { cornerRadius: -3 });
  assert(leg.cornerRadius === 0 && !leg.d.includes("C"), "negative radius sanitizes to 0 → sharp d again");

  // resizeRemap keeps fillets in the emitted d; scaleRemap multiplies the radius
  const orig = structuredClone(el);
  const rz = structuredClone(el);
  resizeRemap(rz, orig, elementBBox(orig), { x: 5, y: 7, w: 200, h: 100 });
  assert(rz.d.includes("C") && rz.cornerRadius === 10, "resizeRemap: radius value fixed, d still rounded");
  const sc = structuredClone(el);
  scaleRemap(sc, orig, elementBBox(orig), { x: 5, y: 7, w: 200, h: 200 });
  assert(near(sc.cornerRadius!, 20), "scaleRemap (K tool) multiplies the path radius like rect");
  // the ordering trap: the scaled d must reflect the SCALED radius — the fillet
  // trim on the 2× geometry must sit at 2× the distance from the corner.
  const scaled = pathToNodes(sc.d);
  const entry = scaled[1];
  assert(near(entry.x, 180, 0.5) && near(entry.y, 0, 0.5), "K-scaled d re-emitted with the multiplied radius (trim at 20 on the 200-leg)");
}

// ---------------------------------------------------------------------------
// 10. Endpoint merge (pen sub-mode): reverseNodes + mergeNodeChains
// ---------------------------------------------------------------------------
{
  const N = (x: number, y: number, extra: Partial<VectorNode> = {}): VectorNode => ({ x, y, type: "corner", ...extra });
  // reverseNodes: order flips, handles swap, geometry identical
  const chain = [N(0, 0, { hOut: { dx: 10, dy: 0 } }), N(50, 20, { hIn: { dx: -10, dy: 0 }, hOut: { dx: 5, dy: 5 } }), N(100, 0)];
  const rev = reverseNodes(chain);
  assert(rev[0].x === 100 && rev[2].x === 0, "reverseNodes flips order");
  assert(rev[2].hIn?.dx === 10 && rev[1].hOut?.dx === -10 && rev[1].hIn?.dx === 5, "reverseNodes swaps hIn/hOut per node");

  const base = [N(0, 0), N(100, 0), N(200, 0)];
  // append at END: draft seeded on (200,0) drawing on to (300,50)
  const draftEnd = [N(200, 0, { hOut: { dx: 20, dy: 20 } }), N(300, 50)];
  const m1 = mergeNodeChains(base, draftEnd, "end", false);
  assert(m1.nodes.length === 4 && !m1.closed, "end-extend: base + draft tail, stays open");
  assert(m1.nodes[2].hOut?.dx === 20 && m1.nodes[2].hOut?.dy === 20, "seed's pulled handle folds onto the base endpoint");
  assert(m1.nodes[3].x === 300 && m1.nodes[3].y === 50, "draft tail appended");
  // prepend at START: draft seeded on (0,0) drawing out to (-100,40)
  const draftStart = [N(0, 0), N(-100, 40, { hIn: { dx: 10, dy: 10 } })];
  const m2 = mergeNodeChains(base, draftStart, "start", false);
  assert(m2.nodes.length === 4 && m2.nodes[0].x === -100, "start-extend: draft prepends reversed");
  assert(m2.nodes[0].hOut?.dx === 10 && m2.nodes[0].hOut?.dy === 10, "reversed draft's handles swap (hIn → hOut)");
  assert(m2.nodes[1].x === 0 && m2.nodes[3].x === 200, "base order preserved after the prepend");
  // close: seeded at END, draft comes back around onto the START node
  const draftClose = [N(200, 0), N(150, 80), N(0, 0, { hIn: { dx: 30, dy: 30 } })];
  const m3 = mergeNodeChains(base, draftClose, "end", true);
  assert(m3.closed && m3.nodes.length === 4, "end→start draft closes the path (landing node dropped)");
  assert(m3.nodes[0].hIn?.dx === 30, "landing node's hIn folds onto the start (the wrap segment keeps its curve)");
  // 2-node draft straight from end to start = close with no new nodes
  const m4 = mergeNodeChains(base, [N(200, 0), N(0, 0)], "end", true);
  assert(m4.closed && m4.nodes.length === 3, "minimal end→start draft just closes");
  // free draft REVERSED onto an endpoint (the landing path in Canvas)
  const free = [N(400, 100), N(300, 60), N(200, 0)]; // ends ON base's end node
  const m5 = mergeNodeChains(base, reverseNodes(free), "end", false);
  assert(m5.nodes.length === 5 && m5.nodes[3].x === 300 && m5.nodes[4].x === 400, "free draft attaches reversed at the endpoint");
  // merged result round-trips through updatePath/refit cleanly
  const p3: Project = { version: 1, name: "t3", canvases: [{ id: "c1", name: "C" }], figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [] }], assets: [], palette: [] };
  const mid = ops.addPath(p3, "f1", { nodes: base, closed: false, stroke: "#000" })!;
  ops.updatePath(p3, mid, { nodes: m3.nodes, closed: m3.closed });
  const mEl = p3.figures[0].elements[0] as PathElement;
  assert(mEl.closed && mEl.d.trim().endsWith("Z") && mEl.nodes?.length === 4, "merge → updatePath: closed d + refit hold");
}

console.log(fails === 0 ? "\nF1 PATH-CORE ALL PASS" : `\nF1 PATH-CORE ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
