// WP 2.5 (R4_T9 §3.1-§3.4) — PURE gate for glide lanes (slide/lanes.ts), the letter bag and the roll look (slide/textMatch.ts
// additions) and resolveTextLook (slide/timing.ts: params only, X1d). Adds to the `text-morph` manifest group. Never loosens
// verify-text-match.ts (its crossArc/fadeLook/policy pins stay; crossArc is the fallback of every non-colliding glide).
// X6: bowOffset's normal is the canvas-wide arcBox one, (-dy, dx); gated below against arcBox itself.
import { harness } from "./lib/harness.mjs";
import { crossArc, matchTokens, charLevelAllowed, planTextMorph, rollLook, fadeLook, LETTER_BAG_POLICY, LEFTOVER_ROLL, type TextRange } from "../src/lib/slide/textMatch";
import { glideLanes, laneOffset, bowOffset, classicOffset, LANE_POLICY, LEFT_OF_TRAVEL, type GlideGeom } from "../src/lib/slide/lanes";
import { arcBox } from "../src/lib/slide/tween";
import { resolveTextLook } from "../src/lib/slide/timing";

const h = harness("verify-text-lanes");
const adv = (s: number) => 0.5 * s;
interface W { t: string; x: number; y: number; w: number }
function layout(words: string[], size: number, width: number, align: "left" | "center" = "left"): W[] {
  const lines: string[][] = [[]]; let cur = 0;
  for (const wd of words) { const w = wd.length * adv(size); if (lines[lines.length - 1].length && cur + w > width) { lines.push([]); cur = 0; } lines[lines.length - 1].push(wd); cur += w + 0.25 * size; }
  return lines.flatMap((ln, li) => { const total = ln.reduce((a, wd) => a + wd.length * adv(size), 0) + 0.25 * size * (ln.length - 1); let x = align === "center" ? (width - total) / 2 : 0; return ln.map((t) => { const w = t.length * adv(size); const o = { t, x, y: size + li * 1.2 * size, w }; x += w + 0.25 * size; return o; }); });
}
const glides = (a: string, b: string, size: number, width: number, align: "left" | "center" = "left"): GlideGeom[] => {
  const A = layout(a.split(" "), size, width, align), B = layout(b.split(" "), size, width, align), out: GlideGeom[] = [];
  for (const wa of A) { const wb = B.find((q) => q.t === wa.t); if (wb) out.push({ ax: wa.x, ay: wa.y, bx: wb.x, by: wb.y, w: wa.w, size }); } return out;
};
const ss = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
/** worst per-frame sum of pairwise ink-box overlap (word width x 0.6 em) over 55 smootherstep frames, ALL glides. */
function worstOverlap(gs: GlideGeom[], lanes?: (number | undefined)[]): number {
  let worst = 0;
  for (let f = 0; f <= 54; f++) {
    const t = ss(f / 54), P = gs.map((g, i) => { const o = laneOffset(g, lanes ? lanes[i] : undefined, t); return { x: g.ax + (g.bx - g.ax) * t + o.dx, y: g.ay + (g.by - g.ay) * t + o.dy, w: g.w, s: g.size }; });
    let area = 0;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const ox = Math.min(P[i].x + P[i].w, P[j].x + P[j].w) - Math.max(P[i].x, P[j].x), oy = P[i].s * 0.6 - Math.abs(P[i].y - P[j].y); if (ox > 1 && oy > 0) area += ox * oy; }
    worst = Math.max(worst, area);
  }
  return Math.round(worst);
}

h.section("pinned policies");
h.eq(JSON.stringify(LANE_POLICY), JSON.stringify({ marginEm: 0.08, bandEm: 0.6, steps: 24, engage: 0.1, maxActive: 16, ladderEm: [0.3, 0.6, 0.9, 1.2], sweeps: 4 }), "LANE_POLICY pinned");
h.eq(JSON.stringify(LETTER_BAG_POLICY), JSON.stringify({ maxLetters: 30, minLetters: 5, minOverlap: 0.8, minMovers: 2 }), "LETTER_BAG_POLICY pinned");
h.eq(JSON.stringify(LEFTOVER_ROLL), JSON.stringify({ rollEm: 0.35, travelEm: 1.5, maxEm: 0.9, frac: 0.3 }), "LEFTOVER_ROLL pinned");

