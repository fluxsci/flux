#!/usr/bin/env -S npx tsx
// MORPH-PATH (WP 2.1, T5 (1)-(3)): same-kind RING alignment (H2; open chains keep their authored pairing),
// compound paths, set pairing without crossings (M3), the content-keyed alignment memo and its warm hook.
// Pure tier. Run: npx tsx scripts/verify-morph-path.ts
// WP 3.3 (T5 (4)-(6)): arcs on hand-off / set flights (one centre-based law, the band and fixed heads ride it), Suggest arcs, the opt-in
// rigid turn.
import { lerpElement, lerpNodes, lerpCompoundD, warmSlideMorphs, rigidSegment, turnOf, arcBox } from "../src/lib/slide/tween";
import { alignChains, planElementMorph, sampleElementMorph, compoundRings } from "../src/lib/slide/outline";
import { pathToSubpaths } from "../src/lib/path";
import { planCorrespondence, sampleCorrespondence, assignMinCost, greedyAssign, arcOffset, planBends } from "../src/lib/slide/correspondence";
import { suggestArcs, collidingFlights, suggestBeatArcs, ARC_CANDIDATES } from "../src/lib/slide/arcSuggest";
import { elementStageOutlines } from "../src/lib/slide/targetGeometry";
import { createDeck, addSlide, addElement, addBeat, setTransform, setTrackArc, suggestArcsForBeat, setTrackTurn } from "../src/lib/slide/ops";
import { harness } from "./lib/harness.mjs";
import type { VectorNode } from "../src/lib/types";
const h = harness("verify-morph-path");
const N = (pts: number[][]): VectorNode[] => pts.map(([x, y]) => ({ x, y, type: "corner" as const }));
const d = (n: VectorNode[], closed: boolean) => "M " + n.map((p) => `${p.x} ${p.y}`).join(" L ") + (closed ? " Z" : "");
const path = (nodes: VectorNode[], closed = true): any => ({ type: "path", id: "p", x: 0, y: 0, width: 400, height: 400, rotation: 0, d: d(nodes, closed), nodes, fill: "#000", stroke: "#000", strokeWidth: 1, closed });
const area = (n: { x: number; y: number }[]) => { let a = 0; for (let i = 0; i < n.length; i++) { const p = n[i], q = n[(i + 1) % n.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };
const hex = (rev = false) => { const p = Array.from({ length: 6 }, (_, i) => [200 + 150 * Math.cos(i * Math.PI / 3), 200 + 150 * Math.sin(i * Math.PI / 3)]); return N(rev ? p.slice().reverse() : p); };
const shift = <T,>(a: T[], k: number) => [...a.slice(k), ...a.slice(0, k)];
const minAreaRatio = (A: VectorNode[], B: VectorNode[]) => {
  const a = path(A), b = path(B); let min = Infinity;
  for (let i = 1; i < 100; i++) { const t = i / 100, m = lerpElement(a, b, t, t) as any; min = Math.min(min, Math.abs(area(m.nodes)) / (Math.abs(area(A)) + (Math.abs(area(B)) - Math.abs(area(A))) * t)); }
  return min;
};
const ring = (n: number, r: number, wob: number) => N(Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n, rr = r * (1 + wob * Math.sin(5 * a)); return [200 + rr * Math.cos(a), 200 + rr * Math.sin(a)]; }));

h.section("H2: same-kind ring alignment");
h.ok(minAreaRatio(hex(), shift(hex(), 3)) > 0.98, "hexagon vs itself started 3 nodes later never loses area (was 0 at t = .5)");
h.ok(minAreaRatio(hex(), hex(true)) > 0.98, "hexagon vs its reversed winding never loses area");
h.ok(minAreaRatio(hex(), shift(hex(true), 1)) > 0.98, "shift 1 + reversed");
const sq = N([[100, 100], [300, 100], [300, 300], [100, 300]]);
h.ok(minAreaRatio(sq, N([[300, 300], [300, 100], [100, 100], [100, 300]])) > 0.98, "reversed-start square keeps its area");
{ const tri = N([[100, 300], [200, 100], [300, 300]]);
  h.ok(minAreaRatio(sq, tri) > 0.99, "square -> triangle (start at BL) has no area dip below the lerp of the areas (was .58)");
  const drag = N([[100, 100], [300, 100], [380, 330], [100, 300]]), m = lerpElement(path(sq), path(drag), .5, .5) as any;
  h.ok(sq.every((p, i) => Math.abs(m.nodes[i].x - (p.x + drag[i].x) / 2) < 1e-9 && Math.abs(m.nodes[i].y - (p.y + drag[i].y) / 2) < 1e-9), "an authored edit (drag one corner) keeps the index pairing exactly");
  // OPEN chains keep their authored pairing: bonds and rungs share end points with neighbours, and arrowhead /
  // dash / gradient direction belong to the end element, so a reversed open twin is NOT re-paired.
  const open = path(N([[50, 50], [200, 300], [350, 60]]), false), flip = path(N([[350, 60], [200, 300], [50, 50]]), false);
  const mo = lerpElement(open, flip, .5, .5) as any;
  h.ok(open.nodes.every((p: any, i: number) => Math.abs(mo.nodes[i].x - (p.x + flip.nodes[i].x) / 2) < 1e-12 && Math.abs(mo.nodes[i].y - (p.y + flip.nodes[i].y) / 2) < 1e-12), "an open path vs its reversed twin keeps the authored index pairing (byte-equal to the plain lerp)");
  const tip = path(N([[50, 50], [200, 380], [350, 60]]), false), mt = lerpElement(open, tip, .5, .5) as any;
  h.ok(Math.abs(mt.nodes[1].y - 340) < 1e-9, "an open authored edit keeps its direction");
  const e0 = lerpElement(path(sq), path(tri), 0.000001, 0.000001) as any;
  h.ok(Math.abs(Math.abs(area(e0.nodes)) - 40000) < 5, "t -> 0 is the authored pre shape (area)");
  // alignChains itself: open chains are never re-paired, closed ones are, and the gain threshold is 0.8x
  const oa = N([[0, 0], [100, 0], [100, 100]]), ob = N([[100, 100], [100, 0], [0, 0]]);
  h.eq(JSON.stringify(alignChains(oa, ob, false)), JSON.stringify({ a: oa, b: ob, reversed: false }), "alignChains(open, equal counts) returns the chains untouched");
  const ra = alignChains(sq, N([[300, 300], [300, 100], [100, 100], [100, 300]]), true);
  h.ok(ra.reversed && ra.b.every((p, i) => Math.abs(p.x - sq[i].x) < 1e-9 && Math.abs(p.y - sq[i].y) < 1e-9), "alignChains(closed) re-pairs a reversed-start square onto the identity pairing");
  const near = N([[110, 100], [300, 100], [300, 300], [100, 300]]); // a mildly dragged corner: the identity is already the cheapest
  h.ok(!alignChains(sq, near, true).reversed && alignChains(sq, near, true).b.every((p, i) => p.x === near[i].x && p.y === near[i].y), "an alternative pairing that is not 0.8x cheaper is not taken");
}

