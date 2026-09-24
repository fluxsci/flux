// Transforms, way three — BECOME between drawn kinds: the outline morph core
// (src/lib/slide/outline.ts) and its tween integration. Pure: outlines per
// kind, boundary-preserving splitting, ring/stroke correspondence (cut vs
// inflate), the retype law in applyState/diffState, lerpElement across kinds
// (exact endpoints, a synthetic path mid-flight), contentPlan's mode choice,
// and determinism. Run: node --import tsx scripts/verify-slide-outline.ts
import { harness } from "./lib/harness.mjs";
import {
  elementOutline, splitOutline, planOutlines, planElementMorph, sampleElementMorph, outlineMorphable,
  arrowFade, fixedHeadOpacity, arcT,
} from "../src/lib/slide/outline";
import { applyState, diffState, lerpElement, contentPlan, transformEndState } from "../src/lib/slide/tween";
import { elementBBox } from "../src/lib/geometry";
import { segLength, splitSeg, type PathSeg } from "../src/lib/path";
import type { Element, RectElement, EllipseElement, LineElement, PathElement, TextElement, VectorNode } from "../src/lib/types";

const h = harness("verify-slide-outline");
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const finite = (nodes: VectorNode[]) => nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && (!n.hIn || (Number.isFinite(n.hIn.dx) && Number.isFinite(n.hIn.dy))) && (!n.hOut || (Number.isFinite(n.hOut.dx) && Number.isFinite(n.hOut.dy))));

const rect = (o: Partial<RectElement> = {}): RectElement => ({ type: "rect", id: "el", x: 10, y: 20, width: 200, height: 100, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0, ...o });
const ellipse = (o: Partial<EllipseElement> = {}): EllipseElement => ({ type: "ellipse", id: "el", x: 300, y: 40, width: 120, height: 120, rotation: 0, fill: "#d14d41", stroke: "#000000", strokeWidth: 2, ...o });
const line = (o: Partial<LineElement> = {}): LineElement => ({ type: "line", id: "el", x: 50, y: 50, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 180, y2: 0, stroke: "#222222", strokeWidth: 3, arrowStart: false, arrowEnd: true, ...o });
const boxWH = (e: Element): [number, number] => {
  const b = elementBBox({ ...e, rotation: 0 });
  return [b.w || 1e-9, b.h || 1e-9];
};
const arc = (o: Partial<PathElement> = {}): PathElement => ({ type: "path", id: "el", x: 0, y: 0, width: 100, height: 60, rotation: 0, d: "", fill: "none", stroke: "#00aa00", strokeWidth: 2, closed: false,
  nodes: [{ x: 0, y: 60, type: "corner" }, { x: 50, y: 0, type: "smooth", hIn: { dx: -20, dy: 0 }, hOut: { dx: 20, dy: 0 } }, { x: 100, y: 60, type: "corner" }], ...o });
const text = (o: Partial<TextElement> = {}): TextElement => ({ type: "text", id: "el", x: 0, y: 0, width: 200, height: 40, rotation: 0, text: "hello", fontFamily: "Arial", fontSize: 16, fontWeight: 400, fontStyle: "normal", align: "left", color: "#ffffff", sizing: "auto", ...o });

h.section("outlines per kind");
{
  const r = elementOutline(rect())!;
  h.eq(r.nodes.map((n) => [n.x, n.y]), [[0, 0], [200, 0], [200, 100], [0, 100]], "a rect's outline is its four corners, closed, in box-local px");
  h.ok(r.closed, "rect outline is a ring");
  const rr = elementOutline(rect({ cornerRadius: 20 }))!;
  h.ok(rr.nodes.length === 8 && rr.nodes.some((n) => n.hOut || n.hIn), "corner radius fillets the rect outline (8 nodes with arc handles)");
  const e = elementOutline(ellipse())!;
  h.ok(e.closed && e.nodes.length === 4 && e.nodes.every((n) => n.hIn && n.hOut), "an ellipse is four smooth bezier nodes");
  h.ok(near(e.nodes[0].x, 120) && near(e.nodes[0].y, 60) && near(e.nodes[1].hIn!.dx, 60 * 0.5522847498, 1e-6), "ellipse handles use the cubic circle constant");
  const l = elementOutline(line({ x1: 50, y1: 10, x2: 0, y2: 0 }))!;
  h.eq(l.nodes.map((n) => [n.x, n.y]), [[50, 10], [0, 0]], "a line's outline is expressed relative to its ENDPOINT box (the wrapper's corner)");
  h.ok(!l.closed, "line outline is open");
  const p = elementOutline(arc())!;
  h.ok(!p.closed && p.nodes.length === 3 && !!p.nodes[1].hIn, "a path's outline is its own nodes, handles kept");
  const flipped = elementOutline(rect({ flipX: true, cornerRadius: 0 }))!;
  h.eq(flipped.nodes.map((n) => [n.x, n.y]), [[200, 0], [0, 0], [0, 100], [200, 100]], "flips are baked into the outline (mirror about the box)");
  h.ok(elementOutline(text()) === null, "text has no outline");
  h.ok(elementOutline(arc({ nodes: [{ x: 1, y: 1, type: "corner" }] })) === null, "a one-node path is degenerate (no outline)");
}

