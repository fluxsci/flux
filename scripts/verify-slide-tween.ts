#!/usr/bin/env -S npx tsx
// Animation rework §4 — the transform tween core (src/lib/slide/tween.ts) and
// its player integration. Pure units: lerpElement per prop class (numeric /
// rotation shortest-arc / OKLab colors / node resample / dash / discrete
// midpoint / numeric text), diffState↔applyState round-trips, chained
// pre-state composition, contentPlan (crossfade selection). Then a linkedom
// drive: computeSlideAnims emits transform specs, applyStatic lands the
// composed END state on the wrapper + content (the export frame-step
// substrate), chains rest at intermediate states, futures never leak, and the
// same-beat appearance/transform conflict rule holds.
// Run: npx tsx scripts/verify-slide-tween.ts
import { parseHTML, DOMParser } from "linkedom";
import * as tween from "../src/lib/slide/tween";
const { applyState, diffState, lerpElement, lerpNodes, lerpDash, numericTextTween,
  contentPlan, foldPreState, arcBox, overshootBox } = tween;
import { compileSlide } from "../src/lib/slide/compile";
import { resampleNodes, nodesToPath, pathD } from "../src/lib/path";
import type { Element as FigElement, RectElement, TextElement, PathElement, VectorNode } from "../src/lib/types";

