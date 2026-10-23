// verify-slide-stroke-band — the stroke BAND contract (R2 follow-up F1; pure, no browser).
// A stroked shape that becomes another used to morph its CENTRELINE with a stroke on top, and a stroke's outer corner is round with radius
// w/2 + r the moment the centreline's corner radius r is above zero: a sharp 12 px rect corner jumped from radius 0 to 6 on the first frame
// of its Become (the Release 1 deck's slides 11 and 13), and a body that stops inside an arrowhead poked a round cap out past the tip.
// The stroke is now drawn as the band between two contours (strokeBand.ts), normal-matched like the centreline (outline.ts planStrokeBand).
import type { Element, VectorNode } from "../src/lib/types";
import { ringBand, lineBand, MITER_LIMIT } from "../src/lib/slide/strokeBand";
import { planElementMorph, sampleElementMorph, planStrokeBand, sampleStrokeBand, elementOutline, trimUnderHeads, fixedHeadPoints, type BandSide, type Outline } from "../src/lib/slide/outline";
import { planCorrespondence, sampleCorrespondence } from "../src/lib/slide/correspondence";
import { elementStageOutlines } from "../src/lib/slide/targetGeometry";
import { segsFromNodes, segPoint, nodesExtent } from "../src/lib/path";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-stroke-band");
type P = { x: number; y: number };

const poly = (nodes: VectorNode[], per = 48): P[] => segsFromNodes(nodes, true).flatMap(s => Array.from({ length: per }, (_, i) => segPoint(s, i / per)));
const distToRing = (p: P, ring: P[]) => { let m = Infinity; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1e-12, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)); m = Math.min(m, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)); } return m; };
const spread = (ring: VectorNode[], centre: VectorNode[]) => { const c = poly(centre, 300), d = poly(ring, 24).map(p => distToRing(p, c)); return { min: Math.min(...d), max: Math.max(...d) }; };
const mk = (type: string, o: Record<string, unknown> = {}): any => ({ type, id: "e", rotation: 0, x: 0, y: 0, width: 240, height: 160, fill: "none", stroke: "#100f0f", strokeWidth: 12, cornerRadius: 0, ...o });
const out = (el: any): Outline => elementOutline(el)!;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const hasNodeAt = (nodes: VectorNode[], x: number, y: number, tol = 1e-6) => nodes.some(n => Math.hypot(n.x - x, n.y - y) <= tol);

