// FIG-4 slice gate (V1 readiness 1.5) — rotation-aware bounds: rotatedCorners /
// rotatedAABB / rectIntersectsElement + the selectionBBox change to hug rotated
// members. Pure geometry. Run: npx tsx scripts/verify-fig-rotbounds.ts
import {
  elementBBox,
  rotatedCorners,
  rotatedAABB,
  rectIntersectsElement,
  selectionBBox,
} from "../src/lib/geometry";
import type { Element } from "../src/lib/types";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol;

const rect = (over: Partial<Element> = {}): Element =>
  ({ type: "rect", id: "r1", x: 100, y: 100, width: 100, height: 100, rotation: 0, fill: "#000", stroke: "", strokeWidth: 0, cornerRadius: 0, ...over }) as Element;

// --- unrotated: everything degenerates to the plain bbox ------------------------------
{
  const e = rect();
  ok(JSON.stringify(rotatedAABB(e)) === JSON.stringify(elementBBox(e)), "rotation 0 → rotatedAABB === elementBBox (fast path)");
  ok(rectIntersectsElement({ x: 150, y: 150, w: 10, h: 10 }, e), "rotation 0: rect inside → intersects");
  ok(!rectIntersectsElement({ x: 300, y: 300, w: 10, h: 10 }, e), "rotation 0: rect away → no intersect");
}

// --- 90°: same square footprint ---------------------------------------------------------
{
  const e = rect({ rotation: 90 });
  const b = rotatedAABB(e);
  ok(near(b.x, 100) && near(b.y, 100) && near(b.w, 100) && near(b.h, 100), "90° square: AABB unchanged", JSON.stringify(b));
}

// --- 45°: the AABB grows by √2; corners land on the diamond points ----------------------
{
  const e = rect({ rotation: 45 });
  const b = rotatedAABB(e);
  const s = 100 * Math.SQRT2;
  ok(near(b.w, s, 0.01) && near(b.h, s, 0.01), `45° square: AABB is √2 wider (${b.w.toFixed(2)})`);
  ok(near(b.x, 150 - s / 2, 0.01) && near(b.y, 150 - s / 2, 0.01), "45°: AABB centered on the same centre");
  const cs = rotatedCorners(e);
  ok(cs.some((p) => near(p.x, 150, 0.01) && near(p.y, 150 - s / 2, 0.01)), "a corner lands on the top diamond point");
}

// --- the marquee case FIG-4 exists for: the empty AABB corner of a diamond --------------
{
  const e = rect({ rotation: 45 });
  // A small rect in the AABB's top-left corner region — overlaps the AABB, NOT the diamond.
  const cornerProbe = { x: 100 - 15, y: 100 - 15, w: 24, h: 24 };
  ok(!rectIntersectsElement(cornerProbe, e), "AABB-corner probe misses the rotated shape (old code selected it)");
  // Crossing the diamond's edge → hit.
  ok(rectIntersectsElement({ x: 140, y: 80, w: 20, h: 30 }, e), "probe crossing the diamond edge hits");
  ok(rectIntersectsElement({ x: 0, y: 0, w: 600, h: 600 }, e), "enclosing marquee hits");
  ok(rectIntersectsElement({ x: 145, y: 145, w: 10, h: 10 }, e), "probe fully inside the shape hits");
}

// --- rotated line: pivot is the endpoints' bbox centre (FIG-2 semantics) -----------------
{
  const line = { type: "line", id: "l1", x: 0, y: 0, x1: 100, y1: 100, x2: 300, y2: 100, rotation: 90, stroke: "#000", strokeWidth: 2 } as unknown as Element;
  const b = rotatedAABB(line);
  ok(near(b.x, 200, 0.01) && near(b.w, 0, 0.01) && near(b.y, 0, 0.01) && near(b.h, 200, 0.01), "90° line: horizontal → vertical about its centre", JSON.stringify(b));
}

// --- selectionBBox hugs rotated members ---------------------------------------------------
{
  const a = rect();
  const b = rect({ id: "r2", x: 300, y: 100, rotation: 45 });
  const box = selectionBBox([a, b])!;
  const s = 100 * Math.SQRT2;
  ok(near(box.x, 100) && near(box.x + box.w, 350 + s / 2, 0.01), `selection box extends to the rotated member's true right edge (${(box.x + box.w).toFixed(2)})`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
