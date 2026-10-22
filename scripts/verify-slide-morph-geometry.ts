// verify-slide-morph-geometry — morph bug floor (WP 1.5, T4 step 0; pure, no browser).
// `ends` is a required sampleNodes parameter and a stroke-thin box samples in pixels (a line swells linearly, no sag),
// a fixed arrowhead rides the swelling stroke tip rigidly in both drivers, per-channel alpha + colormap gradients ride t.
// (The convex-pairing, dash and fallback sections arrive with WP 1.6.)
import type { Element } from "../src/lib/types";
import { planElementMorph, sampleElementMorph, sampleNodes, elementOutline, fixedHeadPoints, lerpGradientFill, pixelLaw, THIN_BOX } from "../src/lib/slide/outline";
import { planCorrespondence, sampleCorrespondence, pairHeadPoints } from "../src/lib/slide/correspondence";
import { elementStageOutlines } from "../src/lib/slide/targetGeometry";
import { segsFromNodes, segPoint } from "../src/lib/path";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-morph-geometry");
type P = { x: number; y: number };

// ---- metrics (closed polylines) ----
const poly = (nodes: any[], closed: boolean, per = 24): P[] => {
  const out: P[] = [];
  for (const s of segsFromNodes(nodes, closed)) for (let i = 0; i < per; i++) out.push(segPoint(s, i / per));
  return out;
};
const area = (p: P[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; };
function hull(pts: P[]): P[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y), cr = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: P[] = []; for (const p of s) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up: P[] = []; for (const p of [...s].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
function convexity(pts: P[]) {
  const n = pts.length, sgn = Math.sign(area(pts)) || 1;
  let reflex = 0, maxTurn = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    if (Math.hypot(v1.x, v1.y) < 1e-9 || Math.hypot(v2.x, v2.y) < 1e-9) continue;
    const ang = (Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y) * 180 / Math.PI) * sgn;
    if (ang < -0.05) reflex += -ang; maxTurn = Math.max(maxTurn, ang);
  }
  const A = Math.abs(area(pts)), H = Math.abs(area(hull(pts)));
  return { hullDef: H > 0 ? (H - A) / H : 0, reflex, maxTurn };
}
function selfX(pts: P[]): number {
  const cross = (a: P, b: P, c: P) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x), n = pts.length;
  let c = 0;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[j], p4 = pts[(j + 1) % n];
    if (cross(p3, p4, p1) * cross(p3, p4, p2) < -1e-9 && cross(p1, p2, p3) * cross(p1, p2, p4) < -1e-9) c++;
  }
  return c;
}
const dist = (p: P, q: P[], closed = true) => { let m = 1e9; const N = closed ? q.length : q.length - 1; for (let i = 0; i < N; i++) { const a = q[i], b = q[(i + 1) % q.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)); m = Math.min(m, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)); } return m; };
const hausdorff = (A: P[], B: P[]) => Math.max(...A.map((p) => dist(p, B)), ...B.map((p) => dist(p, A)));

// ---- fixtures ----
const mk = (type: string, o: Record<string, unknown> = {}): any => ({ type, id: "e", rotation: 0, x: 0, y: 0, width: 200, height: 200, fill: "#4385be", stroke: "#205ea6", strokeWidth: 0, cornerRadius: 0, ...o });
const circle = (o = {}) => mk("ellipse", { fill: "#d14d41", stroke: "#942822", ...o });
const tri = mk("path", { closed: true, d: "", nodes: [{ x: 100, y: 0, type: "corner" }, { x: 200, y: 200, type: "corner" }, { x: 0, y: 200, type: "corner" }] });
const star = (rev = false) => { const pts = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 48 : 100, a = -Math.PI / 2 + i * Math.PI / 5; return { x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a), type: "corner" }; }); return mk("path", { closed: true, d: "", nodes: rev ? pts.reverse() : pts, fill: "#d14d41" }); };
const hex = (rev: boolean) => { const n = Array.from({ length: 6 }, (_, i) => ({ x: 100 + 100 * Math.cos(i * Math.PI / 3), y: 87 + 87 * Math.sin(i * Math.PI / 3), type: "corner" })); return mk("path", { closed: true, d: "", width: 200, height: 174, nodes: rev ? n.reverse() : n, dash: [12, 8], strokeWidth: 6 }); };
const line = (o: Record<string, unknown> = {}) => ({ type: "line", id: "e", x: 140, y: 180, width: 360, height: 0, x1: 0, y1: 0, x2: 360, y2: 0, rotation: 0, stroke: "#205ea6", strokeWidth: 6, arrowStart: false, arrowEnd: false, cap: "round", ...o }) as any;
const TS = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);
const frame = (plan: any, t: number, per = 24) => { const s = sampleElementMorph(plan, t); return { s, pts: poly(s.nodes!, s.closed!, per) }; };

