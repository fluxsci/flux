#!/usr/bin/env -S npx tsx
// Primitive-completeness core (pure): dashed strokes (model sanitizing +
// dasharray attr), path arrowheads (pathRender: tangents, filled-head trim,
// vee, bails), TRUE curve extents (cubic extrema — handles never inflate the
// bbox), segment math (split/length/nearest), and the ctrl-drag bend core.
import { dashAttr, arrowTri, arrowHeadLen } from "../src/lib/geometry";
import {
  pathRender,
  nodesExtent,
  refitPath,
  segsFromNodes,
  segPoint,
  segTangent,
  splitSeg,
  segLength,
  nearestTOnSeg,
  bendSegment,
  nodesToPath,
} from "../src/lib/path";
import * as ops from "../src/lib/ops";
import type { PathElement, Project, VectorNode } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 0.01) => Math.abs(a - b) <= t;
const N = (x: number, y: number, h?: Partial<VectorNode>): VectorNode => ({ x, y, type: "corner", ...h });

// --- 1. dash: attr + sanitized model writes ---------------------------------
assert(dashAttr({}) === undefined && dashAttr({ dash: [] }) === undefined, "dashAttr: absent/empty → solid (no attr)");
assert(dashAttr({ dash: [6, 4] }) === "6 4", "dashAttr: [6,4] → '6 4'");

const proj: Project = { version: 1, name: "t", canvases: [{ id: "c1", name: "C" }], figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [] }], assets: [], palette: [] };
proj.figures[0].elements.push(
  { type: "rect", id: "r1", x: 0, y: 0, width: 50, height: 40, rotation: 0, fill: "#aaa", stroke: "#000", strokeWidth: 2, cornerRadius: 0 },
  { type: "line", id: "l1", x: 0, y: 100, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 100, y2: 0, stroke: "#000", strokeWidth: 2, arrowStart: false, arrowEnd: false },
  { type: "path", id: "p1", x: 200, y: 0, width: 100, height: 1, rotation: 0, d: "M 0 0 L 100 0", fill: "none", stroke: "#000", strokeWidth: 4, closed: false },
);
ops.setElementStyle(proj, ["r1", "l1", "p1"], { dash: [6, 4] });
const [r1, l1, p1] = proj.figures[0].elements as [any, any, PathElement];
assert(r1.dash?.join() === "6,4" && l1.dash?.join() === "6,4" && p1.dash?.join() === "6,4", "set_style dash applies to rect/line/path");
ops.setElementStyle(proj, ["r1"], { dash: [] });
assert(!("dash" in r1), "dash: [] clears back to solid (property deleted)");
ops.setElementStyle(proj, ["l1"], { dash: [-3, NaN, 5, 2] });
assert(l1.dash?.join() === "5,2", "dash: negative/NaN entries filtered");
ops.setElementStyle(proj, ["l1"], { dash: [0, 0] });
assert(!("dash" in l1), "dash: all-zero pattern treated as solid");

// --- 2. path arrowheads (pathRender) ----------------------------------------
ops.setElementStyle(proj, ["p1"], { arrowEnd: true });
assert(p1.arrowEnd === true, "set_style arrowEnd applies to an open path");
{
  const pr = pathRender(p1);
  assert(pr.polys.length === 1 && pr.vees.length === 0, "filled end arrow → one triangle");
  const head = arrowHeadLen(4, undefined, 100, 1);
  assert(near(pr.polys[0][0][0], 100) && near(pr.polys[0][0][1], 0), "triangle tip sits ON the path end");
  // The body TUCKS under the head (0.65×head euclidean from the tip) — never a
  // gap, and always covered by the solid triangle.
  const em = pr.d.trim().match(/(-?[\d.]+) (-?[\d.]+)$/);
  const endX = em ? Number(em[1]) : NaN;
  assert(near(endX, 100 - head * 0.65, 0.5) && endX < 100, `filled head: body tucks under the triangle (end x=${endX})`);
  const same = arrowTri(100, 0, 1, 0, head);
  assert(JSON.stringify(pr.polys[0]) === JSON.stringify(same), "path head geometry === line head geometry (one source)");
}
{
  // REGRESSION (owner screenshot): a strongly curved end used to open a GAP
  // between the trimmed body and the filled head — arc-length trimming lands
  // short of the tangent-aligned base. Euclidean tuck keeps the stub inside.
  const el: PathElement = { type: "path", id: "hook", x: 0, y: 0, width: 120, height: 60, rotation: 0, d: "", fill: "none", stroke: "#000", strokeWidth: 4, closed: false, arrowEnd: true, nodes: [N(0, 0), N(120, 60, { hIn: { dx: -60, dy: -60 } })] };
  el.d = nodesToPath(el.nodes!, false);
  const pr = pathRender(el);
  const head = arrowHeadLen(4, undefined, 999, 1); // long path → unclamped head
  const m = pr.d.trim().match(/(-?[\d.]+) (-?[\d.]+)$/);
  const gap = m ? Math.hypot(Number(m[1]) - 120, Number(m[2]) - 60) : Infinity;
  assert(gap <= head * 0.72 && gap > 0, `curved end: stub ends INSIDE the head, no gap (dist ${gap.toFixed(2)} vs head ${head})`);
}
{
  const vee = pathRender({ ...p1, arrowStyle: "vee" });
  assert(vee.vees.length === 1 && vee.d === p1.d, "vee style: legs drawn, body NOT trimmed");
}
{
  const both = pathRender({ ...p1, arrowStart: true });
  assert(both.polys.length === 2, "start + end arrows");
  assert(near(both.polys[1][0][0], 0) && near(both.polys[1][0][1], 0), "start tip sits on the path start");
}
assert(pathRender({ ...p1, closed: true }).polys.length === 0, "closed path: arrows ignored");
assert(pathRender({ ...p1, arrowEnd: false }).d === p1.d, "no arrows → model d passes through untouched");
{
  // curved end: tangent follows the last segment's true direction
  const el: PathElement = { type: "path", id: "pc", x: 0, y: 0, width: 100, height: 60, rotation: 0, d: "", fill: "none", stroke: "#000", strokeWidth: 2, closed: false, arrowEnd: true, nodes: [N(0, 0), N(100, 60, { hIn: { dx: 0, dy: -40 } })] };
  el.d = nodesToPath(el.nodes!, false);
  const pr = pathRender(el);
  const tip = pr.polys[0][0];
  const base = pr.polys[0][1];
  // incoming direction at the end is straight down (+y): the head must point down
  assert(near(tip[0], 100) && near(tip[1], 60), "curved path: tip on endpoint");
  assert(base[1] < tip[1], "curved path: head oriented along the end tangent (downward approach)");
}

