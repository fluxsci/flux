// ---------------------------------------------------------------------------
// Flux Slide — the GLYPH-MATCHED TEXT MORPH driver (oct2 W3 §3.1). The browser
// half of textMatch.ts: shared words glide from where the old text drew them to
// where the new text draws them, everything else fades out/in, staggered by
// reading order — Keynote's Magic Move "by word", under Flux's slide laws.
//
// Measure, don't guess: both endpoint states are rendered once through the ONE
// serializer (fillContent → export.ts elementToSvg) into a hidden measurement
// node, and every glyph position comes from the browser's own shaping
// (getStartPositionOfChar / getExtentOfChar: kerning, scripts, justification
// gaps included), in the element's unrotated stage frame. The measurement nodes
// are removed immediately; no layout is read on the frame path.
//
// Each span is an absolutely positioned <div> holding a tiny <svg><text> clone
// of exactly that substring, placed by its baseline start point. The tiny svg
// carries its ENDPOINT's own view-box mapping (EndpointFrame) and the span layer
// the endpoint's own residual scale, so a glyph is shaped and drawn exactly as the
// endpoint's static render draws it. A layer bakes the sub-pixel phase of its first
// raster, so a promoted span's picture is NOT the in-place picture the endpoints are
// (measured 15 to 130 stage px² of step on the first and the last moving frame of a
// rewrite), and spans painted in place instead move in quarter-device-pixel hops (a
// slow glide stair-steps). ONE law answers both: the static render (A at the start, B
// at the end) and the span layer are handed over to each other in premultiplied space
// over the first and last HANDOVER_EPS stage px of change, so the frames in between
// ride compositor layers (smooth glides) and the phase of a layer's first raster never
// shows at either end.
//
// Channels (docs/SLIDE_TRANSFORMS.md): glide POSITIONS and scale take the eased
// progress unclamped (a spring overshoots the words like any box); opacity and
// colour take it clamped; endpoints (raw ≤ 0 / ≥ 1) belong to the caller, which
// shows its A / B layers and calls hide(). Every frame is a pure function of
// (u, raw, origin): reverse and random seeks are exact.
// ---------------------------------------------------------------------------

import type { TextElement } from "../../types";
import { blockLayout, visualLineRanges, canMeasureText, applyTextLayout } from "../../text";
import { textSvgLayout, segmentAttrs } from "../../export";
import { elementBBox } from "../../geometry";
import { elementPaints } from "../../color/gradient";
import { prepareColorLerp, parseColor } from "../../color/interp";
import { numericTextTween } from "../tween";
import { planTextMorph, textMorphTimeline, windowProgress, fadeLook, rollLook, type TextMorphSpan, type TextMorphPlan, type TextRange } from "../textMatch";
import { glideLanes, laneOffset, type GlideGeom, type LaneBounds } from "../lanes";
import type { TextLook } from "../timing";
import { fillContent, layoutBoxOf, promoteMovingWrapper, settleWrapper, type SlideRenderCtx } from "./render";

const SVG_NS = "http://www.w3.org/2000/svg";
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** The hand-over between the static render and the span layer, at both ends. Chrome shapes and rasterises a run of text a few hundredths of a
 *  device pixel differently when it is cut into spans (a quarter-pixel glyph bucket flips for a glyph or two), which reads 5 to 90 stage px²
 *  on a line of text: a step on the first moving frame and on the landing frame. The static render (A at the start, B at the end) is
 *  therefore blended with the span layer over the first and the last `HANDOVER_EPS` stage px of change (added in premultiplied space, so a
 *  glyph never reads bolder or lighter while both show), which spreads the step over the frames in which the text has all but stopped. The
 *  window is a DISTANCE, not a time: a short move gets a long hand-over, a long one a short hand-over, and the glyphs are never more than
 *  `HANDOVER_EPS` apart while two copies show. `entry` (A -> spans) and `landing` (spans -> B) are pure functions of the frame. */
