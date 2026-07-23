#!/usr/bin/env -S npx tsx
// Pure gate for the cascade core (src/lib/cascade.ts + ops.cascadeElements +
// slideOps.cascadeTracks + color/interp shiftOklch): the stepped-delta law,
// unit decomposition/ordering, applicability exclusion, clamps, both numeric
// modes, the OKLCh color ramp, absolute-from-baseline idempotence, and the
// track flavor. Run: npx tsx scripts/verify-cascade.ts
import type { Project, Element, RectElement, TextElement, EllipseElement } from "../src/lib/types";
import type { Deck } from "../src/lib/slide/types";
import * as ops from "../src/lib/ops";
import * as slideOps from "../src/lib/slide/ops";
import { stepOf, cascadeValue, PT_TO_PX, supportsBoxDim } from "../src/lib/cascade";
import { shiftOklch, parseColor } from "../src/lib/color/interp";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// --- fixtures ---------------------------------------------------------------

let seq = 0;
const rect = (x: number, y: number, w = 40, h = 120, extra: Partial<RectElement> = {}): RectElement => ({
  id: `r${++seq}`,
  type: "rect",
  x,
  y,
  width: w,
  height: h,
  rotation: 0,
  fill: "#88bbdd",
  stroke: "#225588",
  strokeWidth: 2,
  cornerRadius: 0,
  ...extra,
});
const text = (x: number, y: number, extra: Partial<TextElement> = {}): TextElement => ({
  id: `t${++seq}`,
  type: "text",
  x,
  y,
  width: 120,
  height: 24,
  rotation: 0,
  text: "hi",
  fontFamily: "Inter",
  fontSize: 16,
  fontWeight: 400,
  fontStyle: "normal",
  align: "left",
  color: "#333333",
  sizing: "auto",
  ...extra,
});
const ellipse = (x: number, y: number): EllipseElement => ({
  id: `e${++seq}`,
  type: "ellipse",
  x,
  y,
  width: 60,
  height: 60,
  rotation: 0,
  fill: "#ffaa00",
  stroke: "#000000",
  strokeWidth: 1,
});

function proj(els: Element[]): { p: Project; figId: string } {
  const p: Project = {
    version: 1,
    name: "cascade-test",
    canvases: [{ id: "c1", name: "Canvas 1" }],
    figures: [],
    assets: [],
    palette: [],
  } as unknown as Project;
  const f = ops.createFigure(p, { canvasId: "c1", name: "F", width: 800, height: 600 });
  f.elements = els;
  return { p, figId: f.id };
}
const el = (p: Project, id: string): Element => p.figures[0].elements.find((e) => e.id === id)!;

// --- 1. the step law ----------------------------------------------------------

assert(stepOf(0, false) === 1 && stepOf(3, false) === 4, "firstFixed=false → step = rank+1");
assert(stepOf(0, true) === 0 && stepOf(3, true) === 3, "firstFixed=true → step = rank");
assert(cascadeValue(10, { delta: 25 }, 2) === 60, "add: base + delta·step");
assert(cascadeValue(100, { mode: "mul", factor: 1.5 }, 2) === 225, "mul: base · factor^step");
let threw = false;
try {
  cascadeValue(1, { mode: "mul", factor: 0 }, 1);
} catch {
  threw = true;
}
assert(threw, "mul with factor ≤ 0 throws");

// --- 2. the owner's rotation example (4 stacked rects, +25°, firstFixed off) ---

{
  const rs = [rect(100, 100), rect(100, 100), rect(100, 100), rect(100, 100)];
  const { p, figId } = proj(rs);
  ops.cascadeElements(p, figId, rs.map((r) => r.id), { property: "rotation", delta: 25 });
  const rots = rs.map((r) => el(p, r.id).rotation);
  assert(JSON.stringify(rots) === JSON.stringify([25, 50, 75, 100]), `rotation +25 no-fix → 25/50/75/100 (got ${rots})`);
}

// --- 3. the owner's x example (+30, firstFixed on) ------------------------------

{
  const rs = [rect(200, 100), rect(200, 100), rect(200, 100), rect(200, 100)];
  const { p, figId } = proj(rs);
  ops.cascadeElements(p, figId, rs.map((r) => r.id), { property: "x", delta: 30, firstFixed: true });
  const xs = rs.map((r) => el(p, r.id).x);
  assert(JSON.stringify(xs) === JSON.stringify([200, 230, 260, 290]), `x +30 first-fixed → 0/+30/+60/+90 (got ${xs})`);
}