h.section("H2f: a dashed ring keeps its authored pairing (its dashes start at node 0 and cannot be re-phased)");
{ const rs = N([[300, 300], [300, 100], [100, 100], [100, 300]]);
  const plain = lerpElement(path(sq), path(rs), .5, .5) as any, dashed = lerpElement({ ...path(sq), dash: [10, 6] }, { ...path(rs), dash: [10, 6] }, .5, .5) as any;
  const idx = sq.map((p, i) => ({ x: (p.x + rs[i].x) / 2, y: (p.y + rs[i].y) / 2 }));
  h.ok(Math.abs(area(plain.nodes)) > 30000, "an undashed reversed-start square is re-paired (area kept)");
  h.ok(dashed.nodes.every((p: any, i: number) => Math.abs(p.x - idx[i].x) < 1e-9 && Math.abs(p.y - idx[i].y) < 1e-9), "a dashed reversed-start square keeps the plain index pairing (no re-seam, so no dash-phase snap at the landing)");
  const one = lerpElement(path(sq), { ...path(rs), dash: [10, 6] }, .5, .5) as any;
  h.ok(one.nodes.every((p: any, i: number) => Math.abs(p.x - idx[i].x) < 1e-9), "a dash on EITHER end is enough");
  const e1 = lerpElement({ ...path(sq), dash: [10, 6] }, { ...path(rs), dash: [10, 6] }, .999999, .999999) as any;
  h.ok(Math.abs(e1.nodes[0].x - rs[0].x) < 1e-3 && Math.abs(e1.nodes[0].y - rs[0].y) < 1e-3, "and the frame before the landing starts where the resting path starts");
}

h.section("H2c: the owner's real bonds and DNA rungs lerp exactly as before");
{ // 2-node open sticks from the DNA slide (rung flips through zero length) and the Beckmann deck (bonds sharing vertices)
  const pairs: [string, string][] = [["M 0 16.971 L 0 0", "M 0 0 L 0 26"], ["M 0 40 L 0 0", "M 0 38.918 L 8.881 0"], ["M 34.641 0 L 0 20", "M 39.911 0 L 0 0"], ["M 0 0 L 0 0", "M 0 0 L 5.3 1.116"]];
  let worst = 0;
  for (const [pa, pb] of pairs) {
    const mk = (dd: string): any => { const n = dd.match(/-?[\d.]+/g)!.map(Number); return { ...path(N([[n[0], n[1]], [n[2], n[3]]]), false), d: dd, nodes: undefined, width: 40, height: 40 }; };
    const A = mk(pa), B = mk(pb), na = A.d.match(/-?[\d.]+/g)!.map(Number), nb = B.d.match(/-?[\d.]+/g)!.map(Number);
    for (const t of [.1, .25, .5, .75, .9]) {
      const m = lerpElement(A, B, t, t) as any, got = m.d.match(/-?[\d.e-]+/g)!.map(Number);
      na.forEach((v: number, i: number) => { worst = Math.max(worst, Math.abs(got[i] - (v + (nb[i] - v) * t))); });
    }
  }
  h.ok(worst < 1e-3, `4 real 2-node sticks equal the plain index lerp at 5 phases (max deviation ${worst.toExponential(1)})`);
  // an open chain of UNEQUAL counts keeps today's split-at-the-union pairing too (no alignment, no memo)
  const o2 = path(N([[0, 0], [100, 0]]), false), o3 = path(N([[0, 0], [60, 40], [100, 0]]), false);
  const split = lerpNodes(o2.nodes, o3.nodes, false, .5);
  h.ok(split.length === 3 && Math.abs(split[1].x - 58.0196) < 1e-3 && Math.abs(split[1].y - 20) < 1e-9, "an open chain with unequal counts still splits at the union of stations (a straight edge gains the corner it will need)");
}

h.section("H2d: unequal-count rings align cheaply and the memo is content-keyed");
{ const A = path(ring(200, 100, .1)), B = path(ring(300, 120, .2));
  const t0 = performance.now(); lerpElement(A, B, .5, .5); const cold = performance.now() - t0;
  const t1 = performance.now(); lerpElement(structuredClone(A), structuredClone(B), .5, .5); const fresh = performance.now() - t1;
  h.ok(cold < 60, `cold unequal-count ring align 200 -> 300 nodes ${cold.toFixed(1)} ms < 60 ms (measured ~3 ms; the bound is generous for CI noise)`);
  h.ok(fresh < Math.max(15, cold * 2), `fresh structuredClone inputs hit the memo (${fresh.toFixed(1)} ms): keyed by content, not identity`);
  const rot = ring(200, 100, .1), rot2 = [...rot.slice(37), ...rot.slice(0, 37)];
  h.ok(minAreaRatio(rot, rot2) > 0.98, "a 200-node ring vs itself started 37 nodes later keeps its area");
  // an editor that mutates a chain IN PLACE must never read a stale alignment out of the memo: the memo
  // holds its own copies, and the lookup compares full coordinates
  const a = hex(), b = shift(hex(true), 2);
  const before = JSON.stringify(lerpNodes(a, b, true, .5));
  const bMut = structuredClone(b); bMut[0].x += 40; bMut[3].y -= 25;
  const afterMut = JSON.stringify(lerpNodes(a, bMut, true, .5));
  h.ok(afterMut !== before, "a ring edited in place gets a fresh alignment, never the stale memo entry");
  b[0].x += 40; b[3].y -= 25; // mutate the ORIGINAL arrays the first call saw
  h.eq(JSON.stringify(lerpNodes(a, b, true, .5)), afterMut, "mutating the first call's own arrays in place cannot poison the memo (same content as bMut -> same frame)");
  // a re-seamed (shifted, equal-count) pair is a new ARRAY of the caller's node OBJECTS: the memo must copy those too
  const sa = hex(), sb = shift(hex(), 2), frame0 = JSON.stringify(lerpNodes(sa, sb, true, .5));
  for (const p of sb) { p.x += 77; p.y -= 31; } // in-place edit of the very objects the memo was filled from
  h.eq(JSON.stringify(lerpNodes(hex(), shift(hex(), 2), true, .5)), frame0, "mutating the node OBJECTS of a re-seamed (shift-only) equal-count ring in place cannot poison the memo");
  const back = structuredClone(hex()), again = lerpNodes(hex(), shift(hex(true), 2), true, .5);
  h.eq(JSON.stringify(again), before, "the original content still answers with the original frame after the edits");
  void back;
}