import { harness } from "./lib/harness.mjs";
const h = harness("verify-slide-tween");
function assert(cond: unknown, msg: string) {
  if (!h.ok(cond, msg)) throw new Error("FAIL: " + msg);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

const rect = (over: Partial<RectElement> = {}): RectElement => ({
  type: "rect", id: "r1", x: 10, y: 20, width: 100, height: 50, rotation: 0,
  fill: "#ff0000", stroke: "#000000", strokeWidth: 2, cornerRadius: 0, ...over,
});
const text = (over: Partial<TextElement> = {}): TextElement => ({
  type: "text", id: "t1", x: 0, y: 0, width: 200, height: 40, rotation: 0,
  text: "hello", fontFamily: "Arial", fontSize: 16, fontWeight: 400,
  fontStyle: "normal", align: "left", color: "#ffffff", sizing: "auto", ...over,
});

// Discrete channels follow the raw clock, even when easing reverses.
{
  const { resolveCurve } = await import("../src/lib/slide/curves");
  for (const curve of [{ kind: "bezier", p: [.3, 2, .7, -1] }, { kind: "spring", bounce: .8 }] as const) {
    const ease = resolveCurve({ curve: curve as import("../src/lib/slide/types").Curve });
    const before = text(), after = text({ fontFamily: "Georgia", align: "center", flipX: true });
    const frames = Array.from({ length: 60 }, (_, i) => lerpElement(before, after, ease.clamped(i/59), i/59) as TextElement);
    const flips = frames.slice(1).filter((f,i) => f.fontFamily !== frames[i].fontFamily).length;
    assert(flips === 1, `non-monotone timing flips a discrete prop once over 60 samples (observed ${flips})`);
    assert(frames.every((f,i) => f.fontFamily === (i/59 < .5 ? "Arial" : "Georgia")), "discrete props use raw progress even at clamped eased endpoints");
  }
}

// M6: the arc acts only on an owned sample's position; zero keeps exact bytes.
{
  const a = rect(), b = rect({ x: 210, y: 120, width: 220, rotation: 35 });
  for (const u of [0, .1, .5, .9, 1, 1.15, -.1]) {
    const sample = overshootBox(lerpElement(a, b, Math.max(0, Math.min(1, u))), a, b, u);
    const bytes = JSON.stringify(sample);
    assert(arcBox(sample, a, b, u, 0) === sample && JSON.stringify(sample) === bytes, `arc 0 is byte-identical at ${u}`);
    for (const arc of [-1, 1]) {
      const curved = arcBox(structuredClone(sample), a, b, u, arc);
      assert(near(curved.x, a.x + (b.x-a.x)*u - (b.y-a.y)*arc*u*(1-u), 1e-12) &&
        near(curved.y, a.y + (b.y-a.y)*u + (b.x-a.x)*arc*u*(1-u), 1e-12), `arc ${arc} quadratic position at ${u}`);
      assert(JSON.stringify({ ...curved, x: sample.x, y: sample.y }) === bytes, "arc changes only x/y");
      if (u === .5) assert(near(Math.hypot(curved.x-sample.x, curved.y-sample.y), Math.hypot(b.x-a.x,b.y-a.y)/4, 1e-12), "arc ±1 midpoint has one quarter of the travel distance");
    }
  }

}

// --- numerics + rotation + opacity -------------------------------------------
{
  const a = rect(), b = rect({ x: 110, width: 200, opacity: 0.5, rotation: 350 });
  const m = lerpElement(a, b, 0.5) as RectElement;
  assert(near(m.x, 60) && near(m.width, 150), "numeric props lerp (x 10→110 = 60 at t=.5)");
  assert(near(m.opacity ?? -1, 0.75), "absent opacity defaults to 1 (1→0.5 = 0.75)");
  assert(near(m.rotation, -5), "rotation takes the SHORTEST arc (0→350 goes −10°, not +350°)");
  assert((lerpElement(a, b, 0) as RectElement).x === 10 && (lerpElement(a, b, 1) as RectElement).x === 110, "t=0/1 return endpoint clones verbatim");
}

// --- colors (OKLab via color/interp) -----------------------------------------
{
  const m = lerpElement(rect(), rect({ fill: "#0000ff" }), 0.5) as RectElement;
  const mid = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(m.fill)!;
  assert(parseInt(mid[1], 16) > 100 && parseInt(mid[3], 16) > 100, `fill blends in OKLab (red→blue mid is purple: ${m.fill})`);
  const n = lerpElement(rect({ fill: "none" }), rect({ fill: "#1b9e77" }), 0.5) as RectElement;
  assert(/^#1b9e77[0-9a-f]{2}$/.test(n.fill) || n.fill.startsWith("#1b9e7"), `none→color ramps alpha (${n.fill})`);
}

// --- dash ---------------------------------------------------------------------
{
  assert(JSON.stringify(lerpDash([6, 4], undefined, 0.5)) === "[6,2]", "dash→solid halves the gaps at t=.5");
  assert(JSON.stringify(lerpDash(undefined, [6, 4], 0.5)) === "[6,2]", "solid→dash mirrors");
  assert(JSON.stringify(lerpDash([8], [2, 2], 0.5)) === JSON.stringify([5, 5]), "odd patterns double (SVG repeat rule: [8]→[8,8]) then lerp");
  const m = lerpElement(rect({ dash: [6, 4] }), rect(), 0.5) as RectElement;
  assert(JSON.stringify(m.dash) === "[6,2]", "lerpElement routes dash through lerpDash");
}

// --- discrete steps at 0.5 ----------------------------------------------------
{
  const a = text(), b = text({ fontFamily: "Georgia", align: "center", fontWeight: 700 });
  assert((lerpElement(a, b, 0.49) as TextElement).fontFamily === "Arial", "discrete props hold until t=.5");
  assert((lerpElement(a, b, 0.5) as TextElement).align === "center", "…then step");
  assert((lerpElement(a, b, 0.5) as TextElement).fontWeight === 600, "fontWeight lerps then rounds to weight steps (400→700 mid = 600)");
}

// --- text: numeric digit-tween vs crossfade ----------------------------------
{
  const s = numericTextTween("n = 100 cells", "n = 250 cells")!;
  assert(s(0.5) === "n = 175 cells", "pure numeric diff digit-tweens");
  assert(s(0) === "n = 100 cells" && s(1) === "n = 250 cells", "…with exact endpoints");
  const c = numericTextTween("n = 1,000", "n = 2,000")!;
  assert(c(0.5) === "n = 1,500", "thousands separators inferred");
  assert(numericTextTween("hello", "world") === null, "a rewrite is not tweenable");
  // R2 F2: the shown precision moves from the start text's to the end text's, never to the larger of the two at once. "42" -> "4.2" read "42.0" on
  // its first frame (a ".0" out of nowhere, a 53 stage px^2 start pop on the Release 2 corpus); the first frame is the start text, digit for digit.
  const p = numericTextTween("Flux 42", "Flux 4.2")!;
  assert(p(1e-9) === "Flux 42" && p(0.25) === "Flux 33" && p(0.45) === "Flux 25" && p(0.55) === "Flux 21.2" && p(0.999) === "Flux 4.2" && p(1) === "Flux 4.2", "42 -> 4.2: whole numbers until the count is half way, one decimal after, the end text at 1 (no '42.0' on the first frame)");
  const q = numericTextTween("3.50 s", "4 s")!;
  assert(q(1e-9) === "3.50 s" && q(0.2) === "3.60 s" && q(0.4) === "3.7 s" && q(0.999) === "4 s" && q(1) === "4 s", "3.50 -> 4: the precision runs down with the count (two decimals, one, none), the start text exactly at the first frame, no trailing zero kept to the end");
  const same = numericTextTween("1,000 cells", "2,500 cells")!;
  assert(same(0.001) === "1,002 cells" && same(0.5) === "1,750 cells", "equal precision keeps its separators and its single format");
  // Superseded 2026-10-02 (oct2 W3): a rewrite plays the glyph-matched text
  // morph (shared words glide, the rest fades staggered), never the flat crossfade.
  assert(contentPlan(text({ text: "hello" }), text({ text: "world" })).mode === "textMorph", "contentPlan sends text rewrites to the text morph");
  assert(contentPlan(text({ text: "n = 1" }), text({ text: "n = 9" })).mode === "tween", "…but digit-tweens numeric diffs");
  const m = lerpElement(text({ text: "n = 100" }), text({ text: "n = 200" }), 0.5) as TextElement;
  assert(m.text === "n = 150", "lerpElement digit-tweens text in place");
}

// --- contentPlan dirt classes -------------------------------------------------
{
  assert(contentPlan(rect(), rect({ x: 400, rotation: 30, opacity: 0.4 })).contentDirty === false, "box-only transforms never touch content");
  const p = contentPlan(rect(), rect({ width: 300 }));
  assert(p.contentDirty && p.geometryDirty, "a size change is content- and geometry-dirty");
  assert(contentPlan(rect(), rect({ fill: "#00ff00" })).contentDirty === true, "a fill change re-renders content");
  assert(contentPlan(rect(), rect({ fill: "#00ff00" })).geometryDirty === false, "…but is not geometry-dirty");
}

// --- paths: equal-count lerp, resample, topology step -------------------------
{
  const nodes = (pts: [number, number][]): VectorNode[] => pts.map(([x, y]) => ({ x, y, type: "corner" as const }));
  const pathEl = (ns: VectorNode[], closed = false): PathElement => ({
    type: "path", id: "p1", x: 0, y: 0, width: 100, height: 100, rotation: 0,
    d: nodesToPath(ns, closed), fill: "none", stroke: "#000", strokeWidth: 2, closed, nodes: ns,
  });
  const a = pathEl(nodes([[0, 0], [100, 0]]));
  const b = pathEl(nodes([[0, 100], [100, 100]]));
  const m = lerpElement(a, b, 0.5) as PathElement;
  assert(m.nodes!.every((n) => near(n.y, 50)), "equal-count paths lerp node positions");
  assert(m.d.includes("50"), "…and regenerate d");

  // unequal counts: 2-node line vs 5-node line — resample then lerp
  const b5 = pathEl(nodes([[0, 100], [25, 100], [50, 100], [75, 100], [100, 100]]));
  const m2 = lerpElement(a, b5, 0.5) as PathElement;
  assert(m2.nodes!.length === 5, "unequal node counts resample BOTH to the larger");
  assert(m2.nodes!.every((n) => near(n.y, 50, 0.5)), "…and tween cleanly");
  const snap = lerpElement(a, b5, 1) as PathElement;
  assert(snap.nodes!.length === 5 && JSON.stringify(snap.nodes) === JSON.stringify(b5.nodes), "t=1 snaps to the TRUE end nodes (no resample residue)");

  // resampleNodes itself: geometry preserved on a straight polyline
  const rs = resampleNodes(nodes([[0, 0], [100, 0]]), false, 5);
  assert(rs.length === 5 && rs.every((n, i) => near(n.x, i * 25) && near(n.y, 0)), "resampleNodes spaces stations by arc length");
  assert(!rs.some((n) => n.hIn || n.hOut), "straight links stay handle-free");
  const closed = resampleNodes(nodes([[0, 0], [100, 0], [100, 100], [0, 100]]), true, 8);
  assert(closed.length === 8 && near(closed[0].x, 0) && near(closed[0].y, 0), "closed resample keeps the seam at node 0");
  assert(near(closed[1].x, 50) && near(closed[1].y, 0), "…and walks the perimeter (400/8=50 per station)");

  // topology change → the outline morph (Become): one path whose ends travel,
  // never a crossfade or a step (superseded 2026-09-15 — see verify-slide-outline)
  const open = pathEl(nodes([[0, 0], [100, 0], [100, 100]]), false);
  const shut = pathEl(nodes([[0, 0], [100, 0], [100, 100]]), true);
  assert(contentPlan(open, shut).mode === "morph", "closed≠open topology morphs through the outline");
  const topo = lerpElement(open, shut, 0.6) as PathElement;
  assert(topo.type === "path" && topo.nodes!.length > 3 && topo.nodes!.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), "…and the model samples a finite intermediate path");

  // cornerRadius lerps and the frame's d embeds the interpolated fillets;
  // cap (a string) steps at t=.5 like other discrete props.
  const bendA = pathEl(nodes([[0, 0], [100, 0], [100, 100]]));
  const bendB = { ...pathEl(nodes([[0, 0], [100, 0], [100, 100]])), cornerRadius: 20, cap: "butt" as const };
  bendA.d = pathD(bendA.nodes!, false, 0);
  bendB.d = pathD(bendB.nodes!, false, 20);
  const rm = lerpElement(bendA, bendB, 0.5) as PathElement;
  assert(near(rm.cornerRadius ?? 0, 10), "path cornerRadius lerps (0→20 mid = 10)");
  assert(rm.d.includes("C") && rm.d === pathD(rm.nodes!, false, 10), "mid-frame d = pathD(lerped skeleton, lerped radius)");
  assert(rm.nodes!.length === 3 && !rm.nodes![1].hOut, "lerped nodes stay the sharp skeleton (fillets only in d)");
  assert((lerpElement(bendA, bendB, 0.49) as PathElement).cap === undefined, "cap holds until t=.5");
  assert((lerpElement(bendA, bendB, 0.5) as PathElement).cap === "butt", "…then steps");
  // applyState with a patched radius re-emits d through pathD
  const rp = applyState(bendA, { cornerRadius: 20 }) as PathElement;
  assert(rp.d === pathD(bendA.nodes!, false, 20), "applyState cornerRadius patch re-emits rounded d");
}

// --- diffState / applyState round trips ---------------------------------------
{
  const a = rect({ overrides: undefined });
  const b = rect({ x: 99, fill: "#00aa00", dash: [4, 2] });
  const patch = diffState(a, b)!;
  assert(JSON.stringify(Object.keys(patch).sort()) === JSON.stringify(["dash", "fill", "x"]), "diffState is SPARSE (only changed props)");
  assert(JSON.stringify(applyState(a, patch)) === JSON.stringify(b), "applyState(pre, diff) reproduces cur exactly");
  // prop deletion round-trips as null
  const c = rect({ dash: [4, 2] });
  const d = rect();
  const del = diffState(c, d)!;
  assert(del.dash === null, "a deleted prop records null");
  assert(!("dash" in (applyState(c, del) as unknown as Record<string, unknown>)), "…and applyState deletes it");
  assert(diffState(a, structuredClone(a)) === null, "no changes → null (no empty patches)");
  // identity/bookkeeping props are never captured
  const e = rect(); const f = rect({ name: "Renamed", locked: true, hidden: true });
  assert(diffState(e, f) === null, "id/name/locked/hidden are never captured");
}

// --- overrides: per-part diff + merge + lerp ----------------------------------
{
  const plotA = { type: "plot", id: "pl", x: 0, y: 0, width: 100, height: 80, rotation: 0, assetId: "as1", overrides: { "s.line": { stroke: "#ff0000", strokeWidth: 1 } } } as unknown as FigElement;
  const plotB = structuredClone(plotA) as unknown as { overrides: Record<string, Record<string, unknown>> };
  plotB.overrides = { "s.line": { stroke: "#0000ff", strokeWidth: 3 }, "s.pts": { hidden: true } };
  const patch = diffState(plotA, plotB as unknown as FigElement)!;
  const ov = patch.overrides as Record<string, unknown>;
  assert(!!ov["s.line"] && !!ov["s.pts"], "override diffs record changed parts verbatim");
  assert(JSON.stringify(applyState(plotA, patch)) === JSON.stringify(plotB), "override patches apply per part-id");
  const back = diffState(plotB as unknown as FigElement, plotA)!;
  assert((back.overrides as Record<string, unknown>)["s.pts"] === null, "a removed part records null");
  assert(JSON.stringify(applyState(plotB as unknown as FigElement, back)) === JSON.stringify(plotA), "…and deletes on apply");
  const mid = lerpElement(plotA, plotB as unknown as FigElement, 0.5) as unknown as { overrides: Record<string, Record<string, unknown>> };
  assert(near(mid.overrides["s.line"].strokeWidth as number, 2), "override leaf numerics lerp (1→3 = 2)");
}

// --- chained pre-state composition --------------------------------------------
{
  const doc = rect();
  const s1 = { x: 200 };
  const s2 = { fill: "#00ff00", x: 300 };
  const pre2 = foldPreState(doc, [s1]);
  assert((pre2 as RectElement).x === 200, "t1 of the second transform = doc ⊕ state1");
  const pre3 = foldPreState(doc, [s1, s2]);
  assert((pre3 as RectElement).x === 300 && (pre3 as RectElement).fill === "#00ff00", "states fold left-to-right in beat order");
}

// --- text metric invalidation --------------------------------------------------
{
  const a = text({ lines: ["hello"], sizing: "auto-h" });
  const out = applyState(a, { text: "a much longer line of copy", fontSize: 20 }) as TextElement;
  assert(!out.lines && out.needsLayout === true, "metric-prop patches drop the wrap cache and flag needsLayout");
  const m = lerpElement(text({ fontSize: 10 }), text({ fontSize: 30 }), 0.5) as TextElement;
  assert(m.needsLayout === true, "metric tweens flag needsLayout per frame (the DOM layer re-wraps)");
}

// === the player drive (linkedom) ==============================================
const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const { computeSlideAnims, applyAt, applyStatic, disposeSlideAnims, transformPreState, renderStaticAt } = await import("../src/lib/slide/player/player");
const { renderSlide } = await import("../src/lib/slide/player/render");
const { FLUX_DARK } = await import("../src/lib/slide/theme");
type Slide = import("../src/lib/slide/types").Slide;

const stage = { width: 640, height: 360 };
const opts = { theme: FLUX_DARK } as never;

function build(slide: Slide) {
  const host = document.createElement("div") as unknown as HTMLElement;
  const rendered = renderSlide(host, slide, stage, { theme: FLUX_DARK });
  const camera = document.createElement("div") as unknown as HTMLElement;
  const specs = computeSlideAnims(slide, rendered, camera, stage, opts);
  return { rendered, specs };
}

// one rect, one transform: move + resize + recolor
{
  const slide: Slide = {
    id: "s1",
    elements: [rect({ id: "r1" })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [{ id: "tr1", target: "r1", preset: "transform", duration: 600, to: { state: { x: 300, width: 200, fill: "#0000ff" } } }] },
    ],
  };
  const { rendered, specs } = build(slide);
  assert(specs.length === 1, "a transform track emits one controller spec");
  const wrap = rendered.elements.get("r1")!;
  applyStatic(specs, 1);
  assert(wrap.style.left === "300px" && wrap.style.width === "200px", "applyStatic(≥beat) rests the wrapper at the composed t2 box");
  const inner = wrap.querySelector("rect");
  assert(inner?.getAttribute("fill") === "#0000ff", "…and the content re-rendered to the t2 state (fill)");
  applyStatic(specs, 0);
  assert(wrap.style.left === "10px" && wrap.querySelector("rect")?.getAttribute("fill") === "#ff0000", "applyStatic(before) restores the pre state (box + content)");
}

