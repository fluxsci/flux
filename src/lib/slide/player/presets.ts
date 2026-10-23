// ---------------------------------------------------------------------------
// Flux Slide — the WAAPI preset compilers (§5.3). Each turns a track's resolved
// target nodes into per-node WAAPI keyframes [from, to]. The player owns timing
// (start + stagger → delay) and static-state (apply `from` before a node's intro
// beat, `to` after); a preset only declares WHAT moves.
//
// Two-tier law (style_principles.md P5): every preset here is Tier-1
// (transform/opacity, compositor-free) EXCEPT `drawOn` (stroke-dashoffset, paint)
// and `writeOn` (clip-path) — Tier-2, reserved for the few signature plot/curve
// builds while the scene is otherwise still. `transform`/`countUp` live elsewhere.
// ---------------------------------------------------------------------------

import { inDefs, paintOf, GEO_TAGS } from "../strokeGeometry";
import { readPaint, parseStyleAttr } from "../../plot/paint";
import type { Track, DeckTheme, StageSize } from "../types";
import { PRESET_CATALOG, isEnterPreset, isExitPreset, presetParam, legacyScaleOf, legacyRotationOf, type PointParam } from "../presetCatalog";
import { partDomId } from "../../plot/parse";
import { barGrow, isManifestBar, growOrigin, pulsePeak, isCompass, compassOrigin, type StagePoint } from "../growOrigin";
import { rotatedAABB } from "../../geometry";
import type { FluxPlotManifest } from "../../plot/types";
import type { Element as SceneElement } from "../../types";
import { trimDashAt, resolveAnchor, isDefaultTrim, windowsDash, hiddenDash, drawReach, type TrimSpec } from "./trim";
import { editorCameraTransform } from "../../editorPresentation";
import { sampleCamera, type CameraPose } from "../camera";

export type TargetNode = HTMLElement | SVGElement;

export interface PresetCtx {
  theme: DeckTheme;
  stage: StageSize;
  cameraFrom?: CameraPose;
  /** The target's plot manifest (bar orientation and sign for growBaseline). */
  manifest?: FluxPlotManifest;
  /** The track target's element as the beat starts (`transformPreState`): scaleIn / scaleOut / pulse origins and the pulse's
   *  stage clamp. Set by the player for those presets. */
  element?: SceneElement;
  /** The shared stage point of a `"group"` origin (the union centre of the tracks that start together). */
  group?: StagePoint;
  /** The presentation opacity of a node just before the track starts: highlight and dim start FROM it (X7). */
  priorOpacity?: (node: TargetNode) => number;
  /** The stage box of ONE plot part: a pulse sizes its peak to the part it swells (a 6-unit marker grows to 1.3x, a bar to 1.12x), not to
   *  the whole plot it sits in. Set by the player for a live pulse on plot parts. */
  partBox?: (node: TargetNode) => { x: number; y: number; w: number; h: number } | undefined;
}

/** One node's animation within a track. `enter` marks an intro (the node is
 *  hidden — at `keyframes[0]` — until this beat plays). `index` orders staggers.
 *  `prep` runs once before play/static to set non-animated scaffolding (dash
 *  array). The transform origin is NOT scaffolding: it is `origin` (data). */
export interface NodeAnim {
  node: TargetNode;
  keyframes: Keyframe[];
  index: number;
  enter: boolean;
  prep?: () => void;
  /** The `transform-origin` this node's transform is about. DATA, not a side effect: the player
   *  writes ONE origin per node per frame (that of the spec in flight) and none at rest, so two
   *  transform effects on one node can never corrupt each other. On an SVG node the player also
   *  sets `transform-box: fill-box`, so percentages refer to the part's own box. */
  origin?: string;
  /** T3: an exact per-frame style source (raw track progress, the track's curve -> one frame). When present the
   *  player samples THIS instead of interpolating `keyframes` (which then only declare the hidden-before / rest
   *  frames and the property set to clear). Lets a draw emit dash lists whose length changes per frame. A
   *  keyframes-only anim (no `sample`) stays valid: a sweep that is pure keyframes (T8's x-clock) returns that. */
  sample?: (raw: number, ease: (x: number) => number) => Keyframe;
  /** T3: props that exist only while the effect plays: dropped at progress 1, so the authored attributes are the
   *  rest state (the generic form of the old `preset === "drawOn"` special case). */
  transient?: readonly string[];
  /** Rebuild camera frames at play start; no argument restores the compiled FROM. */
  refreshCamera?: (transform?: string) => boolean;
  /** The exact transform at an eased progress OUTSIDE [0,1] (a spring's
   *  overshoot). Keyframes cover [0,1]; extrapolating their last segment
   *  linearly would leave the geometric camera path the compiler samples. */
  transformAt?: (u: number) => string;
}

export type Preset = (nodes: TargetNode[], track: Track, ctx: PresetCtx) => NodeAnim[];

const SVG_NS = "http://www.w3.org/2000/svg";

const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
const each = (nodes: TargetNode[], fn: (node: TargetNode, index: number) => NodeAnim): NodeAnim[] =>
  nodes.map(fn);

/** The pivot of a scaleIn / scaleOut / pulse on `node`. A plot part (SVG) scales about a point of its OWN fill-box: a compass
 *  word picks the point, everything else (tail, a stage point, group) falls back to the part's centre. A whole element
 *  (the HTML effects layer) takes the full vocabulary through `growOrigin`, in the element's unrotated local frame. */