h.section("H2g: a big equal-count ring aligns in bounded time (no O(n^2) first frame)");
{ const A = ring(5000, 100, .1), B = shift(A.slice().reverse(), 1234).map((p) => ({ ...p }));
  const t0 = performance.now(); const al = alignChains(A, B, true); const cold = performance.now() - t0;
  h.ok(cold < 30, `5000-node equal ring cold align ${cold.toFixed(1)} ms < 30 ms (the exhaustive 2n x n search took ~214 ms)`);
  h.ok(al.reversed && al.b.every((p, i) => Math.abs(p.x - A[i].x) < 1e-9 && Math.abs(p.y - A[i].y) < 1e-9), "and it still finds the exact seam and direction of a shifted + reversed ring");
  const C = shift(A, 1234).map((p) => ({ ...p })), al2 = alignChains(A, C, true);
  h.ok(!al2.reversed && al2.b.every((p, i) => Math.abs(p.x - A[i].x) < 1e-9 && Math.abs(p.y - A[i].y) < 1e-9), "a 5000-node ring started 1234 nodes later is re-seamed back onto the identity pairing");
  const near = A.map((p, i) => (i === 0 ? { ...p, x: p.x + 5 } : { ...p })), al3 = alignChains(A, near, true);
  h.ok(!al3.reversed && al3.b.every((p, i) => p.x === near[i].x && p.y === near[i].y), "a big ring with one mildly dragged node keeps its authored pairing (0.8x gate against the exact identity cost)");
}

h.section("H2e: seek purity (forward == reverse == shuffled)");
{ const A = path(ring(60, 100, .15)), B = path(shift(ring(90, 110, .05), 17).reverse());
  const ts = Array.from({ length: 41 }, (_, i) => i / 40), at = (t: number) => JSON.stringify((lerpElement(A, B, t, t) as any).nodes);
  const fwd = ts.map(at), rev = ts.slice().reverse().map(at).reverse();
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const order = ts.map((_, i) => i).sort(() => rnd() - .5), shuf: string[] = []; for (const i of order) shuf[i] = at(ts[i]);
  h.ok(fwd.every((s, i) => s === rev[i] && s === shuf[i]), "a ring Change samples identically forward, backward and shuffled (the alignment is a pure function of the chains)");
}

h.section("H2b: compound paths keep their subpaths");
{ const D = (hx: number) => `M 0 0 L 160 0 L 160 160 L 0 160 Z M ${hx} 40 L ${hx} 120 L ${hx + 40} 120 L ${hx + 40} 40 Z`;
  const mk = (dd: string) => ({ ...path(sq), d: dd, nodes: undefined, width: 160, height: 160 });
  const m = lerpElement(mk(D(40)), mk(D(80)), .5, .5) as any;
  h.eq((m.d.match(/M/g) ?? []).length, 2, "two subpaths in, two subpaths out (was one chain with a phantom bridge)");
  h.ok(m.nodes === undefined, "the compound frame carries no flattened chain that would re-bridge the subpaths");
  const solid = lerpElement(mk(D(40)), mk("M 0 0 L 160 0 L 160 160 L 0 160 Z"), .75, .75) as any;
  h.eq((solid.d.match(/M/g) ?? []).length, 2, "a hole with no partner collapses in place instead of vanishing");
  // a hole keeps its winding relative to its outline for the whole flight (nonzero fill: a flipped hole fills in)
  const sub = (dd: string) => dd.split("M").filter(Boolean).map((p) => { const n = p.match(/-?[\d.e-]+/g)!.map(Number), pts = []; for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] }); return area(pts); });
  const holeRev = `M 0 0 L 160 0 L 160 160 L 0 160 Z M 40 40 L 40 120 L 120 120 L 120 40 Z`, holeRev2 = `M 0 160 L 160 160 L 160 0 L 0 0 Z M 120 40 L 120 120 L 40 120 L 40 40 Z`;
  let flips = 0;
  for (let i = 1; i < 100; i++) { const [outer, hole] = sub((lerpElement(mk(holeRev), mk(holeRev2), i / 100, i / 100) as any).d); if (Math.sign(outer) === Math.sign(hole)) flips++; }
  h.eq(flips, 0, "a compound path's hole keeps its winding opposite to the outline at every sample (reversed-start partner)");
  // pairing is largest-area first whatever the order in the string: the hole listed FIRST still pairs with the hole
  const holeFirst = `M 40 40 L 40 120 L 120 120 L 120 40 Z M 0 0 L 160 0 L 160 160 L 0 160 Z`, holeFirst2 = `M 60 60 L 60 100 L 100 100 L 100 60 Z M 0 0 L 160 0 L 160 160 L 0 160 Z`;
  const areas = (dd: string) => sub(dd).map(Math.abs);
  const mid = areas((lerpElement(mk(holeFirst), mk(holeFirst2), .5, .5) as any).d);
  h.ok(Math.abs(mid[0] - 3600) < 1 && Math.abs(mid[1] - 25600) < 1, `subpaths pair by area, not by position in the string (hole ${mid[0].toFixed(0)}, outline ${mid[1].toFixed(0)})`);
  h.ok(Math.abs(areas((lerpElement(mk(D(40)), mk(D(80)), .999999, .999999) as any).d)[0] - 25600) < 1, "the frame just before the landing keeps the END's subpath order (a dash pattern runs on through subpaths in `d` order)");
  // a partnerless subpath is a collapsed point at ITS end of the flight: at that end it is not in the resting d, so not in the frame
  const donut = D(40), plain = "M 0 0 L 160 0 L 160 160 L 0 160 Z";
  h.eq((lerpCompoundD(donut, plain, 1) ?? "").match(/M/g)?.length, 1, "a hole that shrinks away is gone at t = 1 (a stroked point would paint a dot that vanishes at the landing)");
  h.eq((lerpCompoundD(plain, donut, 0) ?? "").match(/M/g)?.length, 1, "a hole that opens is absent at t = 0 (no dot before the move starts)");
  h.eq((lerpCompoundD(donut, plain, .999) ?? "").match(/M/g)?.length, 2, "and present just inside the flight (it still collapses in place)");
  h.eq(lerpCompoundD("M 0 0 L 10 0 L 10 10 Z", "M 0 0 L 20 0 L 20 20 Z", .5), null, "a single-subpath `d` is not compound (the ordinary node lerp keeps it)");
  // purity
  const f = [.1, .4, .8].map((t) => (lerpElement(mk(holeRev), mk(holeRev2), t, t) as any).d), g = [.8, .4, .1].map((t) => (lerpElement(mk(holeRev), mk(holeRev2), t, t) as any).d).reverse();
  h.eq(f, g, "compound frames are pure in t (forward == reverse)");
}

