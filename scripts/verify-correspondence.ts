// Animation v2 B2/B3: real public planner + sampler, hand-written stage fixtures.
import { readFileSync } from "node:fs";
import { harness } from "./lib/harness.mjs";
import { planCorrespondence, sampleCorrespondence, mergeChains, choosePolicy, GLYPH_FLIGHT_THRESHOLD, opaque, expandPolygon } from "../src/lib/slide/correspondence";
import { planCorrespondence as corePlan, sampleCorrespondence as coreSample } from "../flux-core/index";
import { planOutlines, parameterize, pointAt, sampleNodes } from "../src/lib/slide/outline";
import { nodesExtent } from "../src/lib/path";
import { lerpColor, prepareColorLerp } from "../src/lib/color/interp";
import { lerpDash } from "../src/lib/slide/tween";
import type { StageOutline, OutlineOwner, OutlinePaint } from "../src/lib/slide/stageOutline";
import type { VectorNode } from "../src/lib/types";

const h = harness("verify-correspondence");
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const paint: OutlinePaint = { fill: "none", stroke: "#222222", strokeWidth: 2, cap: "round" };
function outline(id: string, xy: number[][], closed = false, owner: Partial<OutlineOwner> = {}, style: Partial<OutlinePaint> = {}): StageOutline {
  const nodes = xy.map(([x, y]): VectorNode => ({ x, y, type: "corner" }));
  return { nodes, closed, bbox: nodesExtent(nodes, closed), owner: { elementId: id, ...owner }, paint: { ...paint, ...style } };
}
const ring = (id: string, x: number, y: number, data?: number) => outline(id, [[x - 2, y - 2], [x + 2, y - 2], [x + 2, y + 2], [x - 2, y + 2]], true,
  data === undefined ? {} : { data: { x: data } }, { fill: "#4488cc" });
const len = (o: StageOutline) => parameterize(o.nodes, o.closed).total;
const local = (o: StageOutline) => ({ closed: o.closed, nodes: o.nodes.map((n) => ({ ...n, x: n.x - o.bbox.x, y: n.y - o.bbox.y })) });
const coords = (nodes: VectorNode[]) => nodes.map((n) => [n.x, n.y]);

h.section("shared export and merged spines");
h.ok(corePlan === planCorrespondence && coreSample === sampleCorrespondence, "both engines load exactly the same planner and sampler");
const spines = [outline("plot", [[30, 90], [30, 5]], false, { partId: "y.spine" }), outline("plot", [[30, 90], [177, 90]], false, { partId: "x.spine" })];
const l = mergeChains(spines);
h.eq(l.length, 1, "(a) two spines merge into ONE chain");
h.eq(coords(l[0].nodes), [[30, 5], [30, 90], [177, 90]], "(a) reversed join keeps the exact three-node L and its corner");
h.eq(l[0].owner.members, [{ elementId: "plot", partId: "y.spine" }, { elementId: "plot", partId: "x.spine" }], "(a) both reveal owners survive merging");
const spinePlan = planCorrespondence([outline("path", [[0, 20], [40, 0], [80, 20]])], spines);
h.eq(spinePlan.destinations.length, 1, "(a) the public planner merges before pairing");
h.eq(spinePlan.pairs.length, 1, "(a) merged spines take one flight");
h.eq(coords(spines[0].nodes), [[30, 90], [30, 5]], "merging never mutates input geometry");
const bracket = mergeChains([outline("a", [[0, 0], [0, 40]]), outline("c", [[40, 0], [40, 40]]), outline("b", [[0, 0], [40, 0]])]);
h.ok(bracket.length === 1 && bracket[0].nodes.length === 4 && bracket[0].owner.members?.length === 3, "greedy joins revisit skipped chains");
h.eq(mergeChains([outline("a", [[0, 0], [100, 0]]), outline("b", [[100.8, 0], [200, 0]])]).length, 1, "default tolerance uses one percent of the shorter chain");
h.eq(mergeChains([outline("a", [[0, 0], [100, 0]]), outline("b", [[100.8, 0], [200, 0]])], 0.5).length, 2, "explicit epsilon overrides the default");