// --- 4. absolute-from-baseline: idempotent re-preview + property switch --------

{
  const rs = [rect(100, 100), rect(100, 100), rect(100, 100)];
  const { p, figId } = proj(rs);
  const ids = rs.map((r) => r.id);
  const baseline = new Map<string, Element>();
  ops.cascadeElements(p, figId, ids, { property: "rotation", delta: 10 }, baseline);
  ops.cascadeElements(p, figId, ids, { property: "rotation", delta: 10 }, baseline);
  const rots = ids.map((id) => el(p, id).rotation);
  assert(JSON.stringify(rots) === JSON.stringify([10, 20, 30]), "same spec re-applied with the session baseline is idempotent");
  ops.cascadeElements(p, figId, ids, { property: "rotation", delta: 40 }, baseline);
  assert(el(p, ids[2]).rotation === 120, "re-preview with a new delta recomputes from baseline (not compounding)");
  ops.cascadeElements(p, figId, ids, { property: "x", delta: 30 }, baseline);
  const after = ids.map((id) => el(p, id));
  assert(after.every((e) => e.rotation === 0), "property switch mid-session reverts the previous property's writes");
  assert(JSON.stringify(after.map((e) => e.x)) === JSON.stringify([130, 160, 190]), "…and applies the new property from baseline");
}

// --- 5. orderings ---------------------------------------------------------------

{
  // z-order: rA, rB, rC — positions scrambled so layer/x orders differ.
  const rA = rect(300, 50);
  const rB = rect(100, 50);
  const rC = rect(200, 50);
  const { p, figId } = proj([rA, rB, rC]);
  const selOrder = [rC.id, rA.id, rB.id]; // "click order"
  const runs: [string, { order?: "selection" | "layer" | "x" | "y"; reverse?: boolean }, string[]][] = [
    ["selection", {}, [rC.id, rA.id, rB.id]],
    ["layer", { order: "layer" }, [rA.id, rB.id, rC.id]],
    ["x", { order: "x" }, [rB.id, rC.id, rA.id]],
    ["layer+reverse", { order: "layer", reverse: true }, [rC.id, rB.id, rA.id]],
  ];
  const baseline = new Map<string, Element>();
  for (const [label, o, expected] of runs) {
    ops.cascadeElements(p, figId, selOrder, { property: "opacity", delta: -0.1, firstFixed: true, ...o }, baseline);
    const rank = (id: string) => Math.round((1 - ((el(p, id).opacity ?? 1) as number)) / 0.1);
    const got = [rA.id, rB.id, rC.id].sort((a, b) => rank(a) - rank(b));
    assert(JSON.stringify(got) === JSON.stringify(expected), `${label} order ranks ${expected.join(",")} (got ${got.join(",")})`);
  }
}

// --- 6. y-order + ties ----------------------------------------------------------

{
  const rA = rect(0, 200);
  const rB = rect(50, 100);
  const rC = rect(100, 200); // y ties with rA → layer breaks the tie (rA first)
  const { p, figId } = proj([rA, rB, rC]);
  ops.cascadeElements(p, figId, [rC.id, rA.id, rB.id], { property: "opacity", delta: -0.1, firstFixed: true, order: "y" });
  const op = (r: RectElement) => (el(p, r.id).opacity ?? 1) as number;
  assert(near(op(rB), 1) && near(op(rA), 0.9) && near(op(rC), 0.8), "y order sorts rB,rA,rC with layer tie-break");
}

// --- 7. group = one rigid unit ---------------------------------------------------