// chained transforms: rest between beats = end of the earlier one; futures never leak
{
  const slide: Slide = {
    id: "s2",
    elements: [rect({ id: "r1" })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [{ id: "tA", target: "r1", preset: "transform", to: { state: { x: 200 } } }] },
      { id: "b2", tracks: [] },
      { id: "b3", tracks: [{ id: "tB", target: "r1", preset: "transform", to: { state: { x: 400, fill: "#00ff00" } } }] },
    ],
  };
  const pre = transformPreState(slide, "r1", 3)!;
  assert((pre as RectElement).x === 200, "transformPreState folds earlier transforms (t1 of B = end of A)");
  const { rendered, specs } = build(slide);
  const wrap = rendered.elements.get("r1")!;
  applyStatic(specs, 0);
  assert(wrap.style.left === "10px", "rest at beat 0 = base (a FUTURE chain leaks nothing)");
  applyStatic(specs, 1);
  assert(wrap.style.left === "200px" && wrap.querySelector("rect")?.getAttribute("fill") === "#ff0000", "rest between the chain = end of the first only");
  applyStatic(specs, 3);
  assert(wrap.style.left === "400px" && wrap.querySelector("rect")?.getAttribute("fill") === "#00ff00", "rest after the chain = the full composition");
  applyStatic(specs, 0);
  assert(wrap.style.left === "10px", "…and scrubbing back restores base (interruption-safe)");
}