h.section("splitting keeps every boundary");
{
  const r = elementOutline(rect())!;
  const split = splitOutline(r, [0.125, 0.5, 0.5, 0.1250001]);
  h.eq(split.map((n) => [Math.round(n.x), Math.round(n.y)]), [[0, 0], [75, 0], [200, 0], [200, 100], [0, 100]], "stations cut the rect where asked, corners survive, near-duplicates merge");
  const e = elementOutline(ellipse())!;
  const es = splitOutline(e, Array.from({ length: 16 }, (_, i) => i / 16));
  h.ok(es.length === 16 && es.every((n) => n.hIn && n.hOut), "a resampled ellipse stays a smooth bezier ring (handles on every node)");
  const radius = es.map((n) => Math.hypot(n.x - 60, n.y - 60));
  h.ok(radius.every((v) => near(v, 60, 0.05)), "de Casteljau cuts keep the curve (every split node still sits on the circle)");
}

h.section("correspondence");
{
  const a = elementOutline(rect())!, b = elementOutline(ellipse())!;
  const plan = planOutlines(a, 200, 100, b, 120, 120);
  h.ok(plan.a.length === plan.b.length && plan.a.length >= 32 && plan.closed, `rect↔ellipse: equal node counts (${plan.a.length}), closed`);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  h.ok(corners.every(([u, v]) => plan.a.some((n) => near(n.x, u) && near(n.y, v))), "every rect corner is a node of the aligned rect chain (unit frame)");
  const same = planOutlines(b, 120, 120, elementOutline(ellipse({ id: "z" }))!, 120, 120);
  const drift = Math.max(...same.a.map((n, i) => Math.hypot(n.x - same.b[i].x, n.y - same.b[i].y)));
  h.ok(drift < 1e-6, `a ring morphing into itself has no seam drift (max ${drift.toExponential(2)})`);
  const cut = planOutlines(elementOutline(ellipse({ fill: "none" }))!, 120, 120, elementOutline(line())!, 180, 1e-9, "cut");
  h.ok(!cut.closed && cut.a.length === cut.b.length, "stroke-only ring ↔ stroke: the ring is CUT open (open intermediate, equal counts)");
  h.ok(near(cut.a[0].x, cut.a[cut.a.length - 1].x) && near(cut.a[0].y, cut.a[cut.a.length - 1].y), "the opened ring starts and ends at the cut point");
  const inflate = planOutlines(elementOutline(line())!, 180, 1e-9, elementOutline(ellipse())!, 120, 120, "inflate");
  h.ok(inflate.closed && inflate.a.length === inflate.b.length, "stroke ↔ filled ring: the stroke INFLATES (closed intermediate, equal counts)");
  const ys = inflate.a.map((n) => n.y);
  h.ok(ys.every((y) => near(y, 0)), "the inflated stroke is a zero-area ring along the line");
  const open = planOutlines(elementOutline(arc())!, 100, 60, elementOutline(line())!, 180, 1e-9);
  h.ok(!open.closed && open.a.length === open.b.length, "stroke ↔ stroke: open, equal counts");
}