{
  const g1 = rect(100, 100, 40, 40);
  const g2 = rect(160, 100, 40, 40);
  const loose = rect(300, 100, 40, 40);
  const { p, figId } = proj([g1, g2, loose]);
  const gid = ops.group(p, [g1.id, g2.id]);
  assert(!!gid, "group created");
  ops.cascadeElements(p, figId, [g1.id, g2.id, loose.id], { property: "x", delta: 30 });
  assert(el(p, g1.id).x === 130 && el(p, g2.id).x === 190, "group unit translates rigidly at rank 0 (step 1)");
  assert(el(p, loose.id).x === 360, "loose element is rank 1 (step 2)");

  // rigid rotation: both members turn 25° and their center distance is preserved
  const c = (e: Element) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
  const d0 = Math.hypot(c(el(p, g1.id)).x - c(el(p, g2.id)).x, c(el(p, g1.id)).y - c(el(p, g2.id)).y);
  ops.cascadeElements(p, figId, [g1.id, g2.id, loose.id], { property: "rotation", delta: 25 });
  const d1 = Math.hypot(c(el(p, g1.id)).x - c(el(p, g2.id)).x, c(el(p, g1.id)).y - c(el(p, g2.id)).y);
  assert(el(p, g1.id).rotation === 25 && el(p, g2.id).rotation === 25, "group members share the unit's 25° turn");
  assert(near(d0, d1, 1e-9), "rigid rotation preserves member-center distance");
  assert(el(p, loose.id).rotation === 50, "loose element turns 50° at rank 1");
}

// --- 8. applicability excludes before ranking ------------------------------------

{
  const t1 = text(0, 0);
  const r1 = rect(50, 0);
  const e1 = ellipse(100, 0);
  const { p, figId } = proj([t1, r1, e1]);
  ops.cascadeElements(p, figId, [t1.id, r1.id, e1.id], { property: "cornerRadius", delta: 4 });
  const r = el(p, r1.id) as RectElement;
  assert(r.cornerRadius === 4, "the only accepting unit is rank 0 (step 1) — excluded units consume no rank");
  assert((el(p, t1.id) as TextElement).fontSize === 16, "non-accepting units untouched");
}

// --- 9. clamps -------------------------------------------------------------------

{
  const rs = [rect(0, 0), rect(0, 0), rect(0, 0)];
  const { p, figId } = proj(rs);
  ops.cascadeElements(p, figId, rs.map((r) => r.id), { property: "opacity", delta: -0.6 });
  const opac = rs.map((r) => (el(p, r.id).opacity ?? 1) as number);
  assert(near(opac[0], 0.4) && opac[1] === 0 && opac[2] === 0, `opacity clamps at 0 (got ${opac})`);
  ops.cascadeElements(p, figId, rs.map((r) => r.id), { property: "strokeWidth", delta: -5 });
  assert(rs.every((r) => (el(p, r.id) as RectElement).strokeWidth === 0), "strokeWidth clamps at 0");
}

// --- 10. width/height: setBoxDim semantics + aspect lock ---------------------------

{
  const plain = rect(0, 0, 100, 50);
  const locked = rect(0, 100, 100, 50, { lockAspect: true });
  const { p, figId } = proj([plain, locked]);
  ops.cascadeElements(p, figId, [plain.id, locked.id], { property: "width", delta: 100, firstFixed: true });
  assert(el(p, plain.id).width === 100 && el(p, plain.id).height === 50, "first-fixed rank 0 unchanged");
  const L = el(p, locked.id);
  assert(L.width === 200 && L.height === 100, `aspect-locked width cascade scales height from BASELINE dims (got ${L.width}×${L.height})`);

  // multiplicative sizes
  const b1 = rect(0, 200, 100, 50);
  const b2 = rect(0, 300, 100, 50);
  const { p: p2, figId: f2 } = proj([b1, b2]);
  ops.cascadeElements(p2, f2, [b1.id, b2.id], { property: "width", mode: "mul", factor: 1.5 });
  assert(el(p2, b1.id).width === 150 && el(p2, b2.id).width === 225, "mul width → ×1.5, ×2.25");
}

// --- 11. groups are excluded from W/H; paths/lines never accept W/H ----------------

{
  const g1 = rect(0, 0, 100, 50);
  const g2 = rect(120, 0, 100, 50);
  const solo = rect(300, 0, 100, 50);
  const { p, figId } = proj([g1, g2, solo]);
  ops.group(p, [g1.id, g2.id]);
  ops.cascadeElements(p, figId, [g1.id, g2.id, solo.id], { property: "width", delta: 50 });
  assert(el(p, g1.id).width === 100 && el(p, g2.id).width === 100, "group unit excluded from width cascade");
  assert(el(p, solo.id).width === 150, "the single-element unit is rank 0 (step 1)");

  // supportsBoxDim is the ONE box-dimension gate — the cascade, the Inspector
  // W/H fields, and the FluxFig-menu W/H keys all consume it. path/line desync
  // their geometry from the box, so they must be excluded from every W/H surface.
  assert(!supportsBoxDim("path") && !supportsBoxDim("line"), "path/line excluded from W/H (supportsBoxDim)");
  assert(
    ["rect", "ellipse", "image", "plot", "text"].every((t) => supportsBoxDim(t)),
    "rect/ellipse/image/plot/text accept W/H (supportsBoxDim)",
  );
}