// Composition: appearance opacity multiplies the authored transform opacity.
{
  const slide: Slide = {
    id: "s3",
    elements: [rect({ id: "r1" })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [
        { id: "f1", target: "r1", preset: "fade", duration: 300 },
        { id: "t1", target: "r1", preset: "transform", to: { state: { x: 500, opacity: 0.25 } } },
      ] },
    ],
  };
  const { rendered, specs } = build(slide);
  const wrap = rendered.elements.get("r1")!;
  applyStatic(specs, 1);
  assert(wrap.style.left === "500px", "the transform still owns the box");
  assert(wrap.style.opacity === "0.25" && (wrap.querySelector(".sl-effects") as HTMLElement)?.style.opacity === "1", "…appearance composes on its own layer and preserves the transformed opacity");
}

// A text rewrite plays the text morph (A original · M spans · B end). This DOM
// cannot measure glyphs, so it exercises the morph's FALLBACK: A and B cross-
// lerp at their natural size while the box moves (superseded 2026-10-02, oct2
// W3 — was two stacked crossfade layers; the real morph is pinned in Chrome by
// verify-text-morph-browser.ts).
{
  const slide: Slide = {
    id: "s4",
    elements: [text({ id: "t1", text: "before" })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [{ id: "tr", target: "t1", preset: "transform", to: { state: { text: "after", x: 100 } } }] },
    ],
  };
  const { rendered, specs } = build(slide);
  const wrap = rendered.elements.get("t1")!;
  const ctrl = specs.find((s) => (s as { morph?: unknown }).morph) as unknown as { morph: { seek(t: number): void } };
  ctrl.morph.seek(0.5);
  assert(wrap.children.length === 3 && (wrap.children[1] as HTMLElement).className === "sl-text-morph", "a text rewrite builds the A / span / B layers");
  const [la, lm, lb] = Array.from(wrap.children) as HTMLElement[];
  assert(lm.style.visibility === "hidden", "…an unmeasurable host shows no spans");
  assert(near(Number(la.style.opacity), 0.5) && near(Number(lb.style.opacity), 0.5), "…and the fallback cross-lerps A and B");
  // mid-flight the box rides the COMPOSITE transform (layout frozen at the t1
  // box — the glide fix); effective x = frozen left + translate-x
  const midTx = /translate\(([-0-9.]+)px/.exec(wrap.style.transform || "")?.[1];
  assert(wrap.style.left === "0px" && near(parseFloat(midTx ?? "NaN"), 50), "…while the box still MOVES via the composite transform (the fallback never pops)");
  assert(lb.textContent?.includes("after"), "the B layer renders the end content");
  ctrl.morph.seek(1);
  assert(wrap.style.left === "100px" && !/translate/.test(wrap.style.transform), "…and the endpoint restores the classic layout box (no composite residue)");
}