h.section("element morph plan + sampler");
{
  const plan = planElementMorph(line(), ellipse())!;
  h.ok(plan.strategy === "inflate" && plan.closed && plan.fixedHeads.length === 1 && plan.fixedHeads[0].side === "pre", "arrow → filled ellipse inflates and carries the arrowhead as a fixed fading head");
  h.ok(near(fixedHeadOpacity(plan.fixedHeads[0], 0), 1) && near(fixedHeadOpacity(plan.fixedHeads[0], 0.2), 0.5) && fixedHeadOpacity(plan.fixedHeads[0], 0.5) === 0, "a pre head melts away over the first 40%");
  const mid = sampleElementMorph(plan, 0.5);
  h.ok(mid.type === "path" && mid.id === "el" && mid.closed && finite(mid.nodes!), "mid-flight sample is a finite closed path with the element's identity");
  h.ok(near(mid.x, 175) && near(mid.y, 45) && near(mid.width, 150) && near(mid.height, 60), "box lerps between the endpoint boxes (line box → ellipse box)");
  h.ok(near(mid.strokeWidth, 2.5) && mid.fill.startsWith("#") && mid.fill.length === 9, "stroke width lerps; fill ramps in from the alpha-0 twin of the ellipse's fill");
  h.ok(!("arrowEnd" in mid) && !("flipX" in mid), "an inflating intermediate carries no arrow flags and no flips");
  const cutPlan = planElementMorph(ellipse({ fill: "none" }), line())!;
  h.ok(cutPlan.strategy === "cut" && !cutPlan.closed && cutPlan.arrowEnd && !cutPlan.fixedHeads.length, "stroke-only ellipse → arrow cuts open; the head rides the intermediate's end");
  h.ok(near(arrowFade(cutPlan, "end", 0.25), 0.25) && arrowFade(cutPlan, "start", 0.5) === 0, "an end-only head fades in with t; an absent head stays invisible");
  const cutMid = sampleElementMorph(cutPlan, 0.5);
  h.ok(cutMid.arrowEnd === true && cutMid.closed === false && cutMid.cap === "round", "the cut intermediate is an open round-capped path with the arrow flag");
  const spun = planElementMorph(rect({ rotation: 30 }), ellipse({ rotation: -30 }))!;
  h.ok(near(sampleElementMorph(spun, 0.5).rotation, 0), "rotation lerps along the shortest arc (30 → −30 passes 0)");
  const a = JSON.stringify(planElementMorph(rect(), ellipse())), b = JSON.stringify(planElementMorph(rect(), ellipse()));
  h.ok(a === b, "planning is deterministic");
}

h.section("tween integration: lerpElement across kinds");
{
  const pre = line(), end = ellipse();
  h.ok(outlineMorphable(pre, end) && !outlineMorphable(text(), end) && !outlineMorphable(rect(), rect({ x: 5 })), "outlineMorphable: drawn kinds across kinds only (same kind keeps the property tween)");
  h.ok(outlineMorphable(arc(), arc({ closed: true })), "a path changing closedness is an outline morph (no crossfade)");
  h.eq(lerpElement(pre, end, 0), pre, "t=0 returns the pre element verbatim");
  h.eq(lerpElement(pre, end, 1), end, "t=1 returns the end element verbatim");
  const mid = lerpElement(pre, end, 0.3) as PathElement;
  h.ok(mid.type === "path" && finite(mid.nodes!) && mid.d.startsWith("M"), "mid-flight lerpElement is the synthetic path");
  const tr = lerpElement(text(), rect(), 0.3), tr2 = lerpElement(text(), rect(), 0.7);
  h.ok(tr.type === "text" && tr2.type === "rect" && near(tr.x, 3) && near(tr2.width, 200), "kinds without an outline step content at t=.5 while the box tweens (the driver crossfades)");
  h.eq(contentPlan(rect(), ellipse()).mode, "morph", "contentPlan: rect→ellipse is a morph");
  h.eq(contentPlan(text(), rect()).mode, "crossfade", "contentPlan: text→rect crossfades");
  h.eq(contentPlan(arc(), arc({ closed: true })).mode, "morph", "contentPlan: open→closed path is a morph");
  h.eq(contentPlan(rect(), rect({ x: 40 })).mode, "tween", "contentPlan: same kind stays a tween");
  const pp = lerpElement(arc(), arc({ closed: true }), 0.5) as PathElement;
  h.ok(pp.type === "path" && finite(pp.nodes!), "closedness change samples a finite path mid-flight");
}

h.section("the plan answers without the correspondence");
{
  // Opening the animator builds every become transform, and each one asks its
  // plan whether the pair ends up a ring and whether it carries arrowheads.
  // Those answers must not drag in `planOutlines`, which dominates that cost.
  const pairs: [string, Element, Element][] = [
    ["rect -> ellipse", rect(), ellipse()],
    ["arrow -> filled ellipse (inflate)", line(), ellipse()],
    ["stroke-only ellipse -> arrow (cut)", ellipse({ fill: "none" }), line()],
    ["arc -> line (both open)", arc(), line()],
    ["open path -> closed path", arc(), arc({ closed: true })],
  ];
  for (const [what, pre, end] of pairs) {
    const plan = planElementMorph(pre, end)!;
    const [aw, ah] = boxWH(pre), [bw, bh] = boxWH(end);
    const truth = planOutlines(elementOutline(pre)!, aw, ah, elementOutline(end)!, bw, bh, plan.strategy);
    h.eq(plan.closed, truth.closed, what + ": the plan's own `closed` equals the correspondence's");
  }
  const plan = planElementMorph(rect(), ellipse())!;
  const own = (k: string) => Object.getOwnPropertyDescriptor(plan, k)!;
  h.ok(own("closed").get === undefined && own("arrowStart").get === undefined && own("arrowEnd").get === undefined,
    "closed / arrowStart / arrowEnd are plain values — reading them cannot build the correspondence");
  h.ok(typeof own("a").get === "function" && typeof own("b").get === "function",
    "the corresponded chains stay behind getters, so nothing pays for them until a frame is drawn");
  h.ok(plan.a.length === plan.b.length && plan.a.length >= 32, "...and asking for them still yields the matched chains");
}