h.section("G1: the contours of a stroke are the centreline offset by w/2, with the element's own join");
{
  const rect = out(mk("rect")), band = ringBand(rect.nodes, 12, "miter")!;
  h.ok(!!band && band.corners, "a rect has corners");
  h.ok(hasNodeAt(band.outer, -6, -6) && hasNodeAt(band.outer, 246, -6) && hasNodeAt(band.outer, 246, 166) && hasNodeAt(band.outer, -6, 166), "mitred: the outer contour of a 240x160 rect stroked 12 has SHARP corners at (-6,-6) .. (246,166)");
  const ie = nodesExtent(band.inner, true);
  h.ok(hasNodeAt(band.inner, 6, 6) && near(ie.x, 6, 1e-6) && near(ie.w, 228, 1e-6) && near(ie.h, 148, 1e-6), `the inner contour is the rect shrunk by 6, corners sharp (${JSON.stringify(ie)})`);
  const round = ringBand(rect.nodes, 12, "round")!, s = spread(round.outer, rect.nodes);
  h.ok(near(s.min, 6, 1e-3) && near(s.max, 6, 5e-3), `round join: every outer point is exactly w/2 from the centreline, the corner an arc about the corner (${s.min.toFixed(4)}…${s.max.toFixed(4)})`);
  // a mitre past SVG's limit (4) bevels, exactly as the static stroke does
  const spike = { nodes: [{ x: 0, y: 0, type: "corner" as const }, { x: 200, y: 20, type: "corner" as const }, { x: 0, y: 40, type: "corner" as const }], closed: true };
  const sp = ringBand(spike.nodes, 6, "miter")!;
  h.ok(1 / Math.sin(Math.atan(20 / 200)) > MITER_LIMIT && sp.outer.length > 3 && nodesExtent(sp.outer, true).w < 200 + 3 / Math.sin(Math.atan(20 / 200)), `a 11-degree tip is past the miter limit and is bevelled (${sp.outer.length} nodes, extent ${nodesExtent(sp.outer, true).w.toFixed(1)} < the mitre's ${(200 + 3 / Math.sin(Math.atan(20 / 200))).toFixed(1)})`);
  const el = out(mk("ellipse", { width: 200, height: 180 })), eb = ringBand(el.nodes, 12, "miter")!, es = spread(eb.outer, el.nodes), ei = spread(eb.inner, el.nodes);
  h.ok(!eb.corners && near(es.min, 6, 0.01) && near(es.max, 6, 0.01) && near(ei.min, 6, 0.01) && near(ei.max, 6, 0.01), `ellipse 200x180: constant width 6 on both sides to 0.01 px (outer ${es.min.toFixed(4)}…${es.max.toFixed(4)}, inner ${ei.min.toFixed(4)}…${ei.max.toFixed(4)}), no corners`);
  const rr = out(mk("rect", { cornerRadius: 24 })), rb = ringBand(rr.nodes, 12, "miter")!, rs = spread(rb.outer, rr.nodes);
  h.ok(!rb.corners && near(rs.min, 6, 0.01) && near(rs.max, 6, 0.01), "a rounded rect has no corner: smooth joins carry the offset (no band is needed for it)");
  h.ok(ringBand(out(mk("ellipse", { width: 10, height: 10 })).nodes, 12, "miter") === null, "a stroke thicker than the ring's radius has no inner contour: no band (the centreline law)");
  h.ok(ringBand(out(mk("ellipse", { width: 400, height: 40 })).nodes, 6, "miter") === null, "an ellipse whose end radius (b^2/a = 2) is under w/2 inverts inwards: no band");
  const star = Array.from({ length: 10 }, (_, i) => ({ x: 100 + (i % 2 ? 40 : 100) * Math.cos(i * Math.PI / 5), y: 100 + (i % 2 ? 40 : 100) * Math.sin(i * Math.PI / 5), type: "corner" as const }));
  h.ok(ringBand(star, 6, "round") === null, "a non-convex ring (a star) is the centreline law's");
  const cw = rect.nodes, ccw = [cw[0], ...cw.slice(1).reverse()], rev = ringBand(ccw, 12, "miter")!;
  h.ok(hasNodeAt(rev.outer, -6, -6) && near(nodesExtent(rev.inner, true).w, 228, 1e-6), "the winding of the input does not matter (the contours come out the same)");
  const none = ringBand(rect.nodes, 0, "miter")!;
  h.ok(none.outer.length === rect.nodes.length && none.inner.length === rect.nodes.length, "no stroke: both contours ARE the centreline (a zero-width band that grows from nothing)");
}

h.section("G2: a line's band is its capsule, and the inner contour is its spine");
{
  const L = (cap: "butt" | "round" | "square") => lineBand({ x: 0, y: 5 }, { x: 200, y: 5 }, 6, cap)!;
  const ext = (cap: "butt" | "round" | "square") => nodesExtent(L(cap).outer, true);
  h.ok(near(ext("butt").w, 200, 1e-6) && near(ext("round").w, 206, 1e-6) && near(ext("square").w, 206, 1e-6) && near(ext("butt").h, 6, 1e-6), "butt: 200 x 6; round: 206 x 6 (a semicircle each end); square: 206 x 6 (a half width each end)");
  h.ok(!L("round").corners && L("butt").corners && L("square").corners, "a round-capped line needs no band by itself; a butt or square cap is a corner a round join cannot draw");
  h.ok(L("round").inner.length === 2 && near(nodesExtent(L("round").inner, true).h, 0, 1e-9), "the inner contour of a capsule is its spine (width 0): the hole a stroked ring opens grows from the line itself");
  const sq = L("square").outer;
  h.ok(hasNodeAt(sq, -3, 2) && hasNodeAt(sq, 203, 8), "square cap: the corners lie a half width past the end points");
}

