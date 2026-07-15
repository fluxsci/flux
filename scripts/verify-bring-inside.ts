#!/usr/bin/env -S npx tsx
// bring_inside (Ctrl+Shift+I) — pure op + headless verb:
//  - minimal translation clamps each unit's bbox inside the figure frame;
//  - NOTHING is ever resized (width/height/endpoints byte-identical);
//  - oversized elements are positioned to fully COVER the frame instead;
//  - rotation-aware (the ROTATED AABB is what must land inside);
//  - line elements clamp by their endpoint bbox;
//  - groups move rigidly as one unit (and a single member id expands);
//  - loose elements clamp independently (overlap allowed);
//  - idempotent (a second run moves nothing);
//  - the flux-core verb round-trips through a real on-disk project.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ops from "../src/lib/ops";
import { rotatedAABB, elementBBox } from "../src/lib/geometry";
import type { Project, RectElement, LineElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 1e-9) => Math.abs(a - b) <= t;

// 200×150 frame; elements are figure-local.
const proj = (): Project => ({
  version: 2,
  name: "t",
  canvases: [{ id: "c1", name: "C1" }],
  figures: [
    { id: "f1", name: "F1", canvasId: "c1", x: 0, y: 0, width: 200, height: 150, background: "#fff", elements: [] },
  ],
  assets: [],
  palette: [],
});
const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<RectElement> = {}): RectElement => ({
  type: "rect", id, x, y, width: w, height: h, rotation: 0,
  fill: "#000", stroke: "none", strokeWidth: 0, cornerRadius: 0, ...extra,
});
const inside = (b: { x: number; y: number; w: number; h: number }, W = 200, H = 150) =>
  b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= W + 1e-9 && b.y + b.h <= H + 1e-9;

// ---- 1. basic clamps: fully outside, partially outside, already inside ------
{
  const p = proj();
  const f = p.figures[0];
  f.elements.push(
    rect("off-right", 500, 40, 80, 60), // fully off to the right
    rect("off-topleft", -30, -20, 50, 40), // spills over the top-left corner
    rect("in", 10, 10, 50, 40), // already compliant
  );
  ops.bringInside(p, "f1");
  const [a, b, c] = f.elements as RectElement[];
  assert(a.x === 120 && a.y === 40, `fully-outside element clamped to the near inside edge (got ${a.x},${a.y})`);
  assert(b.x === 0 && b.y === 0, `partial overflow clamps to 0,0 (got ${b.x},${b.y})`);
  assert(c.x === 10 && c.y === 10, "an already-inside element does not move");
  for (const e of f.elements) assert(e.width === (e.id === "off-right" ? 80 : 50) && inside(elementBBox(e)), `${e.id}: inside, width untouched`);

  // idempotence: a second run moves nothing
  const snap = JSON.stringify(f.elements);
  ops.bringInside(p, "f1");
  assert(JSON.stringify(f.elements) === snap, "second run is a byte-identical no-op (idempotent)");
}

// ---- 2. oversized element → positioned to fully cover the frame -------------
{
  const p = proj();
  const f = p.figures[0];
  f.elements.push(
    rect("big-off", 500, 400, 300, 250), // larger than the frame on both axes, fully outside
    rect("big-cover", -50, -50, 300, 250), // larger AND already covering — must not move
  );
  ops.bringInside(p, "f1");
  const [a, b] = f.elements as RectElement[];
  assert(a.x === 0 && a.y === 0, `oversized element clamps to the near covering bound (got ${a.x},${a.y})`);
  assert(a.width === 300 && a.height === 250, "oversized element is NOT resized");
  assert(a.x <= 0 && a.x + a.width >= 200 && a.y <= 0 && a.y + a.height >= 150, "…and fully covers the frame");
  assert(b.x === -50 && b.y === -50, "an oversized element already covering the frame does not move");
}