h.section("M3: set pairing without crossing flights");
const ell = (id: string, cx: number, cy: number, r: number) => ({ type: "ellipse", id, rotation: 0, x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, fill: "#d14d41", stroke: "#942822", strokeWidth: 3 }) as any;
const rct = (id: string, x: number, y: number, w: number, hh: number) => ({ type: "rect", id, rotation: 0, x, y, width: w, height: hh, fill: "#4385be", stroke: "#205ea6", strokeWidth: 4, cornerRadius: 0 }) as any;
const centre = (o: any) => [o.bbox.x + o.bbox.w / 2, o.bbox.y + o.bbox.h / 2];
const crossings = (A: any[], B: any[]) => {
  const plan = planCorrespondence(A.flatMap((e) => elementStageOutlines(e)), B.flatMap((e) => elementStageOutlines(e)), { method: "dissolve" });
  const segs = plan.pairs.filter((p) => p.a && p.b && p.a.owner.role !== "slice").map((p) => [centre(p.a!), centre(p.b!)]);
  const o = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let n = 0, sq2 = 0;
  for (let i = 0; i < segs.length; i++) { sq2 += (segs[i][1][0] - segs[i][0][0]) ** 2 + (segs[i][1][1] - segs[i][0][1]) ** 2; for (let j = i + 1; j < segs.length; j++) { const [p, q] = [segs[i], segs[j]]; if (o(p[0], p[1], q[0]) * o(p[0], p[1], q[1]) < 0 && o(q[0], q[1], p[0]) * o(q[0], q[1], p[1]) < 0) n++; } }
  return { crossings: n, sq: sq2 };
};
h.eq(crossings([ell("a", 100, 100, 20), ell("b", 300, 100, 20), ell("c", 500, 100, 20)], [rct("r", 120, 260, 360, 120)]).crossings, 0, "3 dots -> 1 rect: no two flights cross (was 1)");
h.eq(crossings([100, 200, 300, 400, 500].map((x, i) => ell("d" + i, x, 100, 16)), [rct("r", 120, 260, 360, 120)]).crossings, 0, "5 dots -> 1 rect: no crossings (was 5)");
h.eq(crossings([[100, 100], [200, 100], [100, 200], [200, 200]].map(([x, y], i) => ell("d" + i, x, y, 16)), [ell("e", 450, 260, 90)]).crossings, 0, "2x2 dots -> 1 ellipse: no crossings (was 2)");
h.eq(crossings([rct("r", 120, 260, 360, 120)], [ell("a", 100, 100, 20), ell("b", 300, 100, 20), ell("c", 500, 100, 20)]).crossings, 0, "1 rect -> 3 dots: the reverse split is the same layout");
{ // the spec's own T5 sample (seed 7, two halves): the pre-WP-2.1 greedy-nearest pairing left 10 crossings (measured on 2c95341d)
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const A = Array.from({ length: 12 }, (_, i) => ell("a" + i, 20 + rnd() * 280, 20 + rnd() * 320, 12)), B = Array.from({ length: 12 }, (_, i) => ell("b" + i, 340 + rnd() * 280, 20 + rnd() * 320, 12));
  h.eq(crossings(A, B).crossings, 1, "12 random dots -> 12 random dots: the minimum-cost pairing leaves 1 crossing (greedy-nearest left 10)");
}
h.ok(crossings(Array.from({ length: 8 }, (_, i) => ell("a" + i, 160 + 100 * Math.cos(i * Math.PI / 4), 140 + 100 * Math.sin(i * Math.PI / 4), 14)), [rct("r", 380, 90, 200, 120)]).crossings <= 1, "8 dots on a circle -> 1 rect: at most 1 crossing (was 6)");
{ // never worse than the legacy layout: 60 seeded set Becomes (k dots <-> one rect, both directions); LEGACY holds the flight
  // crossings the pre-WP-2.1 planner left on exactly these instances (measured on 2c95341d)
  const LEGACY = [8,7,14,14,8,10,3,1,2,5,4,8,4,14,4,2,11,35,10,7,12,4,27,3,18,1,1,2,3,6,16,9,15,18,0,1,5,4,11,6,4,27,4,1,2,30,24,0,3,3,1,3,1,6,20,11,20,5,11,6];
  let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const got: number[] = [];
  for (let trial = 0; trial < 60; trial++) {
    const k = 3 + Math.floor(rnd() * 10), reverse = trial % 2 === 1;
    const dots = Array.from({ length: k }, (_, i) => ell("d" + i, 40 + rnd() * 560, 20 + rnd() * 120, 8 + rnd() * 6));
    const rect = rct("r", 100 + rnd() * 200, 220 + rnd() * 60, 150 + rnd() * 250, 40 + rnd() * 90);
    got.push((reverse ? crossings([rect], dots) : crossings(dots, [rect])).crossings);
  }
  const sum = (v: number[]) => v.reduce((p, q) => p + q, 0);
  h.ok(got.every((n, i) => n <= LEGACY[i]), "no set Become crosses more flights than the legacy layout did (60 seeded instances; a cheaper layout that crosses more is refused)");
  h.ok(sum(got) <= sum(LEGACY) * 0.3, `and in total the layouts cross far fewer flights (${sum(got)} vs ${sum(LEGACY)} legacy)`);
}
h.eq(crossings([rct("a", 0, 100, 40, 40), rct("b", 300, 100, 40, 40)], [rct("c", 200, 100, 40, 40), rct("d", 500, 100, 40, 40)]).sq, 80000, "spatial: {0,300} -> {200,500} takes the minimum-cost pairs (greedy gave 260000)");
{ let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; let ok = true;
  for (let trial = 0; trial < 200; trial++) {
    const n = 2 + Math.floor(rnd() * 4), m = 2 + Math.floor(rnd() * 4);
    const a = Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * 100 })), b = Array.from({ length: m }, () => ({ x: rnd() * 100, y: rnd() * 100 }));
    const got = assignMinCost(a, b).reduce((s, [i, j]) => s + (a[i].x - b[j].x) ** 2 + (a[i].y - b[j].y) ** 2, 0);
    const small = n <= m ? a : b, big = n <= m ? b : a; let best = Infinity; // brute force over injective maps of the smaller side
    const rec = (i: number, used: number, sum: number) => { if (i === small.length) { best = Math.min(best, sum); return; } for (let j = 0; j < big.length; j++) if (!(used >> j & 1)) rec(i + 1, used | 1 << j, sum + (small[i].x - big[j].x) ** 2 + (small[i].y - big[j].y) ** 2); };
    rec(0, 0, 0);
    if (Math.abs(got - best) > 1e-6 * (1 + best)) ok = false;
  }
  h.ok(ok, "assignMinCost equals brute force on 200 random rectangular instances");
}
{ // the set pairing is a pure function of its inputs: planned twice, sampled in three seek orders, it gives the same flights
  const A = [ell("a", 100, 100, 20), ell("b", 300, 100, 20), ell("c", 500, 100, 20)].flatMap((e) => elementStageOutlines(e)), B = [rct("r", 120, 260, 360, 120)].flatMap((e) => elementStageOutlines(e));
  const frame = (t: number) => { const plan = planCorrespondence(A, B, { method: "dissolve" }); plan.prepare(); return JSON.stringify(sampleCorrespondence(plan, t).map((s) => s.nodes.map((n) => [n.x, n.y]))); };
  const ts = [0, .2, .5, .8, 1], fwd = ts.map(frame), rev = ts.slice().reverse().map(frame).reverse(), shuf = [3, 0, 4, 2, 1].map((i) => [i, frame(ts[i])] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  h.ok(fwd.every((s, i) => s === rev[i] && s === shuf[i]), "set flights (3 dots -> rect) are identical forward, backward and shuffled");
}

h.section("M3b: non-finite geometry never hangs the planner; pairing order is stable");
{ const nan = [{ x: 0, y: 0 }, { x: 10, y: 0 }], bad = [{ x: 1, y: 1 }, { x: NaN, y: 3 }], inf = [{ x: Infinity, y: 0 }, { x: 5, y: 5 }];
  h.eq(assignMinCost(nan, bad).length, 2, "NaN centre: assignMinCost answers (greedy fallback) instead of looping forever");
  h.eq(assignMinCost(nan, inf).length, 2, "Infinity centre: same");
  h.eq(assignMinCost([], bad).length, 0, "no rows: empty");
  h.eq(JSON.stringify(assignMinCost([{ x: 3, y: 3 }, { x: 3, y: 3 }], [{ x: 3, y: 3 }, { x: 3, y: 3 }])), "[[0,0],[1,1]]", "all-equal centres: deterministic identity pairing");
  h.eq(JSON.stringify(greedyAssign([{ x: 0, y: 0 }, { x: 3, y: 0 }], [{ x: 2, y: 0 }, { x: 5, y: 0 }])), "[[0,1],[1,0]]", "greedyAssign is the pre-T5 nearest-first pairing (kept as the fallback)");
  const hole = { ...path(sq), id: "inf", d: "M 0 0 L 1e999 5 L 5 5 Z", nodes: undefined } as any;
  const t0 = performance.now(); const A = elementStageOutlines(hole), B = [ell("x", 100, 100, 10), ell("y", 200, 100, 10)].flatMap((e) => elementStageOutlines(e));
  const plan = planCorrespondence([...A, ...elementStageOutlines(ell("z", 50, 50, 10))], B, { method: "dissolve" });
  h.ok(plan.pairs.length > 0 && performance.now() - t0 < 2000, "a path with an infinite extent plans in finite time (the greedy answer)");
  // nearest-first paint order of the matched pairs is what the greedy gave (flights draw in this order)
  const P = [ell("a", 0, 0, 5), ell("b", 100, 0, 5)].flatMap((e) => elementStageOutlines(e)), Q = [ell("p", 10, 0, 5), ell("q", 105, 0, 5)].flatMap((e) => elementStageOutlines(e));
  const order = planCorrespondence(P, Q, { method: "dissolve", pair: "spatial" }).pairs.filter((p) => p.a && p.b).map((p) => p.a!.owner.elementId).join("");
  h.eq(order, "ba", "matched pairs keep nearest-first order (b -> q is 5 away, a -> p is 10: flight z-order as the greedy gave it)");
}

h.section("compound Become (R2 F1): a donut becoming a ring closes its hole in place instead of flattening into a bridged chain");
{
  const D = "M 0 0 L 180 0 L 180 180 L 0 180 Z M 40 40 L 40 140 L 140 140 L 140 40 Z";
  const donut: any = { type: "path", id: "a", x: 230, y: 90, width: 180, height: 180, rotation: 0, d: D, fill: "#4385be", stroke: "#205ea6", strokeWidth: 4, closed: true };
  const circle: any = { type: "ellipse", id: "b", x: 230, y: 90, width: 180, height: 180, rotation: 0, fill: "#d14d41", stroke: "#942822", strokeWidth: 4 };
  const rings = compoundRings(donut)!;
  h.ok(!!rings && rings.holes.length === 1 && Math.abs(Math.abs(area(rings.outer.nodes)) - 180 * 180) < 1e-6 && Math.abs(Math.abs(area(rings.holes[0].nodes)) - 100 * 100) < 1e-6, "compoundRings: the largest subpath is the outline, the other is its hole");
  h.ok(compoundRings({ ...donut, d: "M 0 0 L 180 0 L 180 180 L 0 180 Z" }) === null && compoundRings(circle) === null && compoundRings({ ...donut, d: "M 0 0 L 9 0 L 9 9 Z M 20 20 L 29 20" }) === null, "a plain ring, a non-path and a compound with an open subpath are not compound rings");
  const plan = planElementMorph(donut, circle)!;
  const frame = (t: number) => { const e = sampleElementMorph(plan, t); const sub = pathToSubpaths(e.d); return { e, sub, outer: Math.abs(area(sub[0].nodes)), hole: sub[1] ? Math.abs(area(sub[1].nodes)) : 0, sign: sub[1] ? Math.sign(area(sub[0].nodes)) * Math.sign(area(sub[1].nodes)) : 0 }; };
  const f0 = frame(0.001);
  h.ok(f0.sub.length === 2 && Math.abs(f0.outer - 180 * 180) / (180 * 180) < 0.01 && Math.abs(f0.hole - 100 * 100) / (100 * 100) < 0.01, `t = .001: the frame is the donut (outer ${f0.outer.toFixed(0)}, hole ${f0.hole.toFixed(0)}); the flattened chain bridged its subpaths (start pop 1,994 stage px^2)`);
  let prev = Infinity, ok = true, winding = true;
  for (let k = 1; k < 40; k++) { const f = frame(k / 40); if (f.hole > prev + 1e-6) ok = false; if (f.sub.length === 2 && f.sign >= 0) winding = false; prev = f.hole; }
  h.ok(ok && winding, "the hole only shrinks, and always winds against its ring (nonzero fill keeps it a hole)");
  const near1 = frame(0.995);
  h.ok(near1.hole < 0.02 * 100 * 100 || near1.sub.length === 1, `just before the landing the hole is a speck (${near1.hole.toFixed(1)} px^2 of 10,000): nothing is left to snap`);
  const opens = planElementMorph(circle, donut)!, g = (t: number) => { const sub = pathToSubpaths(sampleElementMorph(opens, t).d); return sub[1] ? Math.abs(area(sub[1].nodes)) : 0; };
  h.ok(g(0.2) < g(0.5) && g(0.5) < g(0.9) && g(0.9) > 0.5 * 100 * 100, "a ring becoming a donut opens its hole from its centroid, growing monotonically");
  const j = (t: number) => JSON.stringify(sampleElementMorph(plan, t).d), ts = [0.001, 0.3, 0.7, 0.999];
  h.ok(JSON.stringify([...ts].reverse().map(j).reverse()) === JSON.stringify(ts.map(j)), "seek purity: forward = reverse");
  // a hole keeps its AUTHORED winding relative to its outline (Flux fills nonzero: a same-wound extra subpath rests as solid and must not open a hole at t > 0)
  {
    const wound = (d: string, t: number, p: any = {}) => { const pl = planElementMorph({ ...donut, d, ...p }, circle)!, sub = pathToSubpaths(sampleElementMorph(pl, t).d); return sub.length === 2 ? Math.sign(area(sub[0].nodes)) * Math.sign(area(sub[1].nodes)) : 0; };
    const cw = "M 0 0 L 180 0 L 180 180 L 0 180 Z", inCw = "M 40 40 L 140 40 L 140 140 L 40 140 Z", inCcw = "M 40 40 L 40 140 L 140 140 L 140 40 Z", ccw = "M 0 0 L 0 180 L 180 180 L 180 0 Z";
    h.ok([0.001, 0.4, 0.8].every((t) => wound(cw + " " + inCw, t) === 1), "a same-wound extra subpath (it rests as solid, no hole) stays same-wound through the whole Become: no hole opens at t > 0 (the first frame was a 1,922 px^2 pop)");
    h.ok([0.001, 0.4, 0.8].every((t) => wound(ccw + " " + inCcw, t) === 1 && wound(ccw + " " + inCw, t) === -1 && wound(cw + " " + inCcw, t) === -1), "counter-clockwise outlines keep the authored relation too (hole stays a hole, same-wound stays same-wound)");
    h.ok([0.001, 0.4, 0.8].every((t) => wound(cw + " " + inCcw, t, { flipX: true }) === -1), "a mirrored donut keeps its hole");
  }
  const o = elementStageOutlines(donut as never)[0];
  h.ok(elementStageOutlines(donut as never).length === 1 && !!o.paint.raster && o.bbox.w === 180, "the hand-off driver takes a compound path by its box (the element crossfades over the box tween), not by a flattened chain");
}

h.section("warm hook: a same-kind path Change is aligned before the first frame");
{ // median of five distinct 800 -> 900-node ring pairs, each timed cold and (separately) after the warm hook
  const median = (xs: number[]) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const cold: number[] = [], warmed: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = ring(800, 100 + i * 0.37, .1), b = ring(900, 120 + i * 0.41, .2);
    const t0 = performance.now(); lerpElement(structuredClone(path(a)), structuredClone(path(b)), .3, .3); cold.push(performance.now() - t0);
    const a2 = ring(800, 140 + i * 0.37, .1), b2 = ring(900, 160 + i * 0.41, .2);
    const deck: any = createDeck({ id: "wp" + i, title: "wp", withTitleSlide: false });
    const sl = addSlide(deck, { id: "s", layout: "blank" });
    addElement(deck, sl.id, { ...path(a2), id: "ring" } as any);
    const beat = addBeat(deck, sl.id, { id: "b1" });
    setTransform(deck, sl.id, beat.id, "ring", { state: { d: d(b2, true), nodes: b2 } as any });
    warmSlideMorphs(sl);
    const t1 = performance.now(); lerpElement(structuredClone(path(a2)), structuredClone(path(b2)), .3, .3); warmed.push(performance.now() - t1);
  }
  h.ok(median(warmed) < median(cold) * 0.8, `the first player sample after the hook is ${median(warmed).toFixed(1)} ms vs ${median(cold).toFixed(1)} ms cold (median of 5; the memo was filled off-frame)`);
}
h.section("arcs honoured by set / hand-off flights");
{ const plan = planCorrespondence([ell("d", 100, 100, 20)].flatMap((e) => elementStageOutlines(e)), [ell("e", 400, 300, 40)].flatMap((e) => elementStageOutlines(e)), { method: "dissolve" });
  plan.prepare();
  const p = plan.pairs.find((q) => q.a && q.b)!;
  h.ok(!!p.travel && Math.abs(p.travel.dx - 300) < 1e-6 && Math.abs(p.travel.dy - 200) < 1e-6, "every two-sided pair records its centre-to-centre travel");
  const mid = (arc?: number) => { const s = sampleCorrespondence(plan, 0.5, [], arc ? { raw: .5, durationMs: 600, arc } : undefined)[0]; const xs = s.nodes.map((n) => n.x), ys = s.nodes.map((n) => n.y); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; };
  const a0 = mid(), a1 = mid(0.83);
  h.ok(Math.abs((a1[0] - a0[0]) - (-200 * 0.83 / 4)) < 0.5 && Math.abs((a1[1] - a0[1]) - (300 * 0.83 / 4)) < 0.5, "arc .83 bends the mid-flight centre by arc·d/4 sideways (arcBox's own formula)");
  const ends = [0, 1].map((t) => sampleCorrespondence(plan, t, [], { raw: t, durationMs: 600, arc: 0.83 })[0].nodes.map((n) => [n.x, n.y]));
  const ref = [0, 1].map((t) => sampleCorrespondence(plan, t, [])[0].nodes.map((n) => [n.x, n.y]));
  h.eq(JSON.stringify(ends), JSON.stringify(ref), "t = 0 and t = 1 are untouched by the arc");
  const box = { x: 0, y: 0, width: 10, height: 10 } as any, to = { ...box, x: 300, y: 200 } as any;
  const ab = arcBox({ ...box }, box, to, .5, .83), off = arcOffset({ dx: 300, dy: 200 }, .5, .83);
  h.ok(Math.abs(ab.x - (150 + off.x)) < 1e-9 && Math.abs(ab.y - (100 + off.y)) < 1e-9, "arcOffset is arcBox's bend (one law for boxes and flights)");
  h.ok(planBends(plan), "a plain flight bends");
  const tile = planCorrespondence([rct("r", 100, 200, 300, 100)].flatMap((e) => elementStageOutlines(e)), [ell("a", 100, 60, 20), ell("b", 300, 60, 20), ell("c", 500, 60, 20)].flatMap((e) => elementStageOutlines(e)), { method: "shatter" });
  h.ok(!planBends(tile), "a shattering ring (live cover clone at the ends) ignores arc");
}