// The placement law (render.ts): a wrapper's LAYOUT box is whole stage pixels
// and the exact box is realized by a residual composite transform — at rest
// as well as mid-flight — so a fractional endpoint never snaps on settle. A
// whole-pixel rest keeps the classic (transform-free, centre-origin) form.
{
  const slide: Slide = {
    id: "s6",
    elements: [rect({ id: "r1", x: 10.4, y: 20, width: 100, height: 50 })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [{ id: "tr", target: "r1", preset: "transform", easing: "linear", to: { state: { x: 300.25, y: 60.5, width: 120.5 } } }] },
      { id: "b2", tracks: [{ id: "tr2", target: "r1", preset: "transform", to: { state: { x: 400, y: 60, width: 120 } } }] },
    ],
  };
  const { rendered, specs } = build(slide);
  const wrap = rendered.elements.get("r1")!;
  applyStatic(specs, 0);
  assert(wrap.style.left === "10px" && wrap.style.transform === "translate(0.4px, 0px)" && wrap.style.transformOrigin === "0 0",
    "a fractional REST position is a whole-pixel layout box plus a residual translate (never a fractional left)");
  applyStatic(specs, 1);
  assert(wrap.style.left === "300px" && wrap.style.top === "61px" && wrap.style.width === "121px",
    "a fractional endpoint rests on the ROUNDED layout box");
  assert(wrap.style.transform === "translate(0.25px, -0.5px) scale(0.995868, 1)",
    "…with the residual translate + scale realizing the exact box (the same composite form mid-flight frames use; micro-pixel precision)");
  const ctrl = specs.find((s) => (s as { trackId?: string }).trackId === "tr") as unknown as { morph: { seek(t: number): void } };
  ctrl.morph.seek(0.999);
  assert(wrap.style.left === "10px" && wrap.style.top === "20px" && wrap.style.width === "100px",
    "mid-flight the layout box is FROZEN at the rounded pre box");
  const tx = /translate\(([-0-9.]+)px, ([-0-9.]+)px\)/.exec(wrap.style.transform)!;
  assert(near(parseFloat(tx[1]), 0.4 + 0.999 * (300.25 - 10.4), 0.001) && near(parseFloat(tx[2]), 0.999 * 40.5, 0.001),
    "…and the composite translate carries the exact fraction, continuous into the endpoint");
  applyStatic(specs, 2);
  assert(wrap.style.left === "400px" && wrap.style.top === "60px" && wrap.style.width === "120px" && wrap.style.transform === "" && wrap.style.transformOrigin === "center center",
    "a whole-pixel rest keeps the classic form (no transform, centre origin)");
}