h.section("G3: planStrokeBand: when a pair has a band, and what the band is at t = 0, 0.001 and 1");
{
  const side = (el: any, o: Outline = out(el)): BandSide => ({ outline: o, box: { x: 220, y: 80, w: el.width, h: el.height }, width: el.strokeWidth, join: el.type === "rect" ? "miter" : "round", cap: "round" });
  const rect = mk("rect", { x: 220, y: 80, width: 200, height: 160 }), circ = mk("ellipse", { x: 220, y: 80, width: 200, height: 200, strokeWidth: 6, fill: "#d14d41", stroke: "#942822" });
  const plan = planStrokeBand(side(rect), side(circ))!;
  h.ok(!!plan, "a stroked rect that becomes an ellipse has a band");
  h.ok(planStrokeBand(side(circ), side(mk("ellipse", { x: 300, width: 100, height: 100, strokeWidth: 6 }))) === null, "ellipse -> ellipse has none (no corner: the stroke law, drawn by the very rasteriser the resting ellipse is)");
  h.ok(planStrokeBand(side(mk("rect", { strokeWidth: 0 })), side(mk("ellipse", { strokeWidth: 0 }))) === null, "no stroke on either end: no band");
  const at = (t: number) => sampleStrokeBand(plan, t, undefined, false);
  const a0 = at(0), tip0 = a0.outer.reduce((m, n) => (n.x + n.y < m.x + m.y ? n : m), a0.outer[0]);
  h.ok(near(tip0.x, 220 - 6, 1e-6) && near(tip0.y, 80 - 6, 1e-6), `t = 0: the outer contour IS the rect's mitred contour, corner at (${tip0.x.toFixed(3)}, ${tip0.y.toFixed(3)}) = (214, 74)`);
  const a1 = at(1), e1 = nodesExtent(a1.outer, true), i1 = nodesExtent(a1.inner, true);
  h.ok(near(e1.x, 220 - 3, 1e-6) && near(e1.w, 206, 1e-6) && near(i1.w, 194, 1e-6), "t = 1: the contours are the ellipse's (outer 206 wide, inner 194)");
  // the centreline law rounds the outer corner by w/2 on the first frame; the band keeps the mitre tip and rounds it continuously
  const mid = (t: number) => { const s = at(t); return poly(s.outer, 16).reduce((m, p) => Math.min(m, Math.hypot(p.x - 214, p.y - 74)), Infinity); };
  const centreLaw = planElementMorph(rect, circ)!, cl = sampleElementMorph(centreLaw, 0.001);
  const clPts = poly(cl.nodes!, 24).map(p => ({ x: p.x + cl.x, y: p.y + cl.y }));
  const clTip = clPts.reduce((m, p) => (p.x + p.y < m.x + m.y ? p : m), clPts[0]), half = cl.strokeWidth / 2;
  const oldTipGap = Math.hypot(clTip.x - half * Math.SQRT1_2 - 214, clTip.y - half * Math.SQRT1_2 - 74);   // the stroked (round) outer corner of the centreline law
  h.ok(mid(0.001) <= 0.05 && oldTipGap > 1.0, `t = .001: the band's outer corner is ${mid(0.001).toFixed(3)} px from the mitre tip; the centreline law's stroke corner was ${oldTipGap.toFixed(2)} px short of it (a round corner of radius w/2 on frame 1)`);
  const sh = (t: number) => JSON.stringify(sampleStrokeBand(plan, t, undefined, false));
  const ts = [0, 0.001, 0.2, 0.5, 0.8, 1], fwd = ts.map(sh), shuf = [...ts].sort(() => Math.random() - 0.5), by = new Map(shuf.map(t => [t, sh(t)]));
  h.ok(ts.every((t, i) => fwd[i] === by.get(t)) && JSON.stringify([...ts].reverse().map(sh).reverse()) === JSON.stringify(fwd), "seek purity: forward = reverse = shuffled (the frame depends on t alone)");
  // the band keeps the centreline inside it at every t: the fill the body paints never peeks out past the stroke
  let worst = 0;
  for (let k = 1; k < 20; k++) {
    const t = k / 20, ring = poly(sampleStrokeBand(plan, t, undefined, false).outer, 32), inner = poly(sampleStrokeBand(plan, t, undefined, false).inner, 32);
    const s = sampleElementMorph(centreLaw, t), c = poly(s.nodes!, 24).map(p => ({ x: p.x + s.x, y: p.y + s.y }));
    const inside = (p: P, r: P[]) => { let w = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x)) w++; } return w % 2 === 1; };
    for (const p of c) { if (!inside(p, ring)) worst = Math.max(worst, distToRing(p, ring)); }
  }
  h.ok(worst <= 0.25, `the centreline (the fill's edge) stays inside the outer contour at every t (worst overshoot ${worst.toFixed(3)} px <= 0.25)`);
}