h.section("length tiling in both directions");
const single = outline("single", [[10, 20], [130, 20]]);
const disjoint = [outline("short", [[0, 0], [30, 0]]), outline("long", [[100, 70], [190, 70]])];
for (const reverse of [false, true]) {
  const p = planCorrespondence(reverse ? disjoint : [single], reverse ? [single] : disjoint, { pair: "tile" });
  const pieces = p.pairs.map((p) => reverse ? p.b! : p.a!);
  h.eq(pieces.length, 2, "(b) one chain tiles into two pieces");
  h.ok(near(len(pieces[0]), 30) && near(len(pieces[1]), 90), "(b) pieces are proportional to partner lengths in either direction");
  h.ok(near(pieces.reduce((sum, o) => sum + len(o), 0), len(single), 1e-6), "(b) tiling covers the full chain");
}
const ringTile = planCorrespondence([outline("rect", [[20, 20], [60, 20], [60, 60], [20, 60]], true)], disjoint, { pair: "tile" });
h.ok(near(ringTile.pairs.reduce((sum, p) => sum + len(p.a!), 0), 160, 1e-6), "ring tiles cover the full perimeter");
h.ok(ringTile.pairs.every((p) => !p.a!.closed), "ring tiles are open arcs");
// Oct-3: a FILLED ring keeps its interior while it splits among three or more
// partners — its open arcs fill only their chord segments, so the polygon
// between the chords rides along as one fill-only triangle per piece (centroid
// → the piece's ends), paired with the piece's own partner as a fill-only copy.
// Two partners need none (two chord-closed arcs already tile the shape).
const filledRing = outline("rect", [[20, 20], [60, 20], [60, 60], [20, 60]], true);
filledRing.paint = { ...filledRing.paint, fill: "#d95f02", stroke: "#100f0f", strokeWidth: 2 };
const three = [...disjoint, outline("third", [[100, 140], [130, 140]])];
for (const reverse of [false, true]) {
  const two = planCorrespondence(reverse ? disjoint : [filledRing], reverse ? [filledRing] : disjoint, { pair: "tile" });
  h.ok(two.pairs.length === 2 && two.pairs.every((q) => !(reverse ? q.b : q.a)!.closed), `filled ring ${reverse ? "merge" : "split"} into TWO partners: just the two chord-closed arcs`);
  const p = planCorrespondence(reverse ? three : [filledRing], reverse ? [filledRing] : three, { pair: "tile" });
  const fills = p.pairs.filter((q) => (reverse ? q.b : q.a)!.owner.role === "slice"), arcs = p.pairs.filter((q) => (reverse ? q.b : q.a)!.owner.role !== "slice");
  h.ok(p.pairs.length === 6 && fills.length === 3 && p.pairs.slice(0, 3).every((q) => fills.includes(q)), `filled ring ${reverse ? "merge" : "split"} into THREE: three fill triangles ride beneath the three arcs`);
  h.ok(near(arcs.reduce((sum, q) => sum + len(reverse ? q.b! : q.a!), 0), 160, 1e-6) && arcs.every((q) => !(reverse ? q.b : q.a)!.closed), `filled ring ${reverse ? "merge" : "split"}: the arcs still tile the whole perimeter`);
  const tris = fills.map((q) => (reverse ? q.b : q.a)!);
  h.ok(tris.every((t) => t.closed && t.nodes.length === 3 && t.paint.fill === "#d95f02" && t.paint.stroke === "none" && t.paint.strokeWidth === 0), `filled ring ${reverse ? "merge" : "split"}: triangles are closed, fill-only, the ring's fill`);
  const area = (pts: VectorNode[]) => Math.abs(pts.reduce((sum, a, i) => { const b = pts[(i + 1) % pts.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
  const chord = area(arcs.map((q) => (reverse ? q.b : q.a)!.nodes[0]));
  const covered = tris.reduce((sum, t) => sum + area(t.nodes), 0);
  h.ok(chord > 1 && covered > chord && covered < chord * 1.25, `filled ring ${reverse ? "merge" : "split"}: the OPAQUE triangles tile the chord polygon with a hair of overlap (${covered.toFixed(1)} over ${chord.toFixed(1)})`);
  const glassy = { ...filledRing, paint: { ...filledRing.paint, fill: "#d95f0280" } };
  const g = planCorrespondence(reverse ? three : [glassy], reverse ? [glassy] : three, { pair: "tile" });
  const gtris = g.pairs.slice(0, 3).map((q) => (reverse ? q.b : q.a)!);
  h.ok(near(gtris.reduce((sum, t) => sum + area(t.nodes), 0), chord, 1e-6) && gtris.every((t) => t.nodes.length === 3), `filled ring ${reverse ? "merge" : "split"}: a TRANSLUCENT fill's triangles tile the chord polygon exactly (an overlap would double-paint)`);
  h.ok(fills.every((q, i) => { const partner = reverse ? q.a! : q.b!, own = reverse ? arcs[i].a! : arcs[i].b!; return partner.owner.elementId === own.owner.elementId && partner.paint.stroke === "none" && partner.paint.strokeWidth === 0 && partner.paint.fill === "none"; }), `filled ring ${reverse ? "merge" : "split"}: each triangle pairs with a fill-only copy of its arc's own partner`);
  p.prepare();
  const sampled = sampleCorrespondence(p, 0.5);
  h.ok(sampled.slice(0, 3).every((q) => q.opacity === 1 && /^#d95f02[0-9a-f]{2}$/i.test(q.paint.fill) && parseInt(q.paint.fill.slice(7), 16) < 160 && parseInt(q.paint.fill.slice(7), 16) > 96), `filled ring ${reverse ? "merge" : "split"}: a triangle never fades as a leftover — its fill pours into the stroke partner, alpha halfway at t = .5 (${sampled[0].paint.fill})`);
  h.ok(sampleCorrespondence(p, 0).slice(0, 3).every((q) => q.paint.fill === (reverse ? "none" : "#d95f02")) && sampleCorrespondence(p, 1).slice(0, 3).every((q) => q.paint.fill === (reverse ? "#d95f02" : "none")), `filled ring ${reverse ? "merge" : "split"}: the triangles are exactly the ring's fill at its own end and nothing at the other`);
}
h.section("transform methods: dissolve · collapse · drain (the interior as ONE fill-only ring)");
for (const method of ["dissolve", "collapse", "drain"] as const) {
  for (const reverse of [false, true]) {
    const p = planCorrespondence(reverse ? three : [filledRing], reverse ? [filledRing] : three, { pair: "tile", method });
    const arcs = p.pairs.filter((q) => !q.interior), ring = p.pairs.find((q) => q.interior)!;
    const side = reverse ? ring.b! : ring.a!, other = reverse ? ring.a : ring.b;
    h.ok(p.pairs.length === 4 && p.pairs[0] === ring && other === null && side.closed && side.paint.fill === "#d95f02" && side.paint.stroke === "none" && ring.interior!.method === method, `${method} ${reverse ? "merge" : "split"}: one fill-only interior ring rides beneath three stroke-only arcs`);
    h.ok(arcs.every((q) => (reverse ? q.b : q.a)!.paint.fill === "none" && (reverse ? q.b : q.a)!.paint.stroke === "#100f0f") && near(arcs.reduce((sum, q) => sum + len(reverse ? q.b! : q.a!), 0), 160, 1e-6), `${method} ${reverse ? "merge" : "split"}: the arcs carry the stroke only and still tile the perimeter`);
    p.prepare();
    const at = (t: number) => sampleCorrespondence(p, t)[0];
    const W = { dissolve: 0.3, collapse: 0.45, drain: 0.45 }[method];
    const full = reverse ? 1 : 0, gone = reverse ? 0 : 1;
    const area = (pts: VectorNode[]) => Math.abs(pts.reduce((sum, a, i) => { const b = pts[(i + 1) % pts.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
    const s0 = at(full), s1 = at(gone), mid = at(reverse ? 1 - W / 2 : W / 2);
    h.ok(s0.opacity === 1 && near(area(s0.nodes), 1600, method === "drain" ? 40 : 1e-6) && s0.paint.fill === "#d95f02" && s0.paint.stroke === "none", `${method} ${reverse ? "merge" : "split"}: at its own end the interior is the whole ring's fill (area ${area(s0.nodes).toFixed(0)})`);
    h.ok(s1.opacity === 0 || area(s1.nodes) < 1e-6, `${method} ${reverse ? "merge" : "split"}: at the other end nothing of it remains`);
    if (method === "dissolve") h.ok(near(mid.opacity, 0.5, 1e-9) && near(area(mid.nodes), 1600, 1e-6), `dissolve ${reverse ? "merge" : "split"}: halfway through its window the whole ring is at half opacity`);
    if (method === "collapse") h.ok(mid.opacity === 1 && near(area(mid.nodes), 400, 1e-6) && near(mid.nodes.reduce((sx, n) => sx + n.x, 0) / 4, 40, 1e-9), `collapse ${reverse ? "merge" : "split"}: halfway the ring is half its size about its centre`);
    if (method === "drain") { const a2 = area(mid.nodes); h.ok(mid.opacity === 1 && a2 > 600 && a2 < 1000 && mid.nodes.every((n) => n.x >= 20 - 1e-6 && n.x <= 60 + 1e-6 && n.y >= 20 - 1e-6 && n.y <= 60 + 1e-6), `drain ${reverse ? "merge" : "split"}: halfway about half the ring remains, inside the ring, behind a straight front (area ${a2.toFixed(0)})`); }
    const beyond = at(reverse ? 1 - W - 0.1 : W + 0.1);
    h.ok(beyond.opacity === 0 || area(beyond.nodes) < 1e-6, `${method} ${reverse ? "merge" : "split"}: outside its window the interior is gone while the arcs still fly`);
  }
}
const kept = planCorrespondence([filledRing], three, { pair: "tile", method: "drain" }); kept.prepare();
const keptOut: ReturnType<typeof sampleCorrespondence> = [];
const firstNodes = sampleCorrespondence(kept, 0.2, keptOut)[0].nodes, firstNode = firstNodes[0];
h.ok(sampleCorrespondence(kept, 0.25, keptOut)[0].nodes === firstNodes && keptOut[0].nodes[0] === firstNode, "drain reuses its clipped node buffer (array and nodes) across frames");
h.eq(planCorrespondence([filledRing], three, { pair: "tile", method: "shatter" }).pairs.length, 6, "shatter stays the default geometry (three arcs + three wedges)");
h.eq(ringTile.pairs.length, 2, "an UNFILLED ring tiles with no fill pieces");
h.eq(planCorrespondence([outline("rect", [[20, 20], [60, 20], [60, 60], [20, 60]], true)], three, { pair: "tile" }).pairs.length, 3, "an UNFILLED ring into three partners: three arcs, nothing beneath");
h.section("seam overlap helpers");
h.ok(opaque({ ...paint, fill: "#d95f02" }) && opaque({ ...paint, fill: "#d95f02ff" }) && opaque({ ...paint, fill: "rgb(1, 2, 3)" }) && opaque({ ...paint, fill: "red" }), "opaque: hex, 8-digit ff, rgb(), named");
h.ok(!opaque({ ...paint, fill: "#d95f0280" }) && !opaque({ ...paint, fill: "rgba(1,2,3,.5)" }) && !opaque({ ...paint, fill: "oklch(60% .1 20 / 50%)" }) && !opaque({ ...paint, fill: "none" }) && !opaque({ ...paint, fill: "#d95f02", opacity: .8 }), "translucent: alpha hex, rgba, slash alpha, none, outline alpha");
const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const grown = expandPolygon(sq, 0.5);
h.ok(grown.every((p, i) => near(Math.abs(p.x - sq[i].x), 0.5, 1e-9) && near(Math.abs(p.y - sq[i].y), 0.5, 1e-9)) && grown[0].x < 0 && grown[2].x > 10, "a square grows outward by d on every side");
const rev = expandPolygon(sq.slice().reverse(), 0.5);
h.ok(near(rev[0].x, -0.5, 1e-9) && near(rev[0].y, 10.5, 1e-9) && near(rev[2].x, 10.5, 1e-9) && near(rev[2].y, -0.5, 1e-9), "winding does not change the outward direction");
const needle = expandPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0.01 }], 0.5);
h.ok(needle.every((p) => Math.hypot(p.x - (p.x < 50 ? 0 : 100), p.y) < 2), "a needle's mitres are capped");
h.section("differently painted touching chains never fuse");
const whisker = outline("plot", [[40, 30], [40, 50]], false, { partId: "before.whiskers" }), box = outline("plot", [[40, 50], [40, 70]], false, { partId: "before.box" }, { strokeWidth: 7, stroke: "#225da880" });
h.eq(mergeChains([whisker, box]).length, 2, "a 7-px half-alpha box stroke stays its own chain beside the 2-px whisker it touches");
h.eq(mergeChains([whisker, outline("plot", [[40, 50], [40, 70]], false, { partId: "before.whiskers" })]).length, 1, "same-paint touching chains still fuse");

h.section("data stations and complete union");
const sine = outline("sine", Array.from({ length: 49 }, (_, i) => [30 + i * 4, 60 + 24 * Math.sin(i / 48 * Math.PI * 2)]), false, { data: { x: 0 }, role: "line" });
const fit = { m: 192, c: 30, log: false };
const xs = [0.025, 0.06, 0.12, 0.18, 0.26, 0.38, 0.49, 0.56, 0.67, 0.78, 0.89, 0.97];
const points = xs.map((x, i) => ring(`p${i}`, 240 - i * 9, 150 + i % 3 * 8, x));
const data = planCorrespondence(points, [sine], { pair: "data", data: { destAxisFit: fit } });
const midpoints = data.pairs.map((p) => pointAt(parameterize(p.b!.nodes, false), 0.5));
h.eq(data.pairs.map((p) => p.a!.owner.data!.x), xs, "(c) stations follow data x despite reversed source positions");
h.ok(midpoints.every((p, i) => !i || p.x >= midpoints[i - 1].x), "(c) piece midpoints are monotone in projected x");
h.ok(midpoints.every((p, i) => Math.abs(p.x - (30 + 192 * xs[i])) <= 192 * Math.max(xs[i] - (xs[i - 1] ?? 0), (xs[i + 1] ?? 1) - xs[i])), "(c) every piece midpoint is within one neighbouring station spacing of its datum");
h.ok(near(data.pairs.reduce((sum, p) => sum + len(p.b!), 0), len(sine), 1e-6), "(c) sum of tiled lengths equals the whole sine chain within 1e-6");
for (let i = 1; i < data.pairs.length; i++) {
  const prev = data.pairs[i - 1].b!.nodes, next = data.pairs[i].b!.nodes;
  h.eq(coords([prev[prev.length - 1]]), coords([next[0]]), "(c) neighbouring tiles share exactly one boundary");
}
// Independent straight-chain oracle makes a biased midpoint split visibly red.
const axisChain = outline("axis", [[0, 0], [100, 0]], false, { data: { x: 0 } });
const uneven = planCorrespondence([ring("lo", 0, 80, 10), ring("mid", 10, 80, 40), ring("hi", 20, 80, 90)], [axisChain], { pair: "data", data: { destAxisFit: { m: 1, c: 0, log: false } } });
h.eq(uneven.pairs.map((p) => coords(p.b!.nodes)), [[[0, 0], [25, 0]], [[25, 0], [65, 0]], [[65, 0], [100, 0]]], "(c) boundaries are the exact MIDPOINTS between data stations, including full end tails");
const back = planCorrespondence([sine], points, { pair: "data", data: { sourceAxisFit: fit, destAxisFit: fit } });
h.ok(back.pairs.length === points.length && near(back.pairs.reduce((sum, p) => sum + len(p.a!), 0), len(sine), 1e-6), "data ↔ summary supports the reverse direction");
const bins = [outline("bin1", [[0, 0], [40, 0], [40, 40], [0, 40]], true, { role: "bar", data: { x: 20 } }), outline("bin2", [[60, 0], [100, 0], [100, 40], [60, 40]], true, { role: "box", data: { x: 80 } })];
const binPlan = planCorrespondence([ring("right", 0, 70, 80), ring("left", 100, 70, 20)], bins, { pair: "data", data: { destAxisFit: { m: 1, c: 0, log: false } } });
h.ok(binPlan.pairs.every((p) => p.a!.owner.data!.x === p.b!.owner.data!.x), "bars and boxes pair by containing data bin");
const repeated = planCorrespondence([ring("same1", 0, 40, 50), ring("same2", 10, 40, 50), ring("same3", 20, 40, 50)], [axisChain], { pair: "data", data: { destAxisFit: { m: 1, c: 0, log: false } } });
h.eq(repeated.pairs.map((p) => len(p.b!)), [50, 0, 50], "coincident data stations preserve full coverage and stable zero-length middle tiles");
const vertical = outline("vertical", [[40, 10], [40, 110]], false, { data: { y: 0 } });
const ys = [0, 0.5, 1].map((y, i) => ({ ...ring(`y${i}`, i * 10, 140), owner: { elementId: `y${i}`, data: { y } } }));
const yPlan = planCorrespondence(ys, [vertical], { data: { axis: "y", destAxisFit: { scale: "linear", domain: [0, 1], anchors: [{ data: 0, svg: 10 }, { data: 1, svg: 110 }] } } });
h.ok(yPlan.policy === "data" && yPlan.pairs.length === 3 && near(yPlan.pairs.reduce((sum, p) => sum + len(p.b!), 0), 100), "y data and manifest anchors use the shared axisFit projection");
const logPoints = [1, 10, 100].map((x, i) => ring(`log${i}`, i * 10, 80, x));
const logPlan = planCorrespondence(logPoints, [axisChain], { pair: "data", data: { destAxisFit: { m: 100 / Math.log(100), c: 0, log: true } } });
h.ok(near(logPlan.pairs[0].b!.nodes.at(-1)!.x, 25) && near(logPlan.pairs[1].b!.nodes.at(-1)!.x, 75), "log fits project each source datum before cutting midpoint stations");

h.section("leftovers, policies and crossfades");
const a3 = [0, 20, 40].map((x, i) => ring(`a${i}`, x, 0));
const b4 = [0, 20, 40, 60].map((x, i) => ring(`b${i}`, x, 30));
const leftover = planCorrespondence(a3, b4, { pair: "spatial" }); leftover.prepare();
h.eq(leftover.pairs.filter((p) => !p.a && !!p.b).length, 1, "(d) 3↔4 leaves exactly one destination-only outline");
const li = leftover.pairs.findIndex((p) => !p.a);
h.ok([0, 0.2, 0.6].every((t) => sampleCorrespondence(leftover, t)[li].opacity === 0) && sampleCorrespondence(leftover, 1)[li].opacity === 1, "(d) destination leftover envelope is zero through 0.6 and one at 1");
h.ok(near(sampleCorrespondence(leftover, 0.8)[li].opacity, 0.5), "destination leftover fades linearly");
const fade = planCorrespondence(b4, a3, { pair: "spatial" }); fade.prepare();
const fi = fade.pairs.findIndex((p) => !p.b);
h.ok(sampleCorrespondence(fade, 0)[fi].opacity === 1 && near(sampleCorrespondence(fade, 0.2)[fi].opacity, 0.5) && sampleCorrespondence(fade, 0.4)[fi].opacity === 0, "source leftover uses the first 40 percent");
const indexed = a3.map((o, i) => ({ ...o, owner: { ...o.owner, index: 2 - i } }));
h.eq(choosePolicy(points, [sine], { destAxisFit: fit }), "data", "(h) auto chooses data with a shared variable and fit");
h.eq(choosePolicy(indexed, indexed), "order", "(h) auto chooses order for indexed equal counts");
h.eq(choosePolicy(a3, [single]), "tile", "(h) auto chooses tile for a singleton");
h.eq(choosePolicy(a3, b4), "spatial", "(h) auto chooses spatial otherwise");
h.eq(choosePolicy(points, [sine]), "tile", "auto requires a supplied destination fit before choosing data");
h.eq(planCorrespondence(indexed, indexed, { pair: "order" }).pairs.map((p) => p.a!.owner.index), [0, 1, 2], "order sorts by index");
h.eq(planCorrespondence(a3, b4, { pair: "order" }).policy, "spatial", "unequal order counts use spatial pairing");
const text = outline("text", [[10, 10], [70, 10], [70, 30], [10, 30]], true, {}, { text: true });
const crossfade = planCorrespondence([text], [a3[0]]).pairs[0];
h.ok(crossfade.crossfade === true && !crossfade.plan, "(i) non-outline pair exposes crossfade, never a path plan");
h.eq(crossfade.boxes, { a: text.bbox, b: a3[0].bbox }, "(i) crossfade retains both endpoint bboxes");
h.eq(planCorrespondence([], []).pairs, [], "empty inputs remain empty");
const mutable = outline("mutable", [[20, 30], [80, 30]]), original = structuredClone(mutable);
const saved = planCorrespondence([mutable], [single]); saved.prepare();
mutable.nodes[0].x = 10; mutable.bbox = nodesExtent(mutable.nodes);
const edited = planCorrespondence([mutable], [single]);
const again = planCorrespondence([original], [single]);
h.ok(edited !== saved && again === saved, "batch keys invalidate edits and retain a warm prior geometry");
h.eq(coords(sampleCorrespondence(again, 0)[0].nodes), coords(original.nodes), "cached plans own snapshots independent of mutable producer arrays");
const ranked = planCorrespondence(Array.from({ length: 70 }, (_, i) => ring(`rankA${i}`, (69 - i) * 20, 0)), Array.from({ length: 70 }, (_, i) => ring(`rankB${i}`, i * 20, 50)), { pair: "spatial" });
h.ok(ranked.pairs.every((p) => p.a!.bbox.x === p.b!.bbox.x), "large spatial products pair deterministically by x rank");
const largeSource = a3.map((o) => ({ ...o, bbox: { ...o.bbox, w: 13 } }));
h.eq(planCorrespondence(Array.from({ length: 65 }, (_, i) => ({ ...largeSource[i % 3], owner: { elementId: `wide${i}` } })), [single]).driver, "path", "glyph driver refuses a source ring wider than 12 stage pixels");

h.section("1↔1 compatibility, sampler and no frame planning");
const rect = outline("rect", [[11, 17], [131, 17], [131, 77], [11, 77]], true, {}, { fill: "#dd4422", dash: [2, 1, 3] });
const ellipse = outline("ellipse", [[290, 90], [250, 120], [210, 90], [250, 60]], true, {}, { fill: "#2244dd", strokeWidth: 5, cap: "butt", dash: [5, 2] });
const k = 0.5522847498307936;
ellipse.nodes.forEach((n, i) => {
  const incoming = [[0, -30 * k], [40 * k, 0], [0, 30 * k], [-40 * k, 0]][i];
  n.hIn = { dx: incoming[0], dy: incoming[1] }; n.hOut = { dx: -incoming[0], dy: -incoming[1] }; n.type = "smooth";
});
for (const [a, b] of [[rect, ellipse], [single, rect]]) {
  const p = planCorrespondence([a], [b]);
  const pp = p.pairs[0].plan!;
  h.ok(typeof Object.getOwnPropertyDescriptor(pp, "a")?.get === "function" && typeof Object.getOwnPropertyDescriptor(pp, "b")?.get === "function", "pair chains stay lazy getters");
  let refused = false;
  try { sampleCorrespondence(p, 0.25); } catch (e) { refused = String(e).includes("prepare()"); }
  h.ok(refused, "sampling cannot trigger lazy geometry planning on the frame path");
  const direct = planOutlines(local(a), a.bbox.w, a.bbox.h, local(b), b.bbox.w, b.bbox.h, pp.strategy);
  p.prepare();
  h.ok(pp.a === direct.a && pp.b === direct.b && pp.closed === direct.closed, "(e) pair correspondence is the SAME arrays/topology as direct planOutlines");
  const out = sampleCorrespondence(p, 0);
  h.eq(coords(out[0].nodes), coords(a.nodes), "(g) t=0 returns exact authored source nodes");
  const path = out[0], start = out[0].nodes;
  h.ok(sampleCorrespondence(p, 1, out) === out && out[0] === path, "(g) sampling retains the out array and path object");
  h.eq(out[0].nodes, b.nodes.map((n) => ({ ...n, hIn: n.hIn && { ...n.hIn }, hOut: n.hOut && { ...n.hOut } })), "(g) t=1 returns exact destination nodes and handles");
  sampleCorrespondence(p, 0.35, out);
  const ns = out[0].nodes, n0 = ns[0], hi = ns.find((n) => n.hIn)?.hIn, dash = out[0].paint.dash;
  const expected = sampleNodes(pp.a, pp.b, 0.35, a.bbox.w + (b.bbox.w - a.bbox.w) * 0.35, a.bbox.h + (b.bbox.h - a.bbox.h) * 0.35);
  h.ok(ns.every((n, i) => near(n.x, expected[i].x + a.bbox.x + (b.bbox.x - a.bbox.x) * 0.35) && near(n.y, expected[i].y + a.bbox.y + (b.bbox.y - a.bbox.y) * 0.35)), "unit correspondence is placed exactly in the interpolated stage bbox");
  h.eq(out[0].paint.fill, lerpColor(a.paint.fill, b.paint.fill, 0.35), "paint uses the shared OKLab interpolator");
  h.eq(dash, lerpDash(a.paint.dash, b.paint.dash, 0.35), "paint uses the shared dash interpolator");
  sampleCorrespondence(p, 0.72, out);
  h.ok(ns === out[0].nodes && n0 === ns[0] && hi === ns.find((n) => n.hIn)?.hIn && dash === out[0].paint.dash, "frame samples reuse nodes, handles and dash buffers");
  sampleCorrespondence(p, 0, out);
  h.ok(start === out[0].nodes, "reverse seek reuses the exact source endpoint buffer");
  sampleCorrespondence(p, 0.35, out);
  h.ok(ns === out[0].nodes, "intermediate buffer survives endpoint seeks");
}
const curved = { ...ellipse, closed: false, owner: { elementId: "curve-tile" } };
const curvedTiles = planCorrespondence([curved], disjoint, { pair: "tile" }).pairs.map((p) => p.a!);
h.ok(curvedTiles.every((p) => p.nodes.some((n) => n.hIn || n.hOut)), "curved tiles retain Bézier handles");
const probes = curvedTiles.flatMap((o) => Array.from({ length: 21 }, (_, i) => pointAt(parameterize(o.nodes, false), i / 20)));
h.ok(probes.every((p) => Math.abs(((p.x - 250) / 40) ** 2 + ((p.y - 90) / 30) ** 2 - 1) < 0.001), "curved tiling preserves the ellipse geometry instead of replacing it by chords");
const paints = ["none", "transparent", "#abcdef", "#1234", "rgba(8, 90, 180, 0.4)", "var(--accent)"];
for (const a of paints) for (const b of paints) {
  const prepared = prepareColorLerp(a, b);
  h.ok([0, 0.125, 0.4, 0.5, 0.875, 1].every((t) => lerpColor(a, b, t, prepared) === lerpColor(a, b, t)), "prepared paints preserve the color core's exact results");
}

h.section("cold-path geometry stays exact");
// Recorded from C2 @ ddbdff3 before hoisting the invariant search stations.
// Keep the old chains: comparing two callers of today's planner cannot catch drift.
const coldOracle = JSON.parse(readFileSync(new URL("./fixtures/correspondence-cold.json", import.meta.url), "utf8")) as {
  cases: { name: string; a: StageOutline; b: StageOutline; expected: ReturnType<typeof planOutlines> }[];
};
let maxDeviation = 0;
for (const { name, a, b, expected } of coldOracle.cases) {
  const p = planCorrespondence([a], [b], { pair: "spatial" }); p.prepare();
  const actual = p.pairs[0].plan!;
  h.ok(JSON.stringify({ a: actual.a, b: actual.b, closed: actual.closed }) === JSON.stringify(expected), `${name}: old planner's nodes, handles, seam and winding are byte-identical`);
  const out = sampleCorrespondence(p, 0.125);
  const path = out[0], nodes = path.nodes, identities = nodes.map(n => [n, n.hIn, n.hOut]);
  let deviation = 0;
  for (const t of [0.125, 0.5, 0.875]) {
    sampleCorrespondence(p, t, out);
    const oldNodes = sampleNodes(expected.a, expected.b, t, a.bbox.w + (b.bbox.w - a.bbox.w) * t, a.bbox.h + (b.bbox.h - a.bbox.h) * t);
    for (const n of oldNodes) { n.x += a.bbox.x + (b.bbox.x - a.bbox.x) * t; n.y += a.bbox.y + (b.bbox.y - a.bbox.y) * t; }
    const oldPath = parameterize(oldNodes, expected.closed), newPath = parameterize(out[0].nodes, out[0].closed);
    for (let i = 0; i < 1000; i++) {
      const oldPoint = pointAt(oldPath, i / 999), newPoint = pointAt(newPath, i / 999);
      deviation = Math.max(deviation, Math.hypot(oldPoint.x - newPoint.x, oldPoint.y - newPoint.y));
    }
  }
  maxDeviation = Math.max(maxDeviation, deviation);
  h.ok(deviation <= 0.25, `${name}: 1,000 stations at each of three flight times deviate by ${deviation} stage px (≤0.25)`);
  // Planning changes must never allocate new geometry on repeated frame seeks.
  for (let i = 0; i < 1000; i++) sampleCorrespondence(p, 0.01 + (i % 99) / 100, out);
  h.ok(path === out[0] && nodes === out[0].nodes && identities.every(([n, hi, ho], i) => n === nodes[i] && hi === nodes[i].hIn && ho === nodes[i].hOut), `${name}: 1,000 frame seeks retain every path, node and handle`);
}
console.log(`old-planner maximum sampled deviation: ${maxDeviation} stage px`);

h.section("1,200-marker warm planning budget");
const dense = Array.from({ length: 1200 }, (_, i) => ring(`dense${i}`, i % 100 * 5, 200 + Math.floor(i / 100) * 5, i / 1199));
const opts = { pair: "data" as const, data: { destAxisFit: fit } };
const coldStart = performance.now();
const warm = planCorrespondence(dense, [sine], opts); warm.prepare();
console.log(`cold plan + prepare: ${(performance.now() - coldStart).toFixed(2)} ms`);
// A cache MISS with warm code: shift every ring by a sub-pixel so the batch key differs.
const dense2 = dense.map((o) => ({ ...o, nodes: o.nodes.map((n) => ({ ...n, x: n.x + 0.001 })), bbox: { ...o.bbox, x: o.bbox.x + 0.001 } }));
const start = performance.now();
const large = planCorrespondence(dense2, [sine], opts); large.prepare();
const ms = performance.now() - start;
// Warm-hook work (never a frame): what remains is the exact batch key (~3 ms), the protective
// input clone (~7 ms) and the data pairing itself; 40 ms leaves headroom for a loaded machine.
h.ok(ms <= 40, `(f) 1,200-ring plan including prepare, warm code but a cache MISS: ${ms.toFixed(2)} ms ≤ 40 ms (glyph pairs plan no outline correspondence)`);
h.ok(large.pairs.every((p) => !p.plan), "(f) glyph pairs carry landings only — no per-pair outline plan to prepare");
const hitStart = performance.now();
planCorrespondence(dense2, [sine], opts).prepare();
h.ok(performance.now() - hitStart <= 5, "(f) a repeated plan is a cache hit");
h.eq(large.driver, "glyph", "(f) large small-ring set selects glyph flights");
h.ok(large.pairs.length === 1200 && large.pairs.every((p) => p.landing && p.landing.x >= sine.bbox.x && p.landing.x <= sine.bbox.x + sine.bbox.w && near(p.landing.scale, 0.5)), "(f) every marker has an on-curve landing and stroke-to-marker scale");
h.ok(large.pairs.every((p) => {
  const q = p.landing!;
  // Sine fixture consists of straight links: interpolate its owning segment.
  const index = Math.min(47, Math.floor((q.x - 30) / 4));
  const a = sine.nodes[index], b = sine.nodes[index + 1];
  return near(q.y, a.y + (b.y - a.y) * (q.x - a.x) / (b.x - a.x), 1e-7);
}), "(f) landing points lie on the actual destination chain");
h.ok(large.pairs.every((p) => near(p.landing!.x, 30 + 192 * p.a!.owner.data!.x!, 1e-7)), "glyphs land at their own data station, including endpoint tails");
h.eq(GLYPH_FLIGHT_THRESHOLD, 64, "glyph threshold is pinned at 64");
await h.done();
