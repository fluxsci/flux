// Animation v2 B2/B3: real public planner + sampler, hand-written stage fixtures.
import { harness } from "./lib/harness.mjs";
import { planCorrespondence, sampleCorrespondence, mergeChains, choosePolicy, GLYPH_FLIGHT_THRESHOLD } from "../src/lib/slide/correspondence";
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

h.section("1,200-marker warm planning budget");
const dense = Array.from({ length: 1200 }, (_, i) => ring(`dense${i}`, i % 100 * 5, 200 + Math.floor(i / 100) * 5, i / 1199));
const opts = { pair: "data" as const, data: { destAxisFit: fit } };
const coldStart = performance.now();
const warm = planCorrespondence(dense, [sine], opts); warm.prepare();
console.log(`cold plan + prepare: ${(performance.now() - coldStart).toFixed(2)} ms`);
const start = performance.now();
const large = planCorrespondence(dense, [sine], opts); large.prepare();
const ms = performance.now() - start;
h.ok(ms <= 15, `(f) 1,200-ring plan including prepare after ONE warm run: ${ms.toFixed(2)} ms ≤ 15 ms`);
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
