/**
 * The tween of an image's view between two states of a slide (stage 2: fluximg in Slides).
 *
 * A placed image stores how it is shown as numbers (`view.ts`), so a slide step that changes any of them is a
 * Change like any other: `to.state` holds the end's `view` and `crop`, and this module says what every frame in
 * between shows. It is the ONE definition: the slide tween core (`slide/tween.ts`), the compiler, the player's
 * live surface, the export bakers and flux-core all call it. Pure: no DOM, no service, no Svelte, no Node.
 *
 * THE LAW (owner-approved plan, feature 10: "Time, depth, contrast, crop and layer opacity all animate. Planes
 * step; they are never blended unless you ask for a crossfade."):
 *   1. CONTINUOUS numbers lerp on the eased time `t`: each channel's black and white points (in log space when
 *      both ends use the log norm) and gamma, an intensity layer's window and opacity, a vector or label layer's
 *      opacity, stroke width and fill opacity, the crop rectangle (the frame: zoom and pan), furniture sizes.
 *      Colours lerp in OKLab (`color/interp.lerpColor`): a channel's ramp colour, a layer's colour, the background.
 *   2. PLANE POSITIONS STEP. `index[dim]` walks the whole planes from the start's to the end's, each shown for an
 *      equal share of the (eased) time; the end's own plane arrives exactly at the end. A projection's run ends
 *      (`from`, `to`) step the same way. Nothing is ever shown that is not a plane of the data, unless the track
 *      asks for a crossfade (`options.blend`): then the neighbouring plane is mixed in by the fractional position.
 *   3. SWITCHES FADE, they never pop. A layer or a furniture piece switched on or off is a fade of its opacity.
 *      A discrete PIXEL setting that differs between the ends (a channel shown or hidden, a colour map swapped for
 *      another, the norm kind, invert, composite/solo, a projection switched on, off or to another mode or
 *      dimension, an intensity layer's colour map) makes TWO pictures of each frame: the same moment drawn with
 *      the start's settings and with the end's, mixed by `t`. Everything continuous is the same in both.
 *   4. EXACT ENDS: at `raw <= 0` the frame is exactly the start, at `raw >= 1` exactly the end (so the last frame
 *      of a tween is the element's own still, and nothing pops when the player hands over).
 *   5. Absent means default: both ends are completed from the manifest (`viewOps.resolveView`; an absent crop is
 *      the whole image) before anything is compared, so "as placed" glides to an explicit value.
 *   6. What does not animate steps at `raw` 0.5: `smooth`, the layer order, a furniture piece's corner, `insetOf`,
 *      `link`.
 *
 * Callers pass the eased `t` (which may overshoot 0..1 on a spring: clamp where a value has hard bounds) and the
 * linear progress `raw` (0..1), exactly as the slide engine's `MorphController.seek(u, raw)` receives them.
 *
 * The rules made exact (W1a):
 *   - A walk from plane a to plane b (N = |b − a| planes) shows `a + sign·min(N, floor(c·N))` with c = clamp(t, 0, 1)
 *     (plus 1e-9 so that c = k/N lands on plane k despite rounding). With `blend`, the crossfade neighbour is the
 *     next plane toward b at weight frac(c·N). When several dimensions (or projection run ends) walk at once, each
 *     steps by its own N and `blend` reports the one with the largest N (the first in stored order on a tie, a
 *     position before a run end).
 *   - Values with hard bounds are clamped after an overshoot: opacities and fill opacity to 0..1, stroke width to
 *     >= 0, gamma and furniture sizes to > 0 and windows to black < white (an overshoot that would break a bound
 *     falls back to the clamped time), the crop to the image (`still.clampCrop`). Colours never overshoot.
 *   - A channel's discrete settings (shown, colour map, norm kind, invert) and composite/solo only make two
 *     pictures when they can change pixels (the channel contributes at one end at least; the contributing set
 *     changes); otherwise they step at raw 0.5 like everything else that is not pixels. Any field this module does
 *     not know (a later view field) is carried and steps at raw 0.5: nothing is dropped.
 *   - Everything a plan returns (pictures, views, frames) is shared and READ-ONLY: unchanged parts of a frame are
 *     the very objects of `start`, `end` is returned as is at raw >= 1, and `overlay` is `a` or `b` itself.
 */
import type { CropRect } from "../types";
import type { FluximgManifest } from "./types";
import type {
  FluximgProjection, FluximgView, PixelRect, ResolvedChannel, ResolvedFurniture, ResolvedLayer, ResolvedView,
} from "./view";
import { contributingChannelIndices, pixelKey, positionDims, resolveView } from "./viewOps";
import { clampCrop } from "./crop";
import { prepareColorLerp } from "../color/interp";
import { hexToRgb } from "./lut";
import { positionText } from "./furniture";
import { naturalRate } from "./live/rail";

/** One end of a Change: what the element stores at that state. */
export interface ViewEnd {
  view?: FluximgView | null;
  /** Level-0 image pixels; absent = the whole image. */
  crop?: CropRect | null;
}

/** One picture: a resolved view over a concrete frame (never absent: the whole image when the element has no crop). */
export interface TweenPicture {
  view: ResolvedView;
  crop: PixelRect;
}

export interface TweenOptions {
  /** Crossfade neighbouring planes instead of stepping them (law 2). Default false. */
  blend?: boolean;
}

/** What one frame of the tween shows. */
export interface ViewTweenFrame {
  /** The picture: continuous values lerped, plane positions stepped, discrete pixel settings as at the START. */
  a: TweenPicture;
  /** Law 3: the same moment with the END's discrete pixel settings, while they differ; otherwise null. */
  b: TweenPicture | null;
  /** Weight of `b` over `a`, 0..1 (0 when `b` is null). */
  mix: number;
  /**
   * Law 2 with `options.blend`: the neighbouring plane to mix over the picture(s), i.e. `a` (and `b`) drawn with
   * `index[dim] = other` (or, for a stepping projection run, with that run end), at `weight` 0..1. Null when
   * planes step or the position is whole.
   */
  blend: { dim: string; other: number; weight: number; end?: "from" | "to" } | null;
  /** What the vector and label layers, the names and the furniture draw: ONE resolved view over the frame's crop. */
  overlay: TweenPicture;
  /** Law 3 for furniture: the opacity (0..1) of each piece that is fading in or out; absent = 1. */
  furnitureOpacity: Partial<Record<keyof ResolvedFurniture, number>>;
}

