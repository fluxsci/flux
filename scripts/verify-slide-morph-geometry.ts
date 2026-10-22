// verify-slide-morph-geometry — the morph geometry contract (WP 1.5 + 1.6; pure, no browser).
// Convex rings pair by tangent angle (Minkowski blend), implicit 1/3-chord handles on every straight
// segment, unit-frame sampling (pixel frame only for stroke-thin boxes), hairpin strokes swell as
// stadiums, rigid fixed heads on the swelling tip, per-channel alpha + gradients ride t, dash phase.
import type { Element } from "../src/lib/types";
import { planElementMorph, sampleElementMorph, planOutlines, sampleNodes, elementOutline, fixedHeadPoints, lerpGradientFill, dashOffsetAt, pixelLaw, THIN_BOX } from "../src/lib/slide/outline";
import { normalMatchRings } from "../src/lib/slide/normalMatch";
import { planCorrespondence, sampleCorrespondence, pairHeadPoints } from "../src/lib/slide/correspondence";
import { elementStageOutlines } from "../src/lib/slide/targetGeometry";
import { segsFromNodes, segPoint } from "../src/lib/path";
import { parameterize, pointAt } from "../src/lib/slide/outline";
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

h.section("pillow: convex Become pairs round progressively (square→circle, triangle→circle, rounded-rect→ellipse)");
for (const [name, a, b] of [
  ["square→circle", mk("rect"), circle()], ["triangle→circle", tri, circle()],
  ["rounded-rect→ellipse", mk("rect", { width: 240, height: 140, cornerRadius: 30 }), circle({ width: 240, height: 140 })],
] as [string, any, any][]) {
  const plan = planElementMorph(a, b)!;
  let hull_ = 0, reflex = 0, turn = 0, sx = 0;
  const areas: number[] = [];
  for (const t of TS) { const { pts } = frame(plan, t); const c = convexity(pts); hull_ = Math.max(hull_, c.hullDef); reflex = Math.max(reflex, c.reflex); turn = Math.max(turn, c.maxTurn); sx += selfX(pts); areas.push(Math.abs(area(pts))); }
  h.ok(hull_ <= 1e-4 && reflex <= 1 && turn <= 5 && sx === 0, `${name}: every frame t=.05….95 is convex (hull deficiency ${hull_.toExponential(1)} ≤ 1e-4, reflex ${reflex.toFixed(2)}° ≤ 1°, sharpest vertex turn ${turn.toFixed(1)}° ≤ 5°, ${sx} self-intersections)`);
  const lo = Math.min(areas[0], areas[areas.length - 1]) * 0.9, hi = Math.max(areas[0], areas[areas.length - 1]) * 1.1;
  h.ok(areas.every((v) => v >= lo && v <= hi), `${name}: area stays within the end areas ±10 % (no bulge)`);
  plan.prepare?.();
  h.ok(plan.a.length === plan.b.length && plan.a.length >= 8 && plan.a.length <= 24 && plan.closed, `${name}: equal chains of ${plan.a.length} nodes (8…24), closed`);
}
{ // t=0 / t=1 are exactly A and B (Hausdorff ≤ 0.05 px at t=1e-4 and 1−1e-4)
  const a = mk("rect", { width: 240, height: 160 }), b = circle({ width: 100, height: 300, x: 50, y: 20 });
  const plan = planElementMorph(a, b)!, ra = elementOutline(a)!, rb = elementOutline(b)!;
  const f0 = frame(plan, 1e-4, 60), f1 = frame(plan, 1 - 1e-4, 60);
  const sh = (pts: P[], o: P) => pts.map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
  const dA = hausdorff(sh(f0.pts, f0.s as any), sh(poly(ra.nodes, true, 48), a)), dB = hausdorff(sh(f1.pts, f1.s as any), sh(poly(rb.nodes, true, 48), b));
  h.ok(dA <= 0.05 && dB <= 0.05, `endpoints reproduce A and B (Hausdorff ${dA.toFixed(4)} / ${dB.toFixed(4)} px ≤ 0.05)`);
}