// --- 3. TRUE curve extents ---------------------------------------------------
{
  // symmetric bulge: handles reach y=-100 but the curve only reaches y=-75
  const nodes = [N(0, 0, { hOut: { dx: 0, dy: -100 } }), N(100, 0, { hIn: { dx: 0, dy: -100 } })];
  const ext = nodesExtent(nodes);
  assert(near(ext.y, -75) && near(ext.h, 75), `extents use curve extrema, not handles (y=${ext.y.toFixed(2)})`);
  assert(near(ext.x, 0) && near(ext.w, 100), "x extents from endpoints");
}
{
  // unclosed: an unpainted wrap segment must NOT count; closed: it must
  const nodes = [N(0, 0, { hIn: { dx: -50, dy: 0 } }), N(100, 0), N(50, 80)];
  const open = nodesExtent(nodes, false);
  const closed = nodesExtent(nodes, true);
  assert(near(open.x, 0), "open path: first node's hIn (unrendered) ignored");
  assert(closed.x < -5, "closed path: wrap segment's curve included");
}
{
  const el: PathElement = { type: "path", id: "pr", x: 10, y: 10, width: 1, height: 1, rotation: 0, d: "", fill: "none", stroke: "#000", strokeWidth: 2, closed: false, nodes: [N(0, 0, { hOut: { dx: 0, dy: -100 } }), N(100, 0, { hIn: { dx: 0, dy: -100 } })] };
  refitPath(el);
  assert(near(el.height, 75) && near(el.y, 10 - 75), `refitPath: bbox hugs the curve (h=${el.height.toFixed(2)})`);
}

// --- 4. segment math ----------------------------------------------------------
{
  const s = segsFromNodes([N(0, 0, { hOut: { dx: 30, dy: 0 } }), N(90, 60, { hIn: { dx: -30, dy: 0 } })], false)[0];
  const [a, b] = splitSeg(s, 0.3);
  assert(near(segLength(a, 64) + segLength(b, 64), segLength(s, 64), 0.5), "splitSeg preserves arc length");
  const p = segPoint(s, 0.3);
  assert(near(a.x3, p.x) && near(a.y3, p.y), "split point = segPoint(t)");
  const nt = nearestTOnSeg(s, p.x, p.y);
  assert(near(nt.t, 0.3, 0.02) && nt.dist < 0.5, "nearestTOnSeg finds the parameter");
  const tg = segTangent(s, 0);
  assert(near(tg.x, 1) && near(tg.y, 0), "tangent at t=0 follows the outgoing handle");
}

// --- 5. bend core --------------------------------------------------------------
{
  const nodes = [N(0, 0), N(100, 0), N(200, 0)];
  const bent = bendSegment(nodes, 0, false, 0.5, 0, 40);
  assert(bent[0].hOut && bent[1].hIn, "straight segment sprouted handles");
  const s = segsFromNodes(bent, false)[0];
  const mid = segPoint(s, 0.5);
  assert(near(mid.x, 50) && near(mid.y, 40), `bend pulls the curve THROUGH the drag point (mid=${mid.x.toFixed(1)},${mid.y.toFixed(1)})`);
  assert(bent[0].type === "corner" && bent[1].type === "corner", "bent nodes become corner (independent tangents)");
  assert(!bent[2].hIn && nodes[0].hOut === undefined, "other nodes untouched; input not mutated");
}
{
  // closed wrap segment: bending the last segment reaches node 0
  const nodes = [N(0, 0), N(100, 0), N(50, 80)];
  const bent = bendSegment(nodes, 2, true, 0.5, 10, 0);
  assert(bent[2].hOut && bent[0].hIn, "closed wrap bend targets last.hOut + first.hIn");
}
{
  // t clamped away from the ends (no handle explosion)
  const nodes = [N(0, 0), N(100, 0)];
  const bent = bendSegment(nodes, 0, false, 0.02, 0, 10);
  const mag = Math.hypot(bent[0].hOut!.dx - 100 / 3, bent[0].hOut!.dy);
  assert(mag < 60, "extreme-t bend stays bounded (clamped to 0.15)");
}

console.log(fails === 0 ? "\nPRIMITIVES CORE ALL PASS" : `\nPRIMITIVES CORE ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
