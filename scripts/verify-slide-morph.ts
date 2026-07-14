#!/usr/bin/env -S npx tsx
// P3 — the data-space morph (§5.4). Verify the projection math purely (a datum
// interpolates in DATA space then projects through the blended anchor tables,
// incl. AXIS RESCALE and LOG axes), then drive a live morph over a linkedom SVG
// and assert the line path `d` + point markers rewrite from A→B.
// Run: npx tsx scripts/verify-slide-morph.ts
import { parseHTML } from "linkedom";
import { morphSeriesPixels, createMorph } from "../src/lib/slide/player/morph";
import type { FluxPlotManifest, FluxPlotAxis } from "../src/lib/plot/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// A linear axis: data domain → svg px via 2 anchors (y-flip baked in).
const ax = (dom: [number, number], svg: [number, number], scale = "linear"): FluxPlotAxis => ({
  scale, domain: dom, anchors: [{ data: dom[0], svg: svg[0] }, { data: dom[1], svg: svg[1] }],
});

// State A: a 4-point line, y rising. State B: y reversed (a clear morph).
const xs = [1, 2, 3, 4];
const yA = [2, 4, 6, 8], yB = [8, 6, 4, 2];
const mk = (ys: number[], yAxis: FluxPlotAxis): FluxPlotManifest => ({
  spec: "fluxplot", schemaVersion: "1", plotType: "line", svg: "", size: { width: 480, height: 400, unit: "px" },
  axes: [{ x: ax([0, 5], [40, 440]), y: yAxis }],
  series: [{
    id: "ctrl", svg: { line: "ctrl.line", points: "ctrl.pts" },
    points: xs.map((x, i) => ({ index: i, svgId: `ctrl.p${i}`, x, y: ys[i] })),
  }],
});
const yAxisSame = ax([0, 10], [380, 20]); // data 0→bottom(380), 10→top(20)
const A = mk(yA, yAxisSame);
const B = mk(yB, yAxisSame);

// --- pure projection: endpoints + midpoint ---------------------------------
const proj = (m: FluxPlotManifest) => m.axes[0];
const at = (t: number) => morphSeriesPixels(A.series[0], B.series[0], proj(A), proj(B), t);
// y-fit (same axis): svg = 380 - 36*data. point0 y: 2→8.
assert(near(at(0)[0].y, 380 - 36 * 2), "t=0 point0 at A's pixel (y data 2)");
assert(near(at(1)[0].y, 380 - 36 * 8), "t=1 point0 at B's pixel (y data 8)");
assert(near(at(0.5)[0].y, 380 - 36 * 5), "t=0.5 point0 interpolates in data space (y=5)");
// x is unchanged A=B, so x pixels constant across t
assert(near(at(0)[0].x, at(1)[0].x) && near(at(0)[0].x, 40 + ((440 - 40) / 5) * 1), "x pixel stable (x data 1)");

// --- AXIS RESCALE: B's y-axis zooms to [0,8] over the same pixel span -------
const B2 = mk(yB, ax([0, 8], [380, 20])); // m = (20-380)/8 = -45
const at2 = (t: number) => morphSeriesPixels(A.series[0], B2.series[0], proj(A), proj(B2), t);
assert(near(at2(0)[0].y, 380 - 36 * 2), "rescale t=0 uses A's fit");
assert(near(at2(1)[0].y, 380 - 45 * 8), "rescale t=1 uses B's (steeper) fit → data 8 at top");
// midpoint blends BOTH the datum and the fit → between the two projections
const blendMid = at2(0.5)[0].y;
assert(blendMid > 380 - 45 * 8 && blendMid < 380 - 36 * 2, "rescale t=0.5 blends datum + axis fit");

// --- LOG axis interpolates in log space ------------------------------------
const Alog = mk([1, 10, 100, 1000], ax([1, 1000], [380, 20], "log"));
const Blog = mk([1000, 100, 10, 1], ax([1, 1000], [380, 20], "log"));
const atl = morphSeriesPixels(Alog.series[0], Blog.series[0], proj(Alog), proj(Blog), 0.5);
// point0: 1 → 1000, geometric mean = ~31.6; log fit maps it to mid pixel ≈ 200
assert(near(atl[0].y, 200, 3), "log axis: t=0.5 lands at the geometric-mean pixel");

// --- live DOM morph (linkedom) ---------------------------------------------
const { document } = parseHTML("<!doctype html><html><body></body></html>");
const wrap = document.createElement("div");
const circles = xs.map((_, i) => `<circle id="p1__ctrl.p${i}" cx="0" cy="0" r="3"/>`).join("");
wrap.innerHTML = `<svg><path id="p1__ctrl.line" d="M0 0"/>${circles}</svg>`;
const m = createMorph(wrap as unknown as ParentNode, "p1", A, B);

m.seek(0);
const d0 = wrap.querySelector('[id="p1__ctrl.line"]')!.getAttribute("d")!;
const cy0 = +wrap.querySelector('[id="p1__ctrl.p0"]')!.getAttribute("cy")!;
assert(d0.startsWith("M") && d0.includes("L"), "seek(0): line path rebuilt as M..L.. polyline");
assert(near(cy0, 380 - 36 * 2), "seek(0): point0 circle at A position");

m.seek(1);
const cy1 = +wrap.querySelector('[id="p1__ctrl.p0"]')!.getAttribute("cy")!;
assert(near(cy1, 380 - 36 * 8), "seek(1): point0 circle moved to B position");
const d1 = wrap.querySelector('[id="p1__ctrl.line"]')!.getAttribute("d")!;
assert(d0 !== d1, "seek(1): line path changed from A→B");

// --- GROUP-WRAPPED line (the real fluxplot structure) ----------------------
// fluxplot emits the series line as <g id="…ctrl.line"><path/></g> (a group,
// esp. when the line carries markers). The morph must rewrite the CHILD path's
// `d`, not set `d` on the <g> (a silent no-op that froze the line at A).
const wrapG = document.createElement("div");
wrapG.innerHTML = `<svg><g id="p1__ctrl.line"><path d="M0 0"/></g>${circles}</svg>`;
const mg = createMorph(wrapG as unknown as ParentNode, "p1", A, B);
mg.seek(0);
const gd0 = wrapG.querySelector('[id="p1__ctrl.line"] path')!.getAttribute("d")!;
mg.seek(1);
const gd1 = wrapG.querySelector('[id="p1__ctrl.line"] path')!.getAttribute("d")!;
assert(gd0.startsWith("M") && gd0.includes("L"), "group-line seek(0): child path rebuilt (not the <g>)");
assert(gd0 !== gd1, "group-line seek(1): child path d changed A→B (regression: <g>-wrapped line morph)");

console.log("\nALL SLIDE-MORPH (P3) MATH TESTS PASSED");