h.section("hand-off ring pairs are planned in the UNIT frame: ellipse→ellipse stays an exact ellipse");
for (const [wa, ha, wb, hb] of [[300, 100, 100, 300], [200, 100, 80, 40]]) {
  const A = elementOutline(circle({ width: wa, height: ha }))!, B = elementOutline(circle({ width: wb, height: hb }))!;
  const plan = planOutlines(A, wa, ha, B, wb, hb, "cut");
  let dev = 0;
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const W = wa + (wb - wa) * t, H = ha + (hb - ha) * t;
    const nodes = sampleNodes(plan.a, plan.b, t, W, H, [], { wa, ha, wb, hb });
    for (const p of poly(nodes, true, 24)) dev = Math.max(dev, Math.abs(Math.hypot((p.x - W / 2) / (W / 2), (p.y - H / 2) / (H / 2)) - 1) * Math.min(W, H) / 2);
  }
  h.ok(dev <= 0.05, `ellipse ${wa}×${ha} → ${wb}×${hb}: max deviation from the exact ellipse ${dev.toFixed(3)} px ≤ 0.05 (the pixel-frame variant gave a 6–9 % squarish bean)`);
}
{ // roundness scales with the box: a 24 px dot growing into 300×170 stays a soft squircle (corner radius ≥ 0.25·t·min(box) at t = .1)
  const A = elementOutline(circle({ width: 24, height: 24 }))!, B = elementOutline(mk("rect", { width: 300, height: 170 }))!;
  const plan = planOutlines(A, 24, 24, B, 300, 170, "cut");
  const t = 0.1, W = 24 + 276 * t, H = 24 + 146 * t;
  const pts = poly(sampleNodes(plan.a, plan.b, t, W, H, [], { wa: 24, ha: 24, wb: 300, hb: 170 }), true, 24);
  const corner = Math.hypot(pts.reduce((m, p) => Math.min(m, Math.hypot(p.x, p.y)), 1e9), 0);
  h.ok(corner >= 0.25 * t * Math.min(300, 170), `dot→box t=.1: the nearest point to the box corner is ${corner.toFixed(1)} px away (≥ ${(0.25 * t * 170).toFixed(1)}): the corner is already rounded, not a sharp box`);
}
h.ok(sampleNodes.length === 7, "sampleNodes' `ends` boxes are a REQUIRED parameter (arity 7: the law cannot be chosen without them)");
h.ok(!pixelLaw({ wa: 200, ha: 100, wb: 50, hb: 50 }) && pixelLaw({ wa: 360, ha: 0, wb: 50, hb: 50 }) && pixelLaw({ wa: 360, ha: THIN_BOX - 0.01, wb: 5, hb: 5 }) && !pixelLaw({ wa: 360, ha: THIN_BOX, wb: 5, hb: 5 }), `the pixel law applies exactly when a box is thinner than THIN_BOX = ${THIN_BOX}`);

h.section("H1 + hairpin: a stroke swells into a ring as a stadium (no sag, no ears)");
{
  const a = line(), b = circle({ x: 220, y: 80, width: 200, height: 200, strokeWidth: 6 });
  const plan = planElementMorph(a, b)!; plan.prepare?.();
  let worstH = 0, worstC = 0, turn = 0, sx = 0;
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const { s, pts } = frame(plan, t);
    const ys = pts.map((p) => p.y), hh = Math.max(...ys) - Math.min(...ys), cy = (Math.max(...ys) + Math.min(...ys)) / 2 + (s as any).y;
    worstH = Math.max(worstH, Math.abs(hh - 200 * t)); worstC = Math.max(worstC, Math.abs(cy - 180)); turn = Math.max(turn, convexity(pts).maxTurn); sx += selfX(pts);
  }
  h.ok(worstH <= 0.5 && worstC <= 0.5, `line→circle: height is exactly linear in t (worst ${worstH.toFixed(2)} px ≤ 0.5), centre y flat at 180 (worst ${worstC.toFixed(2)} px ≤ 0.5); the product law sagged it 25 px`);
  h.ok(plan.a.length <= 8 && plan.closed && turn <= 6 && sx === 0, `line→circle: a ${plan.a.length}-node ring, sharpest vertex turn ${turn.toFixed(1)}° ≤ 6° (the old eye had 170° ears), ${sx} self-intersections`);
  const nm = normalMatchRings([{ x: 0, y: 0, type: "corner" }, { x: 360, y: 0, type: "corner" }], elementOutline(circle({ width: 200, height: 200 }))!.nodes);
  h.ok(!!nm && nm.a.length === nm.b.length && nm.a.length <= 8, `normalMatchRings: a hairpin (zero-area out-and-back ring) pairs with a circle (${nm?.a.length} nodes)`);
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