// Layer hygiene (render.ts): a PURE MOVE rides its own compositor layer for
// the flight (will-change: transform — text glides instead of stepping a
// device pixel at a time; heavy content moves without repainting) and is
// demoted at either endpoint. A flight that scales (or rotates) never is.
{
  const slide: Slide = {
    id: "s7",
    elements: [rect({ id: "mv" }), rect({ id: "grow", x: 300 }), rect({ id: "spin", x: 500 }), rect({ id: "tint", x: 100, y: 200 }), text({ id: "turn", x: 300, y: 250 })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [
        { id: "a", target: "mv", preset: "transform", to: { state: { x: 200, y: 80, fill: "#00ff00" } } },
        { id: "b", target: "grow", preset: "transform", to: { state: { x: 350, width: 150 } } },
        { id: "c", target: "spin", preset: "transform", to: { state: { rotation: 45 } } },
        { id: "d", target: "tint", preset: "transform", to: { state: { fill: "#ff0000" } } },
        { id: "e", target: "turn", preset: "transform", to: { state: { rotation: 30 } } },
      ] },
      { id: "b2", tracks: [] },
      { id: "b3", tracks: [{ id: "f", target: "mv", preset: "transform", to: { state: { width: 150 } } }] },
    ],
  };
  const { rendered, specs } = build(slide);
  const mv = rendered.elements.get("mv")!, grow = rendered.elements.get("grow")!, spin = rendered.elements.get("spin")!, tint = rendered.elements.get("tint")!, turn = rendered.elements.get("turn")!;
  // linkedom has no Web Animations: stub `animate` to observe the flight MARK —
  // the paused, additive, no-op transform animation that tells the compositor
  // the transform is animating (without it a promoted node that also repaints
  // per frame bakes its fractional offset into every raster and steps again)
  const marks: { node: HTMLElement; frames: Keyframe[]; opts: KeyframeAnimationOptions; paused: boolean; cancelled: boolean }[] = [];
  (Object.getPrototypeOf(mv) as { animate?: unknown }).animate = function (this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const m = { node: this, frames, opts, paused: false, cancelled: false };
    marks.push(m);
    return { pause: () => { m.paused = true; }, cancel: () => { m.cancelled = true; }, finished: Promise.resolve() };
  };
  const ctrl = (id: string) => (specs.find((s) => (s as { trackId?: string }).trackId === id) as unknown as { morph: { seek(t: number): void } }).morph;
  applyStatic(specs, 0);
  assert(!mv.style.willChange && !grow.style.willChange, "at rest nothing is promoted");
  assert(marks.length === 0, "the flight mark follows the BEAT (lane J): a node whose glide is in a later beat has none yet (no layer kept for a flight that is not coming)");
  applyAt(specs, 1, 0);
  assert(marks.some((m) => m.node === mv && m.paused && m.opts.composite === "add" && m.frames.every((f) => f.transform === "translate(0px, 0px)")),
    "…armed at the first frame of the beat in which the pure mover glides: one paused additive no-op transform animation");
  assert(!marks.some((m) => m.node === grow || m.node === spin || m.node === tint), "a scaling flight, a turning SHAPE and a recolour that goes nowhere get none (a mark on a shape only adds a first-frame step; a recolour has nothing to carry)");
  assert(marks.some((m) => m.node === turn) && marks.length === 2, "a TURNING TEXT rides the mark (unpromoted it flips between a hinted and a rotated raster: a 9 to 66 stage px^2 jump at the first frames, ragged all along)");
  ctrl("a").seek(0.5); ctrl("b").seek(0.5); ctrl("c").seek(0.5);
  assert(mv.style.willChange === "transform", "mid-flight a pure move (even one that recolors) rides its own layer");
  assert(!grow.style.willChange && !spin.style.willChange, "a scaling or rotating flight paints in place every frame (no resampled raster, no sharpen pop on settle)");
  ctrl("a").seek(1);
  assert(!mv.style.willChange && mv.style.left === "200px", "the endpoint demotes the wrapper (crisp at rest)");
  ctrl("a").seek(0.25); ctrl("a").seek(0);
  assert(!mv.style.willChange && mv.style.left === "10px", "…and so does a seek back to the start");
  applyStatic(specs, 1);
  const mvMark = marks.find((m) => m.node === mv)!;
  assert(marks.length === 2 && !mvMark.cancelled, "the mark outlives the flight and its landing (the layer is baked at the phase it lands on: nothing to demote)");
  applyStatic(specs, 2);
  assert(!mvMark.cancelled, "…and a beat the node sits out leaves it alone (releasing it at the first frame of an UNRELATED cue stepped the node's picture while something else began to move)");
  applyAt(specs, 3, 0);
  assert(mvMark.cancelled, "…and it is released at the first frame of a beat in which the node plays something that changes its picture (a kept layer re-rasters a resize at fractional transforms and lands soft)");
  applyAt(specs, 1, 0);
  assert(marks.length === 3 && marks[2].node === mv && !marks[2].cancelled, "a seek back to the beat that glides arms a fresh mark (the mark is a function of the beat, not of history)");
  disposeSlideAnims(specs);
  assert(marks[2].cancelled && marks.find((m) => m.node === turn)!.cancelled, "tearing the slide down cancels every mark (a paused animation would pin its detached node alive)");
  delete (Object.getPrototypeOf(mv) as { animate?: unknown }).animate;
}