function growPivot(node: TargetNode, word: string | PointParam | null, ctx: PresetCtx, count: number): string {
  if (node.namespaceURI === SVG_NS) return isCompass(word) ? compassOrigin(word) : "50% 50%";
  return growOrigin(word ?? undefined, count === 1 ? ctx.element : undefined, ctx.group);
}

/** [hidden, shown] clip-path insets for a writeOn/wipeOut direction. The
 *  non-animating edges use a NEGATIVE margin: any clip-path clips the border
 *  box, and hugged text overflows it slightly (descenders, italic overhang,
 *  antialiasing) — without the margin the resting state permanently shaves
 *  the bottom of written-on text. Only the reveal edge sweeps 100% → −20%. */
function wipeInsets(direction: string): [string, string] {
  const M = "-20%";
  const hidden =
    direction === "rtl" ? `inset(${M} ${M} ${M} 100%)` :
    direction === "ttb" ? `inset(${M} ${M} 100% ${M})` :
    direction === "btt" ? `inset(100% ${M} ${M} ${M})` :
    `inset(${M} 100% ${M} ${M})`; // ltr
  return [hidden, `inset(${M} ${M} ${M} ${M})`];
}

/** True when the node or any ancestor carries a computed transform that rotates, skews or flips (anything but
 *  translate + positive scale). The ink measure reads SCREEN rects and turns them into fractions of the box along the
 *  wipe axis; the clip-path lives in the element's LOCAL frame, so under rotation or a flip the two disagree (a 90-degree
 *  text showed 27 % of itself before its beat). Such targets sweep the whole box, the pre-T3 behaviour (review F1). */
function axesNotPreserved(node: Element): boolean {
  for (let el: Element | null = node; el; el = el.parentElement) {
    const t = getComputedStyle(el).transform;
    if (!t || t === "none") continue;
    const v = (/\(([^)]*)\)/.exec(t)?.[1] ?? "").split(",").map(Number);
    const [a, b, c, d] = t.startsWith("matrix3d") ? [v[0], v[1], v[4], v[5]] : v;
    if (![a, b, c, d].every(Number.isFinite)) continue;
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a < 0 || d < 0) return true;
  }
  return false;
}

/** T3: the INK extent of a target along the wipe axis, as fractions of its box ([0,1] = the box edge to edge) along
 *  the SWEEP direction. A fixed-width, centred text box is mostly empty: sweeping the whole box leaves a quarter of
 *  the duration revealing nothing before the first glyph and after the last. SVG nodes use their geometry boxes;
 *  HTML text uses the union of its text-node client rects. No layout (headless DOM) -> [0,1], the whole box. */
function inkFractions(node: TargetNode, direction: string): [number, number] {
  const horiz = direction === "ltr" || direction === "rtl";
  try {
    if (axesNotPreserved(node)) return [0, 1];
    const box = node.getBoundingClientRect();
    const size = horiz ? box.width : box.height;
    if (!(size > 1)) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    const take = (r: DOMRect) => {
      if (!(r.width > 0 || r.height > 0)) return;
      lo = Math.min(lo, horiz ? r.left : r.top); hi = Math.max(hi, horiz ? r.right : r.bottom);
    };
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) take(r);
    }
    if (!Number.isFinite(lo)) for (const el of Array.from(node.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon,image,img,canvas"))) take(el.getBoundingClientRect());
    if (!Number.isFinite(lo)) return [0, 1];
    const origin = horiz ? box.left : box.top;
    let a = (lo - origin) / size, b = (hi - origin) / size;
    if (direction === "rtl" || direction === "btt") [a, b] = [1 - b, 1 - a]; // fractions along the SWEEP direction
    return [Math.min(1, Math.max(0, a)), Math.min(1, Math.max(a + 0.02, Math.min(1, b)))];
  } catch { return [0, 1]; }
}
/** inset() with the sweeping edge at fraction `f` of the box (0 = hidden at the sweep start, 1 = the box end); the
 *  non-sweeping edges keep the -20 % overflow margin (descenders survive, see wipeInsets). */
function wipeAt(direction: string, f: number): string {
  const M = "-20%", e = `${Math.round((1 - f) * 10000) / 100}%`;
  return direction === "rtl" ? `inset(${M} ${M} ${M} ${e})` : direction === "ttb" ? `inset(${M} ${M} ${e} ${M})` :
    direction === "btt" ? `inset(${e} ${M} ${M} ${M})` : `inset(${M} ${e} ${M} ${M})`;
}
/** Where the sweep has covered the ink; the last (1 - this) only uncovers the overhang margin. */
export const WIPE_BOX_AT = 0.95;

/** Measured length of a strokable node, honoring an explicit pathLength
 *  attribute (dash units must then be expressed in ITS scale). */
function geoLength(geo: SVGElement): number {
  const pl = Number(geo.getAttribute?.("pathLength"));
  if (Number.isFinite(pl) && pl > 0) return pl;
  try {
    return (geo as unknown as SVGGeometryElement).getTotalLength?.() || 1;
  } catch {
    return 1;
  }
}

/** Is this geometry a closed loop (dash windows wrap)? */
function geoClosed(geo: SVGElement): boolean {
  const tag = geo.tagName?.toLowerCase();
  if (tag === "rect" || tag === "ellipse" || tag === "circle" || tag === "polygon") return true;
  if (tag === "path") return /z\s*$/i.test((geo.getAttribute?.("d") ?? "").trim());
  return false;
}

