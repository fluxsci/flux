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
import { parseHTML } from "linkedom";
import {
  applyState, diffState, lerpElement, lerpNodes, lerpDash, numericTextTween,
  contentPlan, foldPreState,
} from "../src/lib/slide/tween";
import { resampleNodes, nodesToPath, pathD } from "../src/lib/path";
import type { Element as FigElement, RectElement, TextElement, PathElement, VectorNode } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
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
  assert(contentPlan(text({ text: "hello" }), text({ text: "world" })).mode === "crossfade", "contentPlan crossfades text rewrites");
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

const { computeSlideAnims, applyStatic, disposeSlideAnims, transformPreState } = await import("../src/lib/slide/player/player");
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

// crossfade: a text rewrite builds two stacked layers mid-flight
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
  assert(wrap.children.length === 2, "non-tweenable content crossfades via two stacked layers");
  const [la, lb] = Array.from(wrap.children) as HTMLElement[];
  assert(near(Number(la.style.opacity), 0.5) && near(Number(lb.style.opacity), 0.5), "…opacity cross-lerped");
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
    elements: [rect({ id: "mv" }), rect({ id: "grow", x: 300 }), rect({ id: "spin", x: 500 })],
    beats: [
      { id: "b0", tracks: [] },
      { id: "b1", tracks: [
        { id: "a", target: "mv", preset: "transform", to: { state: { x: 200, y: 80, fill: "#00ff00" } } },
        { id: "b", target: "grow", preset: "transform", to: { state: { x: 350, width: 150 } } },
        { id: "c", target: "spin", preset: "transform", to: { state: { rotation: 45 } } },
      ] },
    ],
  };
  const { rendered, specs } = build(slide);
  const mv = rendered.elements.get("mv")!, grow = rendered.elements.get("grow")!, spin = rendered.elements.get("spin")!;
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
  assert(marks.length === 1 && marks[0].node === mv && marks[0].paused && marks[0].opts.composite === "add" && marks[0].frames.every((f) => f.transform === "translate(0px, 0px)"),
    "…but the pure mover is ARMED at rest: one paused additive no-op transform animation (a scaling/rotating flight gets none)");
  ctrl("a").seek(0.5); ctrl("b").seek(0.5); ctrl("c").seek(0.5);
  assert(mv.style.willChange === "transform", "mid-flight a pure move (even one that recolors) rides its own layer");
  assert(!grow.style.willChange && !spin.style.willChange, "a scaling or rotating flight paints in place every frame (no resampled raster, no sharpen pop on settle)");
  ctrl("a").seek(1);
  assert(!mv.style.willChange && mv.style.left === "200px", "the endpoint demotes the wrapper (crisp at rest)");
  ctrl("a").seek(0.25); ctrl("a").seek(0);
  assert(!mv.style.willChange && mv.style.left === "10px", "…and so does a seek back to the start");
  assert(marks.length === 1 && !marks[0].cancelled, "the mark outlives the flight (armed once per node, inert at rest, ready for the next flight)");
  disposeSlideAnims(specs);
  assert(marks[0].cancelled, "tearing the slide down cancels the mark (a paused animation would pin its detached node alive)");
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

console.log("\nSLIDE TWEEN (transform core + player drive): PASS");