// dangling transform target: tolerated no-op
{
  const slide: Slide = {
    id: "s5",
    elements: [],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [{ id: "tr", target: "ghost", preset: "transform", to: { state: { x: 1 } } }] },
    ],
  };
  const { specs } = build(slide);
  assert(specs.length === 0, "a dangling transform target emits no spec (tolerated, never crashes)");
}

// Thumbnail/export stills retain the hand-off's semantic visibility after all
// temporary controllers and flight drawings have been disposed.
{
  const root = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="axis.x.spine" d="M10 80H90"/><path id="axis.y.spine" d="M10 80V10"/></svg>', 'image/svg+xml').documentElement;
  const slide: Slide = { id: "handoff-static", elements: [rect({ id: "source" }), { id: "dest", type: "plot", assetId: "axes", x: 300, y: 100, width: 200, height: 200, rotation: 0 }], beats: [
    { id: "base", tracks: [] }, { id: "flight", tracks: [{ id: "handoff", target: "source", preset: "transform", duration: 600, to: { state: {}, become: { mode: "handoff", ref: { element: "dest", parts: ["axis.x.spine", "axis.y.spine"] } } } }] },
  ] };
  const unvalidated = compileSlide(slide, stage);
  assert(unvalidated.handoffs.length === 1 && unvalidated.handoffs[0].destination[0].partIds?.join() === "axis.x.spine,axis.y.spine", "manifest-less compile retains both literal destination spine ids in one hand-off");
  const missingSpine = structuredClone(slide);
  missingSpine.beats[1].tracks[0].to!.become!.ref.parts = ["axis.y.spine"];
  const validated = compileSlide(missingSpine, stage, { plotManifest: () => ({ spec: "fluxplot", schemaVersion: "0.2.0", size: { width: 100, height: 100, unit: "px" }, series: [], parts: { id: "plot", role: "figure", children: [{ id: "axis.x.spine", role: "spine" }] } } as any) });
  assert(validated.handoffs.length === 0 && validated.issues.some(issue => /Destination parts not found/.test(issue.reason)), "a manifest that lacks axis.y.spine still refuses that destination");
  const host = document.createElement("div") as unknown as HTMLElement;
  for (const beat of [0, 1, 0]) {
    const rendered = renderStaticAt(host, slide, stage, beat, { theme: FLUX_DARK, plotRoot: () => root as unknown as Element });
    const parts = [...host.querySelectorAll<SVGElement>('[id="dest__axis.x.spine"],[id="dest__axis.y.spine"]')];
    assert(parts.length === 2 && parts.every(p => (p.style.visibility ?? "") === (beat ? "" : "hidden")), `renderStaticAt(${beat}) retains the destination parts' ${beat ? "visible" : "hidden"} baseline`);
    assert((rendered.elements.get("source")!.style.visibility ?? "") === (beat ? "hidden" : ""), `renderStaticAt(${beat}) retains the source state`);
    assert(rendered.flight.childElementCount === 0, "a static hand-off releases every temporary flight child");
  }
}