/** A tween between two ends, prepared once (both ends resolved and compared). */
export interface ViewTweenPlan {
  /** False when both ends draw the same pixels: the surface need not be redrawn per frame. */
  readonly pixels: boolean;
  /** False when the vector layers, the names and the furniture do not change. */
  readonly overlay: boolean;
  /** True when some frame needs two pictures (law 3). */
  readonly twoPictures: boolean;
  /** The start and the end, resolved (what `frame` returns at raw 0 and raw 1). */
  readonly start: TweenPicture;
  readonly end: TweenPicture;
  /** The frame at eased time `t` and linear progress `raw`. */
  frame(t: number, raw: number): ViewTweenFrame;
  /**
   * The distinct pictures (as `frame(...).a`, plus `b` and blend neighbours where they apply) the tween shows
   * while linear progress goes from `rawFrom` to `rawTo` (either direction), in order of first use, for decoding
   * ahead. `ease` maps raw to the eased time as the track's curve does. At most `limit` entries (default 64).
   */
  upcoming(rawFrom: number, rawTo: number, ease: (raw: number) => number, limit?: number): TweenPicture[];
}

/** One thing a Change does to an image, in words (the animator's chips, diagnostics, agents). */
export interface ViewChange {
  kind: "position" | "projection" | "window" | "colour" | "channel" | "frame" | "layer" | "furniture" | "other";
  /** The dimension walked (kind "position" / "projection"). */
  dim?: string;
  /** Plane indices at the start and the end (kind "position"). */
  from?: number;
  to?: number;
  /** A short phrase: "t 0 → 400", "channel 1 contrast", "zooms in", "footprints fade in". */
  label: string;
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers (shared by the resolved and the sparse form, so the two agree by construction)
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isHex = (v: unknown): v is string => typeof v === "string" && hexToRgb(v) !== null;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const STEP_EPS = 1e-9;
const EMPTY: Readonly<Partial<Record<keyof ResolvedFurniture, number>>> = Object.freeze({});

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a as Obj), kb = Object.keys(b as Obj);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual((a as Obj)[k], (b as Obj)[k])) return false;
  return true;
}

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (isObj(v)) { const o: Obj = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o as T; }
  return v;
}

function unionKeys(a: object, b: object): string[] {
  const out = Object.keys(a);
  for (const k of Object.keys(b)) if (!(k in a)) out.push(k);
  return out;
}

/** Whole planes taken of a walk of `n` at clamped time `c`. */
function stepOf(c: number, n: number): number {
  const s = Math.floor(c * n + STEP_EPS);
  return s < 0 ? 0 : s > n ? n : s;
}
/** Law 2: the plane shown by a walk from `a` to `b` at clamped time `c`. */
function walkAt(a: number, b: number, c: number): number {
  if (a === b) return a;
  return a + (b > a ? 1 : -1) * stepOf(c, Math.abs(b - a));
}