h.section("lanes: today's look is the base");
{
  const shift = glides("red blue", "the red blue", 40, 520);
  const l = glideLanes(shift);
  h.ok(l.every((v) => v === undefined), "a pure shift (no collision) keeps every glide on the classic arc");
  h.ok(shift.every((g) => { for (const t of [0.1, 0.5, 0.9]) { const o = laneOffset(g, undefined, t); if (o.dx !== 0 || o.dy !== crossArc(g.bx - g.ax, g.by - g.ay, g.size, t)) return false; } return true; }), "…and laneOffset(undefined) == crossArc bit-for-bit");
  h.ok(shift.some((g) => Math.abs(laneOffset(g, undefined, 0.5).dy) > 5), "…which is a visible lift (>5 px) the lane planner must not remove");
  const big = glides(Array.from({ length: 20 }, (_, i) => "w" + (i + 10)).join(" "), Array.from({ length: 20 }, (_, i) => "w" + (29 - i)).join(" "), 20, 620);
  const lb = glideLanes(big); h.ok(lb.length === big.length && lb.every((v) => v === undefined), "more than maxActive colliding glides: undefined for ALL (classic arcs stay), not zeros");
  h.ok(glideLanes([]).length === 0 && glideLanes(glides("solo", "solo", 30, 300)).length === 1, "degenerate inputs are safe");
}

