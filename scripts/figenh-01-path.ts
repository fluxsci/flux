#!/usr/bin/env -S npx tsx
// Feature 1 — pure vector-path core: nodesToPath/pathToNodes round-trip, Shift
// constrain, scaleNodes, refitPath, the resizeRemap path FIX (nodes + legacy d),
// and ops.addPath/updatePath.
import { nodesToPath, pathToNodes, scaleNodes, refitPath, constrain45, nodesExtent } from "../src/lib/path";
import { resizeRemap } from "../src/lib/editing";
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

console.log(fails === 0 ? "\nF1 PATH-CORE ALL PASS" : `\nF1 PATH-CORE ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