h.section("arcs: the law for flights vs boxes");
{ // flights bend about CENTRE-to-centre travel; arcBox bends by origin deltas. Equal-size moves agree; a resize about a fixed
  // centre bends in arcBox (its origin travels) and not in a flight (its centre does not).
  const box = { x: 0, y: 0, width: 100, height: 100 } as any, grown = { x: -100, y: -100, width: 300, height: 300 } as any;
  const ab = arcBox({ ...box }, box, grown, .5, .83), straightX = (0 + -100) / 2;
  h.ok(Math.abs(ab.x - straightX) > 1 || Math.abs(ab.y - (-50)) > 1, "arcBox bends a pure resize about a fixed centre (origin-based, unchanged contract)");
  h.eq(JSON.stringify(arcOffset({ dx: 0, dy: 0 }, .5, .83)), JSON.stringify({ x: 0, y: 0 }), "a flight whose centre does not travel does not bend (centre-based law)");
  h.eq(JSON.stringify(arcOffset({ dx: 300, dy: 200 }, 0, .83)), JSON.stringify({ x: 0, y: 0 }), "arcOffset is exactly zero at t = 0 and t = 1");
}

h.section("arc suggestions");
{ const R = (x: number, y: number, w = 100, hh = 100) => ({ x, y, w, h: hh });
  const swap = [{ id: "p", pre: R(150, 130), end: R(390, 130) }, { id: "q", pre: R(390, 130), end: R(150, 130) }];
  h.eq(suggestArcs(swap).arcs, { p: 0.83, q: 0.83 }, "two boxes swapping places settle on manim's 90° Swap arc (0.83): 0.25 and 0.45 cannot clear a swap");
  h.eq(JSON.stringify(ARC_CANDIDATES), "[0.25,0.45,0.83]", "the ladder is the owner's modal arcs then the Swap arc");
  h.eq(suggestArcs([{ id: "p", pre: R(100, 130), end: R(440, 130) }, { id: "q", pre: R(440, 130), end: R(100, 130) }]).arcs, { p: 0.83, q: 0.83 }, "a wide swap is cleared by 0.83");
  h.eq(suggestArcs([{ id: "p", pre: R(100, 60), end: R(300, 60) }, { id: "q", pre: R(100, 220), end: R(300, 220) }]).collisions, 0, "parallel moves stay straight");
  h.eq(suggestArcs([{ id: "p", pre: R(100, 100), end: R(400, 200) }]).arcs, {}, "a single move stays straight");
  h.eq(suggestArcs(swap, { p: 0 }).arcs, { q: 0.83 }, "an authored 0 is never overwritten");
  const cyc = suggestArcs([{ id: "a", pre: R(270, 40), end: R(430, 220) }, { id: "b", pre: R(430, 220), end: R(110, 220) }, { id: "c", pre: R(110, 220), end: R(270, 40) }]).arcs;
  h.ok(Object.keys(cyc).length === 3 && Object.values(cyc).every((v) => v === cyc.a) && Math.abs(cyc.a) < 0.83, "a 3-cycle circulates (one sign, a magnitude below the Swap arc)");
  h.eq(collidingFlights([{ id: "p", pre: R(100, 100), end: R(100, 100, 160, 160) }, { id: "q", pre: R(110, 110, 40, 40), end: R(110, 110, 80, 80) }]).length, 0, "in-place resizes are not collisions");
  h.eq(collidingFlights([{ id: "u", pre: R(100, 100), end: R(400, 100) }, { id: "v", pre: R(110, 110, 40, 40), end: R(500, 300, 40, 40) }]).length, 0, "a move out from under another box (overlap at the start) is composed, not a collision");
  // real clocks: a swap whose second box starts after the first has landed does not collide
  const ease = (r: number) => r;
  const pq = (timed: boolean) => [{ id: "p", pre: R(100, 130), end: R(500, 130), ...(timed ? { start: 300, duration: 300, ease } : {}) }, { id: "q", pre: R(280, 130), end: R(280, 290), ...(timed ? { start: 0, duration: 200, ease } : {}) }];
  h.eq([suggestArcs(pq(false)).collisions, suggestArcs(pq(true)).collisions], [1, 0], "p crosses q's column while q is still moving on ONE shared clock (1 collision) but q is gone before p starts on the real clocks (0)");
  h.eq(suggestArcs([{ id: "p", pre: R(150, 130), end: R(390, 130), start: 0, duration: 400, ease }, { id: "q", pre: R(390, 130), end: R(150, 130), start: 600, duration: 400, ease }]).arcs, {}, "a staggered swap (p lands on q's spot while q still sits there) is reported but arcs cannot fix timing: nothing written");
  h.eq(suggestArcs([{ id: "p", pre: R(150, 130), end: R(150, 330), start: 0, duration: 300, ease }, { id: "q", pre: R(300, 130), end: R(300, 330), start: 0, duration: 300, ease }]).collisions, 0, "side-by-side parallel moves on one clock never collide");
  // perf cliff: 12 mutually colliding flights answer fast and 60 flagged flights say why they give up
  const ring = (n: number) => Array.from({ length: n }, (_, i) => { const a = i / n * 2 * Math.PI, b = ((i + n / 2) % n) / n * 2 * Math.PI; return { id: "r" + i, pre: R(300 + 200 * Math.cos(a), 200 + 150 * Math.sin(a), 30, 30), end: R(300 + 200 * Math.cos(b), 200 + 150 * Math.sin(b), 30, 30) }; });
  const t0 = performance.now(), many = suggestArcs(ring(12)); const ms = performance.now() - t0;
  h.ok(ms < 120 && many.collisions > 0, `12 colliding flights suggest in ${ms.toFixed(0)} ms (< 120 ms; the 2^12 search took 395 ms)`);
  const huge = suggestArcs(ring(60)), thirteen = suggestArcs(ring(14));
  h.ok(!Object.keys(huge.arcs).length && /too many/.test(huge.reason ?? ""), "60 colliding flights give up WITH a reason");
  h.ok(!Object.keys(thirteen.arcs).length && /too many colliding moves \(1[34]\)/.test(thirteen.reason ?? ""), "more than MAX_FLAGGED = 12 flagged flights give up too (a chorus of bows is not a fix)");
  // never a bigger bow than needed: two boxes that merely cross (offset enough that 0.45 clears) must not get the Swap arc
  const R2 = (x: number, y: number) => ({ x, y, w: 30, h: 30 });
  const cross = suggestArcs([{ id: "m", pre: R2(100, 100), end: R2(400, 300) }, { id: "n", pre: R2(100, 300), end: R2(400, 100) }]);
  h.ok(Object.values(cross.arcs).length === 2 && Object.values(cross.arcs).every((v) => Math.abs(v) === 0.45), `an X crossing of 30-unit boxes is cleared by 0.45, not the Swap's 0.83 (${JSON.stringify(cross.arcs)})`);

  // resolved arcs + resolved clocks through a real deck: a style-inherited arc counts as authored
  const deck: any = createDeck({ id: "t5g", title: "g", withTitleSlide: false });
  const sl = addSlide(deck, { id: "s", layout: "blank" });
  for (const [id, x] of [["p", 150], ["q", 390], ["r", 20]] as const) addElement(deck, sl.id, { type: "rect", id, x, y: 130, width: 100, height: 100, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as any);
  const beat = addBeat(deck, sl.id, { id: "b1" });
  const tp = setTransform(deck, sl.id, beat.id, "p", { state: { x: 390 } })!, tq = setTransform(deck, sl.id, beat.id, "q", { state: { x: 150 } })!;
  const bi = sl.beats.findIndex((b: any) => b.id === beat.id), res = suggestBeatArcs(sl, bi, deck);
  h.eq(res.arcs, { [tp.id!]: 0.83, [tq.id!]: 0.83 }, "suggestBeatArcs on a real swap beat");
  deck.animStyles = [{ id: "st", name: "bow", family: "transform", track: { preset: "transform", arc: 0.3 } }]; tq.styleId = "st";
  h.eq(suggestBeatArcs(sl, bi, deck).arcs[tq.id!], undefined, "an arc inherited from a linked style counts as authored (never overwritten)");
  delete tq.styleId; setTrackArc(tq, 0);
  const done = suggestArcsForBeat(deck, sl.id, beat.id);
  h.ok(tq.arc === 0 && tp.arc !== undefined && done.written.length === 1, "suggestArcsForBeat writes only unset tracks and leaves an authored 0");
}

h.section("rigid turn (opt-in `params.turn`)");
{ const P = (x: number, y: number) => ({ x, y });
  const th = 120 * Math.PI / 180, cx = 320, cy = 180, r = 80;
  const p1 = P(cx - r, cy), p2 = P(cx + r, cy), q1 = P(cx - r * Math.cos(th), cy - r * Math.sin(th)), q2 = P(cx + r * Math.cos(th), cy + r * Math.sin(th));
  let spread = 0, drift = 0;
  for (let i = 1; i < 100; i++) { const [a, b] = rigidSegment(p1, p2, q1, q2, i / 100)!; spread = Math.max(spread, Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 2 * r)); drift = Math.max(drift, Math.hypot((a.x + b.x) / 2 - cx, (a.y + b.y) / 2 - cy)); }
  h.ok(spread < 1e-9 && drift < 1e-9, "a 120° turn about the centre keeps length and centre exactly (the endpoint lerp dips to cos 60° = 50 %)");
  const t1 = P(240, 180), h1 = P(400, 180), h2 = P(240 + 160 * Math.cos(th), 180 + 160 * Math.sin(th));
  let tail = 0, len = 0;
  for (let i = 1; i < 100; i++) { const [a, b] = rigidSegment(t1, h1, t1, h2, i / 100)!; tail = Math.max(tail, Math.hypot(a.x - 240, a.y - 180)); len = Math.max(len, Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 160)); }
  h.ok(tail < 1e-9 && len < 1e-9, "a swing about the tail keeps the tail fixed and the length constant");
  // the critique: the centre must travel in a STRAIGHT line (arc stays the only curvature); a spiral similarity bent it by 87 px
  const s1 = P(0, 0), s2 = P(100, 0), e1 = P(300 - 50 * Math.cos(th), -50 * Math.sin(th)), e2 = P(300 + 50 * Math.cos(th), 50 * Math.sin(th));
  let off = 0;
  for (const t of [.1, .3, .5, .7, .9]) { const [a, b] = rigidSegment(s1, s2, e1, e2, t)!; const c = P((a.x + b.x) / 2, (a.y + b.y) / 2), c0 = P(50, 0), c1 = P(300, 0); off = Math.max(off, Math.abs((c1.x - c0.x) * (c.y - c0.y) - (c1.y - c0.y) * (c.x - c0.x)) / Math.hypot(c1.x - c0.x, c1.y - c0.y)); }
  h.ok(off < 1e-9, "move + turn: the centre stays on the straight chord at 5 phases (arc 0 = straight)");
  h.eq(rigidSegment(P(0, 0), P(100, 0), P(50, 40), P(150, 40), .5), null, "a pure translation is the plain lerp (null)");
  h.eq(rigidSegment(P(0, 0), P(100, 0), P(0, 0), P(200, 0), .5), null, "a pure stretch is the plain lerp (null)");
  const [e0, f0] = rigidSegment(P(10, 10), P(110, 30), P(200, 150), P(160, 240), 1)!;
  h.ok(Math.abs(e0.x - 200) < 1e-9 && Math.abs(e0.y - 150) < 1e-9 && Math.abs(f0.x - 160) < 1e-9 && Math.abs(f0.y - 240) < 1e-9, "t = 1 lands on the end endpoints exactly (turn + stretch + shift)");
  // through lerpElement: default = the old lerp byte for byte; rigid keeps the length
  const line = (x2: number, y2: number, x = 240, y = 180): any => ({ type: "line", id: "l", x, y, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2, y2, stroke: "#000", strokeWidth: 6, arrowStart: false, arrowEnd: true });
  const a = line(160, 0), b = line(160 * Math.cos(th), 160 * Math.sin(th));
  const plain = lerpElement(a, b, .5, .5) as any, rigid = lerpElement(a, b, .5, .5, { turn: "rigid" }) as any;
  h.ok(Math.abs(Math.hypot(plain.x2 - plain.x1, plain.y2 - plain.y1) - 80) < 1e-6, "default Change of a turning line: the endpoint lerp (length 80 = cos 60° of 160): unchanged contract");
  h.ok(Math.abs(Math.hypot(rigid.x2 - rigid.x1, rigid.y2 - rigid.y1) - 160) < 1e-9, "params.turn = rigid keeps the length 160");
  const track: any = { id: "t", target: "l", preset: "transform" }; setTrackTurn(track, "rigid");
  h.eq([turnOf(track), track.params?.turn], ["rigid", "rigid"], "setTrackTurn / turnOf round-trip through params.turn");
  setTrackTurn(track, null); h.eq([turnOf(track), track.params], [undefined, undefined], "turn: null removes the key (and an empty params)");
  const stick = (d: string): any => ({ ...path(N([[0, 0], [0, 0]]), false), d, nodes: undefined, x: 100, y: 100, width: 40, height: 40 });
  const sm = lerpElement(stick("M 0 0 L 40 0"), stick("M 0 0 L 0 40"), .5, .5, { turn: "rigid" }) as any;
  const pm = sm.d.match(/-?[\d.e-]+/g).map(Number);
  h.ok(Math.abs(Math.hypot(pm[2] - pm[0], pm[3] - pm[1]) - 40) < 1e-2, "a straight 2-node stick on a rigid track keeps its length too");
}

{ // the stroke BAND (R2 F1: a thick ring's stroke drawn as the ring between two contours) rides the same bent flight as its centreline
  const plan = planCorrespondence(elementStageOutlines({ ...rct("d", 50, 50, 80, 60), strokeWidth: 8 }), elementStageOutlines({ ...ell("e", 400, 300, 40), strokeWidth: 8 }), { method: "dissolve" });
  plan.prepare();
  const at = (arc?: number) => sampleCorrespondence(plan, 0.5, [], { raw: .5, durationMs: 600, ...(arc ? { arc } : {}) })[0];
  const flat = at(), bent = at(0.6), off = arcOffset(plan.pairs[0].travel, 0.5, 0.6);
  h.ok(!!flat.band && !!bent.band && Math.abs(bent.band.outer[0].x - flat.band.outer[0].x - off.x) < 1e-6 && Math.abs(bent.band.inner[0].y - flat.band.inner[0].y - off.y) < 1e-6
    && Math.abs(bent.nodes[0].x - flat.nodes[0].x - off.x) < 1e-6, "a thick ring's stroke band is displaced exactly like its centreline (no band left on the chord)");
}

await h.done();