h.section("lanes: measured quality (ink overlap, px^2, smootherstep 55 frames)");
{
  const rev = glides("alpha beta gamma delta", "delta gamma beta alpha", 44, 640), lr = glideLanes(rev);
  const c = worstOverlap(rev), n = worstOverlap(rev, lr);
  h.ok(lr.every((v) => v !== undefined), "4-word reversal: every glide takes a lane");
  h.ok(c > 5000 && n <= 700 && n < c / 8, `4-word reversal: classic ${c} -> lanes ${n} px^2 (<= 700, >= 8x better)`);
  h.ok(rev.every((g, i) => { const a = laneOffset(g, lr[i], 0), b = laneOffset(g, lr[i], 1); return a.dx === 0 && a.dy === 0 && Math.abs(b.dx) < 1e-9 && Math.abs(b.dy) < 1e-9; }), "endpoints are exact (offset 0 at t = 0 and t = 1)");
  const three = glides("one two three four five six seven eight alpha beta gamma delta", "one two three four five six seven eight delta gamma beta alpha", 24, 280), l3 = glideLanes(three);
  const c3 = worstOverlap(three), n3 = worstOverlap(three, l3);
  h.ok(n3 <= 450 && n3 < c3, `reversal with static lines above and below: classic ${c3} -> lanes ${n3} px^2 (static glides are obstacles)`);
  const sen = glides("We measured calcium in neurons during sleep", "During sleep we measured calcium in neurons", 30, 420), ls = glideLanes(sen);
  h.ok(worstOverlap(sen, ls) < worstOverlap(sen) * 0.5, `7-word sentence: classic ${worstOverlap(sen)} -> lanes ${worstOverlap(sen, ls)} px^2`);
  const long = glides("the quick brown fox jumps over the lazy dog and runs far away home", "away home far runs and dog lazy the over jumps fox brown quick the", 28, 400), ll = glideLanes(long);
  h.ok(worstOverlap(long, ll) < worstOverlap(long) * 0.5, `13-word reversal over 2 lines: classic ${worstOverlap(long)} -> lanes ${worstOverlap(long, ll)} px^2`);
  // characterised limitation: a one-word-per-line vertical reorder is NOT solved (lanes cannot clear 100 px words); it must not get worse
  const size = 40, wds = ["Aims", "Methods", "Results"], tgt = ["Results", "Aims", "Methods"], wd = (t: string) => t.length * adv(size);
  const vert: GlideGeom[] = wds.map((t, i) => ({ ax: (640 - wd(t)) / 2, ay: size + i * 1.2 * size, bx: (640 - wd(t)) / 2, by: size + tgt.indexOf(t) * 1.2 * size, w: wd(t), size }));
  const lv = glideLanes(vert); h.ok(worstOverlap(vert, lv) <= worstOverlap(vert), `vertical list reorder (characterised, NOT solved): classic ${worstOverlap(vert)} -> lanes ${worstOverlap(vert, lv)} px^2, never worse`);
  const bnd = { x0: 0, y0: 0, x1: 640, y1: 360 }, top = glides("alpha beta gamma delta", "delta gamma beta alpha", 44, 640).map((g) => ({ ...g, ay: 44, by: 44 })), lt = glideLanes(top, bnd);
  h.ok(top.every((g, i) => { for (let k = 1; k < 24; k++) { const t = k / 24, o = laneOffset(g, lt[i], t); if (g.ay + (g.by - g.ay) * t + o.dy - g.size < bnd.y0 - 1e-6) return false; } return true; }), "a title on the top edge: no lane lifts ink above the stage (LaneBounds)");
  // X6 — ONE arc sign: bowOffset's normal is arcBox's (-dy, dx); gated against arcBox itself, on a diagonal and on the axes.
  for (const g of [{ ax: 10, ay: 20, bx: 210, by: 90 }, { ax: 0, ay: 0, bx: 100, by: 0 }, { ax: 50, ay: 50, bx: 50, by: 150 }, { ax: 300, ay: 10, bx: 20, by: 60 }].map((q) => ({ ...q, w: 40, size: 20 }))) {
    const d = Math.hypot(g.bx - g.ax, g.by - g.ay);
    for (const t of [0.1, 0.35, 0.5, 0.8]) {
      const bo = bowOffset(g, 12, t);
      const pre = { x: g.ax, y: g.ay }, end = { x: g.bx, y: g.by }, el = { x: 0, y: 0 };
      arcBox(el as never, pre as never, end as never, t, (4 * 12) / d);
      const off = { x: el.x - (g.ax + (g.bx - g.ax) * t), y: el.y - (g.ay + (g.by - g.ay) * t) };
      h.ok(Math.abs(bo.dx - off.x) < 1e-9 && Math.abs(bo.dy - off.y) < 1e-9, `bowOffset == arcBox's offset for a positive bow (${g.ax},${g.ay})->(${g.bx},${g.by}) at t=${t}`);
    }
  }
  const right = { ax: 0, ay: 0, bx: 100, by: 0, w: 40, size: 20 }, left = { ax: 100, ay: 0, bx: 0, by: 0, w: 40, size: 20 };
  h.ok(bowOffset(right, 5, 0.5).dy > 0 && bowOffset(left, 5, 0.5).dy < 0, "positive bow = the clockwise side: DOWN for a rightward glide, UP for a leftward one (arcBox / arcOffset)");
  h.ok(LEFT_OF_TRAVEL === -1 && bowOffset(right, LEFT_OF_TRAVEL * 5, 0.5).dy < 0 && bowOffset(left, LEFT_OF_TRAVEL * 5, 0.5).dy > 0, "LEFT_OF_TRAVEL lifts a rightward glide and dips a leftward one: today's crossArc side");
  for (const g of [right, left]) h.ok(Math.sign(bowOffset(g, LEFT_OF_TRAVEL * 5, 0.5).dy) === Math.sign(classicOffset(g, 0.5).dy) && classicOffset(g, 0.5).dy !== 0, "…same side as classicOffset (crossArc)");
  h.ok(bowOffset(right, 0, 0.5).dx === 0 && bowOffset(right, 0, 0.5).dy === 0 && bowOffset(right, 9, 0).dy === 0 && bowOffset(right, 9, 1).dy === 0, "bow 0 is straight; t = 0 and t = 1 are exact");
  const swap = glides("alpha beta", "beta alpha", 44, 640), ls2 = glideLanes(swap);
  h.ok(ls2.every((v) => v !== undefined), "a two-word swap is planned (both glides collide)");
  h.ok(worstOverlap(swap, ls2) < worstOverlap(swap), `a two-word swap overprints less on lanes (${worstOverlap(swap)} -> ${worstOverlap(swap, ls2)} px^2)`);
  const ts: number[] = []; const g16 = glides(Array.from({ length: 16 }, (_, i) => "w" + i + "x".repeat(i % 4)).join(" "), Array.from({ length: 16 }, (_, i) => "w" + (15 - i) + "x".repeat((15 - i) % 4)).join(" "), 28, 520);
  for (let k = 0; k < 7; k++) { const t0 = performance.now(); glideLanes(g16); ts.push(performance.now() - t0); } ts.sort((x, y) => x - y);
  h.ok(ts[3] < 25, `planning 16 glides: median ${ts[3].toFixed(1)} ms (< 25; measured ~9 warm, runs in the idle warm-up, not in a frame)`);
}