h.section("dashes: A keeps its own start and direction; B lands on its static pattern");
{
  // CCW (reversed) dashed hexagon → dashed ellipse
  const a = hex(true), b = circle({ width: 200, height: 174, dash: [12, 8], strokeWidth: 6 });
  const plan = planElementMorph(a, b)!; plan.prepare?.();
  const nodesA = elementOutline(a)!.nodes;
  const ha = plan.preBox;
  const px = (n: any) => ({ x: n.x * ha.w, y: n.y * ha.h });
  const p0 = px(plan.a[0]), p1 = px(plan.a.find((n: any) => Math.hypot(px(n).x - p0.x, px(n).y - p0.y) > 1e-6)!);   // first chain node off the (corner) start
  const dirA = { x: nodesA[1].x - nodesA[0].x, y: nodesA[1].y - nodesA[0].y };
  const dirP = { x: p1.x - p0.x, y: p1.y - p0.y };
  const dot = (dirA.x * dirP.x + dirA.y * dirP.y) / (Math.hypot(dirA.x, dirA.y) * Math.hypot(dirP.x, dirP.y));
  h.ok(Math.hypot(p0.x - nodesA[0].x, p0.y - nodesA[0].y) < 1e-6 && dot > 0.999, `a counter-clockwise A keeps its own start node and travel direction in the chain (dir cos ${dot.toFixed(4)}): the t=0+ frame lays dashes exactly where A's markup did`);
  // clockwise A, ellipse B: B's static start sits on the chain at dashShift
  const a2 = mk("rect", { width: 200, height: 174, dash: [12, 8], strokeWidth: 6 });
  const plan2 = planElementMorph(a2, b)!; plan2.prepare?.();
  const shift = plan2.dashShift as number | undefined;
  h.ok(shift !== undefined && shift > 0, `normal-matched clockwise pair carries a dashShift (${shift?.toFixed(2)} px)`);
  if (shift) {
    // chain position at arc length s' from the chain start == B's own path at s' − shift
    const eb = plan2.endBox, chain = plan2.b.map((n: any) => ({ ...n, x: n.x * eb.w, y: n.y * eb.h, hIn: n.hIn && { dx: n.hIn.dx * eb.w, dy: n.hIn.dy * eb.h }, hOut: n.hOut && { dx: n.hOut.dx * eb.w, dy: n.hOut.dy * eb.h } }));
    const pc = parameterize(chain, true), pb = parameterize(elementOutline(b)!.nodes, true);
    const perim = (() => { let L = 0, prev = pointAt(pc, 0); for (let i = 1; i <= 2000; i++) { const q = pointAt(pc, i / 2000); L += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; } return L; })();
    let worst = 0;
    for (let k = 1; k < 40; k++) { const s = (k / 40) * (perim - shift); const x = pointAt(pc, (s + shift) / perim), y = pointAt(pb, s / perim); worst = Math.max(worst, Math.hypot(x.x - y.x, x.y - y.y)); }
    h.ok(worst <= 0.25, `B's static start is ${shift!.toFixed(1)} px along the chain: chain(s'+shift) = B(s') within ${worst.toFixed(3)} px (≤ 0.25)`);
    h.ok(Math.abs(dashOffsetAt(shift, [12, 8], 1) - ((-shift % 20) + 20) % 20) < 1e-9 && dashOffsetAt(shift, [12, 8], 0) === 0, "dash offset runs 0 → −shift (mod the 20 px period): seek-pure");
    // the dash ON/OFF state of the live chain at t=1 equals B's static pattern wherever the two seams do not interfere
    const on = (s: number) => (((s % 20) + 20) % 20) < 12;
    let bad = 0, tested = 0; const per = 640;   // chain perimeter stand-in: only the relation s_static = s' − shift matters
    for (let k = 0; k < per; k++) { const sp = shift + 0.5 + k * 0.97; if (Math.abs(((sp % 20) + 20) % 20 - 12) < 0.6 || Math.abs(((sp % 20) + 20) % 20) < 0.6) continue; tested++; if (on(sp + dashOffsetAt(shift, [12, 8], 1)) !== on(sp - shift)) bad++; }
    h.ok(tested > 400 && bad === 0, `forward: the dash ON/OFF state of the chain at t=1 equals B's static state at ${tested} sampled positions (${bad} mismatches)`);
  }
  // reversed: A clockwise, B counter-clockwise (a reversed hexagon outline as the destination)
  const planR = planElementMorph(mk("rect", { width: 200, height: 174, dash: [12, 8], strokeWidth: 6 }), hex(true))!; planR.prepare?.();
  const shiftR = planR.dashShift as number | undefined;
  h.ok(planR.dashReversed === true && shiftR !== undefined, `opposite winding: the plan flags dashReversed (shift ${shiftR?.toFixed(1)} px)`);
  if (shiftR !== undefined) {
    const on = (s: number) => (((s % 20) + 20) % 20) < 12;
    let bad = 0, tested = 0;
    for (let k = 0; k < 400; k++) { const sp = 0.5 + k * 0.31; if (sp > shiftR) break; const stat = shiftR - sp; if (Math.abs(((stat % 20) + 20) % 20 - 12) < 0.6 || Math.abs(((stat % 20) + 20) % 20) < 0.6 || Math.abs(((sp % 20) + 20) % 20 - 12) < 0.6) continue; tested++; if (on(sp + dashOffsetAt(shiftR, [12, 8], 1, true)) !== on(stat)) bad++; }
    h.ok(tested > 30 && bad === 0, `reversed: the chain's pattern (offset ${dashOffsetAt(shiftR, [12, 8], 1, true).toFixed(2)}) equals B's reversed static pattern at ${tested} positions (${bad} mismatches)`);
    h.ok(dashOffsetAt(shiftR, [5, 3, 2, 3], 1, true) === 0, "a reversed pattern that is not its own reversal up to a shift keeps offset 0");
  }
}

