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
// of exactly that substring, placed by its baseline start point. Spans ride
// `will-change: transform` for the flight (text painted in place snaps its
// baseline to device pixels — guide §9), armed with the paused flight mark at
// build time and demoted at both endpoints and after the shared 250 ms cool-down
// (render.ts layer hygiene). Promotion is capped (TEXT_MORPH_CAPS.maxSpans).
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
import { elementPaints } from "../../color/gradient";
import { prepareColorLerp, parseColor } from "../../color/interp";
import { numericTextTween } from "../tween";
import { planTextMorph, textMorphTimeline, windowProgress, fadeLook, crossArc, TEXT_MORPH_CAPS, type TextMorphSpan, type TextMorphPlan, type TextRange } from "../textMatch";
import { fillContent, promoteMovingWrapper, settleWrapper, armFlightMark, releaseFlightMark, type SlideRenderCtx } from "./render";

const SVG_NS = "http://www.w3.org/2000/svg";
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
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
  div.style.cssText = `position:absolute;left:0;top:0;width:${Math.max(1, el.width)}px;height:${Math.max(1, el.height)}px;visibility:hidden;pointer-events:none;`;
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

interface Clone { div: HTMLDivElement; text: SVGTextElement; fill?: (t: number) => string }
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
}

export interface TextMorph {
  /** Measure + build now (the warm hook); false when the texts cannot be mapped
   *  (then `failed()` is true and the caller crossfades) or cannot be measured
   *  yet (a hidden host — the next call tries again). */
  ensure(): boolean;
  failed(): boolean;
  /** Mid-flight frame. `origin` = the virtual box origin in the LAYER's frame. */
  frame(u: number, raw: number, origin: { x: number; y: number }): void;
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
}

/** Plan and build lazily: nothing is measured until the warm hook or the first
 *  mid-flight seek asks for it. */