h.section("the retype law: applyState / diffState");
{
  const pre = line({ name: "Arrow", groupId: "g1", locked: true, opacity: 0.8 });
  const end = ellipse({ name: "Blob" });
  const patch = diffState(pre, { ...end, id: pre.id, name: pre.name, groupId: pre.groupId, locked: true })!;
  h.ok(patch.type === "ellipse" && "fill" in patch && "stroke" in patch && "strokeWidth" in patch && !("x1" in patch), "diffState across kinds records `type` and the whole new kind, no nulls for the old kind's props");
  const out = applyState(pre, patch) as Record<string, unknown>;
  h.ok(out.type === "ellipse" && out.id === "el" && out.name === "Arrow" && out.groupId === "g1" && out.locked === true && !("opacity" in out), "applyState retypes: identity survives and destination defaults replace old base props");
  h.ok(!("x1" in out) && !("arrowEnd" in out) && out.fill === "#d14d41" && out.width === 120, "…and nothing of the old kind lingers");
  const rt = applyState(pre, diffState(pre, { ...end, id: "el", name: "Arrow", groupId: "g1", locked: true })!);
  h.eq(canon(rt), canon({ ...end, id: "el", name: "Arrow", groupId: "g1", locked: true }), "applyState(pre, diffState(pre, cur)) exactly equals destination including implicit opacity default");
  const bare = applyState(rect(), { type: "line" }) as LineElement;
  h.ok(bare.type === "line" && bare.x2 === 200 && bare.y2 === 100 && bare.stroke === "#000000" && bare.arrowEnd === false, "a bare {type} patch completes the new kind's required props");
  const same = applyState(rect(), { type: "rect", x: 5 }) as RectElement;
  h.ok(same.fill === "#4385be" && same.x === 5, "a patch naming the SAME kind is an ordinary patch");
  const chained = applyState(applyState(pre, patch), { fill: "#00ff00", x: 1 }) as EllipseElement;
  h.ok(chained.type === "ellipse" && chained.fill === "#00ff00" && chained.x === 1, "later patches fold onto the retyped element");
  const plotEnd = transformEndState(rect(), { to: { state: { type: "plot", overrides: { "a.line": { stroke: "#f00" } } }, assetId: "asset-9" } });
  h.ok(plotEnd.type === "plot" && (plotEnd as { assetId: string }).assetId === "asset-9", "transformEndState puts the content half on a retyped plot");
}

// --- arcT is the reference bisection, just faster (2026-09-24) ----------------
// arcT was rewritten allocation-free (the hot loop of morph planning). It must
// return what its definition returns: bisection on the 16-station polyline
// length of the left de Casteljau half. Pinned on seeded random cubics.
{
  const reference = (seg: PathSeg, len: number, dist: number): number => {
    if (dist <= 0) return 0;
    if (dist >= len) return 1;
    let lo = 0, hi = 1, t = dist / len;
    for (let k = 0; k < 20; k++) { t = (lo + hi) / 2; if (segLength(splitSeg(seg, t)[0], 16) < dist) lo = t; else hi = t; }
    return t;
  };
  let seed = 11, worst = 0, calls = 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 400 - 200;
  for (let i = 0; i < 1500; i++) {
    const seg: PathSeg = { x0: rnd(), y0: rnd(), x1: rnd(), y1: rnd(), x2: rnd(), y2: rnd(), x3: rnd(), y3: rnd(), line: false };
    const len = segLength(seg, 24);
    for (const f of [0, 0.13, 0.5, 0.77, 1]) { worst = Math.max(worst, Math.abs(arcT(seg, len, len * f) - reference(seg, len, len * f))); calls++; }
  }
  h.ok(worst <= 1e-9, `arcT matches its reference bisection on ${calls} random cubic stations (worst |dt| ${worst})`);
}

await h.done();