// ---- 3. rotation-aware: the ROTATED AABB is what lands inside ---------------
{
  const p = proj();
  const f = p.figures[0];
  f.elements.push(rect("rot", 300, 0, 100, 20, { rotation: 90 }));
  ops.bringInside(p, "f1");
  const e = f.elements[0] as RectElement;
  const r = rotatedAABB(e);
  assert(inside(r), `rotated element's ROTATED AABB is inside (${r.x},${r.y} ${r.w}×${r.h})`);
  assert(near(e.x, 140) && near(e.y, 40), `unrotated origin compensates for the rotation (got ${e.x},${e.y})`);
  assert(e.width === 100 && e.height === 20 && e.rotation === 90, "size + rotation untouched");
}

// ---- 4. line element: endpoint bbox clamps; endpoints never rewritten -------
{
  const p = proj();
  const f = p.figures[0];
  const line: LineElement = {
    type: "line", id: "ln", x: 500, y: 50, width: 0, height: 0, rotation: 0,
    x1: 0, y1: 0, x2: 50, y2: 30, stroke: "#000", strokeWidth: 1, arrowStart: false, arrowEnd: false,
  };
  f.elements.push(line);
  ops.bringInside(p, "f1");
  assert(line.x === 150 && line.y === 50, `line clamps by its endpoint bbox (got ${line.x},${line.y})`);
  assert(line.x1 === 0 && line.y1 === 0 && line.x2 === 50 && line.y2 === 30, "endpoints untouched");
}

// ---- 5. groups move rigidly; a single member id expands to the unit ---------
{
  const p = proj();
  const f = p.figures[0];
  f.groups = { g1: { id: "g1", name: "G" } };
  f.elements.push(
    rect("m1", 250, 10, 40, 30, { groupId: "g1" }),
    rect("m2", 310, 60, 40, 30, { groupId: "g1" }), // union bbox: x 250..350, y 10..90
    rect("loose", 400, 200, 20, 20),
  );
  ops.bringInside(p, "f1", ["m1", "loose"]); // one member + one loose id
  const [m1, m2, loose] = f.elements as RectElement[];
  assert(m1.x === 100 && m2.x === 160, `group translated rigidly (m1 ${m1.x}, m2 ${m2.x})`);
  assert(m2.x - m1.x === 60 && m2.y - m1.y === 50, "members keep their relative offset");
  assert(m1.y === 10 && m2.y === 60, "group already inside vertically — no y move");
  assert(loose.x === 180 && loose.y === 130, `loose element clamps independently (got ${loose.x},${loose.y})`);
}

// ---- 6. omitted ids = all elements; missing figure is a no-op ---------------
{
  const p = proj();
  const f = p.figures[0];
  f.elements.push(rect("a", -500, -500, 10, 10), rect("b", 900, 900, 10, 10));
  ops.bringInside(p, "f1");
  assert(f.elements.every((e) => inside(elementBBox(e))), "ids omitted → every element brought inside");
  ops.bringInside(p, "nope"); // must not throw
  assert(true, "unknown figure id is a silent no-op");
}

// ---- 7. the flux-core verb, end to end on a real project --------------------
const core = await import("../flux-core/index");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bring-inside-"));
try {
  await core.scaffold(root, { title: "BringInside" });
  const { figureId } = await core.createFigure(root, { id: "bi", width: 200, height: 150 });
  const { id: tid } = await core.addFigText(root, figureId, { text: "way out", x: 900, y: 700, width: 120, height: 20 });
  await core.bringInside(root, figureId);
  const { project: p2 } = await core.loadFigModel(root);
  const el = p2.figures.find((f) => f.id === figureId)!.elements.find((e) => e.id === tid)!;
  assert(el.x + el.width <= 200 && el.y + el.height <= 150 && el.x >= 0 && el.y >= 0,
    `verb round-trip: element persisted inside the frame (${el.x},${el.y} ${el.width}×${el.height})`);
  assert(el.width === 120, "verb round-trip: width untouched");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nVERIFY-BRING-INSIDE ALL PASS" : `\nVERIFY-BRING-INSIDE ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