h.section("WP 4.2 Restore: return an element to an earlier look as an ordinary Change");
{
  const ops = await import("../src/lib/slide/ops");
  const d = ops.createDeck({ id: "r", title: "r", withTitleSlide: false } as never);
  const s = ops.addSlide(d, { id: "s", layout: "blank" } as never);
  ops.addElement(d, s.id, { id: "A", type: "rect", x: 40, y: 40, width: 100, height: 60, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  ops.addElement(d, s.id, { id: "T", type: "text", x: 40, y: 200, width: 200, height: 30, rotation: 0, text: "bold word", runs: [{ from: 0, to: 4, fontWeight: 700 }], fontFamily: "Arial", fontSize: 20, fontWeight: 400, fontStyle: "normal", align: "left", color: "#100f0f", sizing: "fixed" } as never);
  const b = [1, 2, 3, 4].map((k) => ops.addBeat(d, s.id, { id: "b" + k } as never)!);
  ops.setTransform(d, s.id, b[0].id, "A", { state: { x: 300, fill: "#d14d41" } });
  ops.setTransform(d, s.id, b[1].id, "A", { state: { y: 200, width: 180 } });
  ops.setTransform(d, s.id, b[1].id, "T", { state: { fontSize: 32, color: "#d14d41" } });
  // (needsLayout / lines are derived layout hints a metric change sets, not part of the look)
  const sl = d.slides[0], pre = (beat: number, id = "A") => { const e: any = tween.transformPreState(sl, id, beat); delete e.needsLayout; delete e.lines; delete e.lineWidths; return e; };
  const r0 = ops.restoreState(d, s.id, b[2].id, "A", { toBeat: 0 });
  h.ok(!!r0.track && r0.restored.sort().join() === "fill,width,x,y" && r0.overwritten.length === 0, `Return to Design at step 3 writes one Change restoring ${r0.restored.join(", ")}`);
  h.eq(JSON.stringify(pre(4)), JSON.stringify(pre(1)), "...after it, the element IS its Design state (deep-equal)");
  const r2 = ops.restoreState(d, s.id, b[3].id, "A", { toBeat: 2 });
  h.ok(!!r2.track, "Return to before step 2 at step 4 writes a Change");
  h.eq(JSON.stringify(pre(5)), JSON.stringify(pre(2)), "...after it, the element is exactly its state before step 2 (deep-equal)");
  const snap = JSON.stringify(d), again = ops.restoreState(d, s.id, b[3].id, "A", { toBeat: 2 });
  h.ok(JSON.stringify(d) === snap && again.overwritten.length === again.restored.length, "the same Restore again changes nothing (idempotent: it re-writes its own keys)");
  const none = ops.restoreState(d, s.id, b[0].id, "A", { toBeat: 0 });
  h.ok(none.track === null && none.restored.length === 0 && !!none.message, "returning to a look it already has writes nothing (a message, not an error)");
  const rt = ops.restoreState(d, s.id, b[2].id, "T", { toBeat: 0 });
  h.ok(!!rt.track && JSON.stringify(pre(4, "T")) === JSON.stringify(pre(1, "T")), "a text with formatted runs round-trips to its Design look");
  // an existing Change at the step keeps its other keys; the restored keys win and are reported
  ops.setTransform(d, s.id, b[3].id, "T", { state: { x: 90, fontSize: 40 } });
  const rm = ops.restoreState(d, s.id, b[3].id, "T", { toBeat: 3, keys: ["fontSize"] });
  const tk = d.slides[0].beats[4].tracks.find((t: any) => t.target === "T" && t.preset === "transform")!;
  h.ok(rm.overwritten.join() === "fontSize" && tk.to!.state!.x === 90 && tk.to!.state!.fontSize === 32, "merging into an existing Change: other keys kept (x 90), restored keys win (fontSize 32), the overwritten key reported");
  const refuse = (fn: () => unknown) => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };
  h.ok(/EARLIER step/.test(refuse(() => ops.restoreState(d, s.id, b[1].id, "A", { toBeat: 2 }))), "refused: returning to a step that is not earlier");
  h.ok(/Design cannot animate/.test(refuse(() => ops.restoreState(d, s.id, d.slides[0].beats[0].id, "A", { toBeat: 0 }))), "refused: Design as the step");
  ops.addElement(d, s.id, { id: "P", type: "rect", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#000", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  ops.setTransform(d, s.id, b[0].id, "P", { state: { type: "ellipse" } });
  h.ok(/content changed/.test(refuse(() => ops.restoreState(d, s.id, b[2].id, "P", { toBeat: 0 }))), "refused: the content changed since then (a retype / Become)");
}

console.log("\nSLIDE TWEEN (transform core + player drive): PASS");

await h.done();