/** Trim-path params from a track (documented schema — §5 of the rework plan; defaults live in PRESET_PARAMS). */
interface TrimParams {
  anchor?: number | string;
  direction?: "forward" | "reverse";
  mode?: "single" | "both-ends" | "middle-out";
  from?: number;
  to?: number;
}

// ---------------------------------------------------------------------------
// T3 — the draw plan. One compiler for drawOn/drawOff: classify the target's geometry into pen UNITS, give every
// piece of a unit a slice of ONE eased pen clock, and emit a per-frame sampler (`NodeAnim.sample`) whose frames
// are exact dash windows (trim.ts `windowsDash`). Contract for a later clock mode (WP 3.1, T8's x-clock): a sweep
// that is pure keyframes returns NodeAnims WITHOUT `sample` (built on `hiddenDash(len)`, ending at
// `drawReach(len, tag)`, declaring `transient: ["strokeDashoffset", "strokeDasharray"]`); `drawPlan` offers those
// keyframes before it chooses `sample`.
// ---------------------------------------------------------------------------
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** A filled piece: the outline runs over the first DRAW_OUTLINE of the clock, the fill ramps over the last (1 - DRAW_FILL_FROM). */
export const DRAW_OUTLINE = 0.6, DRAW_FILL_FROM = 0.45;
/** Hairline of the synthetic border drawn round a fill-only shape (stage units). */
export const DRAW_HAIRLINE = 1.25;
/** Dash segments a single drawOn/drawOff target may have live at once. Measured (Chrome 156, 40 lines x 400 dashes =
 *  16,000 segments): raster 1.8 -> 10.1 ms/frame, JS 0.2 -> 1.6 ms. Past this a target's authored patterns are NOT kept
 *  during the draw (it draws solid and takes the pattern at rest, as every deck did before T3). */
export const DRAW_DASH_BUDGET = 4000;
/** Props that exist only while a draw plays; dropped at progress 1 (the authored attributes are the rest state). */
const DRAW_TRANSIENT = ["strokeDashoffset", "strokeDasharray", "strokeLinecap", "fillOpacity", "stroke", "strokeWidth", "transform", "transformOrigin"] as const;
const IDENT = (x: number) => x;

function rawPaintVal(el: Element, name: string): string {
  for (let p: Element | null = el; p; p = p.parentElement) {
    const v = parseStyleAttr(p.getAttribute("style")).get(name) ?? p.getAttribute(name);
    if (v != null && v !== "inherit") return v.trim();
  }
  return "";
}
function pts(el: Element): [number, number][] {
  const nums = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}
/** A stroke's end point in its parent's user space. */
function strokeEnd(geo: SVGElement, which: "start" | "end"): [number, number] | null {
  const tag = geo.tagName.toLowerCase();
  if (tag === "line") return which === "start" ? [Number(geo.getAttribute("x1")), Number(geo.getAttribute("y1"))] : [Number(geo.getAttribute("x2")), Number(geo.getAttribute("y2"))];
  if (tag !== "path") return null;
  const g = geo as unknown as SVGGeometryElement;
  try {
    const pt = g.getPointAtLength(which === "start" ? 0 : g.getTotalLength());
    const m = (geo as unknown as SVGGraphicsElement).transform?.baseVal?.consolidate?.()?.matrix;
    return m ? [m.a * pt.x + m.c * pt.y + m.e, m.b * pt.x + m.d * pt.y + m.f] : [pt.x, pt.y];
  } catch { return null; }
}
/** Does the node carry an explicit positive `pathLength` (so `geoLength` is NOT its geometric length)? Without one the
 *  dash length IS the true length: one `getTotalLength` per piece, not two (review F7). */
function explicitPathLength(geo: SVGElement): boolean {
  const pl = Number(geo.getAttribute?.("pathLength"));
  return Number.isFinite(pl) && pl > 0;
}
/** The TRUE geometric length (never the `pathLength` attribute, whose units are dash units): the pen-clock weight. */
function trueLength(geo: SVGElement, fallback: number): number {
  try { return (geo as unknown as SVGGeometryElement).getTotalLength?.() || fallback; } catch { return fallback; }
}

interface Piece {
  geo: SVGElement; tag: string; role: "stroke" | "strokeFill" | "fill" | "headFill" | "headVee";
  /** dash-math length: `geoLength`, which honours an explicit `pathLength` (X12) */
  len: number; closed: boolean; pattern?: number[];
  /** the pen length this piece contributes to its unit's clock (true geometric length; the head's own for heads) */
  pen: number;
  /** headFill: scale origin (user space). headVee: the tip is the polyline's mid-length. */
  origin?: [number, number];
}
interface Unit { pieces: Piece[]; pen: number }

/** Classify a target's geometry into pen UNITS. A Flux line/path arrow is a stroke plus sibling head shapes
 *  (`<polygon>` filled / `<polyline>` vee): the heads join their shaft's unit, so the pen reaches them in order.
 *  Same geometry selection as `strokeGeometry.drawGeometry` (GEO tags, nothing inside `<defs>`, no `<use>`). */