h.ok(sampleNodes.length === 7, "sampleNodes' `ends` boxes are a REQUIRED parameter (arity 7: the law cannot be chosen without them)");
h.ok(!pixelLaw({ wa: 200, ha: 100, wb: 50, hb: 50 }) && pixelLaw({ wa: 360, ha: 0, wb: 50, hb: 50 }) && pixelLaw({ wa: 360, ha: THIN_BOX - 0.01, wb: 5, hb: 5 }) && !pixelLaw({ wa: 360, ha: THIN_BOX, wb: 5, hb: 5 }), `the pixel law applies exactly when a box is thinner than THIN_BOX = ${THIN_BOX}`);

h.section("H1: a stroke swells into a ring linearly in t (pixel law for stroke-thin boxes)");
{
  const a = line(), b = circle({ x: 220, y: 80, width: 200, height: 200, strokeWidth: 6 });
  const plan = planElementMorph(a, b)!; plan.prepare?.();
  let worstH = 0, worstC = 0;
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const { s, pts } = frame(plan, t);
    const ys = pts.map((p) => p.y), hh = Math.max(...ys) - Math.min(...ys), cy = (Math.max(...ys) + Math.min(...ys)) / 2 + (s as any).y;
    worstH = Math.max(worstH, Math.abs(hh - 200 * t)); worstC = Math.max(worstC, Math.abs(cy - 180));
  }
  h.ok(worstH <= 0.5 && worstC <= 0.5, `line→circle: height is exactly linear in t (worst ${worstH.toFixed(2)} px ≤ 0.5), centre y flat at 180 (worst ${worstC.toFixed(2)} px ≤ 0.5); the product law sagged it 25 px`);
}

h.section("H3: an arrowhead rides the swelling stroke end, rigid, tip on the outline at every t");
{
  const a = line({ arrowEnd: true }), b = circle({ x: 220, y: 80, width: 200, height: 200, strokeWidth: 6 });
  const plan = planElementMorph(a, b)!; plan.prepare?.();
  h.ok(plan.fixedHeads.length === 1, "arrow→circle: one fixed head");
  let thickMin = 1e9, gapMax = 0;
  for (const t of [0.02, 0.1, 0.2, 0.3, 0.4]) {
    const s = sampleElementMorph(plan, t), outline = poly(s.nodes!, true).map((p) => ({ x: p.x, y: p.y }));
    const pts = fixedHeadPoints(plan, plan.fixedHeads[0], t).map(([x, y]) => ({ x, y }));
    const tip = pts.reduce((m, p) => (p.x > m.x ? p : m), pts[0]);
    thickMin = Math.min(thickMin, Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)));
    gapMax = Math.max(gapMax, dist(tip, outline));
  }
  h.ok(thickMin >= 20 && gapMax <= 0.5, `head thickness ≥ 20 px at t=.02…0.4 (min ${thickMin.toFixed(1)}; was 0.0) and tip gap ≤ 0.5 px (max ${gapMax.toFixed(2)}; was 17.5 at t=.4)`);
  // twin-engine parity: the hand-off law gives the same head for the same geometry
  const A = elementStageOutlines(a)[0], B = elementStageOutlines(b)[0];
  const cp = planCorrespondence([A], [B], { pair: "spatial" }); cp.prepare();
  const pair = cp.pairs[0];
  const anchor = plan.fixedHeads[0].anchor, dir = plan.fixedHeads[0].dir;
  const stageAnchor: [number, number] = [anchor[0] + A.bbox.x, anchor[1] + A.bbox.y];
  const hp = pairHeadPoints(pair, plan.fixedHeads[0].pts.map(([x, y]) => [x + A.bbox.x, y + A.bbox.y]), stageAnchor, dir, 0.3);
  const fp = fixedHeadPoints(plan, plan.fixedHeads[0], 0.3);
  // both lerp boxes: pair uses stage coordinates, the plan box-local ones
  const ox = A.bbox.x + (B.bbox.x - A.bbox.x) * 0.3, oy = A.bbox.y + (B.bbox.y - A.bbox.y) * 0.3;
  const par = hp.every(([x, y], i) => Math.hypot(x - (fp[i][0] + ox), y - (fp[i][1] + oy)) < 1e-6);
  h.ok(par, "pairHeadPoints (hand-off) = fixedHeadPoints (1↔1) + the box origin: one law, two drivers");
}