// --- 12. fontSize is authored in pt (model px = pt·4/3) ----------------------------

{
  const t1 = text(0, 0);
  const t2 = text(0, 40);
  const { p, figId } = proj([t1, t2]);
  ops.cascadeElements(p, figId, [t1.id, t2.id], { property: "fontSize", delta: 3, firstFixed: true });
  const px = (id: string) => (el(p, id) as TextElement).fontSize;
  assert(near(px(t1.id), 16) && near(px(t2.id), 16 + 3 * PT_TO_PX), `fontSize +3pt → +4px per step (got ${px(t2.id)})`);
}

// --- 13. color ramp (OKLCh) ---------------------------------------------------------

{
  const rs = [rect(0, 0), rect(0, 40), rect(0, 80, 40, 120, { fill: "none" })];
  rs[0].fill = "#ff0000";
  rs[1].fill = "#ff0000";
  const { p, figId } = proj(rs);
  ops.cascadeElements(p, figId, rs.map((r) => r.id), { property: "fill", color: { dH: 40 } });
  const fills = rs.map((r) => (el(p, r.id) as RectElement).fill);
  assert(fills[0] === shiftOklch("#ff0000", { dH: 40 }, 1), "fill rank 0 = one 40° OKLCh hue step");
  assert(fills[1] === shiftOklch("#ff0000", { dH: 40 }, 2), "fill rank 1 = two hue steps (single k-scaled conversion)");
  assert(fills[0] !== fills[1] && fills[0] !== "#ff0000", "ramp produces distinct colors");
  assert(fills[2] === "none", '"none" keeps its rank but is left untouched');
}

// --- 14. shiftOklch pins --------------------------------------------------------------

{
  const round = shiftOklch("#3a7bd5", { dH: 360 }, 1)!;
  const a = parseColor("#3a7bd5")!;
  const b = parseColor(round)!;
  assert(Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2, "dH=360 is identity within rounding");
  assert(shiftOklch("none", { dL: 0.1 }, 1) === null, "shiftOklch(none) → null");
  assert(shiftOklch("var(--x)", { dL: 0.1 }, 1) === null, "unparseable → null");
  const white = shiftOklch("#888888", { dL: 5 }, 3)!;
  assert(parseColor(white)!.r === 255, "dL clamps at L=1 (white)");
  const gray = shiftOklch("#777777", { dH: 90 }, 2)!;
  const g = parseColor(gray)!;
  assert(Math.abs(g.r - g.g) <= 2 && Math.abs(g.g - g.b) <= 2, "hue rotation leaves achromatic gray gray (C≈0)");
  const alpha = shiftOklch("#ff000080", { dH: 30 }, 1)!;
  assert(alpha.length === 9 && alpha.endsWith("80"), "alpha preserved through the shift");
}

// --- 15. text color prop + missing ids -----------------------------------------------

{
  const t1 = text(0, 0);
  const t2 = text(0, 40);
  const { p, figId } = proj([t1, t2]);
  ops.cascadeElements(p, figId, [t1.id, "ghost", t2.id], { property: "color", color: { dL: -0.1 } });
  const c1 = (el(p, t1.id) as TextElement).color;
  assert(c1 === shiftOklch("#333333", { dL: -0.1 }, 1), "text color ramps via the color prop; unknown ids are skipped");
}

// === tracks ============================================================================

function deckFixture(): Deck {
  return {
    schemaVersion: "0.3.0",
    id: "deck1",
    title: "T",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    stage: { width: 640, height: 360 },
    theme: "flux-dark",
    defaults: { transition: "none", buildEasing: "smooth", advance: "click" },
    assets: [],
    slides: [
      {
        id: "s1",
        elements: [],
        beats: [
          { id: "b0", tracks: [] },
          {
            id: "b1",
            tracks: [
              { id: "tA", target: "el1", preset: "fade" },
              { id: "tB", target: "el2", preset: "fade", stagger: { perMs: 100 } },
            ],
          },
          { id: "b2", tracks: [{ id: "tC", target: "el3", preset: "fade", duration: 700 }] },
        ],
      },
    ],
  } as unknown as Deck;
}
const trk = (d: Deck, id: string) => d.slides[0].beats.flatMap((b) => b.tracks).find((t) => t.id === id)!;