h.section("G4: a dashed or gradient stroke keeps the centreline law; the element planner builds the band lazily");
{
  const A = mk("rect", { x: 220, y: 80, width: 200, height: 200 }), B = mk("ellipse", { x: 220, y: 80, width: 200, height: 200, strokeWidth: 6 });
  h.ok(planElementMorph(A, B)!.band!() !== null, "rect -> ellipse: the element plan has a band");
  h.ok(planElementMorph({ ...A, dash: [12, 8] }, B)!.band!() === null && planElementMorph(A, { ...B, dash: [12, 8] })!.band!() === null, "a dash on either end: no band (dashes live on the centreline: dashShift / dashOffsetAt)");
  h.ok(planElementMorph({ ...A, strokeMap: { map: "viridis", axis: "x", stops: ["#440154", "#fde725"] } }, B)!.band!() === null, "a gradient STROKE: no band (a fill-painted band would lay its ramp over the wrong box)");
  h.ok(planElementMorph(A, { ...B, strokeWidth: 0, stroke: "none" })!.band!() !== null, "a stroked rect that becomes an unstroked ellipse still has one: the band thins to nothing");
  const line = mk("line", { x: 60, y: 180, width: 200, height: 10, x1: 0, y1: 5, x2: 200, y2: 5, strokeWidth: 6, arrowStart: false, arrowEnd: true, cap: "round", fill: undefined });
  const lp = planElementMorph(line, B)!; lp.prepare?.();
  h.ok(lp.band!() === null, "a round-capped line becoming an ellipse needs no band (no corner on either end)");
  const lr = planElementMorph(line, mk("rect", { x: 380, y: 120, width: 180, height: 120, strokeWidth: 6, fill: "#d14d41" }))!; lr.prepare?.();
  h.ok(lr.band!() !== null, "the same line becoming a rect does: the rect's mitred corners");
}

h.section("G5: a stroke that inflates starts from the body it is DRAWN with (inside its arrowhead)");
{
  const nodes: VectorNode[] = [{ x: 0, y: 5, type: "corner" }, { x: 220, y: 5, type: "corner" }];
  const trimmed = trimUnderHeads(nodes, { strokeWidth: 6, arrowEnd: true });
  const cut = 220 - trimmed[1].x;
  h.ok(trimmed.length === 2 && trimmed[0].x === 0 && cut > 10 && cut < 30, `a filled head trims the body's end back by ${cut.toFixed(1)} px (0.65 of the head: pathRender's tuck), the start stays`);
  h.ok(trimUnderHeads(nodes, { strokeWidth: 6, arrowEnd: true, arrowStyle: "vee" }) === nodes && trimUnderHeads(nodes, { strokeWidth: 6 }) === nodes, "a vee head or no head: the body is untouched");
  const line = mk("line", { x: 360, y: 180, width: 220, height: 10, x1: 0, y1: 5, x2: 220, y2: 5, strokeWidth: 6, arrowStart: false, arrowEnd: true, cap: "round", fill: undefined });
  const circle = mk("ellipse", { x: 380, y: 110, width: 140, height: 140, strokeWidth: 6, fill: "#d14d41", stroke: "#942822" });
  const plan = planElementMorph(line, circle)!; plan.prepare?.();
  const s = sampleElementMorph(plan, 0.002), rightmost = Math.max(...poly(s.nodes!, 24).map(p => p.x));
  h.ok(rightmost < 220 - 10, `the swelling ring's right end is ${rightmost.toFixed(1)} < ${220 - 10} px: it stops inside the head, not at the tip (the head is ${plan.fixedHeads[0].pts.reduce((m, p) => Math.max(m, p[0]), 0).toFixed(0)} px out)`);
  const head = fixedHeadPoints(plan, plan.fixedHeads[0], 0.002), tipX = Math.max(...head.map(p => p[0]));
  h.ok(near(tipX, 220, 0.5), `the head still stands at the authored tip (x ${tipX.toFixed(2)} = 220): the first frame is the arrow as drawn`);
}