h.section("M2: per-channel alpha and colormap gradients ride t (no step at .5)");
{
  const V = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
  const a = mk("rect", { fill: "#4385be", fillOpacity: 0.35, fillMap: { map: "viridis", axis: "x", stops: V } }), b = circle();
  const plan = planElementMorph(a, b)!;
  const f = (t: number) => sampleElementMorph(plan, t) as any;
  const o = [0.2, 0.45, 0.55, 0.8].map((t) => f(t).fillOpacity);
  h.ok(o.every((v, i) => v > (i ? o[i - 1] : 0.35)) && o[0] < 1 && f(0.99).fillOpacity > 0.99, `fillOpacity 0.35 → 1 rises monotonically (${o.map((v) => v.toFixed(2)).join(", ")}), no step at .5`);
  const g = (t: number) => f(t).fillMap?.stops as string[];
  h.ok(g(0.45).join() !== g(0.55).join() && g(0.5)[2] !== V[2] && g(0.5)[2] !== "#d14d41" && g(0.99).every((c) => /^#?[0-9a-f]+$/i.test(c.replace("#", "")) || c.startsWith("rgb") || c.startsWith("oklch")), "gradient → flat: the 5 stops blend in OKLab (mid stop differs from both ends; continuous across .5)");
  const cache = {} as any;
  const m = lerpGradientFill({ map: "viridis", axis: "x", stops: V, discrete: true } as any, undefined, "#fff", "#d14d41", 0.3, cache);
  h.ok(m?.stops?.join() === V.join(), "a banded (discrete) map cannot blend: it keeps its bands until .5");
  // hand-off pieces
  const A = elementStageOutlines(mk("rect", { fillOpacity: 0.4, strokeOpacity: 0.5, fillMap: { map: "viridis", axis: "x", stops: V }, x: 10, y: 10 }))[0];
  const B = elementStageOutlines(circle({ x: 300, y: 10 }))[0];
  const cp = planCorrespondence([A], [B], { pair: "spatial" }); cp.prepare();
  const out = sampleCorrespondence(cp, 0.5);
  const p = out[0].paint as any;
  h.ok(p.fillOpacity > 0.4 && p.fillOpacity < 1 && p.strokeOpacity > 0.5 && p.fillMap?.stops?.length === 5, "hand-off sampleCorrespondence carries fillOpacity, strokeOpacity and a blended fillMap at t=.5");
  h.ok(A.paint.gradBox && Math.abs(A.paint.gradBox.w - 200) < 1e-6, "a gradient element's stage outline carries its box (`paint.gradBox`)");
  // pieces of one element keep the ELEMENT's gradient box (userSpaceOnUse)
  const dots = [0, 1, 2].map((i) => elementStageOutlines(circle({ id: "d" + i, x: 400, y: 20 + i * 60, width: 30, height: 30 }))[0]);
  const set = planCorrespondence([A], dots, { pair: "tile" } as any);
  h.ok(set.pairs.length >= 3 && set.pairs.filter((q) => q.a).every((q) => q.a!.paint.gradBox && q.a!.paint.gradBox!.w === A.paint.gradBox!.w), "every piece cut from a gradient shape inherits the shape's gradBox");
}

await h.done();