h.section("seek purity: forward = reverse = shuffled (the player seeks backwards and skips)");
{
  const V = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
  const arrow = line({ arrowEnd: true, dash: [12, 8] }), ring = circle({ x: 220, y: 80, width: 200, height: 200, strokeWidth: 6, dash: [12, 8], fillMap: { map: "viridis", axis: "x", stops: V }, fillOpacity: 0.5 });
  const plan = planElementMorph(arrow, ring)!; plan.prepare?.();
  const plan2 = planElementMorph(hex(true), circle({ width: 200, height: 174, dash: [12, 8], strokeWidth: 6 }))!; plan2.prepare?.();
  const A = elementStageOutlines(arrow)[0], B = elementStageOutlines(ring)[0];
  const cp = planCorrespondence([A], [B], { pair: "spatial" }); cp.prepare();
  const grid = Array.from({ length: 21 }, (_, i) => i / 20), order = [7, 19, 2, 14, 0, 20, 11, 5, 16, 9, 3, 18, 12, 1, 8, 15, 4, 17, 10, 13, 6];
  const frameOf = (t: number) => JSON.stringify([
    sampleElementMorph(plan, t), fixedHeadPoints(plan, plan.fixedHeads[0], t), dashOffsetAt(plan2.dashShift ?? 0, [12, 8], t, plan2.dashReversed), sampleElementMorph(plan2, t),
    pairHeadPoints(cp.pairs[0], plan.fixedHeads[0].pts.map(([x, y]) => [x + A.bbox.x, y + A.bbox.y]), [plan.fixedHeads[0].anchor[0] + A.bbox.x, plan.fixedHeads[0].anchor[1] + A.bbox.y], plan.fixedHeads[0].dir, t),
    JSON.parse(JSON.stringify(sampleCorrespondence(cp, t))),
  ]);
  const fwd = grid.map(frameOf), rev = grid.map((_, i) => frameOf(grid[20 - i])).reverse(), shuf = order.map((i) => frameOf(grid[i]));
  const byIndex = grid.map((_, i) => shuf[order.indexOf(i)]);
  h.ok(fwd.every((f, i) => f === rev[i]) && fwd.every((f, i) => f === byIndex[i]), "1↔1 and hand-off frames (alpha, gradient, heads, dash offset, nodes) are byte-identical sampled forward, reversed and shuffled");
}