/** A display window: lerped (in log space when asked), ordered even when `t` overshoots. */
function lerpRange(a: readonly [number, number], b: readonly [number, number], t: number, log: boolean): [number, number] {
  const at = (u: number): [number, number] => log
    ? [Math.exp(lerp(Math.log(a[0]), Math.log(b[0]), u)), Math.exp(lerp(Math.log(a[1]), Math.log(b[1]), u))]
    : [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
  const r = at(t);
  return r[1] > r[0] ? r : at(clamp01(t));
}
const logWindow = (a: readonly number[], b: readonly number[]): boolean => a[0] > 0 && a[1] > 0 && b[0] > 0 && b[1] > 0;
/** A positive quantity (gamma, a size): lerped, the clamped time when an overshoot would reach zero. */
function lerpPos(a: number, b: number, t: number): number {
  const v = lerp(a, b, t);
  return v > 0 ? v : lerp(a, b, clamp01(t));
}
const lerpUnit = (a: number, b: number, t: number): number => clamp01(lerp(a, b, t));
const lerpNonNeg = (a: number, b: number, t: number): number => Math.max(0, lerp(a, b, t));
const validRange = (r: unknown): r is [number, number] => Array.isArray(r) && r.length === 2 && finite(r[0]) && finite(r[1]) && r[1] > r[0];

// ---------------------------------------------------------------------------------------------
// Parts: a channel, a layer, a furniture piece. A part that differs is a shallow copy of its start object with
// patches applied; `discrete` names the fields picture b takes from the end.
// ---------------------------------------------------------------------------------------------

/** (out, eased t, clamped t, raw) */
type Patch = (o: Obj, t: number, c: number, raw: number) => void;

interface PartPlan {
  a: Obj;
  b: Obj;
  same: boolean;
  patches: Patch[];
  discrete: string[];
}

const stepPatch = (k: string, bv: unknown): Patch => (o, _t, _c, raw) => { if (raw >= 0.5) o[k] = bv; };

function colorPatch(k: string, x: string, y: string): Patch {
  const f = prepareColorLerp(x, y);
  return (o, t) => { o[k] = f(t); };
}

function partFrame(p: PartPlan, t: number, c: number, raw: number): Obj {
  if (p.same) return p.a;
  const o: Obj = { ...p.a };
  for (let i = 0; i < p.patches.length; i++) p.patches[i](o, t, c, raw);
  return o;
}
function partB(p: PartPlan, oa: Obj): Obj {
  if (!p.discrete.length) return oa;
  const o: Obj = { ...oa };
  for (const k of p.discrete) o[k] = p.b[k];
  return o;
}

function planChannel(ca: ResolvedChannel, cb: ResolvedChannel, contributes: boolean): PartPlan {
  const A = ca as unknown as Obj, B = cb as unknown as Obj;
  const p: PartPlan = { a: A, b: B, same: deepEqual(A, B), patches: [], discrete: [] };
  if (p.same) return p;
  const ramp = isHex(ca.color) && isHex(cb.color) && !ca.lut && !cb.lut;
  for (const k of unionKeys(A, B)) {
    if (deepEqual(A[k], B[k])) continue;
    switch (k) {
      case "range": {
        const log = ca.norm === "log" && cb.norm === "log" && logWindow(ca.range, cb.range);
        p.patches.push((o, t) => { o.range = lerpRange(ca.range, cb.range, t, log); });
        break;
      }
      case "gamma": p.patches.push((o, t) => { o.gamma = lerpPos(ca.gamma, cb.gamma, t); }); break;
      case "color": case "lut":
        if (ramp) { if (k === "color") p.patches.push(colorPatch("color", ca.color!, cb.color!)); }
        else if (contributes) p.discrete.push(k);
        else p.patches.push(stepPatch(k, B[k]));
        break;
      case "visible": case "norm": case "invert":
        if (contributes) p.discrete.push(k); else p.patches.push(stepPatch(k, B[k]));
        break;
      default: p.patches.push(stepPatch(k, B[k]));
    }
  }
  return p;
}

function planLayer(la: ResolvedLayer, lb: ResolvedLayer): PartPlan {
  const A = la as unknown as Obj, B = lb as unknown as Obj;
  const p: PartPlan = { a: A, b: B, same: deepEqual(A, B), patches: [], discrete: [] };
  if (p.same) return p;
  const intensity = la.kind === "intensity";
  const fade = la.visible !== lb.visible;
  if (fade) {
    // Law 3: a layer switched on or off is a fade; it stays drawn while its opacity goes to / comes from 0.
    const oa = la.visible ? la.opacity : 0, ob = lb.visible ? lb.opacity : 0;
    p.patches.push((o, t) => { o.visible = true; o.opacity = lerpUnit(oa, ob, t); });
  }
  const ramp = isHex(la.color) && isHex(lb.color) && !la.lut && !lb.lut;
  for (const k of unionKeys(A, B)) {
    if (deepEqual(A[k], B[k])) continue;
    switch (k) {
      case "visible": break; // the fade above
      case "opacity": if (!fade) p.patches.push((o, t) => { o.opacity = lerpUnit(la.opacity, lb.opacity, t); }); break;
      case "strokeWidth": p.patches.push((o, t) => { o.strokeWidth = lerpNonNeg(la.strokeWidth, lb.strokeWidth, t); }); break;
      case "fillOpacity": p.patches.push((o, t) => { o.fillOpacity = lerpUnit(la.fillOpacity, lb.fillOpacity, t); }); break;
      case "range":
        if (validRange(la.range) && validRange(lb.range)) { const ra = la.range, rb = lb.range; p.patches.push((o, t) => { o.range = lerpRange(ra, rb, t, false); }); }
        else p.patches.push(stepPatch(k, B[k]));
        break;
      case "color": case "lut":
        if (intensity) {
          if (ramp) { if (k === "color") p.patches.push(colorPatch("color", la.color!, lb.color!)); }
          else if (la.visible || lb.visible) p.discrete.push(k); // a colour-map change of an intensity layer is pixels
          else p.patches.push(stepPatch(k, B[k]));
        } else if (k === "color" && isHex(la.color) && isHex(lb.color)) p.patches.push(colorPatch("color", la.color, lb.color));
        else p.patches.push(stepPatch(k, B[k])); // one end keeps the layer's own colours: steps
        break;
      default: p.patches.push(stepPatch(k, B[k])); // incl. fields this module does not know (carried, never dropped)
    }
  }
  return p;
}

/**
 * One layer's law on its own (picture a: a discrete pixel setting stays the start's): a switch is a fade,
 * opacity, stroke width, fill opacity and window lerp, colours lerp when both ends have one, and every other
 * field (including fields this module does not know, such as a later `styleBy`) is carried and steps at raw 0.5.
 * Exact ends. For hosts that tween layers they already hold resolved (the exported player's vector layers).
 */
export function lerpResolvedLayer(la: ResolvedLayer, lb: ResolvedLayer, t: number, raw: number): ResolvedLayer {
  if (!(raw > 0)) return la;
  if (raw >= 1) return lb;
  if (!Number.isFinite(t)) t = raw;
  return partFrame(planLayer(la, lb), t, clamp01(t), raw) as unknown as ResolvedLayer;
}

/** A furniture piece present at both ends: sizes and colours lerp, the rest steps at raw 0.5. */
function planPiece(fa: Obj, fb: Obj): PartPlan {
  const p: PartPlan = { a: fa, b: fb, same: false, patches: [], discrete: [] };
  for (const k of unionKeys(fa, fb)) {
    const x = fa[k], y = fb[k];
    if (deepEqual(x, y)) continue;
    if (finite(x) && finite(y)) p.patches.push((o, t) => { o[k] = lerpPos(x, y, t); });
    else if (k === "length" && (x === null || y === null)) p.patches.push((o) => { o[k] = null; }); // automatic: the drawer recomputes it
    else if (isHex(x) && isHex(y)) p.patches.push(colorPatch(k, x, y));
    else p.patches.push(stepPatch(k, y));
  }
  return p;
}

type PieceKey = keyof ResolvedFurniture;
interface PiecePlan { key: string; kind: "lerp" | "fade" | "step"; part?: PartPlan; piece?: Obj; fadesIn?: boolean; a?: unknown; b?: unknown }

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

interface Walk { dim: string; a: number; b: number; n: number; sign: 1 | -1 }

/** Prepare the tween between two ends of one image. */
export function planViewTween(manifest: FluximgManifest, pre: ViewEnd, end: ViewEnd, options?: TweenOptions): ViewTweenPlan {
  const A = resolveView(manifest, pre?.view), B = resolveView(manifest, end?.view);
  const cropA = clampCrop(manifest, pre?.crop), cropB = clampCrop(manifest, end?.crop);
  const start: TweenPicture = { view: A, crop: cropA }, finish: TweenPicture = { view: B, crop: cropB };
  const blendOn = options?.blend === true;

  // --- positions and the projection -----------------------------------------------------------
  const projSame = deepEqual(A.projection, B.projection);
  const pa = A.projection, pb = B.projection;
  const projWalk = !projSame && pa && pb && pa.dim === pb.dim && pa.mode === pb.mode;
  const projDiscrete = !projSame && !projWalk;
  const walks: Walk[] = [];
  for (const d of positionDims(manifest)) {
    const a = A.index[d] ?? 0, b = B.index[d] ?? 0;
    if (a !== b) walks.push({ dim: d, a, b, n: Math.abs(b - a), sign: b > a ? 1 : -1 });
  }
  // A dimension projected at both ends shows no plane: its index walk is invisible (no blend, no upcoming key).
  const hidden = (d: string): boolean => !!(pa && pb && pa.dim === d && pb.dim === d);
  const projRun = projWalk ? { dim: pa!.dim, mode: pa!.mode, fa: pa!.from, fb: pb!.from, ta: pa!.to, tb: pb!.to, len: dimLen(manifest, pa!.dim) } : null;

  // The neighbour a crossfade mixes in: the walk with the most planes.
  let blendSrc: { dim: string; a: number; b: number; n: number; end?: "from" | "to" } | null = null;
  if (blendOn) {
    for (const w of walks) if (!hidden(w.dim) && (!blendSrc || w.n > blendSrc.n)) blendSrc = { dim: w.dim, a: w.a, b: w.b, n: w.n };
    if (projRun) {
      const nf = Math.abs(projRun.fb - projRun.fa), nt = Math.abs(projRun.tb - projRun.ta);
      if (nf > 0 && (!blendSrc || nf > blendSrc.n)) blendSrc = { dim: projRun.dim, a: projRun.fa, b: projRun.fb, n: nf, end: "from" };
      if (nt > 0 && (!blendSrc || nt > blendSrc.n)) blendSrc = { dim: projRun.dim, a: projRun.ta, b: projRun.tb, n: nt, end: "to" };
    }
  }

  // --- channels, composite --------------------------------------------------------------------
  const contribA = contributingChannelIndices(A), contribB = contributingChannelIndices(B);
  const contributing = new Set([...contribA, ...contribB]);
  const chPlans = A.channels.map((c, i) => planChannel(c, B.channels[i], contributing.has(i)));
  const channelsSame = chPlans.every((p) => p.same);
  const channelsDiscrete = chPlans.some((p) => p.discrete.length > 0);
  const compositeDiffers = A.composite !== B.composite || A.solo !== B.solo;
  const compositeDiscrete = compositeDiffers && !deepEqual(contribA, contribB);

  // --- background -------------------------------------------------------------------------------
  const bgDiffers = A.background !== B.background;
  const bgLerp = bgDiffers && isHex(A.background) && isHex(B.background) ? prepareColorLerp(A.background, B.background) : null;
  const bgDiscrete = bgDiffers && !bgLerp;

  // --- layers -----------------------------------------------------------------------------------
  const layerIdsA = A.layers.map((l) => l.id), layerIdsB = B.layers.map((l) => l.id);
  const bById = new Map(B.layers.map((l) => [l.id, l]));
  const lyPlans = A.layers.map((l) => planLayer(l, bById.get(l.id) ?? l));
  const orderSame = deepEqual(layerIdsA, layerIdsB);
  const orderB = layerIdsB.map((id) => layerIdsA.indexOf(id));
  const layersSame = orderSame && lyPlans.every((p) => p.same);
  const layersDiscrete = lyPlans.some((p) => p.discrete.length > 0);

  // --- furniture --------------------------------------------------------------------------------
  const FA = A.furniture as unknown as Obj, FB = B.furniture as unknown as Obj;
  const pieces: PiecePlan[] = [];
  for (const k of unionKeys(FA, FB)) {
    const x = FA[k], y = FB[k];
    if (deepEqual(x, y)) continue;
    if (isObj(x) && isObj(y)) pieces.push({ key: k, kind: "lerp", part: planPiece(x, y) });
    else if (isObj(x) || isObj(y)) pieces.push({ key: k, kind: "fade", piece: (isObj(x) ? x : y) as Obj, fadesIn: !isObj(x) });
    else pieces.push({ key: k, kind: "step", a: x, b: y }); // neither end a piece (a field this module does not know)
  }
  const anyFade = pieces.some((p) => p.kind === "fade");

  // --- everything else at the top level steps at raw 0.5 ---------------------------------------
  const HANDLED = new Set(["index", "projection", "channels", "composite", "solo", "background", "layers", "furniture"]);
  const topSteps: string[] = [];
  for (const k of unionKeys(A, B)) if (!HANDLED.has(k) && !deepEqual((A as unknown as Obj)[k], (B as unknown as Obj)[k])) topSteps.push(k);
  if (compositeDiffers && !compositeDiscrete) topSteps.push("composite", "solo");

  // --- crop -------------------------------------------------------------------------------------
  const cropSame = cropA.x === cropB.x && cropA.y === cropB.y && cropA.width === cropB.width && cropA.height === cropB.height;

  // --- what changes -----------------------------------------------------------------------------
  const twoPictures = projDiscrete || channelsDiscrete || compositeDiscrete || bgDiscrete || layersDiscrete;
  const pixels = pixelKey(manifest, A, cropA, 1024, 1024) !== pixelKey(manifest, B, cropB, 1024, 1024) || A.smooth !== B.smooth;
  const overlay = overlayChanges(A, B, lyPlans, orderSame, cropSame, compositeDiffers, chPlans);

  // --- frames -----------------------------------------------------------------------------------
  const startFrame: ViewTweenFrame = { a: start, b: null, mix: 0, blend: null, overlay: start, furnitureOpacity: EMPTY };
  const endFrame: ViewTweenFrame = { a: finish, b: null, mix: 0, blend: null, overlay: finish, furnitureOpacity: EMPTY };
  const AO = A as unknown as Obj, BO = B as unknown as Obj;

  function projectionAt(c: number): FluximgProjection | null {
    if (!projRun) return pa;
    const from = walkAt(projRun.fa, projRun.fb, c);
    let to = walkAt(projRun.ta, projRun.tb, c);
    if (to <= from) to = Math.min(projRun.len, from + 1); // defensive: whole-plane walks of ordered ends never cross
    return { dim: projRun.dim, mode: projRun.mode, from, to };
  }

  function frame(t: number, raw: number): ViewTweenFrame {
    if (!(raw > 0)) return startFrame;
    if (raw >= 1) return endFrame;
    if (!Number.isFinite(t)) t = raw;
    const c = clamp01(t);

    let index = A.index;
    if (walks.length) {
      index = { ...A.index };
      for (let i = 0; i < walks.length; i++) { const w = walks[i]; index[w.dim] = w.a + w.sign * stepOf(c, w.n); }
    }

    let chA = A.channels as unknown as Obj[], chB = chA;
    if (!channelsSame) {
      chA = new Array(chPlans.length);
      chB = channelsDiscrete ? new Array(chPlans.length) : chA;
      for (let i = 0; i < chPlans.length; i++) {
        const o = partFrame(chPlans[i], t, c, raw);
        chA[i] = o;
        if (chB !== chA) chB[i] = partB(chPlans[i], o);
      }
    }

    let lyA = A.layers as unknown as Obj[], lyB = lyA;
    if (!layersSame) {
      const fa: Obj[] = new Array(lyPlans.length);
      const fb: Obj[] | null = layersDiscrete ? new Array(lyPlans.length) : null;
      for (let i = 0; i < lyPlans.length; i++) {
        const o = partFrame(lyPlans[i], t, c, raw);
        fa[i] = o;
        if (fb) fb[i] = partB(lyPlans[i], o);
      }
      if (orderSame || raw < 0.5) { lyA = fa; lyB = fb ?? fa; }
      else { lyA = orderB.map((i) => fa[i]); lyB = fb ? orderB.map((i) => fb[i]) : lyA; }
    }

    let furniture = A.furniture as unknown as Obj;
    let furnitureOpacity: Partial<Record<PieceKey, number>> = EMPTY;
    if (pieces.length) {
      furniture = { ...FA };
      if (anyFade) furnitureOpacity = {};
      for (const p of pieces) {
        if (p.kind === "fade") {
          furniture[p.key] = p.piece;
          (furnitureOpacity as Obj)[p.key] = p.fadesIn ? c : 1 - c;
        } else if (p.kind === "step") furniture[p.key] = raw < 0.5 ? p.a : p.b;
        else furniture[p.key] = partFrame(p.part!, t, c, raw);
      }
    }

    const va: Obj = { ...AO };
    for (const k of topSteps) if (raw >= 0.5) va[k] = BO[k];
    va.index = index;
    va.projection = projectionAt(c);
    va.channels = chA;
    va.layers = lyA;
    va.furniture = furniture;
    if (bgLerp) va.background = bgLerp(t);

    let crop: PixelRect = cropA;
    if (!cropSame) {
      crop = clampCrop(manifest, {
        x: lerp(cropA.x, cropB.x, t), y: lerp(cropA.y, cropB.y, t),
        width: lerp(cropA.width, cropB.width, t), height: lerp(cropA.height, cropB.height, t),
      });
      // An overshoot can shrink the frame to nothing: then the clamped time's frame (always inside).
      if (!(crop.width > 0 && crop.height > 0)) crop = clampCrop(manifest, { x: lerp(cropA.x, cropB.x, c), y: lerp(cropA.y, cropB.y, c), width: lerp(cropA.width, cropB.width, c), height: lerp(cropA.height, cropB.height, c) });
    }

    const a: TweenPicture = { view: va as unknown as ResolvedView, crop };
    let b: TweenPicture | null = null;
    if (twoPictures) {
      const vb: Obj = { ...va, channels: chB, layers: lyB };
      if (projDiscrete) vb.projection = pb;
      if (compositeDiscrete) { vb.composite = B.composite; vb.solo = B.solo; }
      if (bgDiscrete) vb.background = B.background;
      b = { view: vb as unknown as ResolvedView, crop };
    }

    let blend: ViewTweenFrame["blend"] = null;
    if (blendSrc) {
      const s = c * blendSrc.n, st = stepOf(c, blendSrc.n), w = s - st;
      if (st < blendSrc.n && w > STEP_EPS) {
        const sign = blendSrc.b > blendSrc.a ? 1 : -1;
        blend = { dim: blendSrc.dim, other: blendSrc.a + sign * (st + 1), weight: Math.min(1, w) };
        if (blendSrc.end) blend.end = blendSrc.end;
      }
    }

    return { a, b, mix: b ? c : 0, blend, overlay: b && raw >= 0.5 ? b : a, furnitureOpacity };
  }

  // --- upcoming ---------------------------------------------------------------------------------
  // The key of a picture: which end's discrete settings it has, and every position that can change its pixels.
  const keyWalks = walks.filter((w) => !hidden(w.dim));
  const totalSteps = keyWalks.reduce((s, w) => s + w.n, 0) + (projRun ? Math.abs(projRun.fb - projRun.fa) + Math.abs(projRun.tb - projRun.ta) : 0);
  function keyAt(c: number, side: string, override?: { dim: string; other: number; end?: string }): string {
    let k = side;
    for (const w of keyWalks) k += `|${override && !override.end && override.dim === w.dim ? override.other : walkAt(w.a, w.b, c)}`;
    if (projRun) {
      const p = projectionAt(c)!;
      k += `|${override?.end === "from" ? override.other : p.from}:${override?.end === "to" ? override.other : p.to}`;
    }
    return k;
  }
  function blendPicture(p: TweenPicture, bl: NonNullable<ViewTweenFrame["blend"]>): TweenPicture {
    const v = p.view;
    if (bl.end) return { view: { ...v, projection: { ...v.projection!, [bl.end]: bl.other } }, crop: p.crop };
    return { view: { ...v, index: { ...v.index, [bl.dim]: bl.other } }, crop: p.crop };
  }

  function upcoming(rawFrom: number, rawTo: number, ease: (raw: number) => number, limit = 64): TweenPicture[] {
    const out: TweenPicture[] = [];
    if (!(limit > 0)) return out;
    const r0 = clamp01(Number.isFinite(rawFrom) ? rawFrom : 0), r1 = clamp01(Number.isFinite(rawTo) ? rawTo : 0);
    const seen = new Set<string>();
    // Enough samples that every plane of a walk is visited under any reasonable curve (8 per plane of linear time).
    const n = Math.min(20000, Math.max(1, Math.ceil((8 * totalSteps + 16) * Math.abs(r1 - r0))));
    const endSide = twoPictures ? "b" : "a";
    for (let i = 0; i <= n; i++) {
      const raw = i === n ? r1 : r0 + ((r1 - r0) * i) / n;
      let t = ease(raw);
      if (!Number.isFinite(t)) t = raw;
      const c = clamp01(t);
      let keys: string[];
      if (raw <= 0) keys = [keyAt(0, "a")];
      else if (raw >= 1) keys = [keyAt(1, endSide)];
      else keys = twoPictures ? [keyAt(c, "a"), keyAt(c, "b")] : [keyAt(c, "a")];
      let fresh = keys.some((k) => !seen.has(k));
      let f: ViewTweenFrame | null = null;
      if (blendSrc && raw > 0 && raw < 1) {
        f = frame(t, raw);
        if (f.blend) {
          const bl = f.blend;
          keys.push(keyAt(c, "a", bl));
          if (twoPictures) keys.push(keyAt(c, "b", bl));
          fresh = fresh || keys.some((k) => !seen.has(k));
        }
      }
      if (!fresh) continue;
      f ??= frame(t, raw);
      const pics: TweenPicture[] = raw <= 0 || raw >= 1 ? [f.a] : f.b ? [f.a, f.b] : [f.a];
      if (f.blend) { pics.push(blendPicture(f.a, f.blend)); if (f.b) pics.push(blendPicture(f.b, f.blend)); }
      for (let j = 0; j < keys.length && j < pics.length; j++) {
        if (seen.has(keys[j])) continue;
        seen.add(keys[j]);
        out.push(pics[j]);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  return { pixels, overlay, twoPictures, start, end: finish, frame, upcoming };
}

const dimLen = (m: FluximgManifest, dim: string): number => { const i = m.pixels.dims.indexOf(dim); return i >= 0 ? m.pixels.shape[i] : 0; };

/**
 * Whether the vector and label layers, the names or the furniture draw anything different. Conservative where it
 * cannot know (a field it does not know differs); exact for the common cases (a pure contrast change with no colour
 * bar is false).
 */
function overlayChanges(A: ResolvedView, B: ResolvedView, lyPlans: PartPlan[], orderSame: boolean, cropSame: boolean, compositeDiffers: boolean, chPlans: PartPlan[]): boolean {
  const KNOWN = new Set(["index", "projection", "channels", "composite", "solo", "smooth", "background", "layers", "furniture", "insetOf", "link"]);
  for (const k of unionKeys(A, B)) if (!KNOWN.has(k) && !deepEqual((A as unknown as Obj)[k], (B as unknown as Obj)[k])) return true;
  if (!deepEqual(A.furniture, B.furniture)) return true;
  const objects = lyPlans.filter((p) => (p.a as unknown as ResolvedLayer).kind !== "intensity");
  const shown = objects.filter((p) => (p.a as unknown as ResolvedLayer).visible || (p.b as unknown as ResolvedLayer).visible);
  if (shown.some((p) => !p.same)) return true;
  if (!orderSame) {
    const ids = new Set(shown.map((p) => (p.a as unknown as ResolvedLayer).id));
    const oa = A.layers.filter((l) => ids.has(l.id)).map((l) => l.id), ob = B.layers.filter((l) => ids.has(l.id)).map((l) => l.id);
    if (!deepEqual(oa, ob)) return true;
  }
  const on = (k: PieceKey): boolean => !!A.furniture[k] || !!B.furniture[k];
  if (!cropSame && (shown.length > 0 || on("scalebar") || on("names"))) return true;
  if (on("stamp") && (!deepEqual(A.index, B.index) || !deepEqual(A.projection, B.projection))) return true;
  const chDiff = (keys: string[]): boolean => chPlans.some((p) => keys.some((k) => !deepEqual(p.a[k], p.b[k])));
  if (on("channelLabels") && (compositeDiffers || chDiff(["visible", "color", "lut", "name"]))) return true;
  if (on("colorbar") && (compositeDiffers || chPlans.some((p) => !p.same))) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// The sparse recipe form
// ---------------------------------------------------------------------------------------------

const stepV = (x: unknown, y: unknown, raw: number): unknown => clone(raw < 0.5 ? x : y);

function lerpRecipeIndex(x: Obj, y: Obj, c: number, raw: number): Obj {
  const o: Obj = {};
  for (const d of unionKeys(x, y)) {
    const a = x[d], b = y[d];
    const v = finite(a) && finite(b) ? walkAt(Math.round(a), Math.round(b), c) : stepV(a, b, raw);
    if (v !== undefined) o[d] = v;
  }
  return o;
}

function lerpRecipeProjection(x: unknown, y: unknown, c: number, raw: number): unknown {
  if (!isObj(x) || !isObj(y) || x.dim !== y.dim || x.mode !== y.mode || !finite(x.from) || !finite(x.to) || !finite(y.from) || !finite(y.to)) return stepV(x, y, raw);
  const from = walkAt(Math.round(x.from), Math.round(y.from), c);
  let to = walkAt(Math.round(x.to), Math.round(y.to), c);
  if (to <= from) to = from + 1;
  return { ...clone(x), from, to };
}

/** Fields of a sparse part: `lerpers` say how a known field present at both ends moves; the rest steps. */
function lerpRecipePart(x: Obj, y: Obj, t: number, raw: number, lerpers: Record<string, (a: unknown, b: unknown, t: number) => unknown>): Obj {
  const o: Obj = {};
  for (const k of unionKeys(x, y)) {
    const a = x[k], b = y[k];
    let v: unknown;
    if (deepEqual(a, b)) v = clone(a);
    else {
      const f = lerpers[k];
      v = f ? f(a, b, t) : undefined;
      if (v === undefined) v = stepV(a, b, raw);
    }
    if (v !== undefined) o[k] = v;
  }
  return o;
}

const colourL = (a: unknown, b: unknown, t: number): unknown => (isHex(a) && isHex(b) ? prepareColorLerp(a, b)(t) : undefined);
const unitL = (a: unknown, b: unknown, t: number): unknown => (finite(a) && finite(b) ? lerpUnit(a, b, t) : undefined);
const posL = (a: unknown, b: unknown, t: number): unknown => (finite(a) && finite(b) && a > 0 && b > 0 ? lerpPos(a, b, t) : undefined);
const nonNegL = (a: unknown, b: unknown, t: number): unknown => (finite(a) && finite(b) ? lerpNonNeg(a, b, t) : undefined);
const rangeL = (log: boolean) => (a: unknown, b: unknown, t: number): unknown => (validRange(a) && validRange(b) ? lerpRange(a, b, t, log && logWindow(a, b)) : undefined);

const LAYER_L = { opacity: unitL, fillOpacity: unitL, strokeWidth: nonNegL, color: colourL, range: rangeL(false) };
const PIECE_L = { length: posL, thickness: posL, fontSize: posL, color: colourL };

/**
 * The same tween as a sparse RECIPE, for callers that hold no manifest (`slide/tween.lerpElement`, and through it
 * `compile.sample`). Numbers present at both ends lerp, plane positions present at both ends step by law 2,
 * colours present at both ends lerp, everything else steps at `raw` 0.5. Exact ends (law 4). Returns undefined
 * for "no view" (the default view).
 *
 * Exact: the numbers that lerp are a channel's window (in log space when both ends say `norm: "log"`) and gamma,
 * a layer's opacity, fill opacity, stroke width and window, a furniture piece's sizes and scale-bar length, with
 * the same bounds as `planViewTween`; `solo` and fields this module does not know step. Where both forms define
 * a field they agree (verify-fluximg-view-tween pins it).
 */
export function lerpFluximgView(a: FluximgView | null | undefined, b: FluximgView | null | undefined, t: number, raw: number): FluximgView | undefined {
  const A = isObj(a) ? (a as Obj) : undefined, B = isObj(b) ? (b as Obj) : undefined;
  if (!(raw > 0)) return A ? (clone(A) as FluximgView) : undefined;
  if (raw >= 1) return B ? (clone(B) as FluximgView) : undefined;
  if (!A && !B) return undefined;
  if (!Number.isFinite(t)) t = raw;
  const c = clamp01(t);
  const x = A ?? {}, y = B ?? {};
  const out: Obj = {};
  for (const k of unionKeys(x, y)) {
    const va = x[k], vb = y[k];
    let v: unknown;
    if (deepEqual(va, vb)) v = clone(va);
    else switch (k) {
      case "index": v = isObj(va) && isObj(vb) ? lerpRecipeIndex(va, vb, c, raw) : stepV(va, vb, raw); break;
      case "projection": v = lerpRecipeProjection(va, vb, c, raw); break;
      case "channels": {
        if (!Array.isArray(va) || !Array.isArray(vb)) { v = stepV(va, vb, raw); break; }
        const n = Math.max(va.length, vb.length), arr: unknown[] = [];
        for (let i = 0; i < n; i++) {
          const ca = va[i], cb = vb[i];
          if (isObj(ca) && isObj(cb)) {
            const log = ca.norm === "log" && cb.norm === "log";
            arr.push(lerpRecipePart(ca, cb, t, raw, { range: rangeL(log), gamma: posL, color: colourL }));
          } else arr.push(stepV(ca ?? null, cb ?? null, raw));
        }
        v = arr;
        break;
      }
      case "layers": case "furniture": {
        if (!isObj(va) || !isObj(vb)) { v = stepV(va, vb, raw); break; }
        const o: Obj = {};
        for (const id of unionKeys(va, vb)) {
          const p = va[id], q = vb[id];
          const r = isObj(p) && isObj(q) ? lerpRecipePart(p, q, t, raw, k === "layers" ? LAYER_L : PIECE_L) : stepV(p, q, raw);
          if (r !== undefined) o[id] = r;
        }
        v = o;
        break;
      }
      case "background": v = isHex(va) && isHex(vb) ? prepareColorLerp(va, vb)(t) : stepV(va, vb, raw); break;
      default: v = stepV(va, vb, raw);
    }
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? (out as FluximgView) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const PIECE_WORDS: Record<string, string> = { scalebar: "scale bar", stamp: "stamp", channelLabels: "channel names", names: "object names", colorbar: "colour bar" };
const KIND_RANK: Record<ViewChange["kind"], number> = { position: 0, projection: 1, frame: 2, channel: 3, window: 4, colour: 5, layer: 6, furniture: 7, other: 8 };

/** A view either resolved or sparse, in one shape for comparing. */
interface Cmp {
  index: Obj;
  projection: unknown;
  channels: unknown[];
  composite: unknown; solo: unknown; background: unknown; smooth: unknown; insetOf: unknown; link: unknown;
  layers: Record<string, Obj>;
  order: unknown;
  furniture: Obj;
  rest: Obj;
}

function cmpOf(v: Obj, resolved: boolean): Cmp {
  const layers: Record<string, Obj> = {};
  if (resolved) for (const l of v.layers as ResolvedLayer[]) layers[l.id] = l as unknown as Obj;
  else if (isObj(v.layers)) for (const [id, l] of Object.entries(v.layers)) if (isObj(l)) layers[id] = l;
  const fur: Obj = {};
  if (isObj(v.furniture)) for (const [k, p] of Object.entries(v.furniture)) if (isObj(p)) fur[k] = p;
  const rest: Obj = {};
  const KNOWN = new Set(["index", "projection", "channels", "composite", "solo", "background", "smooth", "insetOf", "link", "layers", "layerOrder", "furniture"]);
  for (const k of Object.keys(v)) if (!KNOWN.has(k)) rest[k] = v[k];
  return {
    index: isObj(v.index) ? v.index : {},
    projection: isObj(v.projection) ? v.projection : null,
    channels: Array.isArray(v.channels) ? v.channels : [],
    composite: v.composite, solo: v.solo, background: v.background, smooth: v.smooth, insetOf: v.insetOf ?? null, link: v.link ?? null,
    layers,
    order: resolved ? (v.layers as ResolvedLayer[]).map((l) => l.id) : v.layerOrder,
    furniture: fur,
    rest,
  };
}

/** What a Change does to an image, as a short list of phrases, most telling first. Empty when nothing changes. */
export function describeViewChange(manifest: FluximgManifest | undefined, pre: ViewEnd, end: ViewEnd): ViewChange[] {
  const m = manifest;
  const sparse = (v: unknown): Obj => (isObj(v) ? v : {});
  const va = (m ? resolveView(m, pre?.view) : sparse(pre?.view)) as unknown as Obj;
  const vb = (m ? resolveView(m, end?.view) : sparse(end?.view)) as unknown as Obj;
  const A = cmpOf(va, !!m), B = cmpOf(vb, !!m);
  const out: ViewChange[] = [];
  const add = (c: ViewChange): void => { out.push(c); };

  // Positions.
  const plane = (d: string, i: number): string => {
    if (!m) return String(i + 1);
    const axis = m.axes?.[d];
    // The stamp's words for a physical or named position; a bare count reads as a 1-based plane number.
    if (axis && (axis.labels || axis.coords || (typeof axis.scale === "number" && (axis.unit || axis.scale !== 1 || axis.offset)))) return positionText(axis, i, dimLen(m, d));
    return String(i + 1);
  };
  const dims = m ? positionDims(m) : unionKeys(A.index, B.index);
  for (const d of dims) {
    const a = A.index[d], b = B.index[d];
    if (deepEqual(a, b)) continue;
    if (finite(a) && finite(b)) add({ kind: "position", dim: d, from: a, to: b, label: `${d} ${plane(d, a)} → ${plane(d, b)}` });
    else add({ kind: "position", dim: d, ...(finite(b) ? { to: b } : {}), ...(finite(a) ? { from: a } : {}), label: finite(b) ? `${d} → ${plane(d, b)}` : `${d} as placed` });
  }

  // Projection.
  if (!deepEqual(A.projection, B.projection)) {
    const p = A.projection as FluximgProjection | null, q = B.projection as FluximgProjection | null;
    const run = (r: FluximgProjection): string => (r.to - r.from <= 1 ? `${r.from + 1}` : `${r.from + 1}–${r.to}`);
    if (p && q && p.dim === q.dim && p.mode === q.mode) add({ kind: "projection", dim: q.dim, label: `${q.mode} ${q.dim} ${run(p)} → ${run(q)}` });
    else if (q && !p) add({ kind: "projection", dim: q.dim, label: `${q.mode} ${q.dim} on` });
    else if (p && !q) add({ kind: "projection", dim: p.dim, label: `${p.mode} ${p.dim} off` });
    else add({ kind: "projection", dim: q!.dim, label: `${p!.mode} ${p!.dim} → ${q!.mode} ${q!.dim}` });
  }

  // The frame.
  const ca: PixelRect | null = m ? clampCrop(m, pre?.crop) : pre?.crop ?? null;
  const cb: PixelRect | null = m ? clampCrop(m, end?.crop) : end?.crop ?? null;
  if (!deepEqual(ca, cb)) {
    let label = "pans";
    if (!ca) label = "zooms in";
    else if (!cb) label = "zooms out";
    else {
      const r = (cb.width * cb.height) / (ca.width * ca.height);
      if (r < 0.99) label = "zooms in"; else if (r > 1.01) label = "zooms out";
    }
    add({ kind: "frame", label });
  }

  // Channels.
  const chName = (i: number): string => m?.channels[i]?.name ?? `channel ${i + 1}`;
  if (A.composite !== B.composite || (A.solo !== B.solo && (A.composite === "single" || B.composite === "single"))) {
    add({ kind: "channel", label: B.composite === "single" ? `only ${chName(finite(B.solo) ? B.solo : 0)}` : "all channels" });
  }
  const nCh = Math.max(A.channels.length, B.channels.length);
  const win: ViewChange[] = [], col: ViewChange[] = [];
  for (let i = 0; i < nCh; i++) {
    const x = (isObj(A.channels[i]) ? A.channels[i] : {}) as Obj, y = (isObj(B.channels[i]) ? B.channels[i] : {}) as Obj;
    if (!deepEqual(x.visible, y.visible)) add({ kind: "channel", label: `${chName(i)} ${y.visible === false ? "off" : y.visible === true ? "on" : "as placed"}` });
    if (["range", "norm", "gamma"].some((k) => !deepEqual(x[k], y[k]))) win.push({ kind: "window", label: `${chName(i)} contrast` });
    if (["color", "lut", "invert"].some((k) => !deepEqual(x[k], y[k]))) col.push({ kind: "colour", label: `${chName(i)} colour` });
  }
  out.push(...win, ...col);
  if (!deepEqual(A.background, B.background)) add({ kind: "colour", label: "background" });

  // Layers.
  for (const id of unionKeys(A.layers, B.layers)) {
    const x = A.layers[id] ?? {}, y = B.layers[id] ?? {};
    if (deepEqual(x, y)) continue;
    const name = (typeof y.name === "string" && y.name) || (typeof x.name === "string" && x.name) || m?.layers.find((l) => l.id === id)?.name || id;
    const others = unionKeys(x, y).filter((k) => k !== "visible" && !deepEqual(x[k], y[k]));
    if (!deepEqual(x.visible, y.visible)) add({ kind: "layer", label: `${name} ${y.visible === true ? "fade in" : y.visible === false ? "fade out" : "as placed"}` });
    if (others.length) add({ kind: "layer", label: others.length === 1 && others[0] === "opacity" ? `${name} opacity` : `${name} style` });
  }

  // Furniture.
  for (const k of unionKeys(A.furniture, B.furniture)) {
    const x = A.furniture[k], y = B.furniture[k];
    if (deepEqual(x, y)) continue;
    const word = PIECE_WORDS[k] ?? k;
    add({ kind: "furniture", label: !x ? `${word} on` : !y ? `${word} off` : `${word} changes` });
  }

  // The rest.
  if (!deepEqual(A.smooth, B.smooth)) add({ kind: "other", label: B.smooth === true ? "smoothing on" : "smoothing off" });
  if (!deepEqual(A.order, B.order)) add({ kind: "other", label: "layer order" });
  if (!deepEqual(A.insetOf, B.insetOf)) add({ kind: "other", label: "inset" });
  if (!deepEqual(A.link, B.link)) add({ kind: "other", label: "link" });
  for (const k of unionKeys(A.rest, B.rest)) if (!deepEqual(A.rest[k], B.rest[k])) add({ kind: "other", label: k });

  // Stable sort by kind: most telling first, the order within a kind as found.
  return out.map((c, i) => ({ c, i })).sort((p, q) => KIND_RANK[p.c.kind] - KIND_RANK[q.c.kind] || p.i - q.i).map((x) => x.c);
}

/**
 * How long a walk from plane `from` to plane `to` along `dim` takes at the data's own pace, in milliseconds:
 * real time for a time axis (its frame period), 12 planes a second otherwise; divided by `speed`.
 */
export function naturalDurationMs(manifest: FluximgManifest, dim: string, from: number, to: number, speed = 1): number {
  const planes = Math.abs(to - from);
  return (planes / naturalRate(manifest, dim)) * 1000 / (speed > 0 && Number.isFinite(speed) ? speed : 1);
}