function drawUnits(node: TargetNode): Unit[] {
  const el = node as Element, tag = el.tagName?.toLowerCase();
  const all: SVGElement[] = [];
  if (tag && new RegExp(`^(${GEO_TAGS.replace(/,/g, "|")})$`).test(tag)) { if (!inDefs(el)) all.push(el as SVGElement); }
  else for (const g of Array.from(el.querySelectorAll?.(GEO_TAGS) ?? []) as SVGElement[]) if (!inDefs(g)) all.push(g);
  const paint = new Map(all.map((g) => [g, paintOf(g)] as const));
  const used = new Set<SVGElement>();
  const units: Unit[] = [];
  const mk = (geo: SVGElement, role: Piece["role"]): Piece => {
    const len = geoLength(geo);
    const dash = readPaint(geo).dash;
    return { geo, tag: geo.tagName.toLowerCase(), role, len, closed: geoClosed(geo), pen: explicitPathLength(geo) ? trueLength(geo, len) : len, ...(dash?.some((v) => v > 0) ? { pattern: dash } : {}) };
  };
  // heads first: a head belongs to the stroked line/open-path sibling whose end it sits on
  const hosts = all.filter((g) => ["line", "path"].includes(g.tagName.toLowerCase()) && paint.get(g)!.stroked && !paint.get(g)!.filled && !geoClosed(g));
  // each host's two ends, measured ONCE (getTotalLength + getPointAtLength per candidate head x host would be
  // O(heads x hosts x pathLength) on a dense plot part, at every slide rebuild)
  const ends = new Map<SVGElement, { start: [number, number] | null; end: [number, number] | null }>();
  const endsOf = (h: SVGElement) => { let e = ends.get(h); if (!e) { e = { start: strokeEnd(h, "start"), end: strokeEnd(h, "end") }; ends.set(h, e); } return e; };
  const headOf = new Map<SVGElement, { start?: SVGElement; end?: SVGElement }>();
  for (const g of all) {
    const tg = g.tagName.toLowerCase(), p = paint.get(g)!;
    const fillHead = tg === "polygon" && p.filled && !p.stroked, veeHead = tg === "polyline" && p.stroked && !p.filled;
    if (!fillHead && !veeHead) continue;
    // a head with its own `transform` attribute is NOT classified: the scale() reveal is a CSS transform, which
    // REPLACES the SVG attribute (measured: the polygon jumps to the origin). It draws as a plain filled piece
    // instead. (Flux-authored arrows carry no transform attribute: export.ts:213,234.)
    if (g.hasAttribute("transform")) continue;
    const q = pts(g); const tip = fillHead ? q[0] : q[1];
    if (!tip || q.length !== 3) continue;
    const extent = Math.max(...q.map((v) => Math.hypot(v[0] - tip[0], v[1] - tip[1])));
    let best: { host: SVGElement; which: "start" | "end"; d: number } | null = null;
    for (const h of hosts) {
      if (h.parentNode !== g.parentNode) continue;
      for (const which of ["start", "end"] as const) {
        const e = endsOf(h)[which]; if (!e) continue;
        const d = Math.hypot(e[0] - tip[0], e[1] - tip[1]);
        if (d <= extent * 1.2 + 0.75 && (!best || d < best.d)) best = { host: h, which, d };
      }
    }
    if (!best) continue;
    const slot = headOf.get(best.host) ?? {}; if (slot[best.which]) continue; slot[best.which] = g; headOf.set(best.host, slot);
  }
  for (const h of hosts) {
    const slot = headOf.get(h); if (!slot) continue;
    const pieces: Piece[] = [];
    const head = (g: SVGElement, which: "start" | "end"): Piece => {
      const q = pts(g), fill = g.tagName.toLowerCase() === "polygon";
      const tip = fill ? q[0] : q[1];
      const base: [number, number] = fill ? [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2] : [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
      const pen = Math.hypot(tip[0] - base[0], tip[1] - base[1]) || 1;
      // an END head grows from its base (where the shaft arrives); a START head from its tip (where the pen begins)
      const p = mk(g, fill ? "headFill" : "headVee"); p.pen = pen; if (fill) p.origin = which === "end" ? base : tip;
      return p;
    };
    if (slot.start) pieces.push(head(slot.start, "start"));
    const shaft = mk(h, "stroke"); pieces.push(shaft);
    if (slot.end) pieces.push(head(slot.end, "end"));
    used.add(h); if (slot.start) used.add(slot.start); if (slot.end) used.add(slot.end);
    units.push({ pieces, pen: pieces.reduce((n, p) => n + p.pen, 0) });
  }
  for (const g of all) {
    if (used.has(g)) continue;
    const p = paint.get(g)!;
    const role: Piece["role"] | null = p.stroked && p.filled ? "strokeFill" : p.stroked ? "stroke" : p.filled ? "fill" : null;
    if (!role) continue;
    const piece = mk(g, role);
    units.push({ pieces: [piece], pen: piece.pen });
  }
  // DOM order of each unit's first member (keeps authored z-order = pen order)
  const order = (u: Unit) => Math.min(...u.pieces.map((q) => all.indexOf(q.geo)));
  return units.sort((a, b) => order(a) - order(b));
}

/** The pieces of ONE unit take back-to-back slices of its eased pen clock, proportional to their pen length: one
 *  curve gives a pen of continuous speed across shaft -> head (a unit's slices are cumulative sums, [0,1] in total).
 *  Deliberately local and lag-free: across-unit stroke ORDER (WP 2.4) is a separate, later feature. */
function unitSlices(weights: readonly number[]): [number, number][] {
  const w = weights.map((v) => Math.max(v, 1e-9)), total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((v) => { const a = acc / total; acc += v; return [a, Math.min(1, acc / total)] as [number, number]; });
}

/** A forward sampler: raw progress of the TRACK (0..1) and the track's curve. */
type Forward = (raw: number, ease: (x: number) => number) => Keyframe;
const win = (raw: number, w0: number, w1: number) => clamp01((raw - w0) / Math.max(1e-9, w1 - w0));

/** Frame builders: every frame of one piece carries the SAME key set. `[a,b]` = this piece's slice of the unit's
 *  EASED pen clock. */
function pieceSampler(piece: Piece, [a, b]: [number, number]): Forward {
  const { geo, len, closed, pattern } = piece;
  const reach = drawReach(len, piece.tag);
  const spec = { len: reach, closed, pattern };
  const fillOp = parseFloat(rawPaintVal(geo, "fill-opacity")); const restFillOp = Number.isFinite(fillOp) && fillOp >= 0 ? fillOp : 1;
  const fillCol = rawPaintVal(geo, "fill");
  const strokeCol = rawPaintVal(geo, "stroke");
  const hid = hiddenDash(reach);
  const clock = (raw: number, ease: (x: number) => number) => ease(clamp01(raw));
  const slice = (c: number) => clamp01((c - a) / Math.max(1e-9, b - a));
  if (piece.role === "stroke") return (raw, ease) => (windowsDash(spec, [[0, slice(clock(raw, ease)) * reach]]) ?? hid) as unknown as Keyframe;
  if (piece.role === "headFill") {
    const [ox, oy] = piece.origin!;
    return (raw, ease) => ({ transform: `scale(${Math.max(1e-4, slice(clock(raw, ease)))})`, transformOrigin: `${ox}px ${oy}px` });
  }
  if (piece.role === "headVee") return (raw, ease) => {
    const k = slice(clock(raw, ease)) * len, mid = len / 2; // grows out of the tip (the polyline's mid-length)
    return (windowsDash({ len, closed: false }, [[mid - k / 2, mid + k / 2]]) ?? hiddenDash(len)) as unknown as Keyframe;
  };
  // filled pieces: the OUTLINE runs in its own window (the first DRAW_OUTLINE of the clock) and the FILL in its own
  // (the last 1 - DRAW_FILL_FROM), each eased by the track's curve (manim's double_smooth, overlapped, no plateau).
  const outline = (raw: number, ease: (x: number) => number) => clamp01(ease(win(raw, 0, DRAW_OUTLINE)));
  const fillRamp = (raw: number, ease: (x: number) => number) => clamp01(ease(win(raw, DRAW_FILL_FROM, 1)));
  if (piece.role === "strokeFill") return (raw, ease) => {
    const f = windowsDash(spec, [[0, outline(raw, ease) * reach]]) ?? hid;
    return { ...f, fillOpacity: restFillOp * fillRamp(raw, ease) } as unknown as Keyframe;
  };
  // fill only: a hairline border in the fill colour is drawn first, then fades into the fill
  const colourOK = fillCol && !/^(none|url\(|transparent)/i.test(fillCol);
  let hw = DRAW_HAIRLINE;
  try { const m = (geo as unknown as SVGGraphicsElement).getCTM?.(); const sc = m ? Math.hypot(m.a, m.b) : 1; if (sc > 0) hw = DRAW_HAIRLINE / sc; } catch { /* no CTM */ }
  return (raw, ease) => {
    if (!colourOK) return { ...hid, fillOpacity: restFillOp * clamp01(ease(clamp01(raw))), stroke: strokeCol || "none", strokeWidth: 0 } as unknown as Keyframe;
    const ramp = fillRamp(raw, ease);
    const f = windowsDash(spec, [[0, outline(raw, ease) * reach]]) ?? hid;
    return { ...f, fillOpacity: restFillOp * ramp, stroke: fillCol, strokeWidth: hw * (1 - ramp) } as unknown as Keyframe;
  };
}

function drawPlan(node: TargetNode, index: number, t: Track, enter: boolean): NodeAnim[] {
  const units = drawUnits(node);
  const dashTotal = units.reduce((n, u) => n + u.pieces.reduce((m, p) => m + (p.pattern ? (drawReach(p.len, p.tag) / p.pattern.reduce((x, v) => x + v, 0)) * Math.ceil(p.pattern.length / 2) : 0), 0), 0);
  if (dashTotal > DRAW_DASH_BUDGET) for (const u of units) for (const p of u.pieces) delete p.pattern;
  // no drawable geometry (<use>-based ticks in pre-regen fluxplot SVGs): a fade, never a silent no-op
  if (!units.length) return [{ node, index, enter, keyframes: enter ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }] }];
  const params = (t.params ?? {}) as TrimParams;
  const trim = !isDefaultTrim(params);
  const out: NodeAnim[] = [];
  for (const unit of units) {
    // pieces of one unit share the unit's EASED clock: shaft -> head with no stall
    const inner = unit.pieces.length > 1 ? unitSlices(unit.pieces.map((p) => p.pen)) : [[0, 1] as [number, number]];
    unit.pieces.forEach((piece, pi) => {
      const forward: Forward = trim && piece.role === "stroke" ? trimSampler(piece, inner[pi], t, enter ? "drawOn" : "drawOff") : pieceSampler(piece, inner[pi]);
      // exit = the enter sampled backwards in time with the MIRRORED curve (1 - e(1 - v)): the retreat eases in
      // exit time exactly as the legacy offset reversal did, for any curve
      const sample = enter
        ? (raw: number, ease: (x: number) => number) => forward(clamp01(raw), ease)
        : (raw: number, ease: (x: number) => number) => forward(1 - clamp01(raw), (v) => 1 - ease(1 - v));
      out.push({
        node: piece.geo, index, enter, sample,
        keyframes: enter ? [forward(0, IDENT), forward(1, IDENT)] : [forward(1, IDENT), forward(0, IDENT)],
        ...(enter ? { transient: DRAW_TRANSIENT } : {}),
      });
    });
  }
  return out;
}