export const HANDOVER_EPS = 0.75;
export interface Handover { entry: number; landing: number }
/** The smoothstep of a hand-over window: 0 at no distance, 1 at `HANDOVER_EPS` stage px. ONE ease for text (here) and shapes (shapeHandover.ts). */
export const handoverEase = (distance: number): number => { const q = clamp01(distance / HANDOVER_EPS); return q * q * (3 - 2 * q); };
/** The opacity of each of the three layers while the flight shows: A (the start render), M (the flight: spans or shapes), B (the end render). They
 *  sum to 1 and are ADDED, not laid over each other, so the layers must carry `mix-blend-mode: plus-lighter` inside an isolated parent
 *  (`HANDOVER_LAYER_STYLE`). A whole travel shorter than the two windows together makes them overlap (`entry` below `landing`): the weights are
 *  then normalised, so A crossfades into B and the sum stays 1 (unnormalised, a 0.2 px travel summed 1.65 and plus-lighter over-exposed). */
export function handoverWeights(h: Handover): { a: number; m: number; b: number } {
  const a = 1 - h.entry, m = Math.max(0, h.entry - h.landing), b = h.landing, sum = a + m + b;
  return { a: a / sum, m: m / sum, b: b / sum };
}
/** Set once, with the layers, and never toggled (the crossfade layers' rule: a lone layer renders as it would anywhere, so the rest render before,
 *  during and after goes through one compositing path). */
export const HANDOVER_LAYER_STYLE = Object.freeze({ "mix-blend-mode": "plus-lighter" });
export const HANDOVER_PARENT_STYLE = Object.freeze({ isolation: "isolate" });

/** Crossfade window for a glide whose two ends look different (weight, family,
 *  case): both clones are never at half strength for long. */
const TWIN_FADE = { start: 0.3, end: 0.7 };

/** One measured glyph: its baseline START point and its extent box, stage px in
 *  the element's unrotated frame. */
export interface CharGeometry { x: number; y: number; box: { x: number; y: number; w: number; h: number } }
export interface TextMeasure {
  el: TextElement;
  /** Per UTF-16 offset of `el.text`; null for characters the renderer does not
   *  draw (a collapsed space, the break whitespace dropped by wrapping). */
  chars: (CharGeometry | null)[];
  lines: TextRange[];
}

/** The endpoint as the player draws it: a wrap cache when the GUI can measure,
 *  with the AUTHORED box kept (the wrapper owns the box; re-hugging here would
 *  make the content disagree with it). */
export function layoutForMorph(el: TextElement): TextElement {
  const out = structuredClone(el);
  if (out.needsLayout && canMeasureText()) {
    applyTextLayout(out);
    out.width = el.width; out.height = el.height;
  }
  return out;
}

/** What an endpoint's own render does to its glyphs: its svg maps the view box (the exact box) onto the layout box (whole stage px) by
 *  (kx, ky), and its wrapper carries the residual transform (restX, restY) that undoes it, so a glyph's net scale is exactly 1.
 *  Chrome shapes SVG text at the scale of the svg's own mapping, so the advance widths of a run depend on it (0.06 % at a 53 / 53.2 box:
 *  0.27 device px at the end of a 13-glyph run, enough to re-rasterise every glyph). A span is therefore drawn by an svg with the SAME
 *  mapping and carried by the SAME residual, which makes its picture at rest the endpoint's own picture, pixel for pixel. */
export interface EndpointFrame { kx: number; ky: number; restX: number; restY: number }
/** `residual` = the wrapper rests under the residual transform (the player's resting law); false = a bare layout box (a same-beat
 *  appearance owns the wrapper transform: `applyWrapperBox` with skipTransform). */
export function endpointFrame(el: TextElement, residual = true): EndpointFrame {
  const bb = elementBBox({ ...el, rotation: 0 }), lb = layoutBoxOf(bb), w = Math.max(bb.w, 1), h = Math.max(bb.h, 1);
  // render.ts applyWrapperBox: the residual transform exists when ANY of position or size is off the whole-pixel box, and then carries both scales
  const off = Math.abs(bb.x - lb.x) > 1e-4 || Math.abs(bb.y - lb.y) > 1e-4 || Math.abs(w - lb.w) > 1e-4 || Math.abs(h - lb.h) > 1e-4;
  return { kx: lb.w / w, ky: lb.h / h, restX: residual && off ? w / lb.w : 1, restY: residual && off ? h / lb.h : 1 };
}

