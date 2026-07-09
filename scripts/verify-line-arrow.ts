#!/usr/bin/env -S npx tsx
// figure-v1: the line/arrow rendering contract — the arrowhead TIP sits exactly
// on the model endpoint, the visible stroke is pulled back to a filled head's
// base (no stroke poking through the tip — the "arrows look terrible" bug),
// V-style heads keep the full-length line, heads shrink to fit short lines,
// round caps are the default, and SVG export mirrors the same geometry.
// Run: npx tsx scripts/verify-line-arrow.ts
import { lineRender } from "../src/lib/geometry";
import { elementToSvg } from "../src/lib/export";
import type { LineElement } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const mk = (over: Partial<LineElement> = {}): LineElement => ({
  type: "line",
  id: "l1",
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 0,
  stroke: "#222222",
  strokeWidth: 2,
  arrowStart: false,
  arrowEnd: true,
  ...over,
});

// 1. filled head (the default): tip exactly at the endpoint, stroke pulled back.
let r = lineRender(mk());
assert(r.polys.length === 1 && r.vees.length === 0, "default arrowhead is one filled triangle");
assert(r.polys[0][0][0] === 100 && r.polys[0][0][1] === 0, "tip sits EXACTLY at (x2,y2)");
assert(near(r.x2, 92), `visible stroke pulled back to the head base (got x2=${r.x2}, head=8)`);
assert(r.x1 === 0 && r.y1 === 0, "un-arrowed end untouched");
assert(r.cap === "round", "round cap is the default");
const halfW = Math.abs(r.polys[0][1][1]);
assert(halfW > 1 && near(r.polys[0][1][1], -r.polys[0][2][1]), "triangle symmetric about the line");
assert(halfW >= 2 / 2, "head base wider than the stroke cap (cap hides inside the head)");

// 2. V-style head: full-length line, symmetric legs meeting at the tip.
r = lineRender(mk({ arrowStyle: "vee" }));
assert(r.vees.length === 1 && r.polys.length === 0, "vee emits a chevron, no polygon");
assert(r.x2 === 100, "vee keeps the full-length line (stroke reaches the tip)");
const [legA, tip, legB] = r.vees[0];
assert(tip[0] === 100 && tip[1] === 0, "vee tip at the endpoint");
assert(near(legA[0], legB[0]) && near(legA[1], -legB[1]), "legs symmetric about the line");
assert(legA[0] < 100, "legs sweep back from the tip");

// 3. both heads on a short line: heads shrink so the arrow never inverts.
r = lineRender(mk({ x2: 10, arrowStart: true, arrowEnd: true }));
assert(r.polys.length === 2, "double-headed arrow");
assert(r.x2 > r.x1, `visible stroke survives a short double-headed line (${r.x1}..${r.x2})`);
assert(r.polys[0][0][0] === 10 && r.polys[1][0][0] === 0, "both tips still exactly at the endpoints");

// 4. arrowSize scales the head (multiples of stroke width).
r = lineRender(mk({ arrowSize: 8 }));
assert(near(r.x2, 100 - 16), "arrowSize×strokeWidth head length (8×2=16)");

// 5. explicit cap styles are honored.
assert(lineRender(mk({ cap: "butt" })).cap === "butt", "explicit flat cap");
assert(lineRender(mk({ cap: "square" })).cap === "square", "explicit square cap");

// 6. diagonal line: tip exact, pull-back measured along the line.
r = lineRender(mk({ x2: 30, y2: 40 })); // length 50
assert(r.polys[0][0][0] === 30 && r.polys[0][0][1] === 40, "diagonal tip exact");
assert(near(Math.hypot(30 - r.x2, 40 - r.y2), 8), "pull-back = head length along the line");

// 7. export markup mirrors the shared geometry (canvas ↔ SVG parity).
let svg = elementToSvg(mk({ x: 5, y: 7 }));
assert(svg.includes('x2="97"'), "export line uses the pulled-back endpoint (+x offset)");
assert(svg.includes("100,7") || svg.includes("105,7"), "export polygon tip at the model endpoint");
assert(svg.includes('stroke-linecap="round"'), "export default round cap");
svg = elementToSvg(mk({ arrowStyle: "vee", cap: "butt" }));
assert(svg.includes("<polyline") && svg.includes('fill="none"'), "export vee is a stroked polyline");
assert(svg.includes('x2="100"') && svg.includes('stroke-linecap="butt"'), "export vee keeps full line + explicit cap");
assert(!svg.includes("<polygon"), "no polygon for vee heads");

console.log("\nALL LINE/ARROW TESTS PASSED");