/** Explicit trim params: the legacy window math, sampled exactly per frame with NO structural zero dashes (so the
 *  authored linecap stays: no butt -> round pop on the last frame). */
function trimSampler(piece: Piece, [a, b]: [number, number], t: Track, preset: "drawOn" | "drawOff"): Forward {
  const geo = piece.geo, len = piece.len;
  const box = (geo as unknown as { getBBox?: () => { width: number; height: number } }).getBBox?.();
  const spec: TrimSpec = {
    len, closed: piece.closed,
    anchor: resolveAnchor(presetParam<number | string>(t, "anchor", preset), {
      tag: piece.tag,
      width: box?.width ?? Number(geo.getAttribute?.("width")) ?? undefined,
      height: box?.height ?? Number(geo.getAttribute?.("height")) ?? undefined,
    }),
    direction: presetParam<string>(t, "direction", preset) === "reverse" ? "reverse" : "forward",
    mode: ((m) => m === "both-ends" || m === "middle-out" ? m : "single")(presetParam<string>(t, "mode", preset)),
    from: presetParam(t, "from", preset),
    to: presetParam(t, "to", preset),
  };
  return (raw, ease) => {
    const c = clamp01((ease(clamp01(raw)) - a) / Math.max(1e-9, b - a));
    return (trimDashAt(spec, c, piece.pattern) ?? hiddenDash(len)) as unknown as Keyframe;
  };
}