/** SVG/CSS white-space collapsing as the renderer applies it to our markup:
 *  each run of whitespace draws as one space, and none before the first glyph. */
function addressable(text: string, lines: TextRange[]): number[][] {
  let prevSpace = true;
  return lines.map((r) => {
    const out: number[] = [];
    for (let i = r.from; i < r.to; i++) {
      const ws = /\s/.test(text[i]);
      if (ws && prevSpace) continue;
      out.push(i);
      prevSpace = ws;
    }
    return out;
  });
}

/** Render `el` once through the serializer (hidden, inside `host`), read every
 *  glyph's position and box, and remove the render. Null when the markup cannot
 *  be mapped back onto the text (a stale wrap cache, a legacy whole-line
 *  justification stretch, a renderer that collapsed differently). */
export function measureTextChars(host: HTMLElement, el: TextElement, ctx: SlideRenderCtx): TextMeasure | null | "later" {
  const lines = visualLineRanges(el);
  if (!lines) return null;
  const layout = blockLayout(el);
  if (layout.lines.some((l) => l.justifyWidth != null)) return null;
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;left:0;top:0;width:${Math.max(1, Math.round(el.width))}px;height:${Math.max(1, Math.round(el.height))}px;visibility:hidden;pointer-events:none;`;
  host.appendChild(div);
  try {
    const neutral: TextElement = { ...el, rotation: 0, opacity: undefined };
    delete neutral.flipX; delete neutral.flipY;
    fillContent(div, neutral, ctx);
    // A host that is not laid out right now (display:none keep-alive, detached)
    // has no glyph geometry to read: ask again later, never measure zeros.
    if (!div.getClientRects().length) return "later";
    const text = div.querySelector("text");
    if (!text) return null;
    const tspans = Array.from(text.children).filter((c) => c.tagName.toLowerCase() === "tspan") as SVGTSpanElement[];
    if (tspans.length !== lines.length) return null;
    const chars: (CharGeometry | null)[] = new Array(el.text.length).fill(null);
    const map = addressable(el.text, lines);
    for (let k = 0; k < lines.length; k++) {
      const span = tspans[k], idx = map[k];
      const n = span.getNumberOfChars();
      // A trailing space the renderer dropped is invisible either way.
      if (n !== idx.length && !(n === idx.length - 1 && /\s/.test(el.text[idx[idx.length - 1]]))) return null;
      for (let c = 0; c < n; c++) {
        const p = span.getStartPositionOfChar(c), e = span.getExtentOfChar(c);
        if (![p.x, p.y, e.x, e.y, e.width, e.height].every(Number.isFinite)) return null;
        chars[idx[c]] = { x: p.x, y: p.y, box: { x: e.x, y: e.y, w: e.width, h: e.height } };
      }
    }
    return { el, chars, lines };
  } catch {
    return null;
  } finally {
    div.remove();
  }
}

/** The SVG attributes one substring of `el` paints with: the element's own text
 *  attributes plus whatever its per-range formatting changes at `at`. */
function spanAttrs(el: TextElement, layout: ReturnType<typeof blockLayout>, at: number): Record<string, string> {
  const { attrs } = textSvgLayout(el);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (k !== "x" && k !== "y" && k !== "text-anchor" && k !== "opacity") out[k] = v;
  for (const line of layout.lines) for (const seg of line.segments ?? []) {
    if (at >= seg.from && at < seg.to) { Object.assign(out, segmentAttrs(el, seg)); return out; }
  }
  return out;
}

/** Style-segment boundaries (run formatting and justified word starts): a span
 *  never crosses one, so every clone paints in a single look and advance. */
function segmentCuts(layout: ReturnType<typeof blockLayout>): number[] {
  const cuts: number[] = [];
  for (const line of layout.lines) for (const seg of line.segments ?? []) cuts.push(seg.from, seg.to);
  return cuts;
}

interface Clone { div: HTMLDivElement; text: SVGTextElement; fill?: (t: number) => string; ep: EndpointFrame; side: "a" | "b" }
interface SpanNode {
  span: TextMorphSpan;
  /** Box-relative baseline start points (stage px). */
  a?: { x: number; y: number; size: number; width: number };
  b?: { x: number; y: number; size: number; width: number };
  /** Centre of the drawn run relative to its start point (fades scale about it). */
  centre: { x: number; y: number };
  main: Clone;
  /** Present when the two ends look different: B's own clone crossfades in. */
  twin?: Clone;
  count?: (t: number) => string;
  window: { start: number; end: number };
  visible: boolean;
  /** The glide this fade rides with (same word). */
  ride?: SpanNode;
  /** Glide geometry and its planned lane (stage px; `undefined` = today's crossArc, see lanes.ts). */
  geom?: GlideGeom;
  lane?: number;
  /** Roll style: vector from this fade's centre to the centroid of the OTHER side's free-standing fades. */
  pull?: { x: number; y: number };
}

export interface TextMorph {
  /** Measure + build now (the warm hook); false when the texts cannot be mapped
   *  (then `failed()` is true and the caller crossfades) or cannot be measured
   *  yet (a hidden host — the next call tries again). */
  ensure(): boolean;
  failed(): boolean;
  /** Mid-flight frame. `origin` = the virtual box origin in the LAYER's frame (stage px); `host` = the scale the host carries at this
   *  frame (the wrapper's composite scale; 1 when the layer is not inside one). Returns the hand-over weights for the caller (see
   *  HANDOVER_EPS). */
  frame(u: number, raw: number, origin: { x: number; y: number }, host?: { x: number; y: number }): Handover;
  /** Endpoint: hide every span and demote it. */
  hide(): void;
  dispose(): void;
  /** Introspection for gates and the inspector. */
  info(): { spans: number; glides: number; exits: number; enters: number; level: TextMorphPlan["level"] } | null;
}

export interface TextMorphOptions {
  /** The span layer (absolute, inset 0). Its local frame is stage px. */
  layer: HTMLElement;
  ctx: SlideRenderCtx;
  durationMs: number;
  /** The track's authored text look (`resolveTextLook(track.params)`); absent = today's drift / fade. */
  textLook?: TextLook;
  /** The stage size: glide lanes never push ink off it (a title on the top edge stays on stage). */
  stage?: { width: number; height: number };
  /** The host's wrapper rests under the residual transform (the resting law; default). False: a bare layout box (a same-beat appearance
   *  owns the wrapper transform). */
  residual?: boolean;
  /** Spans ride compositor layers while they fly (default). False when an ancestor already carries the flight on its own layer (a text
   *  box that travels): its spans are painted into that layer, and a layer per span would only re-promote what already moves with it. */
  promote?: boolean;
}

/** Plan and build lazily: nothing is measured until the warm hook or the first
 *  mid-flight seek asks for it. */
export function createTextMorph(a: TextElement, b: TextElement, opts: TextMorphOptions): TextMorph {
  const { layer, ctx } = opts;
  const look = opts.textLook ?? { letters: "fade", fadeStyle: "drift" } as const;
  let nodes: SpanNode[] | null = null, failed = false, plan: TextMorphPlan | null = null;
  let stale = false;
  // One layer per ENDPOINT: A's spans (exits, the glides' own text) ride the scale A's wrapper rests under, B's (enters, the twins) the
  // scale B's does, so each side's glyphs are exactly its endpoint's picture at that end (EndpointFrame).
  const epA = endpointFrame(a, opts.residual !== false), epB = endpointFrame(b, opts.residual !== false);
  const sides: Record<"a" | "b", { layer: HTMLElement; ep: EndpointFrame; counter: string }> = {
    a: { layer: document.createElement("div"), ep: epA, counter: "" }, b: { layer: document.createElement("div"), ep: epB, counter: "" },
  };
  for (const side of [sides.a, sides.b]) side.layer.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";

  function clone(text: string, attrs: Record<string, string>, kind: TextMorphSpan["kind"], side: "a" | "b", role: "main" | "twin" = "main"): Clone {
    const ep = sides[side].ep;
    const div = document.createElement("div");
    div.className = "sl-tm-span";
    div.dataset.kind = kind; div.dataset.role = role; div.dataset.side = side;
    div.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;visibility:hidden;pointer-events:none;";
    const svg = document.createElementNS(SVG_NS, "svg");
    // the endpoint's own mapping (view box over layout box), on a 1 x 1 svg: the glyphs are shaped and drawn exactly as its render does
    svg.setAttribute("width", "1"); svg.setAttribute("height", "1");
    svg.setAttribute("viewBox", `0 0 ${1 / ep.kx} ${1 / ep.ky}`); svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;display:block;";
    const t = document.createElementNS(SVG_NS, "text");
    for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
    t.setAttribute("x", "0"); t.setAttribute("y", "0");
    t.textContent = text;
    svg.appendChild(t);
    div.appendChild(svg);
    return { div, text: t, ep, side };
  }

  function build(): boolean | "later" {
    const A = layoutForMorph(a), B = layoutForMorph(b);
    // A gradient text fill cannot be cloned per span without its defs; such a
    // rare text keeps the classic crossfade.
    if (elementPaints(A).defs.length || elementPaints(B).defs.length) return false;
    const ma = measureTextChars(layer, A, ctx), mb = measureTextChars(layer, B, ctx);
    if (ma === "later" || mb === "later") return "later";
    if (!ma || !mb) return false;
    const la = blockLayout(A), lb = blockLayout(B);
    plan = planTextMorph(A.text, B.text, { aLines: ma.lines, bLines: mb.lines, aCuts: segmentCuts(la), bCuts: segmentCuts(lb), letterBag: look.letters === "travel" });
    const exits = plan.spans.filter((s) => s.kind === "exit").length, enters = plan.spans.filter((s) => s.kind === "enter").length;
    const timeline = textMorphTimeline(exits, enters, opts.durationMs, plan.fadeUnit);
    const built: SpanNode[] = [];
    const point = (m: TextMeasure, el: TextElement, r: TextRange, size: number) => {
      const c = m.chars[r.from];
      if (!c) return null;
      // The drawn advance of the run: from its start point to its last glyph's far edge.
      let right = c.x;
      for (let i = r.from; i < r.to; i++) { const g = m.chars[i]; if (g) right = Math.max(right, g.box.x + g.box.w); }
      return { x: c.x - el.x, y: c.y - el.y, size, width: Math.max(1e-3, right - c.x) };
    };
    const centreOf = (m: TextMeasure, r: TextRange) => {
      const first = m.chars[r.from]!;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = r.from; i < r.to; i++) {
        const c = m.chars[i]; if (!c) continue;
        x0 = Math.min(x0, c.box.x); x1 = Math.max(x1, c.box.x + c.box.w); y0 = Math.min(y0, c.box.y); y1 = Math.max(y1, c.box.y + c.box.h);
      }
      return Number.isFinite(x0) ? { x: (x0 + x1) / 2 - first.x, y: (y0 + y1) / 2 - first.y } : { x: 0, y: 0 };
    };
    const fontSize = (attrs: Record<string, string>, el: TextElement) => Number(attrs["font-size"]) || el.fontSize;
    for (const span of plan.spans) {
      if (span.kind === "glide") {
        const attrsA = spanAttrs(A, la, span.a!.from), attrsB = spanAttrs(B, lb, span.b!.from);
        const pa = point(ma, A, span.a!, fontSize(attrsA, A)), pb = point(mb, B, span.b!, fontSize(attrsB, B));
        if (!pa || !pb) return false;
        const textA = A.text.slice(span.a!.from, span.a!.to), textB = B.text.slice(span.b!.from, span.b!.to);
        const { fill: fillA, ...restA } = attrsA, { fill: fillB, ...restB } = attrsB;
        const sameLook = JSON.stringify(Object.entries(restA).filter(([k]) => k !== "font-size").sort()) === JSON.stringify(Object.entries(restB).filter(([k]) => k !== "font-size").sort());
        const count = span.run === "count" ? numericTextTween(textA, textB) ?? undefined : undefined;
        const blendable = fillA === fillB || (!!parseColor(fillA ?? "") && !!parseColor(fillB ?? ""));
        const single = sameLook && blendable && (textA === textB || !!count) && pa.size === pb.size;
        const main = clone(textA, attrsA, "glide", "a");
        if (single && fillA !== fillB && fillA && fillB) main.fill = prepareColorLerp(fillA, fillB);
        const node: SpanNode = { span, a: pa, b: pb, centre: centreOf(ma, span.a!), main, window: timeline.glide, visible: false, ...(count ? { count } : {}) };
        if (!single) {
          node.twin = clone(textB, attrsB, "glide", "b", "twin");
          if (fillA && fillB && fillA !== fillB && parseColor(fillA) && parseColor(fillB)) {
            const forward = prepareColorLerp(fillA, fillB);
            main.fill = forward; node.twin.fill = forward;
          }
        }
        built.push(node);
      } else {
        const side = span.kind === "exit" ? "a" : "b";
        const el = side === "a" ? A : B, m = side === "a" ? ma : mb, lay = side === "a" ? la : lb, r = span[side]!;
        const attrs = spanAttrs(el, lay, r.from);
        const p = point(m, el, r, fontSize(attrs, el));
        if (!p) return false;
        const windows = span.kind === "exit" ? timeline.exits : timeline.enters;
        built.push({ span, [side]: p, centre: centreOf(m, r), main: clone(el.text.slice(r.from, r.to), attrs, span.kind, side), window: windows[span.order] ?? timeline.glide, visible: false });
      }
    }
    plan.spans.forEach((sp, k) => { if (sp.with !== undefined) built[k].ride = built[sp.with]; });
    // Glide lanes (lanes.ts): words whose classic paths would overprint each other take separate lanes; every glide,
    // static ones included, is an obstacle. Planned HERE, in the build the idle warm-up runs, never inside a frame.
    const glides = built.filter((n) => n.span.kind === "glide");
    for (const n of glides) n.geom = { ax: n.a!.x, ay: n.a!.y, bx: n.b!.x, by: n.b!.y, w: (n.a!.width + n.b!.width) / 2, size: Math.max(n.a!.size, n.b!.size) };
    const bounds: LaneBounds | undefined = opts.stage ? { x0: -Math.min(A.x, B.x), y0: -Math.min(A.y, B.y), x1: opts.stage.width - Math.max(A.x, B.x), y1: opts.stage.height - Math.max(A.y, B.y) } : undefined;
    const lanes = glideLanes(glides.map((n) => n.geom!), bounds);
    glides.forEach((n, i) => { n.lane = lanes[i]; });
    // Roll fades: free-standing exits and enters lean toward the other side's centroid; riders roll in place (below).
    if (look.fadeStyle === "roll") {
      const ctr = (n: SpanNode) => { const p = n.a ?? n.b!; return { x: p.x + n.centre.x, y: p.y + n.centre.y }; };
      const mean = (ns: SpanNode[]) => ns.length ? { x: ns.reduce((q, n) => q + ctr(n).x, 0) / ns.length, y: ns.reduce((q, n) => q + ctr(n).y, 0) / ns.length } : null;
      const ex = built.filter((n) => n.span.kind === "exit" && !n.ride), en = built.filter((n) => n.span.kind === "enter" && !n.ride);
      const cEx = mean(ex), cEn = mean(en);
      for (const n of ex) n.pull = cEn ? { x: cEn.x - ctr(n).x, y: cEn.y - ctr(n).y } : { x: 0, y: 0 };
      for (const n of en) n.pull = cEx ? { x: cEx.x - ctr(n).x, y: cEx.y - ctr(n).y } : { x: 0, y: 0 };
      // Riders (the `e` of Microscope -> Microscopy, glued to their word's glide) roll in place: the same look with no
      // pull, so a stem edit never shows a shrinking letter beside a rolling word. Their glide's position is added in frame().
      for (const n of built) if (n.ride && n.span.kind !== "glide") n.pull = { x: 0, y: 0 };
    }
    // Paint order: A's layer (exits, the glides' own text) under B's (enters, the twins); within a layer exits under glides.
    const order = { exit: 0, glide: 1, enter: 2 } as const;
    for (const side of [sides.a, sides.b]) if (side.layer.parentElement !== layer) layer.appendChild(side.layer);
    for (const node of built.slice().sort((x, y) => order[x.span.kind] - order[y.span.kind])) {
      for (const c of [node.main, node.twin]) if (c) { sides[c.side].layer.appendChild(c.div); }
    }
    nodes = built;
    // A web font still loading measured with fallback metrics: rebuild once it lands.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts && fonts.status === "loading") void fonts.ready.then(() => { stale = true; });
    return true;
  }

  function ensure(): boolean {
    if (stale && nodes) { teardown(); stale = false; }
    if (nodes) return true;
    if (failed) return false;
    if (!layer.isConnected) return false;
    const built = build();
    if (built === "later") { teardown(); return false; }
    if (!built) { teardown(); failed = true; return false; }
    return true;
  }

  const set = (c: Clone, transform: string, opacity: number, origin: string) => {
    const s = c.div.style;
    if (s.transform !== transform) s.transform = transform;
    if (s.transformOrigin !== origin) s.transformOrigin = origin;
    const o = String(opacity);
    if (s.opacity !== o) s.opacity = o;
    const vis = opacity > 0 ? "visible" : "hidden";
    if (s.visibility !== vis) s.visibility = vis;
    if (opts.promote !== false && opacity > 0) promoteMovingWrapper(c.div); else settleWrapper(c.div);
  };
  const n6 = (v: number) => Math.round(v * 1e6) / 1e6;
  /** Where a span sits: `X`, `Y` are stage px from the box origin; the layer's local px are `rest` times them (see EndpointFrame). */
  const at = (c: Clone, X: number, Y: number) => `translate(${n6(X / c.ep.restX)}px, ${n6(Y / c.ep.restY)}px)`;

  function frame(u: number, raw: number, origin: { x: number; y: number }, host: { x: number; y: number } = { x: 1, y: 1 }): Handover {
    if (!ensure()) return { entry: 0, landing: 0 };
    const t = clamp01(u);
    // each side's layer undoes whatever the host is carrying beyond the scale its own endpoint rests under, so the glyphs' net scale is 1
    for (const side of [sides.a, sides.b]) {
      const sx = side.ep.restX / host.x, sy = side.ep.restY / host.y;
      const counter = Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9 ? "" : `scale(${n6(sx)}, ${n6(sy)})`;
      if (counter !== side.counter) { side.counter = counter; side.layer.style.transform = counter; }
    }
    // how far the spans are from the START render (`away`) and from the END render (`settle`), stage px: the hand-over weights below
    let away = 0, settle = 0;
    for (const node of nodes!) {
      const { span } = node;
      if (span.kind === "glide") {
        const a = node.a!, b = node.b!;
        const bo = laneOffset(node.geom!, node.lane, t);
        const x = origin.x + lerp(a.x, b.x, u) + bo.dx, y = origin.y + lerp(a.y, b.y, u) + bo.dy;
        const k = b.size / a.size;
        // how far this glide is from where A draws it and from where B does (position, and size when the look changes)
        away = Math.max(away, Math.hypot(x - origin.x - a.x, y - origin.y - a.y), Math.abs(lerp(1, k, u) - 1) * a.size);
        settle = Math.max(settle, Math.hypot(x - origin.x - b.x, y - origin.y - b.y), Math.abs(lerp(1, k, u) - k) * b.size);
        // a glide whose own LOOK changes in place (a count's digits, a colour lerp, a twin's cross-fade) is as far from A and from B as its
        // look has travelled, in the same units (font size x progress): without it the spans stay at weight 0 under the static render while
        // they count and recolour unseen, and take over in one frame
        const looks = node.twin ? windowProgress(TWIN_FADE, t) : node.count || node.main.fill ? t : -1;
        if (looks >= 0) { away = Math.max(away, looks * a.size); settle = Math.max(settle, (1 - looks) * b.size); }
        if (!node.twin) {
          const s = Math.max(0.01, lerp(1, k, u));
          set(node.main, `${at(node.main, x, y)}${s !== 1 ? ` scale(${n6(s)})` : ""}`, 1, "0 0");
          if (node.main.fill) { const f = node.main.fill(t); if (node.main.text.getAttribute("fill") !== f) node.main.text.setAttribute("fill", f); }
          if (node.count) { const text = node.count(t); if (node.main.text.textContent !== text) node.main.text.textContent = text; }
        } else {
          // Both clones share ONE advance width and height at every moment (a bold
          // run is wider than its regular self): each is stretched a few percent
          // horizontally onto the lerped width, so the crossfade never ghosts.
          const w = windowProgress(TWIN_FADE, t), width = Math.max(1e-3, lerp(a.width, b.width, u));
          const ya = Math.max(0.01, lerp(1, k, u)), yb = Math.max(0.01, lerp(1 / k, 1, u));
          const scaled = (sx: number, sy: number) => sx === 1 && sy === 1 ? "" : ` scale(${n6(sx)}, ${n6(sy)})`;
          // the stretch is distance too: the run's far end is `width - a.width` from where A draws it and `width - b.width` from where B does
          away = Math.max(away, Math.abs(width - a.width)); settle = Math.max(settle, Math.abs(width - b.width));
          set(node.main, `${at(node.main, x, y)}${scaled(width / a.width, ya)}`, 1 - w, "0 0");
          set(node.twin, `${at(node.twin, x, y)}${scaled(width / b.width, yb)}`, w, "0 0");
          for (const c of [node.main, node.twin]) if (c.fill) { const f = c.fill(t); if (c.text.getAttribute("fill") !== f) c.text.setAttribute("fill", f); }
        }
      } else {
        const p = node.a ?? node.b!;
        const wp = windowProgress(node.window, t);
        const roll = node.pull ? rollLook(span.kind, wp, node.pull, p.size) : null;
        const fade = roll ?? { ...fadeLook(span.kind, wp), dx: 0 };
        // Riding a glide: keep this letter's offset from the glide's start on
        // its own side, wherever the glide currently is (and at its scale).
        let px = p.x, py = p.y;
        if (node.ride) {
          const g = node.ride, ga = g.a!, gb = g.b!, own = span.kind === "exit" ? ga : gb;
          const go = laneOffset(g.geom!, g.lane, t);
          const gx = lerp(ga.x, gb.x, u) + go.dx, gy = lerp(ga.y, gb.y, u) + go.dy;
          const k = Math.max(0.01, lerp(1, gb.size / ga.size, u)) * (span.kind === "exit" ? 1 : ga.size / gb.size);
          px = gx + (p.x - own.x) * k; py = gy + (p.y - own.y) * k;
        }
        // fadeLook's dy is in font sizes, rollLook's displacements are stage px.
        const x = origin.x + px + fade.dx, y = origin.y + py + (roll ? roll.dy : fade.dy * p.size);
        const ep = node.main.ep;
        // A fading span is distance too, in font-size terms (its ink gained or lost: opacity x size), plus however far it has moved from where
        // its own end draws it (an exit leaves from `p`, an enter arrives at `p`) and how far it has scaled.
        const shift = Math.hypot(px + fade.dx - p.x, y - origin.y - p.y) + (1 - fade.scale) * p.size;
        if (span.kind === "exit") { away = Math.max(away, (1 - fade.opacity) * p.size + shift); settle = Math.max(settle, fade.opacity * p.size); }
        else { away = Math.max(away, fade.opacity * p.size); settle = Math.max(settle, (1 - fade.opacity) * p.size + shift); }
        set(node.main, `${at(node.main, x, y)}${fade.scale !== 1 ? ` scale(${n6(fade.scale)})` : ""}`, fade.opacity, `${n6(node.centre.x / ep.restX)}px ${n6(node.centre.y / ep.restY)}px`);
      }
    }
    void raw;
    // `entry` 0 -> 1 as the spans leave the start render, `landing` 0 -> 1 as they settle onto the end render
    return { entry: handoverEase(away), landing: 1 - handoverEase(settle) };
  }

  function hide(): void {
    if (!nodes) return;
    for (const node of nodes) for (const c of [node.main, node.twin]) if (c) { settleWrapper(c.div); if (c.div.style.visibility !== "hidden") c.div.style.visibility = "hidden"; }
  }

  function teardown(): void {
    for (const node of nodes ?? []) for (const c of [node.main, node.twin]) if (c) c.div.remove();
    nodes = null;
  }

  return {
    ensure, frame, hide, failed: () => failed,
    dispose() { teardown(); failed = true; },
    info() {
      if (!nodes || !plan) return null;
      const count = (k: TextMorphSpan["kind"]) => plan!.spans.filter((s) => s.kind === k).length;
      return { spans: plan.spans.length, glides: count("glide"), exits: count("exit"), enters: count("enter"), level: plan.level };
    },
  };
}