h.section("letter bag: near-permutations only");
{
  const covered = (a: string, b: string, m = matchTokens(a, b, { letterBag: true })) => {
    const la = new Uint8Array(a.length), lb = new Uint8Array(b.length);
    for (const r of m.runs) { for (let i = r.a.from; i < r.a.to; i++) la[i]++; for (let i = r.b.from; i < r.b.to; i++) lb[i]++; }
    return [la, lb] as const;
  };
  for (const [a, b] of [["the morse code", "here come dots"], ["LISTEN", "SILENT"], ["dormitory", "dirty room"], ["stable states", "tables seats"]] as const) {
    const m = matchTokens(a, b, { letterBag: true }); const [la, lb] = covered(a, b, m), exact = a !== "stable states";
    h.ok(m.runs.some((r) => r.kind === "char" || r.kind === "fold") && m.runs.length >= 2, `bag fires on "${a}" -> "${b}" (${m.runs.length} runs)`);
    const letters = (t: string, c: Uint8Array) => [...c].filter((v, i) => /[\p{L}\p{N}]/u.test(t[i]));
    h.ok(letters(a, la).every((v) => v <= 1) && letters(b, lb).every((v) => v <= 1), "…no letter is covered twice");
    if (exact) h.ok(letters(a, la).every((v) => v === 1) && letters(b, lb).every((v) => v === 1), "…a true anagram: every letter of both sides is covered exactly once");
    else h.ok(letters(a, la).filter((v) => v === 1).length / letters(a, la).length >= 0.8, "…a near-permutation: >= 80 % of the letters travel, the rest exit / enter");
  }
  const quiet: [string, string][] = [["Microscopy", "Optics and Light"], ["teh result", "the result"], ["form", "from"], ["ATP", "TAP"], ["Gamma", "Magma"], ["Treated vs control", "Control vs treated"], ["Panel A", "Panel B"], ["Control", "Controls"], ["n = 12", "n = 21"], ["Day 10", "Day 01"], ["Mean ± SD", "SD ± Mean"], ["neurons fire", "fire neurons"], ["Calcium imaging", "Imaging calcium"], ["the quick brown fox", "a slow brown cat"], ["recieve data", "receive data"], ["adn", "and"], ["cortex", "cortes"]];
  const fired = quiet.filter(([a, b]) => JSON.stringify(matchTokens(a, b, { letterBag: true })) !== JSON.stringify(matchTokens(a, b)));
  h.eq(fired.map((p) => p.join(">")), [], `bag is silent on all ${quiet.length} typo / label / numeric / prose edits (incl. the owner's Deck-3 example)`);
  h.ok(!charLevelAllowed("ab", "ba").allowed, "charLevelAllowed('ab','ba') stays refused (verify-text-match pin untouched)");
  h.eq(JSON.stringify(matchTokens("Microscopy", "Optics and Light")), JSON.stringify(matchTokens("Microscopy", "Optics and Light", { letterBag: true })), "owner Deck-3 example: byte-identical plan with the bag on");
  const line = (s: string): TextRange[] => [{ from: 0, to: s.length }];
  const p = planTextMorph("the morse code", "here come dots", { aLines: line("the morse code"), bLines: line("here come dots"), letterBag: true });
  h.ok(p.spans.length <= 48 && p.spans.some((s) => s.kind === "glide"), `anagram plan fits the span cap (${p.spans.length} spans)`);
}