h.section("scope: dense rings, fallback, stress pairs");
{
  const ngon = (n: number) => mk("path", { closed: true, d: "", nodes: Array.from({ length: n }, (_, i) => ({ x: 100 + 100 * Math.cos(2 * Math.PI * i / n), y: 100 + 100 * Math.sin(2 * Math.PI * i / n), type: "corner" })) });
  for (const n of [12, 50, 200]) { const p = planElementMorph(ngon(n), circle())!; p.prepare?.(); h.ok(p.a.length <= 2 * n + 4 && p.a.length === p.b.length, `${n}-gon→circle plans ${p.a.length} nodes ≤ 2n+4`); }
  const A = elementOutline(ngon(800))!, B = elementOutline(circle())!;
  h.ok(normalMatchRings(A.nodes, B.nodes) === null, "an 800-node ring keeps the arc-length planner (normal matching is capped at 600 nodes per ring)");
  const st = (rev: boolean) => star(rev);
  let worstReflex = 0;
  const pr = planElementMorph(st(false), circle())!; for (const t of TS) worstReflex = Math.max(worstReflex, convexity(frame(pr, t).pts).reflex);
  h.ok(worstReflex <= 300, `star→circle (non-convex: arc-length fallback + implicit handles): reflex turning ≤ 300° (was 1,034°) — max ${worstReflex.toFixed(0)}°`);
  const rs = planElementMorph(mk("rect", { width: 240, height: 160 }), st(false))!; let sx = 0; for (let i = 1; i < 100; i++) sx += selfX(frame(rs, i / 100).pts) > 0 ? 1 : 0;
  h.ok(sx === 0, `rect→star: 0/99 self-intersecting frames (${sx})`);
  const curve: any = { type: "path", id: "e", rotation: 0, fill: "none", stroke: "#205ea6", strokeWidth: 4, x: 100, y: 100, width: 200, height: 100, d: "", closed: false, nodes: [{ x: 0, y: 100, type: "corner" }, { x: 100, y: 0, type: "smooth", hIn: { dx: -60, dy: 0 }, hOut: { dx: 60, dy: 0 } }, { x: 200, y: 100, type: "corner" }] };
  const cs = planElementMorph(curve, star(false))!; let bad = 0; for (let i = 1; i < 100; i++) if (selfX(frame(cs, i / 100).pts) > 0) bad++;
  h.ok(bad <= 2, `curve→star (inflate): ≤ 2/99 self-intersecting frames (${bad}; was 32; the residual is a 0.000 px² loop at the hairpin turn)`);
}