export const PRESETS: Record<string, Preset> = {
  // --- enters (hidden before their beat) -----------------------------------
  fade: (nodes) => each(nodes, (node, index) => ({ node, index, enter: true, keyframes: [{ opacity: 0 }, { opacity: 1 }] })),

  fadeRise: (nodes, t) => {
    const y = presetParam(t, "y", "fadeRise");
    return each(nodes, (node, index) => ({
      node, index, enter: true,
      keyframes: [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: "translateY(0)" }],
    }));
  },

  // Scales about the node's own centre: `origin` is a fill-box percentage on an SVG part (a part scaled
  // about the SVG's top-left corner would fly away) and the centre of the effects layer on a whole element.
  popIn: (nodes, t) => {
    const from = presetParam(t, "from", "popIn");
    return each(nodes, (node, index) => ({
      node, index, enter: true, origin: "50% 50%",
      keyframes: [{ opacity: 0, transform: `scale(${from})` }, { opacity: 1, transform: "scale(1)" }],
    }));
  },

  // Each bar grows along ITS value axis from ITS baseline edge (`barGrow`, from the manifest's
  // series[].bar): vertical bars scaleY from the bottom (the top when negative), horizontal bars scaleX
  // from the left (the right when negative). The origin is a fill-box percentage of the bar's own
  // geometry, never the plot's edge (`transform-origin` on an SVG node resolves against the view-box
  // unless the player sets fill-box). A part that is not a bar grows up from the bottom of its own box;
  // a whole element keeps the classic "bottom center".
  growBaseline: (nodes, t, ctx) => {
    const prefix = partDomId(t.target, "");
    return each(nodes, (node, index) => {
      const svg = node.namespaceURI === SVG_NS;
      const attr = (name: string) => { const v = node.getAttribute?.(name); const x = v == null || v === "" ? NaN : Number(v); return Number.isFinite(x) ? x : null; };
      const part = node.id?.startsWith(prefix) ? node.id.slice(prefix.length) : "";
      const isBar = svg && (node.getAttribute?.("data-role") === "bar" || isManifestBar(ctx.manifest, part));
      const bar = isBar ? barGrow(ctx.manifest, part, { x: attr("data-x"), y: attr("data-y") }) : undefined;
      const fn = bar?.fn ?? "scaleY";
      return { node, index, enter: true, origin: svg ? bar?.origin ?? "50% 100%" : "bottom center", keyframes: [{ transform: `${fn}(0)` }, { transform: `${fn}(1)` }] };
    });
  },

  // scaleIn — manim's GrowFromCenter / GrowFromPoint / GrowArrow / SpinInFromNothing: scale(0) -> scale(1) about an origin,
  // NEVER an opacity channel (a shape grows, it does not fade). params.from: a compass word (center, n..nw) | "tail" | "auto"
  // (the default: an arrow's tail, everything else its centre) | "group" (the centre of the scaleIn tracks that start together) |
  // {x, y} (a stage point). params.spin (degrees; schema only, no UI): the node also unwinds from -spin to 0 (manim's
  // spiral_path). A plot part takes a compass word (a point of its own fill-box); the other forms fall back to its centre.
  scaleIn: (nodes, t, ctx) => {
    const spin = presetParam(t, "spin", "scaleIn"), from = presetParam<string | PointParam>(t, "from", "scaleIn");
    const start = spin ? `scale(0) rotate(${-spin}deg)` : "scale(0)", end = spin ? "scale(1) rotate(0deg)" : "scale(1)";
    return each(nodes, (node, index) => ({ node, index, enter: true, origin: growPivot(node, from, ctx, nodes.length), keyframes: [{ transform: start }, { transform: end }] }));
  },

  // Tier-2: directional reveal via a clip-path inset (math / axis labels /
  // text). params.direction: ltr (default) | rtl | ttb | btt. The sweep is fitted
  // to the INK: hidden exactly at the first ink, covering the last ink at
  // WIPE_BOX_AT, the overhang margin uncovered after: no dead lead, no dead tail.
  writeOn: (nodes, t) => nodes.flatMap((node, index): NodeAnim[] => {
    const dir = presetParam<string>(t, "direction", "writeOn");
    const shown = wipeInsets(dir)[1], [a, b] = inkFractions(node, dir);
    return [{ node, index, enter: true, keyframes: [{ clipPath: wipeAt(dir, a) }, { clipPath: wipeAt(dir, b), offset: WIPE_BOX_AT }, { clipPath: shown }] }];
  }),

  // Tier-2: the SVG self-draw — Flux's Trim Paths (T3 draw plan, see drawPlan()).
  // A target with NO drawable geometry (<use>-based ticks in pre-regen fluxplot
  // SVGs) falls back to a fade, never a silent no-op that leaves the part visible
  // before its beat. Any trim param switches the stroke pieces to the trim windows.
  drawOn: (nodes, t) => nodes.flatMap((node, index) => drawPlan(node, index, t, true)),

  // --- exits (hidden AFTER their beat) --------------------------------------
  fadeOut: (nodes) =>
    each(nodes, (node, index) => ({ node, index, enter: false, keyframes: [{ opacity: 1 }, { opacity: 0 }] })),

  popOut: (nodes, t) => {
    const to = presetParam(t, "to", "popOut");
    return each(nodes, (node, index) => ({
      node, index, enter: false, origin: "50% 50%",
      keyframes: [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: `scale(${to})` }],
    }));
  },

  // scaleOut — scaleIn run backwards (manim ShrinkToCenter): scale(1) -> scale(0) about params.to (the scaleIn.from vocabulary),
  // no opacity channel. An exit: the node rests at scale(0) (not rendered) and the compiled presentation hides it.
  scaleOut: (nodes, t, ctx) => {
    const spin = presetParam(t, "spin", "scaleOut"), to = presetParam<string | PointParam>(t, "to", "scaleOut");
    const start = spin ? "scale(1) rotate(0deg)" : "scale(1)", end = spin ? `scale(0) rotate(${spin}deg)` : "scale(0)";
    return each(nodes, (node, index) => ({ node, index, enter: false, origin: growPivot(node, to, ctx, nodes.length), keyframes: [{ transform: start }, { transform: end }] }));
  },

  // Tier-2: writeOn's mirror — a directional wipe via clip-path, ink-fitted.
  wipeOut: (nodes, t) => nodes.flatMap((node, index): NodeAnim[] => {
    const dir = presetParam<string>(t, "direction", "wipeOut");
    const shown = wipeInsets(dir)[1], [a, b] = inkFractions(node, dir);
    return [{ node, index, enter: false, keyframes: [{ clipPath: shown }, { clipPath: wipeAt(dir, b), offset: 1 - WIPE_BOX_AT }, { clipPath: wipeAt(dir, a) }] }];
  }),

  // Tier-2: drawOn reversed — the same plan sampled backwards (the pen runs from
  // the head back to the tail, heads fold into the shaft first, fills drain first).
  drawOff: (nodes, t) => nodes.flatMap((node, index) => drawPlan(node, index, t, false)),

  // --- transforms / emphasis (already-present elements) --------------------
  move: (nodes, t) => {
    const dx = num(t.to?.x, 0), dy = num(t.to?.y, 0);
    return each(nodes, (node, index) => ({
      node, index, enter: false,
      keyframes: [{ transform: "translate(0,0)" }, { transform: `translate(${dx}px, ${dy}px)` }],
    }));
  },

  // scale / rotate pivot about the node's own centre (a part's fill-box centre): the origin persists at rest, where the
  // transform persists, so an SVG part never turns about the view-box corner.
  scale: (nodes, t) => {
    const s = legacyScaleOf(t);
    return each(nodes, (node, index) => ({
      node, index, enter: false, origin: "50% 50%",
      keyframes: [{ transform: "scale(1)" }, { transform: `scale(${s})` }],
    }));
  },

  rotate: (nodes, t) => {
    const deg = legacyRotationOf(t);
    return each(nodes, (node, index) => ({
      node, index, enter: false, origin: "50% 50%",
      keyframes: [{ transform: "rotate(0deg)" }, { transform: `rotate(${deg}deg)` }],
    }));
  },

  // highlight — the dip-and-recover wink, started FROM the node's presentation opacity (a dimmed node climbs from its dim
  // level instead of jumping). `lead` is the share of eased progress spent easing into the dip: 0 (every saved track) is the
  // historical jump, bit-exact; new tracks author 0.25. Same formula as compile.sample (`highlightOpacityAt`).
  highlight: (nodes, t, ctx) => {
    const level = presetParam(t, "level", "highlight"), lead = presetParam(t, "lead", "highlight");
    return each(nodes, (node, index) => {
      if (!(lead > 0)) return { node, index, enter: false, keyframes: [{ opacity: level }, { opacity: 1 }] };
      const prior = Math.max(0, Math.min(1, ctx.priorOpacity?.(node) ?? 1));
      return { node, index, enter: false, keyframes: [{ opacity: prior }, { opacity: Math.min(prior, level), offset: lead }, { opacity: 1 }] };
    });
  },

  // dim starts FROM the node's presentation opacity too (X7) and ends at `level`: [prior, level] (prior 1 = the legacy [1, level]).
  dim: (nodes, t, ctx) => {
    const level = presetParam(t, "level", "dim");
    return each(nodes, (node, index) => {
      const prior = Math.max(0, Math.min(1, ctx.priorOpacity?.(node) ?? 1));
      return { node, index, enter: false, keyframes: [{ opacity: prior }, { opacity: level }] };
    });
  },

  // pulse — manim's Indicate: scale(1) -> scale(k) -> scale(1), the track's own easing applied to the triangle wave
  // there_and_back(u) = ease(1 - |2u - 1|). With the default `smooth` that is manimgl's `there_and_back` exactly (gated to 1e-12).
  // Token-free: `sample` is a pure function of raw progress, so forward / reverse / shuffled seeks, video and the HTML player agree.
  // The keyframes still declare the flight kind (scale = paints in place) and the rest pose (scale(1): nothing left behind).
  // k is size-aware and stage-clamped (`pulsePeak`); params.about: "group" | a stage point moves the pivot of a whole element.
  pulse: (nodes, t, ctx) => {
    const about = presetParam<string | PointParam | null>(t, "about", "pulse"), authored = presetParam<number | null>(t, "scale", "pulse");
    const point: StagePoint | undefined = about === "group" ? ctx.group : about && typeof about === "object" ? about : undefined;
    const whole = ctx.element ? rotatedAABB(ctx.element) : undefined;
    return each(nodes, (node, index) => {
      // a plot part swells about its OWN fill-box centre and is sized by its own box; a whole element about `about` (default its centre)
      const part = node.namespaceURI === SVG_NS;
      const k = pulsePeak(authored, part ? ctx.partBox?.(node) ?? whole : whole, ctx.stage, part ? undefined : point);
      return {
        node, index, enter: false,
        origin: point ? growPivot(node, point, ctx, nodes.length) : "50% 50%",
        keyframes: [{ transform: "scale(1)" }, { transform: `scale(${k})`, offset: 0.5 }, { transform: "scale(1)" }],
        sample: (raw, ease) => ({ transform: `scale(${1 + (k - 1) * ease(1 - Math.abs(2 * raw - 1))})` }),
      };
    });
  },

  // encircle is a synthetic overlay: the player builds its MorphController in the flight layer (player/overlay.ts), so the
  // preset itself animates no node.
  encircle: () => [],

  // --- the stage camera (target = the camera layer) ------------------------
  camera: (nodes, t, ctx) => {
    const poseOf = (transform = ""): CameraPose => {
      const n = transform.match(/-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
      const zoom = n?.[2] ?? 1;
      return { x: (ctx.stage.width / 2 - (n?.[0] ?? 0)) / zoom, y: (ctx.stage.height / 2 - (n?.[1] ?? 0)) / zoom, zoom };
    };
    return each(nodes, (node, index) => {
      const initial = ctx.cameraFrom ?? poseOf(node.style.transform);
      const to = { x: num(t.to?.x, initial.x), y: num(t.to?.y, initial.y), zoom: num(t.to?.zoom, initial.zoom) };
      const keyframes: Keyframe[] = Array.from({ length: 24 }, (_, i) => ({ offset: i / 23 }));
      const pose = { ...initial };
      let last: CameraPose | undefined, current = initial;
      const transformAt = (u: number) => {
        sampleCamera(current, to, u, ctx.stage, t.to?.path, pose);
        const { x, y, zoom } = editorCameraTransform(pose, ctx.stage);
        return `translate(${x}px, ${y}px) scale(${zoom})`;
      };
      const refreshCamera = (transform?: string) => {
        const from = transform === undefined ? initial : poseOf(transform);
        if (last && from.x === last.x && from.y === last.y && from.zoom === last.zoom) return false;
        last = current = from;
        for (let i = 0; i < keyframes.length; i++) keyframes[i].transform = transformAt(i / 23);
        return true;
      };
      refreshCamera();
      return { node, index, enter: false, keyframes, refreshCamera, transformAt };
    });
  },

  // `stagger` = apply a child preset (default fadeRise) over the node set; the
  // player adds the per-index delay from track.stagger.
  stagger: (nodes, t, ctx) => {
    const child = presetParam<string>(t, "child", "stagger");
    return (PRESETS[child] ?? PRESETS.fadeRise)(nodes, t, ctx);
  },
};

/** Whether a preset name introduces its targets (hidden before its beat). Used
 *  by the player's static-state pass for nodes it hasn't computed specs for yet. */
export const ENTER_PRESETS = new Set(Object.keys(PRESET_CATALOG).filter(isEnterPreset));

/** The disappear family — targets are hidden AFTER their beat. A later enter
 *  re-baselines the node (the player's static accumulation restarts at the last
 *  enter), so enter → exit → re-enter sequences are deterministic + reversible. */
export const EXIT_PRESETS = new Set(Object.keys(PRESET_CATALOG).filter(isExitPreset));

/** The WRAPPER-level style props each appearance preset animates — the
 *  transform-conflict map (rework §4.1): a transform on the same element in
 *  the same beat DROPS these props from its own writes so the appearance owns
 *  them for the overlap (and, at rest, the static pass's later-spec-wins
 *  ordering resolves the same way). Presets that drill to INNER geometry
 *  (drawOn/drawOff) touch no wrapper props and are absent deliberately. */
export const PRESET_WRAPPER_PROPS: Record<string, readonly string[]> = Object.fromEntries(
  Object.values(PRESET_CATALOG).filter(def => def.wrapperProps.length).map(def => [def.name, def.wrapperProps]),
);