h.section("roll look (profile v2 fade)");
{
  const e0 = rollLook("exit", 0, null, 40), e1 = rollLook("exit", 1, null, 40), n0 = rollLook("enter", 0, null, 40), n1 = rollLook("enter", 1, null, 40);
  h.ok(e0.opacity === 1 && e0.dy === 0 && e1.opacity === 0 && Math.abs(e1.dy + 0.35 * 40) < 1e-9 && n0.opacity === 0 && Math.abs(n0.dy - 0.35 * 40) < 1e-9 && n1.opacity === 1 && n1.dy === 0, "in-place swap: exit lifts 0.35 em, enter rises from 0.35 em below");
  h.ok(e1.scale === 1 && n0.scale === 1, "no scale change (the R2 0.6 shrink read as breathing)");
  const far = rollLook("exit", 1, { x: 300, y: 0 }, 40); h.ok(Math.abs(far.dx - Math.min(0.9 * 40, 0.3 * 300)) < 1e-9 && far.dy === 0, "far leftovers: travel toward the other side, capped at min(0.9 em, 30 %)");
  const near = rollLook("exit", 1, { x: 30, y: 10 }, 40); h.ok(near.dx === 0 && Math.abs(near.dy + 14) < 1e-9, "centroids within 1.5 em: stay a roll (no travel)");
  h.ok(rollLook("exit", 0.5, null, 40).opacity === fadeLook("exit", 0.5).opacity, "opacity law identical to fadeLook (the 'never an empty frame' overlap windows still hold)");
}

h.section("coarsening drops the letter flights too");
{
  const line = (s: string): TextRange[] => [{ from: 0, to: s.length }];
  const swapped = (n: number) => { const A: string[] = [], B: string[] = []; for (let i = 0; i < n; i++) { A.push("k" + i, "j" + i); B.push("j" + i, "k" + i); } return [A.join(" ") + " dormitory", B.join(" ") + " dirty room"] as const; };
  const plan = (n: number, letterBag: boolean) => { const [a, b] = swapped(n); return planTextMorph(a, b, { aLines: line(a), bLines: line(b), letterBag }); };
  const fits = plan(19, true), cap = plan(20, true);
  h.ok(fits.level === "char" && fits.match.charLevel === "used" && fits.spans.filter((s) => s.kind === "glide" && (s.run === "char" || s.run === "fold")).length === 9, "19 swapped pairs + an anagram: the bag fires (9 letter runs) and the plan fits the span cap");
  h.ok(cap.level === "word" && cap.match.charLevel !== "used" && cap.spans.every((s) => s.run !== "char" && (s.run !== "fold")), "20 swapped pairs + an anagram: over the span cap -> coarsened, NO letter run left behind");
  h.ok(JSON.stringify(cap.spans) === JSON.stringify(plan(20, false).spans), "…the coarsened spans are exactly today's (bag off) spans");
  h.eq(JSON.stringify(plan(19, false)), JSON.stringify(plan(19, undefined as never)), "letterBag:false == absent");
  h.ok(cap.spans.length <= 48 && fits.spans.length <= 48, "both plans respect the span cap (48)");
}

h.section("resolveTextLook: params only (X1d), absent = today's look");
{
  h.eq(resolveTextLook(undefined), { letters: "fade", fadeStyle: "drift" }, "absent params -> fade + drift (old decks play as made)");
  h.eq(resolveTextLook({}), { letters: "fade", fadeStyle: "drift" }, "empty params -> fade + drift");
  h.eq(resolveTextLook({ letters: "travel", fadeStyle: "roll" }), { letters: "travel", fadeStyle: "roll" }, "authored travel + roll");
  h.eq(resolveTextLook({ letters: "travel" }), { letters: "travel", fadeStyle: "drift" }, "each key reads on its own (letters)");
  h.eq(resolveTextLook({ fadeStyle: "roll" }), { letters: "fade", fadeStyle: "roll" }, "each key reads on its own (fadeStyle)");
  for (const bad of ["Travel", "wobble", "", 3, null, true, {}]) h.eq(resolveTextLook({ letters: bad, fadeStyle: bad }), { letters: "fade", fadeStyle: "drift" }, `malformed ${JSON.stringify(bad)} reads as today's look`);
  h.eq(resolveTextLook.length, 1, "resolveTextLook takes ONE argument: no profile (X1d)");
}

await h.done();