h.section("fuzz: 120 deterministic pairs");
{
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296, R = (a: number, b: number) => a + (b - a) * rnd();
  const fit = (o: any) => { if (!o.nodes) return o; const xs = o.nodes.map((n: any) => n.x), ys = o.nodes.map((n: any) => n.y), x0 = Math.min(...xs), y0 = Math.min(...ys); o.nodes = o.nodes.map((n: any) => ({ ...n, x: n.x - x0, y: n.y - y0 })); o.width = Math.max(...xs) - x0; o.height = Math.max(...ys) - y0; return o; };
  const cvx = (n: number, w: number, hh: number) => Array.from({ length: n }, () => R(0, Math.PI * 2)).sort((a, b) => a - b).map((a) => ({ x: w / 2 + (w / 2) * Math.cos(a), y: hh / 2 + (hh / 2) * Math.sin(a), type: "corner" as const }));
  const make = (k: number) => {
    const w = R(20, 300), hh = R(20, 300), base = { id: "e", rotation: 0, x: R(0, 100), y: R(0, 100), fill: "#4385be", stroke: "#205ea6", strokeWidth: 2 };
    if (k === 0) return { ...base, type: "rect", width: w, height: hh, cornerRadius: rnd() < .5 ? 0 : R(0, Math.min(w, hh) / 2) };
    if (k === 1) return { ...base, type: "ellipse", width: w, height: hh };
    const nodes = cvx(3 + Math.floor(R(0, 6)), w, hh); if (rnd() < .5) nodes.reverse(); const s = Math.floor(R(0, nodes.length));
    return fit({ ...base, type: "path", width: w, height: hh, closed: true, d: "", nodes: [...nodes.slice(s), ...nodes.slice(0, s)] });
  };
  let worstA = 0, worstB = 0, nan = 0, nonconvex = 0, si = 0, n = 0;
  for (let it = 0; it < 120; it++) {
    const a = make(Math.floor(R(0, 3))), b = make(Math.floor(R(0, 3)));
    const plan = planElementMorph(a, b); if (!plan) continue; n++; plan.prepare?.();
    const ra = elementOutline(a)!, rb = elementOutline(b)!;
    const sh = (pts: P[], o: P) => pts.map((p) => ({ x: p.x + o.x, y: p.y + o.y }));
    const f0 = frame(plan, 1e-4, 60), f1 = frame(plan, 1 - 1e-4, 60);
    worstA = Math.max(worstA, hausdorff(sh(f0.pts, f0.s as any), sh(poly(ra.nodes, true, 60), plan.preBox)));
    worstB = Math.max(worstB, hausdorff(sh(f1.pts, f1.s as any), sh(poly(rb.nodes, true, 60), plan.endBox)));
    if (f0.s.nodes!.some((q: any) => !isFinite(q.x) || !isFinite(q.y))) nan++;
    for (const t of [0.05, 0.25, 0.5, 0.75, 0.95]) { const { pts } = frame(plan, t); const c = convexity(pts); if (c.hullDef > 2e-4 || c.reflex > 1) { nonconvex++; break; } }
    for (const t of [0.1, 0.5, 0.9]) if (selfX(frame(plan, t).pts)) { si++; break; }
  }
  h.ok(n >= 60 && worstA <= 0.05 && worstB <= 0.05 && nan === 0 && nonconvex === 0 && si === 0, `${n} convex pairs (rect/rounded/ellipse/polygons, reversed & shifted starts): endpoints ≤ 0.05 px (A ${worstA.toFixed(4)}, B ${worstB.toFixed(4)}), no NaN, convex at every sampled t, 0 self-intersections`);
}

h.section("cost (relative, guide §9)");
{
  const med = (f: () => void, n = 9) => { const v: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); v.push(performance.now() - t); } return v.sort((x, y) => x - y)[Math.floor(n / 2)]; };
  let seed = 1;
  const fresh = (a: () => any, b: () => any) => () => { seed++; planElementMorph({ ...a(), width: 190 + seed * 0.37 }, { ...b(), width: 150 + seed * 0.11 })!.prepare?.(); };
  const convex = med(fresh(() => mk("rect"), () => circle()));
  const concave = med(fresh(() => mk("rect"), () => star(false)));
  h.ok(convex <= concave * 0.75, `a convex ring pair plans at most 0.75× the arc-length fallback (${convex.toFixed(2)} vs ${concave.toFixed(2)} ms)`);
}
await h.done();