export function createTextMorph(a: TextElement, b: TextElement, opts: TextMorphOptions): TextMorph {
  const { layer, ctx } = opts;
  let nodes: SpanNode[] | null = null, failed = false, plan: TextMorphPlan | null = null;
  let stale = false;

  function clone(text: string, attrs: Record<string, string>, kind: TextMorphSpan["kind"], role: "main" | "twin" = "main"): Clone {
    const div = document.createElement("div");
    div.className = "sl-tm-span";
    div.dataset.kind = kind; div.dataset.role = role;
    div.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;visibility:hidden;pointer-events:none;";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "1"); svg.setAttribute("height", "1");
    svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;display:block;";
    const t = document.createElementNS(SVG_NS, "text");
    for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
    t.setAttribute("x", "0"); t.setAttribute("y", "0");
    t.textContent = text;
    svg.appendChild(t);
    div.appendChild(svg);
    return { div, text: t };
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
    plan = planTextMorph(A.text, B.text, { aLines: ma.lines, bLines: mb.lines, aCuts: segmentCuts(la), bCuts: segmentCuts(lb) });
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
        const main = clone(textA, attrsA, "glide");
        if (single && fillA !== fillB && fillA && fillB) main.fill = prepareColorLerp(fillA, fillB);
        const node: SpanNode = { span, a: pa, b: pb, centre: centreOf(ma, span.a!), main, window: timeline.glide, visible: false, ...(count ? { count } : {}) };
        if (!single) {
          node.twin = clone(textB, attrsB, "glide", "twin");
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
        built.push({ span, [side]: p, centre: centreOf(m, r), main: clone(el.text.slice(r.from, r.to), attrs, span.kind), window: windows[span.order] ?? timeline.glide, visible: false });
      }
    }
    plan.spans.forEach((sp, k) => { if (sp.with !== undefined) built[k].ride = built[sp.with]; });
    // Paint order: exits under glides under enters. Arm every node at REST, before
    // its first promotion (render.ts: a mark attached in the promoting frame is inert).
    const order = { exit: 0, glide: 1, enter: 2 } as const;
    for (const node of built.slice().sort((x, y) => order[x.span.kind] - order[y.span.kind])) {
      for (const c of [node.main, node.twin]) if (c) { layer.appendChild(c.div); armFlightMark(c.div); }
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
  };
  const n6 = (v: number) => Math.round(v * 1e6) / 1e6;

  function frame(u: number, raw: number, origin: { x: number; y: number }): void {
    if (!ensure()) return;
    const t = clamp01(u);
    let promoted = 0;
    const place = (c: Clone, visible: boolean) => {
      if (visible && promoted < TEXT_MORPH_CAPS.maxSpans) { promoteMovingWrapper(c.div); promoted++; }
      else settleWrapper(c.div);
    };
    for (const node of nodes!) {
      const { span } = node;
      if (span.kind === "glide") {
        const a = node.a!, b = node.b!;
        const x = n6(origin.x + lerp(a.x, b.x, u)), y = n6(origin.y + lerp(a.y, b.y, u) + crossArc(b.x - a.x, b.y - a.y, Math.max(a.size, b.size), t));
        const k = b.size / a.size;
        if (!node.twin) {
          const s = Math.max(0.01, lerp(1, k, u));
          set(node.main, `translate(${x}px, ${y}px)${s !== 1 ? ` scale(${n6(s)})` : ""}`, 1, "0 0");
          if (node.main.fill) { const f = node.main.fill(t); if (node.main.text.getAttribute("fill") !== f) node.main.text.setAttribute("fill", f); }
          if (node.count) { const text = node.count(t); if (node.main.text.textContent !== text) node.main.text.textContent = text; }
          place(node.main, true);
        } else {
          // Both clones share ONE advance width and height at every moment (a bold
          // run is wider than its regular self): each is stretched a few percent
          // horizontally onto the lerped width, so the crossfade never ghosts.
          const w = windowProgress(TWIN_FADE, t), width = Math.max(1e-3, lerp(a.width, b.width, u));
          const ya = Math.max(0.01, lerp(1, k, u)), yb = Math.max(0.01, lerp(1 / k, 1, u));
          const scaled = (sx: number, sy: number) => sx === 1 && sy === 1 ? "" : ` scale(${n6(sx)}, ${n6(sy)})`;
          set(node.main, `translate(${x}px, ${y}px)${scaled(width / a.width, ya)}`, 1 - w, "0 0");
          set(node.twin, `translate(${x}px, ${y}px)${scaled(width / b.width, yb)}`, w, "0 0");
          for (const c of [node.main, node.twin]) if (c.fill) { const f = c.fill(t); if (c.text.getAttribute("fill") !== f) c.text.setAttribute("fill", f); }
          place(node.main, w < 1); place(node.twin, w > 0);
        }
      } else {
        const p = node.a ?? node.b!;
        const look = fadeLook(span.kind, windowProgress(node.window, t));
        // Riding a glide: keep this letter's offset from the glide's start on
        // its own side, wherever the glide currently is (and at its scale).
        let px = p.x, py = p.y;
        if (node.ride) {
          const g = node.ride, ga = g.a!, gb = g.b!, own = span.kind === "exit" ? ga : gb;
          const gx = lerp(ga.x, gb.x, u), gy = lerp(ga.y, gb.y, u) + crossArc(gb.x - ga.x, gb.y - ga.y, Math.max(ga.size, gb.size), t);
          const k = Math.max(0.01, lerp(1, gb.size / ga.size, u)) * (span.kind === "exit" ? 1 : ga.size / gb.size);
          px = gx + (p.x - own.x) * k; py = gy + (p.y - own.y) * k;
        }
        const x = n6(origin.x + px), y = n6(origin.y + py + look.dy * p.size);
        set(node.main, `translate(${x}px, ${y}px)${look.scale !== 1 ? ` scale(${n6(look.scale)})` : ""}`, look.opacity, `${n6(node.centre.x)}px ${n6(node.centre.y)}px`);
        place(node.main, look.opacity > 0);
      }
    }
    void raw;
  }

  function hide(): void {
    if (!nodes) return;
    for (const node of nodes) for (const c of [node.main, node.twin]) if (c) {
      settleWrapper(c.div);
      if (c.div.style.visibility !== "hidden") c.div.style.visibility = "hidden";
    }
  }

  function teardown(): void {
    for (const node of nodes ?? []) for (const c of [node.main, node.twin]) if (c) { releaseFlightMark(c.div); c.div.remove(); }
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