// --- 16. start stagger, timeline order across beats ------------------------------------

{
  const d = deckFixture();
  const n = slideOps.cascadeTracks(d, "s1", ["tC", "tA", "tB"], { property: "start", delta: 200, firstFixed: true });
  assert(n === 3, "cascadeTracks reports 3 written");
  assert(trk(d, "tA").start === 0 && trk(d, "tB").start === 200 && trk(d, "tC").start === 400,
    "timeline order (beat, then lane) beats the given id order by default");
}

// --- 17. list order + reverse ------------------------------------------------------------

{
  const d = deckFixture();
  slideOps.cascadeTracks(d, "s1", ["tC", "tA", "tB"], { property: "start", delta: 100, firstFixed: true, order: "list" });
  assert(trk(d, "tC").start === 0 && trk(d, "tA").start === 100 && trk(d, "tB").start === 200, "list order = the given selection order");
  const d2 = deckFixture();
  slideOps.cascadeTracks(d2, "s1", ["tA", "tB", "tC"], { property: "start", delta: 100, firstFixed: true, reverse: true });
  assert(trk(d2, "tC").start === 0 && trk(d2, "tA").start === 200, "reverse flips the timeline ranks");
}

// --- 18. duration clamp + default base ----------------------------------------------------

{
  const d = deckFixture();
  slideOps.cascadeTracks(d, "s1", ["tA", "tB", "tC"], { property: "duration", delta: -400 });
  assert(trk(d, "tA").duration === 50 && trk(d, "tB").duration === 50, "duration floors at 50ms from the 400 default");
  assert(trk(d, "tC").duration === 50, "explicit 700ms base clamps too (700 − 1200)");
}

// --- 19. influence: nested write, both-zero deletion, baseline restore on switch ----------

{
  const d = deckFixture();
  const baseline = new Map<string, slideOps.TrackCascadeBaseline>();
  slideOps.cascadeTracks(d, "s1", ["tA", "tB", "tC"], { property: "influence.in", delta: 30 }, baseline);
  assert(trk(d, "tA").influence?.in === 30 && trk(d, "tC").influence?.in === 90, "influence.in ramps 30/60/90");
  assert(trk(d, "tA").influence?.out === 0, "the other side defaults to 0");
  slideOps.cascadeTracks(d, "s1", ["tA", "tB", "tC"], { property: "influence.out", delta: 200 }, baseline);
  assert(trk(d, "tA").influence?.in === 0 && trk(d, "tA").influence?.out === 100, "property switch restores baseline in, clamps out at 100");
  slideOps.cascadeTracks(d, "s1", ["tA", "tB", "tC"], { property: "influence.out", delta: 0 }, baseline);
  assert(trk(d, "tA").influence === undefined, "both-zero influence is deleted (PropertiesPane parity)");
}

// --- 20. stagger.perMs applies only to stagger-bearing tracks ------------------------------

{
  const d = deckFixture();
  const n = slideOps.cascadeTracks(d, "s1", ["tA", "tB", "tC"], { property: "stagger.perMs", delta: 50 });
  assert(n === 1, "only the stagger-bearing track ranks");
  assert(trk(d, "tB").stagger?.perMs === 150, "tB perMs 100 → 150 at rank 0 (step 1)");
  assert(trk(d, "tA").stagger === undefined && trk(d, "tC").stagger === undefined, "others untouched");
}

// --- 21. track idempotence + unknown slide ---------------------------------------------------

{
  const d = deckFixture();
  const baseline = new Map<string, slideOps.TrackCascadeBaseline>();
  slideOps.cascadeTracks(d, "s1", ["tA", "tB"], { property: "start", delta: 100 }, baseline);
  slideOps.cascadeTracks(d, "s1", ["tA", "tB"], { property: "start", delta: 100 }, baseline);
  assert(trk(d, "tA").start === 100 && trk(d, "tB").start === 200, "track re-preview with the session baseline is idempotent");
  assert(slideOps.cascadeTracks(d, "nope", ["tA"], { property: "start", delta: 1 }) === 0, "unknown slide → 0 written");
}

console.log("verify-cascade: ALL OK");