h.section("G6: the hand-off driver's pairs carry the same band");
{
  const A = elementStageOutlines(mk("rect", { id: "a", x: 220, y: 80, width: 200, height: 160, fill: "#4385be", stroke: "#205ea6", strokeWidth: 6 }))[0];
  const B = elementStageOutlines(mk("ellipse", { id: "b", x: 380, y: 140, width: 140, height: 140, fill: "#d14d41", stroke: "#942822", strokeWidth: 6 }))[0];
  const plan = planCorrespondence([A], [B], { pair: "spatial" }); plan.prepare();
  const pair = plan.pairs[0];
  h.ok(!!pair.band?.(), "rect -> ellipse hand-off: the pair has a band plan");
  const buf: any[] = [];
  const atEnd = !sampleCorrespondence(plan, 0, buf)[0].band && !sampleCorrespondence(plan, 1, buf)[0].band, s5 = sampleCorrespondence(plan, 0.5, buf)[0];
  h.ok(atEnd && !!s5.band && s5.band!.outer.length > 4 && s5.band!.inner.length > 4, "the band is sampled in flight (0 < t < 1), never at the endpoints (the real elements are there)");
  const d1 = elementStageOutlines(mk("ellipse", { id: "d1", x: 100, y: 100, width: 24, height: 24, fill: "#4385be", stroke: "#100f0f", strokeWidth: 2 }))[0];
  const d2 = elementStageOutlines(mk("ellipse", { id: "d2", x: 400, y: 200, width: 24, height: 24, fill: "#d14d41", stroke: "#100f0f", strokeWidth: 2 }))[0];
  const dp = planCorrespondence([d1], [d2], { pair: "spatial" }); dp.prepare();
  h.ok(!dp.pairs[0].band?.(), "dot -> dot: no band");
  const dashed = elementStageOutlines(mk("rect", { id: "r", x: 220, y: 80, width: 200, height: 160, dash: [10, 6], strokeWidth: 6 }))[0];
  const dpl = planCorrespondence([dashed], [B], { pair: "spatial" }); dpl.prepare();
  h.ok(!dpl.pairs[0].band?.(), "a dashed end: no band");
  // the band of the hand-off pair equals the element planner's (one law, two drivers), in stage px
  const el = planElementMorph(mk("rect", { id: "a", x: 220, y: 80, width: 200, height: 160, fill: "#4385be", stroke: "#205ea6", strokeWidth: 6 }) as Element, mk("ellipse", { id: "b", x: 380, y: 140, width: 140, height: 140, fill: "#d14d41", stroke: "#942822", strokeWidth: 6 }) as Element)!;
  const a = sampleStrokeBand(el.band!()!, 0.37, undefined, false), b = sampleStrokeBand(pair.band!()!, 0.37, undefined, false);
  h.ok(JSON.stringify(a.outer.map(n => [n.x, n.y].map(v => Math.round(v * 1000)))) === JSON.stringify(b.outer.map(n => [n.x, n.y].map(v => Math.round(v * 1000)))), "the 1-1 driver and the hand-off driver sample the same contour for the same pair");
}

await h.done();
