/**
 * N-dimensional images (fluximg) on a slide: one binding per placement, one controller per slide (stage 2, D3-D5;
 * the model3d split, `player/model3d.ts`). No decoder, no WebGL and no animation clock here: a Change's driver only
 * SETS the sampled frame on the binding (`setSlideFluximgFrame`), and `paint()` flushes every binding once per frame
 * behind a render key that ignores box-only props (a pure move, turn or fade draws nothing).
 *
 * A binding's root holds, bottom to top: the STILL (the cached picture of the state it rests in; the stage-1
 * placeholder until one lands), the live canvas (0x0 and hidden until its first complete frame, then it stays; no
 * loop at rest) and the vector overlay (layers, object names, furniture) built by the same functions the element at
 * rest uses and UPDATED per frame (attributes), never rebuilt per frame. Without a host (filmstrip thumbnails, static
 * documents, the exported deck for now) an image is its still and never allocates GPU (D5).
 */
import type { FluximgElement } from "../../types";
import type { FluximgManifest, FluximgLayer } from "../../fluximg/types";
import type { FluximgMovieClock, FluximgSurface, FluximgSurfaceMotion } from "../../fluximg/slideHost";
import type { PixelRect, ResolvedFurniture, ResolvedLayer } from "../../fluximg/view";
import { planViewTween, withIndex, type TweenPicture, type ViewTweenFrame, type ViewTweenPlan } from "../../fluximg/viewTween";
import { pixelKey, resolveView } from "../../fluximg/viewOps";
// crop.ts, never still.ts: the exported deck's runtime loads this module, and still.ts pulls the reader and renderer.
import { clampCrop, tieredStillSize, zoomedStillScale } from "../../fluximg/crop";
import { cropTransform, FURNITURE_FONT, FURNITURE_WEIGHT, imageStrokeWidth, layerMarkup, namePlacements, namesFontPx, objectIndex, preciseNum, sanitizeLayerSvg, svgNum, type LayerObject } from "../../fluximg/layers";
import { furnitureSvg, stampLines } from "../../fluximg/furniture";
import { fluximgIdPrefix, insetRect, layerStyles, layerSvgPath, layerTablePath, PLACEHOLDER_FILL, stylesToDraw, unflipTransform, wantsTable } from "../../fluximg/static";
import { columnKind, DEFAULT_STYLE_LUT, missingStyle, objectStyleTween, shownObjects, styleTweenAt, type ObjectLegend, type ObjectPaint, type ObjectStyle, type ObjectStyles, type ObjectStyleTween } from "../../fluximg/objectStyle";
import { fluximgPartNode } from "../../fluximg/parts";
import { presetParam } from "../presetCatalog";
import { isHandoff } from "../targets";
import { transformEndState, transformPreState } from "../tween";
import type { CompiledSlide } from "../compile";
import type { SlideRenderCtx } from "./render";
import { rectInViewport } from "./model3d";

const SVG = "http://www.w3.org/2000/svg";
/** Still pixels per stage pixel: the editor's own resting density (FluximgElement BASE_SCALE), so a slide at rest
 *  finds the still the canvas already drew. */
const STILL_SCALE = 2;
/** Backing pixels a live canvas may hold where a camera zoom asks for more than the unzoomed size (review B4): a 4K
 *  screen's worth. The unzoomed size keeps its old bound (4096 px a side). */
const LIVE_MAX_PIXELS = 8_388_608;
/** How often (ms) a playing Change asks the host to decode ahead along its path. */
const AHEAD_EVERY_MS = 120;
const AHEAD_PICTURES = 12;

const bindings = new WeakMap<HTMLElement, SlideFluximgBinding>();
/** Counters for the dev handle and the GUI gate's measurements (a few increments per drawn frame; nothing else reads them).
 *  `mark` / `firstAfterMark`: a gate sets `mark` (performance.now()) and `firstAfterMark = -1` before Play, and reads how long
 *  the first frame with new pixels took. */
export const slideFluximgStats = { asked: 0, late: 0, pending: 0, mark: 0, firstAfterMark: -1 };
const pendingBindings = new Set<object>();
function setPending(b: object, on: boolean): void {
  if (on) pendingBindings.add(b); else pendingBindings.delete(b);
  slideFluximgStats.pending = pendingBindings.size;
}
/** Bumped whenever a binding is made or dropped: a controller re-lists its bindings only then, not every frame. */
let bindingGeneration = 0;
let mountSerial = 0;
const nodes = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-slide-fluximg-root]")];

function liveVisible(node: HTMLElement): boolean {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hidden || current.style.display === "none" || current.style.visibility === "hidden" || current.style.opacity === "0" || current.getAttribute("visibility") === "hidden" || current.getAttribute("display") === "none" || current.getAttribute("opacity") === "0") return false;
  }
  return true;
}
function svgLayer(): SVGSVGElement {
  const layer = document.createElementNS(SVG, "svg");
  layer.setAttribute("width", "100%"); layer.setAttribute("height", "100%"); layer.setAttribute("preserveAspectRatio", "none");
  layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;display:block";
  return layer;
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
function idle(job: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void) => number };
  if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(job); else setTimeout(job, 0);
}

// ---------------------------------------------------------------------------------------------
// The plan of a Change, shared by its driver and the slide's controller
// ---------------------------------------------------------------------------------------------

const plans = new WeakMap<FluximgManifest, Map<string, ViewTweenPlan>>();
/** The tween between two states of one image, prepared once per (manifest, ends, options). */
export function fluximgPlan(manifest: FluximgManifest, pre: FluximgElement, end: FluximgElement, blend: boolean): ViewTweenPlan {
  let byEnds = plans.get(manifest);
  if (!byEnds) plans.set(manifest, byEnds = new Map());
  const key = JSON.stringify([pre.view ?? null, pre.crop ?? null, end.view ?? null, end.crop ?? null, blend]);
  let plan = byEnds.get(key);
  if (!plan) {
    plan = planViewTween(manifest, { view: pre.view, crop: pre.crop }, { view: end.view, crop: end.crop }, { blend });
    byEnds.set(key, plan);
    if (byEnds.size > 64) byEnds.delete(byEnds.keys().next().value as string);
  }
  return plan;
}

/** The same frame at another plane: `viewTween.withIndex` is the one definition (kept under this name for the hook's callers). */
export const withIndexLocal = withIndex;

const manifestOf = (ctx: SlideRenderCtx, assetId: string): FluximgManifest | undefined => ctx.fluximg?.manifest(assetId) ?? ctx.fluximgManifest?.(assetId);

/** What a Change's driver (transform.ts, mode "fluximg-live") needs: the frame at (u, raw), and a readiness hook while
 *  the manifest is still loading (play waits for it). */
export interface FluximgTween {
  frame(u: number, raw: number): ViewTweenFrame | null;
  motion(raw: number): FluximgMotion | undefined;
  ready?: { isReady(): boolean; ready(): Promise<void> };
}
export function fluximgTween(pre: FluximgElement, end: FluximgElement, ctx: SlideRenderCtx & { fluximgBlend?: boolean; fluximgEase?: (raw: number) => number; fluximgTrack?: string; fluximgCurve?: string; durationMs?: number }): FluximgTween {
  const blend = !!ctx.fluximgBlend, ease = ctx.fluximgEase ?? ((raw: number) => raw);
  // What a host playing baked clips needs to find this Change's clip (exported deck); the live host ignores it.
  const id = { blend, ...(ctx.fluximgTrack ? { track: ctx.fluximgTrack } : {}), ...(ctx.durationMs !== undefined ? { durationMs: ctx.durationMs } : {}), ...(ctx.fluximgCurve ? { curve: ctx.fluximgCurve } : {}) };
  let plan: ViewTweenPlan | undefined;
  // The boxes at the Change's two ends: a binding sizes its canvas once for the larger one while it moves (review C8).
  const boxes = { pre: { width: pre.width, height: pre.height }, end: { width: end.width, height: end.height } };
  const make = (manifest: FluximgManifest) => { plan = fluximgPlan(manifest, pre, end, blend); };
  const known = manifestOf(ctx, pre.assetId);
  if (known) make(known);
  let loaded = !!plan;
  const ready = !plan && ctx.fluximg ? {
    isReady: () => loaded,
    ready: () => ctx.fluximg!.need(pre.assetId).then((manifest) => { if (!plan) make(manifest); }).finally(() => { loaded = true; }),
  } : undefined;
  return {
    frame: (u, raw) => (plan ? plan.frame(u, raw) : null),
    motion: (raw) => (plan ? { plan, raw, ease, boxes, ...id } : undefined),
    ...(ready ? { ready } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The vector overlay
// ---------------------------------------------------------------------------------------------

/** One drawn layer. Its group and its shapes are made ONCE and then only their attributes change: a new build (another
 *  crop to cull to, another styling) is RECONCILED into the existing nodes by key, so a node an appearance effect
 *  animates (an object part, W8) is the same node for the life of the slide. */
interface LayerGroup { g: SVGGElement; sig: string; tint: boolean; last: Record<string, string | null>; nodes: Map<string, SVGElement> }
/** A styling change running on a layer (W8): the tween and the inline paint each object had before it overrode it. */
interface StyleRun { tween: ObjectStyleTween; nodes: Map<string, { node: SVGElement; stroke: string; fill: string; opacity: string | null }> }
/** A colour no layer file or style writes: a tinted layer is BUILT in it, then every shape that took it reads the
 *  layer's colour from a custom property instead (styled shapes keep their own colours). */
const TINT_SENTINEL = "#fd03fb";
/** Identity of a table or a styles object in a build signature (the stores hand out the same object until it changes). */
const identities = new WeakMap<object, number>();
let identitySerial = 0;
const identity = (o: object | null | undefined): number => { if (!o) return 0; let n = identities.get(o); if (!n) identities.set(o, n = ++identitySerial); return n; };
interface NamesGroup { g: SVGGElement; sig: string; index: LayerObject[]; nodes: Map<string, SVGTextElement>; place: string }

/** Whether a table's column is numeric, read once per (table object, column): the overlay asks every frame of a tween. */
const kinds = new WeakMap<object, Map<string, boolean>>();
function numericColumn(table: { columns?: Record<string, unknown[]> }, column: string): boolean {
  let per = kinds.get(table);
  if (!per) kinds.set(table, per = new Map());
  let v = per.get(column);
  if (v === undefined) { const values = table.columns?.[column]; v = Array.isArray(values) && columnKind(values) === "number"; per.set(column, v); }
  return v;
}

/** Set an attribute only when its value changes (a frame that changes nothing writes nothing). */
function attr(last: Record<string, string | null>, node: Element, name: string, value: string | null): void {
  if (last[name] === value) return;
  last[name] = value;
  if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
}

class Overlay {
  private layersG: SVGGElement;
  private wordsG: SVGGElement;
  private namesG: SVGGElement;
  private furnG: SVGGElement;
  private insetsG: SVGGElement;
  private insetRects = new Map<string, { rect: SVGRectElement; last: Record<string, string | null> }>();
  private layers = new Map<string, LayerGroup>();
  private names = new Map<string, NamesGroup>();
  private order = "";
  private furnSig = "";
  private opacitySig = "";
  private viewBox = "";
  private wordsLast: Record<string, string | null> = {};
  constructor(private svg: SVGSVGElement, private prefix: string, private ctx: SlideRenderCtx) {
    this.layersG = document.createElementNS(SVG, "g");
    this.wordsG = document.createElementNS(SVG, "g");
    this.namesG = document.createElementNS(SVG, "g");
    this.furnG = document.createElementNS(SVG, "g");
    this.insetsG = document.createElementNS(SVG, "g");
    this.wordsG.append(this.namesG, this.furnG);
    // Bottom to top as at rest (static.ts): layers, blow-out frames, then the words (names, furniture).
    svg.append(this.layersG, this.insetsG, this.wordsG);
  }

  /** The vector layers whose shapes the overlay can draw, loading their text (a miss draws nothing until it lands). */
  layerText(manifest: FluximgManifest, assetId: string, lv: ResolvedLayer): { layer: FluximgLayer; text: string | undefined } | null {
    const layer = manifest.layers.find((l) => l.id === lv.id), path = layerSvgPath(layer);
    if (!layer || !path) return null;
    return { layer, text: this.ctx.fluximgLayerText?.(assetId, path) };
  }

  private last: { manifest: FluximgManifest; el: FluximgElement; pic: TweenPicture; fade: object; cull: PixelRect } | null = null;
  /** Something the overlay waits for landed (a layer file): the next update must look again. */
  invalidate(): void { this.last = null; }
  /** Styled layers held back until their table (and colour map) land: a styled layer is never shown unstyled. */
  readonly waiting = new Set<string>();
  /** Layers whose objects are mid styling change (their per-object paint is written per frame). */
  private runs = new Map<string, StyleRun>();
  private tweens = new WeakMap<ViewTweenPlan, Map<string, ObjectStyleTween | null>>();

  update(manifest: FluximgManifest, assetId: string, el: FluximgElement, pic: TweenPicture, fade: ViewTweenFrame["furnitureOpacity"], cull: PixelRect, motion?: FluximgMotion): void {
    // A styling change between the Change's two ends tweens each object (W8): only while one runs (0 < raw < 1) and only
    // when the two ends style a layer differently; a Change that keeps the styling costs one map lookup per frame.
    const styling = motion && motion.raw > 0 && motion.raw < 1 ? this.styleTweens(manifest, assetId, motion.plan) : null;
    // The plan's pictures are shared and read-only: the same overlay picture on the same element state is nothing new.
    const L = this.last;
    if (!styling?.size && !this.runs.size && L && L.manifest === manifest && L.el === el && L.pic === pic && L.fade === fade && L.cull === cull) return;
    this.last = { manifest, el, pic, fade, cull };
    const box = { width: Math.max(1e-6, el.width), height: Math.max(1e-6, el.height) };
    const vb = `0 0 ${svgNum(box.width)} ${svgNum(box.height)}`;
    if (vb !== this.viewBox) { this.viewBox = vb; this.svg.setAttribute("viewBox", vb); }
    const rv = pic.view, crop = pic.crop;
    const { sx, sy, tx, ty } = cropTransform(crop, box);
    const transform = `matrix(${preciseNum(sx)} 0 0 ${preciseNum(sy)} ${preciseNum(tx)} ${preciseNum(ty)})`;
    const cullKey = `${cull.x},${cull.y},${cull.width},${cull.height}`;
    // --- layers: built once per (text, tint, cull), then only their attributes follow the frame
    const shown: string[] = [];
    // A layer whose styling change just ended (or was left by a seek): its objects take the end state's own build again.
    for (const [id, run] of this.runs) if (!styling?.has(id)) { this.endRun(run); this.runs.delete(id); const g = this.layers.get(id); if (g) g.sig = ""; }
    for (const lv of rv.layers) {
      if (lv.kind === "intensity") continue;
      const entry = this.layers.get(lv.id);
      const wanted = lv.visible && lv.opacity > 0;
      this.waiting.delete(lv.id);
      if (!wanted) { if (entry) attr(entry.last, entry.g, "display", "none"); continue; }
      const source = this.layerText(manifest, assetId, lv);
      if (!source || source.text === undefined) continue;
      const tint = lv.color !== null;
      // A layer styled by its table (W4 styleBy): per-object colours and opacities, from the same objectStyle cache the
      // element at rest uses; they change only when styleBy, the table or the colour maps change (never per frame).
      // Until its table (and, coloured by numbers, its colour map) is here it is NOT shown: drawn unstyled first and
      // restyled later it would flash, and a capture in between would keep the wrong picture (`settled` waits).
      const run = styling?.get(lv.id) ?? null;
      const held = run ? null : this.stylesPending(source.layer, lv, assetId);
      if (held) { this.waiting.add(lv.id); if (entry) attr(entry.last, entry.g, "display", "none"); continue; }
      const styles = run ? null : this.stylesOf(source.layer, lv, assetId);
      const sig = run ? `${source.text.length}|${tint ? "tint" : "own"}|${cullKey}|tween:${identity(run)}`
        : `${source.text.length}|${tint ? "tint" : "own"}|${cullKey}|${lv.styleBy ? JSON.stringify(lv.styleBy) : ""}|${identity(styles)}`;
      let group = entry;
      if (!group || group.sig !== sig) {
        // During a styling change the layer is built at the START's styling with no object left out (one hidden at an
        // end must exist to fade); the run then writes the objects that change.
        const built = this.buildLayer(source.layer, source.text, lv, cull, box, sig, run ? run.start : styles, run ? run.startUnlisted : styles ? missingStyle(lv.styleBy) : null);
        if (group) { this.reconcile(group, built); group.sig = sig; }
        else { group = built; this.layers.set(lv.id, group); this.layersG.append(group.g); }
        this.order = "";
      }
      if (run) this.writeRun(lv.id, run, group, motion!);
      const g = group.g, last = group.last;
      attr(last, g, "display", null);
      attr(last, g, "transform", transform);
      attr(last, g, "stroke-width", preciseNum(imageStrokeWidth(Math.max(0, lv.strokeWidth), sx, sy)));
      attr(last, g, "fill-opacity", svgNum(clamp01(lv.fillOpacity)));
      attr(last, g, "opacity", lv.opacity < 1 ? svgNum(lv.opacity) : null);
      if (group.tint && last["--tint"] !== lv.color) { last["--tint"] = lv.color; g.style.setProperty("--fx-tint", lv.color ?? ""); }
      shown.push(lv.id);
    }
    for (const [id, group] of this.layers) if (!shown.includes(id)) attr(group.last, group.g, "display", "none");
    const order = shown.join(",");
    if (order !== this.order) { this.order = order; for (const id of shown) this.layersG.append(this.layers.get(id)!.g); }

    // --- names and furniture sit in a group that undoes the element's mirror (words read normally)
    attr(this.wordsLast, this.wordsG, "transform", unflipTransform(box, el.flipX, el.flipY) || null);
    this.updateNames(manifest, assetId, el, pic, box, fade.names);
    // The calibration bar draws a colour map's own colours: its markup changes when the tables land.
    const lut = rv.furniture.colorbar ? rv.channels.find((c) => c.lut)?.lut : undefined;
    // The key (a legend of a styled layer) draws the legends of the styled layers, as the element at rest does.
    let legends: Record<string, ObjectLegend | null> | undefined;
    if (rv.furniture.key) {
      legends = {};
      for (const lv of rv.layers) { const layer = lv.kind === "intensity" ? undefined : manifest.layers.find((l) => l.id === lv.id); if (layer) { const st = this.stylesOf(layer, lv, assetId); if (st) legends[lv.id] = st.legend; } }
    }
    const furnSig = JSON.stringify([rv.furniture, rv.index, rv.projection, rv.channels, rv.composite, rv.solo, rv.furniture.key ? rv.layers : null, crop, box, lut ? !!this.ctx.fluximgLut?.(lut) : false, legends ? Object.values(legends).map((l) => identity(l)) : null]);
    if (furnSig !== this.furnSig) {
      this.furnSig = furnSig; this.opacitySig = "";
      let markup = "";
      try { markup = furnitureSvg(manifest, rv, crop, box, this.prefix, this.ctx.fluximgLut, legends); } catch { markup = ""; }
      this.furnG.innerHTML = markup;
    }
    const opacitySig = JSON.stringify(fade);
    if (opacitySig !== this.opacitySig) { this.opacitySig = opacitySig; this.fadeFurniture(fade); }
  }

  /** The styles a shown layer is drawn with (null when it is not styled or its table cannot be read). */
  private stylesOf(layer: FluximgLayer, lv: ResolvedLayer, assetId: string): ObjectStyles | null {
    if (!wantsTable(lv)) return null;
    const path = layerTablePath(layer);
    const table = path ? this.ctx.fluximgTable?.(assetId, path) : null;
    return stylesToDraw(layerStyles(layer, lv, table, this.ctx.fluximgLut));
  }
  /** Whether a styled layer must wait: its table is loading (undefined; null = unreadable, drawn unstyled), or it is
   *  coloured by a numeric column whose colour map has not landed (the colours would be grey). */
  private stylesPending(layer: FluximgLayer, lv: ResolvedLayer, assetId: string): boolean {
    if (!wantsTable(lv)) return false;
    const path = layerTablePath(layer);
    if (!path || !this.ctx.fluximgTable) return false;
    const table = this.ctx.fluximgTable(assetId, path);
    if (table === undefined) return true;
    const c = lv.styleBy?.color;
    if (!table || !c || !this.ctx.fluximgLut) return false;
    const numeric = numericColumn(table, c.column) && !(Array.isArray(c.palette) && c.palette.length && !c.lut);
    return numeric && !this.ctx.fluximgLut(typeof c.lut === "string" && c.lut ? c.lut : DEFAULT_STYLE_LUT);
  }

  private buildLayer(layer: FluximgLayer, text: string, lv: ResolvedLayer, cull: PixelRect, box: { width: number; height: number }, sig: string,
    styles: ObjectStyles | ReadonlyMap<string, ObjectStyle> | null, unlisted: ObjectStyle | null): LayerGroup {
    let markup = "";
    const tint = lv.color !== null;
    const byKey = styles instanceof Map ? styles : (styles as ObjectStyles | null)?.byKey;
    // A layer file anyone may have written can be refused by the sanitizer: draw nothing rather than break the slide.
    try { markup = layerMarkup(layer, text, { ...lv, visible: true, opacity: 1, ...(tint ? { color: TINT_SENTINEL } : {}) }, cull, box, this.prefix, byKey, byKey ? unlisted : null); } catch { markup = ""; }
    const holder = document.createElementNS(SVG, "svg");
    holder.innerHTML = markup;
    const g = (holder.firstElementChild as SVGGElement | null) ?? document.createElementNS(SVG, "g");
    // The group names its layer even when nothing of it is drawn yet (the part finder and a later reconcile find it).
    if (!g.hasAttribute("data-layer")) g.setAttribute("data-layer", layer.id);
    if (tint) {
      // One colour for the whole layer: shapes read it from a custom property, so a colour tween writes ONE style per
      // frame instead of every shape's stroke and fill.
      for (const node of [g, ...Array.from(g.children)]) for (const name of ["stroke", "fill"]) {
        if (node.getAttribute(name) === TINT_SENTINEL) { node.removeAttribute(name); (node as SVGElement).style.setProperty(name, "var(--fx-tint)"); }
      }
      g.style.setProperty("--fx-tint", lv.color!);
    }
    const nodes = new Map<string, SVGElement>();
    for (const c of Array.from(g.children) as SVGElement[]) { const k = c.getAttribute("data-key"); if (k !== null) nodes.set(k, c); }
    return { g, sig, tint, nodes, last: { "--tint": lv.color, transform: g.getAttribute("transform"), "stroke-width": g.getAttribute("stroke-width"), "fill-opacity": g.getAttribute("fill-opacity"), opacity: g.getAttribute("opacity"), display: null } };
  }

  /**
   * A new build of a layer folded into the nodes on screen: the group and every object that is in both keep their
   * identity and take the new attributes (and the new inline paint: the tint's custom property); an object the new
   * build leaves out (culled, hidden by its styling) is kept with `display="none"`; a new object is inserted in file
   * order. Inline styles an effect wrote (opacity, transform, visibility …) are never touched.
   */
  private reconcile(group: LayerGroup, built: LayerGroup): void {
    const g = group.g, fresh = built.g;
    for (const a of Array.from(g.attributes)) if (a.name !== "style" && !fresh.hasAttribute(a.name)) g.removeAttribute(a.name);
    for (const a of Array.from(fresh.attributes)) if (a.name !== "style" && g.getAttribute(a.name) !== a.value) g.setAttribute(a.name, a.value);
    if (built.tint) g.style.setProperty("--fx-tint", fresh.style.getPropertyValue("--fx-tint")); else g.style.removeProperty("--fx-tint");
    for (const name of ["stroke", "fill"]) { const v = fresh.style.getPropertyValue(name); if (v) g.style.setProperty(name, v); else g.style.removeProperty(name); }
    group.tint = built.tint;
    group.last = built.last;
    const keep = new Set<string>();
    let before: SVGElement | null = null;
    // Walk the new build BACKWARDS so each node can be placed before its successor (file order, culled or not).
    const children = Array.from(fresh.children) as SVGElement[];
    for (let i = children.length - 1; i >= 0; i--) {
      const n = children[i], k = n.getAttribute("data-key");
      if (k === null) continue;
      keep.add(k);
      const old = group.nodes.get(k);
      // (a node the player wrapped for an effect sits one level down: insert before its wrapper)
      if (!old) { const at = before?.parentNode === g ? before : before?.parentNode?.parentNode === g ? before.parentNode : null; g.insertBefore(n, at); group.nodes.set(k, n); before = n; continue; }
      for (const a of Array.from(old.attributes)) if (a.name !== "style" && !n.hasAttribute(a.name)) old.removeAttribute(a.name);
      for (const a of Array.from(n.attributes)) if (a.name !== "style" && old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
      for (const name of ["stroke", "fill"]) { const v = n.style.getPropertyValue(name); if (v) old.style.setProperty(name, v); else old.style.removeProperty(name); }
      before = old;
    }
    for (const [k, node] of group.nodes) if (!keep.has(k) && node.getAttribute("display") !== "none") node.setAttribute("display", "none");
  }

  /** The styling changes of a Change's plan, per layer (null: none), computed once per plan. */
  private styleTweens(manifest: FluximgManifest, assetId: string, plan: ViewTweenPlan): Map<string, StyleRun & { start: ReadonlyMap<string, ObjectStyle> | null; startUnlisted: ObjectStyle | null }> | null {
    let per = this.tweens.get(plan) as Map<string, (StyleRun & { start: ReadonlyMap<string, ObjectStyle> | null; startUnlisted: ObjectStyle | null }) | null> | undefined;
    if (!per) {
      per = new Map();
      const ends = plan.end.view.layers;
      for (const a of plan.start.view.layers) {
        const b = ends.find((l) => l.id === a.id);
        if (!b || a.kind === "intensity" || JSON.stringify(a.styleBy ?? null) === JSON.stringify(b.styleBy ?? null)) continue;
        const layer = manifest.layers.find((l) => l.id === a.id);
        const text = layer ? this.ctx.fluximgLayerText?.(assetId, layerSvgPath(layer) ?? "") : undefined;
        if (!layer || text === undefined || this.stylesPending(layer, a, assetId) || this.stylesPending(layer, b, assetId)) continue; // not ready: the step at half stands
        const sa = this.stylesOf(layer, a, assetId), sb = this.stylesOf(layer, b, assetId);
        let shapes: ReturnType<typeof sanitizeLayerSvg>["shapes"] = [], groupAttrs: Record<string, string> = {};
        try { const p = sanitizeLayerSvg(text); shapes = p.shapes; groupAttrs = p.groupAttrs; } catch { continue; }
        const own = new Map(shapes.map((sh) => [sh.key, sh.attrs]));
        const color = b.color;
        const groupStroke = color ?? groupAttrs.stroke ?? (layer as { color?: string | null }).color ?? "#ffffff";
        const groupFill = groupAttrs.fill === undefined || groupAttrs.fill === "none" ? "none" : color ?? groupAttrs.fill;
        const base = (key: string): ObjectPaint => {
          const at = own.get(key) ?? {};
          const stroke = at.stroke === undefined ? groupStroke : at.stroke === "none" ? "none" : color ?? at.stroke;
          const fill = at.fill === undefined ? groupFill : at.fill === "none" ? "none" : color ?? at.fill;
          return { stroke, fill, opacity: at.opacity !== undefined ? Number(at.opacity) : 1 };
        };
        const aUn = sa ? missingStyle(a.styleBy) : null, bUn = sb ? missingStyle(b.styleBy) : null;
        const tween = objectStyleTween(sa?.byKey, aUn, sb?.byKey, bUn, shapes.map((sh) => sh.key), base);
        if (!tween) continue;
        // The start's styling with nothing left out: an object hidden at the start exists (at opacity 0) to fade in.
        const show = (st: ObjectStyle | null | undefined): ObjectStyle | null | undefined => (st?.hidden ? { opacity: 0 } : st);
        const start = sa ? new Map([...sa.byKey].map(([k, st]) => [k, show(st)!])) : null;
        per.set(a.id, { tween, nodes: new Map(), start, startUnlisted: show(aUn) ?? null });
      }
      this.tweens.set(plan, per as never);
    }
    if (!per.size) return null;
    for (const [id, run] of per) if (run) this.runs.set(id, run);
    return per as Map<string, StyleRun & { start: ReadonlyMap<string, ObjectStyle> | null; startUnlisted: ObjectStyle | null }>;
  }
  /** One frame of a styling change: each changing object's colour and opacity at the Change's eased progress. */
  private writeRun(layerId: string, run: StyleRun, group: LayerGroup, motion: FluximgMotion): void {
    const at = styleTweenAt(run.tween, motion.ease(motion.raw));
    for (const [key, p] of at) {
      const node = group.nodes.get(key);
      if (!node) continue;
      if (!run.nodes.has(key)) run.nodes.set(key, { node, stroke: node.style.getPropertyValue("stroke"), fill: node.style.getPropertyValue("fill"), opacity: node.getAttribute("opacity") });
      if (node.getAttribute("display") === "none") node.removeAttribute("display");
      node.style.setProperty("stroke", p.stroke);
      node.style.setProperty("fill", p.fill);
      const o = svgNum(clamp01(p.opacity));
      if (node.getAttribute("opacity") !== o) node.setAttribute("opacity", o);
    }
    void layerId;
  }
  /** A styling change left: the objects' own inline paint comes back (the end's build is reconciled right after). */
  private endRun(run: StyleRun): void {
    for (const { node, stroke, fill, opacity } of run.nodes.values()) {
      if (stroke) node.style.setProperty("stroke", stroke); else node.style.removeProperty("stroke");
      if (fill) node.style.setProperty("fill", fill); else node.style.removeProperty("fill");
      if (opacity === null) node.removeAttribute("opacity"); else node.setAttribute("opacity", opacity);
    }
    run.nodes.clear();
  }

  private updateNames(manifest: FluximgManifest, assetId: string, el: FluximgElement, pic: TweenPicture, box: { width: number; height: number }, fade: number | undefined): void {
    const n = pic.view.furniture.names, seen = new Set<string>();
    if (n) for (const id of n.layers) {
      const lv = pic.view.layers.find((l) => l.id === id);
      if (!lv || !lv.visible || lv.kind === "intensity") continue;
      const source = this.layerText(manifest, assetId, lv);
      if (!source || source.text === undefined) continue;
      const color = lv.color ?? source.layer.color ?? "#ffffff";
      // An object hidden by its styling (missing: "hide") has no name either (as at rest).
      const st = lv.styleBy?.missing === "hide" ? this.stylesOf(source.layer, lv, assetId) : null;
      const sig = `${source.text.length}|${n.fontSize}|${color}|${identity(st)}`;
      let group = this.names.get(id);
      if (!group || group.sig !== sig) {
        group?.g.remove();
        const g = document.createElementNS(SVG, "g");
        g.setAttribute("id", `${this.prefix}names.${id}`); g.setAttribute("data-part", "names"); g.setAttribute("fill", color);
        g.setAttribute("font-family", FURNITURE_FONT); g.setAttribute("font-weight", String(FURNITURE_WEIGHT)); g.setAttribute("font-size", svgNum(namesFontPx(n.fontSize)));
        let index: LayerObject[] = [];
        try { index = shownObjects(objectIndex(source.text), st?.byKey, st ? missingStyle(lv.styleBy) : null).slice(); } catch { index = []; }
        group = { g, sig, index, nodes: new Map(), place: "" };
        this.names.set(id, group);
        this.namesG.append(g);
      }
      seen.add(id);
      group.g.style.display = "";
      const place = `${pic.crop.x},${pic.crop.y},${pic.crop.width},${pic.crop.height}|${box.width}x${box.height}|${el.flipX ? 1 : 0}${el.flipY ? 1 : 0}`;
      if (place !== group.place) {
        group.place = place;
        const placed = namePlacements(group.index, pic.crop, box, { fontSize: n.fontSize, flipX: el.flipX, flipY: el.flipY });
        const on = new Set<string>();
        for (const p of placed ?? []) {
          let t = group.nodes.get(p.key);
          if (!t) {
            t = document.createElementNS(SVG, "text");
            t.setAttribute("id", `${this.prefix}name.${id}/${p.key}`); t.setAttribute("data-key", p.key); t.textContent = p.key;
            group.nodes.set(p.key, t); group.g.append(t);
          }
          t.setAttribute("x", svgNum(p.x)); t.setAttribute("y", svgNum(p.y)); t.setAttribute("text-anchor", p.anchor);
          if (t.style.display) t.style.display = "";
          on.add(p.key);
        }
        for (const [key, t] of group.nodes) if (!on.has(key) && t.style.display !== "none") t.style.display = "none";
      }
      const op = fade === undefined || fade >= 1 ? "" : svgNum(clamp01(fade));
      if ((group.g.getAttribute("opacity") ?? "") !== op) { if (op) group.g.setAttribute("opacity", op); else group.g.removeAttribute("opacity"); }
    }
    for (const [id, group] of this.names) if (!seen.has(id) && group.g.style.display !== "none") group.g.style.display = "none";
  }

  private fadeFurniture(fade: ViewTweenFrame["furnitureOpacity"]): void {
    const pieces: Record<Exclude<keyof ResolvedFurniture, "names">, string[]> = {
      scalebar: [`[id="${this.prefix}scalebar"]`, `[id="${this.prefix}scalebar.label"]`],
      stamp: [`[id="${this.prefix}stamp"]`],
      channelLabels: [`[data-part="channel"]`],
      colorbar: [`[id="${this.prefix}colorbar"]`],
      key: [`[id="${this.prefix}key"]`],
    };
    for (const [piece, selectors] of Object.entries(pieces) as [keyof typeof pieces, string[]][]) {
      const v = fade[piece];
      for (const node of this.furnG.querySelectorAll(selectors.join(","))) {
        if (v === undefined || v >= 1) node.removeAttribute("opacity"); else node.setAttribute("opacity", svgNum(clamp01(v)));
      }
    }
  }

  /**
   * The frames of this image's blow-outs (`insetOf` children on the same slide, with their crops at this frame), drawn
   * as at rest (static.insetRectMarkup). One rectangle per child, made once; a tweening crop (the child's or this one's)
   * moves it by its attributes.
   */
  insets(list: ReadonlyArray<{ id: string; crop: PixelRect }>, crop: PixelRect, el: FluximgElement): void {
    const box = { width: Math.max(1e-6, el.width), height: Math.max(1e-6, el.height) }, seen = new Set<string>();
    for (const inset of list) {
      let entry = this.insetRects.get(inset.id);
      if (!entry) {
        const rect = document.createElementNS(SVG, "rect");
        rect.setAttribute("id", `${this.prefix}${inset.id.replace(/[^A-Za-z0-9_-]/g, "_")}-inset`); rect.setAttribute("data-part", "inset");
        rect.setAttribute("fill", "none"); rect.setAttribute("stroke", "#ffffff"); rect.setAttribute("stroke-width", "1"); rect.setAttribute("stroke-dasharray", "4 3");
        this.insetsG.append(rect);
        this.insetRects.set(inset.id, entry = { rect, last: {} });
      }
      seen.add(inset.id);
      const r = insetRect(inset.crop, crop, box);
      attr(entry.last, entry.rect, "display", r ? null : "none");
      if (r) { attr(entry.last, entry.rect, "x", svgNum(r.x)); attr(entry.last, entry.rect, "y", svgNum(r.y)); attr(entry.last, entry.rect, "width", svgNum(r.width)); attr(entry.last, entry.rect, "height", svgNum(r.height)); }
    }
    for (const [id, entry] of this.insetRects) if (!seen.has(id)) attr(entry.last, entry.rect, "display", "none");
  }

  /** The DOM nodes the overlay owns (gates: the same objects before and after a tween). */
  nodes(): Element[] { return [this.layersG, this.insetsG, this.wordsG, ...[...this.insetRects.values()].map((i) => i.rect), ...[...this.layers.values()].map((l) => l.g), ...[...this.names.values()].map((n) => n.g)]; }
}

// ---------------------------------------------------------------------------------------------
// The binding
// ---------------------------------------------------------------------------------------------

export interface FluximgMotion extends FluximgSurfaceMotion { plan: ViewTweenPlan; raw: number; ease: (raw: number) => number;
  /** The element's box at the Change's start and end (stage units). */
  boxes?: { pre: { width: number; height: number }; end: { width: number; height: number } } }

export interface SlideFluximgBinding {
  readonly root: HTMLElement;
  /** The live canvas (a surface may replace the element: always read it here). */
  readonly canvas: HTMLCanvasElement;
  element: FluximgElement;
  /** Sample only (no render): the element's state, and the tween's frame when a Change drives it. */
  set(element: FluximgElement, frame?: ViewTweenFrame | null, motion?: FluximgMotion): void;
  /** Render this frame if it differs from what is on screen (paint() calls it once per frame). */
  flush(): void;
  /** Something the host was waiting for landed (a plane, a still, a layer file): look again, then flush. */
  refresh(): void;
  /** Resolves when the last frame asked for is exactly on screen (capture). */
  settled(): Promise<void>;
  dispose(): void;
  /** The Change driving this binding at its last frame (decode-ahead). */
  readonly motion: FluximgMotion | undefined;
  /** The live surface's output size in device pixels for the current state. */
  outSize(): { width: number; height: number; native?: boolean };
  /**
   * The camera's RESTING zoom on this image (> 1 magnifies it; 1 when it rests out of the camera's view or without a
   * camera zoom). The player's image controller sets it only when the slide rests (review B4: the canvas and the still
   * are re-rendered for it once, when a camera move ends; during the move the camera's CSS scales them).
   */
  setCameraZoom(zoom: number): void;
  /** Let the surface go live: make its GL context now (idle time, or play's readiness; never inside a frame). */
  prepare(): void;
  /**
   * Media playback (a running clip): override the plane position `index[dim]` of whatever frame this binding shows
   * (the Change's frame, or its resting state), or clear it with null. Composes with the frame through `withIndex`.
   * Takes effect at the next `flush()`, which may be called outside the player's paint() for this binding alone.
   */
  setIndexOverride(override: { dim: string; index: number; clock?: FluximgMovieClock } | null): void;
  /**
   * What a running movie along `dim` needs from its clock while it runs (asked by the movie controller to plan its
   * wake-ups, review C7): "frames" = this binding draws every plane (the live host); "overlay" = the surface plays the
   * movie by itself (a baked clip) but the overlay names the plane (a stamp on `dim`), so it is redrawn at each plane;
   * "none" = nothing to draw until the clock's state changes (a clip that plays natively with no stamp on `dim`, or a
   * movie the surface cannot show at all: the image stays the step's still).
   */
  movieNeeds(dim: string): "frames" | "overlay" | "none";
  /** Decode ahead along `dim`: the next `count` positions in `direction` (+1 / -1) at `stride`, from the shown frame. */
  decodeAhead(dim: string, direction: 1 | -1, stride?: number, count?: number): void;
  /** The picture this binding shows now (its crop and `insetOf`), or null before its manifest is known. */
  current(): { id: string; assetId: string; crop: PixelRect; insetOf: string | null } | null;
  /** The blow-outs to outline on this image this frame (the controller or a static flush passes them). */
  setInsets(list: ReadonlyArray<{ id: string; crop: PixelRect }>): void;
  /** Gates: what is on screen. */
  probe(): { key: string; pending: boolean; live: boolean; still: string; overlay: Element[] };
}

export function fillFluximg(parent: HTMLElement, element: FluximgElement, ctx: SlideRenderCtx): SlideFluximgBinding {
  const root = document.createElement("div"); root.dataset.slideFluximgRoot = element.id;
  root.style.cssText = "position:absolute;inset:0;overflow:hidden";
  // Paint servers (the calibration bar's gradients) must be unique across stage, filmstrip and presenter views.
  const prefix = `${fluximgIdPrefix(element.id)}s${++mountSerial}-`;
  const stillLayer = svgLayer(), over = svgLayer();
  stillLayer.setAttribute("data-fluximg-still", "");
  const canvas = document.createElement("canvas"); canvas.dataset.slideFluximg = element.id;
  // No backing store for an unborn or hidden image, and none at rest until a live frame is asked for.
  canvas.width = 0; canvas.height = 0; canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:none";
  root.append(stillLayer, canvas, over); parent.append(root);
  const overlay = new Overlay(over, prefix, ctx);
  let el = element, frame: ViewTweenFrame | null = null, motion: FluximgMotion | undefined;
  let surface: FluximgSurface | undefined, drawnKey = "", pending = false, disposed = false, intersects = true, needing = false;
  let stillKey = "", failed: Error | undefined, allowLive = false;
  let override: { dim: string; index: number; clock?: FluximgMovieClock } | null = null, overridden: { from: ViewTweenFrame; dim: string; index: number; out: ViewTweenFrame } | null = null;
  let insetList: ReadonlyArray<{ id: string; crop: PixelRect }> = [];
  const waiters: Array<() => void> = [];
  /** Its objects are animated on this slide: the overlay draws the whole image's objects (never culled to a crop). */
  const wholeImage = !!ctx.fluximgPartImages?.has(element.id);
  const liveCanvas = (): HTMLCanvasElement => surface?.canvas ?? canvas;
  /** The frame shown: the Change's (or the resting state), with a running clip's position over it. */
  /** Whether the surface can show the running movie: a baked-clip surface without the movie's clip cannot (an export
   *  without the encoder), and then the image is the step's own picture, its overlay included (review C7). */
  let movieOk: { o: object; a: TweenPicture; ok: boolean } | null = null;
  const movieShowable = (f: ViewTweenFrame): boolean => {
    const s = surface;
    if (!override?.clock || !s?.clocked || !s.movie) return true;
    if (movieOk && movieOk.o === override && movieOk.a === f.a) return movieOk.ok;
    movieOk = { o: override, a: f.a, ok: s.movie(el.assetId, f.a, override.clock) };
    return movieOk.ok;
  };
  const shown = (manifest: FluximgManifest): ViewTweenFrame => {
    const f = frame ?? resting(manifest);
    if (!override || !movieShowable(f)) return f;
    if (overridden && overridden.from === f && overridden.dim === override.dim && overridden.index === override.index) return overridden.out;
    overridden = { from: f, dim: override.dim, index: override.index, out: withIndexLocal(f, override.dim, override.index) };
    return overridden.out;
  };
  let cull: PixelRect | null = null, cullFrom = new WeakSet<ViewTweenPlan>();
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    const next = entries.at(-1)?.isIntersecting ?? false;
    if (next !== intersects) { intersects = next; handle.flush(); }
  }) : undefined;
  observer?.observe(root);

  const widen = (r: PixelRect) => {
    if (!cull) { cull = { ...r }; return; }
    const x0 = Math.min(cull.x, r.x), y0 = Math.min(cull.y, r.y), x1 = Math.max(cull.x + cull.width, r.x + r.width), y1 = Math.max(cull.y + cull.height, r.y + r.height);
    cull = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  let rest: { el: FluximgElement; manifest: FluximgManifest; frame: ViewTweenFrame } | null = null;
  /** The picture of the element's own state (resolved once per state, not per frame). */
  const resting = (manifest: FluximgManifest): ViewTweenFrame => {
    if (rest?.el === el && rest.manifest === manifest) return rest.frame;
    const pic: TweenPicture = { view: resolveView(manifest, el.view), crop: clampCrop(manifest, el.crop) };
    rest = { el, manifest, frame: { a: pic, b: null, mix: 0, blend: null, overlay: pic, furnitureOpacity: {} } };
    return rest.frame;
  };
  let cameraZoom = 1;
  /** Device pixels per stage unit on the unzoomed stage. */
  const baseScale = (): number => {
    const scale = Math.max(.01, typeof ctx.pixelScale === "function" ? ctx.pixelScale() : ctx.pixelScale ?? 1);
    return scale * Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  };
  /**
   * Backing pixels of a box showing `crop` (review B4). Without a camera zoom: the box at the display's scale, exactly
   * as before. Under the camera's resting zoom: the box at scale x zoom, but never more than the crop's own pixels:
   * where the zoom magnifies the data the canvas holds exactly the crop's pixels and the display magnifies them as the
   * image says (`magnification`: true pixels unless smooth), which is what the editor's element does (its still is
   * the crop's true pixels, `image-rendering: pixelated`). Bounded by 4096 px a side and, where the zoom asks for more
   * than the unzoomed size, LIVE_MAX_PIXELS. `native`: the backing is exactly the crop's pixels.
   */
  const sizeFor = (box: { width: number; height: number }, crop: PixelRect, base: number): { width: number; height: number; native: boolean } => {
    const w = Math.max(1, box.width), h = Math.max(1, box.height);
    const plain = Math.min(base, 4096 / Math.max(w, h));
    if (cameraZoom > 1) {
      const native = Math.max(crop.width / w, crop.height / h);
      if (base * cameraZoom >= native) {
        const cw = Math.max(1, Math.round(crop.width)), ch = Math.max(1, Math.round(crop.height));
        const k = Math.min(1, 4096 / Math.max(cw, ch), Math.sqrt(LIVE_MAX_PIXELS / (cw * ch)));
        if (k === 1) return { width: cw, height: ch, native: true };
        return { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)), native: false };
      }
      const factor = Math.max(plain, Math.min(base * cameraZoom, 4096 / Math.max(w, h), Math.sqrt(LIVE_MAX_PIXELS / (w * h))));
      return { width: Math.max(1, Math.round(box.width * factor)), height: Math.max(1, Math.round(box.height * factor)), native: false };
    }
    return { width: Math.max(1, Math.round(box.width * plain)), height: Math.max(1, Math.round(box.height * plain)), native: false };
  };
  function outSize(): { width: number; height: number; native: boolean } {
    const base = baseScale(), m = motion;
    // While a Change moves (0 < raw < 1) the canvas keeps ONE size, the larger of its two ends' (review C8: a Change
    // that scales the image reallocated the GL drawing buffer every frame); the CSS box scales it in between, and both
    // ends are drawn at their exact size.
    if (m?.boxes && m.raw > 0 && m.raw < 1) {
      const a = sizeFor(m.boxes.pre, m.plan.start.crop, base), b = sizeFor(m.boxes.end, m.plan.end.crop, base);
      return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height), native: false };
    }
    const manifest = manifestOf(ctx, el.assetId);
    return sizeFor(el, manifest ? shown(manifest).a.crop : { x: 0, y: 0, width: 1, height: 1 }, base);
  }
  /** A canvas that holds exactly the crop's pixels and that the display magnifies (a camera zoom past them) is
   *  magnified as the image says: true pixels unless it is smooth, as the editor's element does. */
  function magnification(size: { width: number; native: boolean }, smooth: boolean): void {
    const c = liveCanvas(), want = size.native && !smooth && el.width * baseScale() * cameraZoom > size.width * 1.01 ? "pixelated" : "";
    if (c.style.imageRendering !== want) c.style.imageRendering = want;
  }
  // A plan's pictures are shared and read-only (viewTween): one picture object = one key per output size.
  const keys = new WeakMap<TweenPicture, { w: number; h: number; key: string }>();
  const pictureKey = (manifest: FluximgManifest, p: TweenPicture, w: number, h: number): string => {
    const hit = keys.get(p);
    if (hit && hit.w === w && hit.h === h) return hit.key;
    const key = pixelKey(manifest, p.view, p.crop, w, h);
    keys.set(p, { w, h, key });
    return key;
  };
  function frameKey(manifest: FluximgManifest, f: ViewTweenFrame, w: number, h: number): string {
    const b = f.b && f.mix > 0 ? pictureKey(manifest, f.b, w, h) : "";
    const bl = f.blend && f.blend.weight > 0 ? `${f.blend.dim}:${f.blend.other}:${f.blend.end ?? ""}:${f.blend.weight}` : "";
    return `${pictureKey(manifest, f.a, w, h)}#${b}#${b ? f.mix : 0}#${bl}`;
  }
  /** The still of a picture under the canvas (and instead of it with no host): kept until a newer one lands. */
  function showStill(manifest: FluximgManifest, pic: TweenPicture): void {
    const box = { width: el.width, height: el.height };
    // At the camera's resting zoom, by the exports' own rule (an exported deck finds the still it wrote for that step).
    const size = tieredStillSize(pic.crop, box, cameraZoom > 1 ? zoomedStillScale(pic.crop, box, STILL_SCALE, cameraZoom) : STILL_SCALE);
    const key = `${el.assetId}|${pixelKey(manifest, pic.view, pic.crop, size.width, size.height)}`;
    if (key === stillKey) return;
    const href = ctx.fluximg ? ctx.fluximg.still(el.assetId, pic, size.width, size.height) : ctx.fluximgStill?.(el.assetId, pic, size.width, size.height);
    const w = svgNum(el.width), h = svgNum(el.height);
    stillLayer.setAttribute("viewBox", `0 0 ${w} ${h}`);
    if (!href) { if (!stillLayer.firstChild) placeholder(); return; }
    stillKey = key;
    const parts: string[] = [];
    if (pic.view.background !== "transparent") parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${pic.view.background}"/>`);
    stillLayer.innerHTML = parts.join("");
    const image = document.createElementNS(SVG, "image");
    image.setAttribute("x", "0"); image.setAttribute("y", "0"); image.setAttribute("width", w); image.setAttribute("height", h);
    image.setAttribute("preserveAspectRatio", "none"); image.setAttribute("href", href); image.setAttribute("data-fluximg-still-key", key);
    if (size.native && !pic.view.smooth) image.style.imageRendering = "pixelated";
    stillLayer.append(image);
  }
  function placeholder(): void {
    stillLayer.setAttribute("viewBox", `0 0 ${svgNum(el.width)} ${svgNum(el.height)}`);
    stillLayer.innerHTML = `<rect data-fluximg-placeholder="" x="0" y="0" width="${svgNum(el.width)}" height="${svgNum(el.height)}" fill="${PLACEHOLDER_FILL}"/>`;
  }
  const publish = () => {
    const live = !!surface?.shown, c = liveCanvas();
    if (live && c.style.display !== "block") { c.style.display = "block"; stillLayer.style.display = "none"; }
    else if (!live && c.style.display !== "none") { c.style.display = "none"; stillLayer.style.display = "block"; }
  };

  const handle: SlideFluximgBinding = {
    root, element,
    get canvas() { return liveCanvas(); },
    get motion() { return motion; },
    set(next, nextFrame = null, nextMotion) {
      el = next; handle.element = next; frame = nextFrame ?? null; motion = nextMotion;
      if (nextMotion && !cullFrom.has(nextMotion.plan)) { cullFrom.add(nextMotion.plan); widen(nextMotion.plan.start.crop); widen(nextMotion.plan.end.crop); }
    },
    outSize,
    prepare() {
      if (disposed || !ctx.fluximg) return;
      surface ??= ctx.fluximg.surface(canvas);
      surface.prepare();
      allowLive = true;
    },
    setIndexOverride(next) { override = next; },
    setCameraZoom(zoom) { cameraZoom = zoom > 1 ? zoom : 1; },
    movieNeeds(dim) {
      if (!surface?.clocked) return "frames";
      const manifest = manifestOf(ctx, el.assetId);
      if (!manifest) return "none";
      const f = frame ?? resting(manifest);
      if (!movieShowable(f)) return "none";
      // The overlay names the plane only through a stamp line of `dim` (layers, names and the rest do not move with it).
      const rv = f.overlay.view;
      if (!rv.furniture.stamp) return "none";
      const n = manifest.pixels.shape[manifest.pixels.dims.indexOf(dim)] ?? 0, here = rv.index[dim] ?? 0;
      const other = { ...rv, index: { ...rv.index, [dim]: here + 1 < n ? here + 1 : Math.max(0, here - 1) } };
      return stampLines(manifest, rv).join("\n") === stampLines(manifest, other).join("\n") ? "none" : "overlay";
    },
    decodeAhead(dim, direction, stride = 1, count = 8) {
      const manifest = manifestOf(ctx, el.assetId), host = ctx.fluximg;
      if (!manifest || !host) return;
      const f = shown(manifest), n = manifest.pixels.shape[manifest.pixels.dims.indexOf(dim)] ?? 0, here = f.a.view.index[dim];
      if (here === undefined || !(n > 0)) return;
      const pictures: TweenPicture[] = [];
      for (let k = 1; k <= count; k++) { const i = here + direction * stride * k; if (i < 0 || i >= n) break; pictures.push(withIndexLocal(f, dim, i).a); }
      const s = outSize();
      host.warm(el.assetId, pictures, s.width, s.height);
    },
    current() {
      const manifest = manifestOf(ctx, el.assetId);
      if (!manifest) return null;
      const p = shown(manifest).overlay;
      return { id: el.id, assetId: el.assetId, crop: p.crop, insetOf: p.view.insetOf };
    },
    setInsets(list) { insetList = list; },
    refresh() { overlay.invalidate(); handle.flush(); if (!overlay.waiting.size) for (const w of waiters.splice(0)) w(); },
    flush() {
      if (disposed) return;
      const manifest = manifestOf(ctx, el.assetId);
      if (!manifest) {
        if (!stillLayer.firstChild) placeholder();
        if (ctx.fluximg && !needing) {
          needing = true;
          ctx.fluximg.need(el.assetId).then(() => { needing = false; handle.flush(); }, (error: unknown) => { failed = error instanceof Error ? error : new Error(String(error)); root.dataset.fluximgError = failed.message; });
        }
        return;
      }
      const f = shown(manifest);
      if (!cull) widen(wholeImage ? clampCrop(manifest, null) : clampCrop(manifest, el.crop));
      overlay.update(manifest, el.assetId, el, f.overlay, f.furnitureOpacity, cull!, motion);
      overlay.insets(insetList, f.overlay.crop, el);
      if (!ctx.fluximg) { showStill(manifest, f.a); return; }
      // The observer reports asynchronously: confirm an offscreen flag against current layout, so a seek's output never
      // depends on the previous frame (T24). Onscreen flags need no layout read.
      if (!intersects && root.getClientRects().length && rectInViewport(root.getBoundingClientRect(), window.innerWidth, window.innerHeight)) intersects = true;
      if (!intersects || !liveVisible(root)) {
        // Hidden surfaces own no backing store and no textures; the still stands in (nobody sees it while hidden). An
        // image hidden ON screen (unborn, faded out) keeps its context, so its entrance makes none in a frame; offscreen
        // (a camera move, another slide) loses it.
        surface?.release(intersects);
        drawnKey = ""; pending = false; setPending(handle, false);
        showStill(manifest, f.a); publish();
        return;
      }
      // Not live until the surface's context was made outside a frame (prepare): the still stands in until then.
      if (!allowLive) { showStill(manifest, f.a); publish(); return; }
      const size = outSize(), { width, height } = size;
      magnification(size, f.a.view.smooth);
      const key = frameKey(manifest, f, width, height);
      // A frame that waited for its planes is drawn by the surface the moment they land: nothing to ask again.
      if (key === drawnKey && pending && surface?.exact) { pending = false; setPending(handle, false); }
      // A host playing baked clips (exported deck) gets the movie's clock with the frame (W7).
      const drawMotion: FluximgSurfaceMotion | undefined = override?.clock ? { ...motion, movie: override.clock } : motion;
      if (key !== drawnKey || pending || (drawMotion && surface?.clocked)) {
        if (!surface?.shown) showStill(manifest, f.a);
        surface ??= ctx.fluximg.surface(canvas);
        pending = !surface.draw(el.assetId, f, width, height, drawMotion);
        // A surface that hands the picture back to the still (an exported clip at its end) is shown by the still of THIS
        // frame, in the same task: never a frame of the old still.
        if (!surface.shown) showStill(manifest, f.a);
        if (key !== drawnKey) {
          slideFluximgStats.asked++;
          if (pending) slideFluximgStats.late++;
          if (slideFluximgStats.mark && slideFluximgStats.firstAfterMark < 0 && !pending) slideFluximgStats.firstAfterMark = performance.now() - slideFluximgStats.mark;
        }
        setPending(handle, pending);
        drawnKey = key;
      }
      publish();
    },
    async settled() {
      if (failed) throw failed;
      // A styled layer held back for its table (or colour map) is not settled: a capture must never keep it unstyled or missing.
      while (overlay.waiting.size && !disposed) await new Promise<void>((resolve) => waiters.push(resolve));
      if (!ctx.fluximg) return;
      // Capture needs the exact frame: a binding that has not gone live yet does now (capture is not a live frame).
      if (!allowLive && liveVisible(root)) { handle.prepare(); handle.flush(); }
      if (!surface) return;
      await surface.settled();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true; bindingGeneration++;
      for (const w of waiters.splice(0)) w();
      observer?.disconnect(); surface?.dispose(); surface = undefined; setPending(handle, false);
      canvas.width = 0; canvas.height = 0; bindings.delete(root);
    },
    probe: () => ({ key: drawnKey, pending, live: !!surface?.shown, still: stillKey, overlay: overlay.nodes() }),
  };
  bindings.set(root, handle); bindingGeneration++;
  placeholder();
  // A still of the resting state right away when one is cached (thumbnails, the first frame of a preview).
  const known = manifestOf(ctx, element.assetId);
  if (known) showStill(known, resting(known).a);
  // An image whose objects are animated draws its overlay NOW: the player looks its object nodes up as it binds the
  // slide's effects, right after this (W8). Its cull is the whole image, so a later Change never adds a node.
  if (known && wholeImage) {
    widen(clampCrop(known, null));
    const f = resting(known);
    overlay.update(known, element.assetId, el, f.overlay, f.furnitureOpacity, cull!);
    // a ghost copy's inherited object factors (compile.partFactors), as render.compileGhostPartOpacity does for plot parts
    for (const [part, factor] of Object.entries(ctx.ghostPartFactors?.[element.id] ?? {})) {
      const node = fluximgPartNode<SVGElement>(over, part);
      if (node) node.style.opacity = String(Number(node.getAttribute("opacity") ?? 1) * factor.opacity);
    }
  }
  return handle;
}

export function fluximgBindingOf(root: HTMLElement): SlideFluximgBinding | undefined {
  return bindings.get(root) ?? (root.querySelector<HTMLElement>("[data-slide-fluximg-root]") ? bindings.get(root.querySelector<HTMLElement>("[data-slide-fluximg-root]")!) : undefined);
}
export function setSlideFluximgFrame(root: HTMLElement, element: FluximgElement, frame: ViewTweenFrame | null, motion?: FluximgMotion): void {
  fluximgBindingOf(root)?.set(element, frame, motion);
}
/** Hand each image the blow-outs to outline on it: the bindings whose shown picture says `insetOf` that image (same
 *  asset), with their crops at this frame. */
function linkInsets(bs: readonly SlideFluximgBinding[]): void {
  const byParent = new Map<string, Array<{ id: string; crop: PixelRect }>>(), assetOf = new Map<string, string>();
  const now = bs.map((b) => b.current());
  for (const c of now) if (c) assetOf.set(c.id, c.assetId);
  for (const c of now) if (c?.insetOf && assetOf.get(c.insetOf) === c.assetId) { let l = byParent.get(c.insetOf); if (!l) byParent.set(c.insetOf, l = []); l.push({ id: c.id, crop: c.crop }); }
  for (const b of bs) b.setInsets(byParent.get(b.element.id) ?? []);
}
/** Whether any image of the slide is ever a blow-out (only then are insets linked, per frame). */
const hasInsets = (elements: readonly { type: string; view?: unknown }[], ends: readonly FluximgElement[] = []): boolean =>
  [...elements, ...ends].some((e) => e.type === "fluximg" && !!(e as FluximgElement).view?.insetOf);

/** Flush every image binding under `root` (static renders: each shows the cached still of its sampled state). */
export function flushSlideFluximgs(root: HTMLElement): void {
  const bs = nodes(root).map((n) => bindings.get(n)).filter((b): b is SlideFluximgBinding => !!b);
  linkInsets(bs);
  for (const b of bs) b.flush();
}

// ---------------------------------------------------------------------------------------------
// The per-slide controller (live hosts only)
// ---------------------------------------------------------------------------------------------

interface ImageChange { beat: number; assetId: string; target: string; plan?: ViewTweenPlan; pre: FluximgElement; end: FluximgElement; blend: boolean; ease: (raw: number) => number }

/** Created by the player for a slide that holds images, and only when a live host is present. Warms what the slide
 *  will show in idle time, gates play until the first frames of each Change can draw, flushes every binding once per
 *  frame, decodes ahead along a playing Change's path, and frees everything with the slide. */
export function createFluximgController(root: HTMLElement, compiled: CompiledSlide, ctx: SlideRenderCtx, onIssue: (target: string, reason: string) => void = () => {}, stage?: { width: number; height: number }) {
  const host = ctx.fluximg!;
  const slide = compiled.resolvedSlide;
  let disposed = false;
  const images = new Map<string, FluximgElement>();
  for (const el of slide.elements) if (el.type === "fluximg") images.set(el.id, el);
  const changes: ImageChange[] = [];
  compiled.cues.forEach((cue, bi) => {
    for (const ct of cue.tracks) {
      const track = ct.track;
      if (track.disabled || track.preset !== "transform" || isHandoff(track)) continue;
      const pre = transformPreState(slide, track.target, bi);
      if (pre?.type !== "fluximg") continue;
      const end = transformEndState(pre, track);
      if (end.type !== "fluximg") continue;
      changes.push({ beat: bi, assetId: pre.assetId, target: track.target, pre, end, blend: presetParam<boolean>(track, "blend", "transform") === true, ease: ct.ease.fn });
    }
  });
  const planOf = (c: ImageChange): ViewTweenPlan | undefined => {
    if (c.plan) return c.plan;
    const manifest = host.manifest(c.assetId);
    if (!manifest) return undefined;
    try { c.plan = fluximgPlan(manifest, c.pre, c.end, c.blend); } catch (error) { onIssue(c.target, `Image Change shown as a still: ${error instanceof Error ? error.message : String(error)}`); }
    return c.plan;
  };
  const sizeOf = (el: FluximgElement) => {
    const scale = Math.max(.01, typeof ctx.pixelScale === "function" ? ctx.pixelScale() : ctx.pixelScale ?? 1);
    const factor = Math.min(scale * Math.max(1, window.devicePixelRatio || 1), 4096 / Math.max(1, el.width, el.height));
    return { width: Math.max(1, Math.round(el.width * factor)), height: Math.max(1, Math.round(el.height * factor)) };
  };
  const first = (c: ImageChange): TweenPicture[] => planOf(c)?.upcoming(0, 1, c.ease, 2) ?? [];
  const assets = new Set([...images.values()].map((el) => el.assetId));
  const manifests = (): Promise<unknown> => Promise.all([...assets].map((id) => (host.manifest(id) ? undefined : host.need(id).catch((error: unknown) => { for (const el of images.values()) if (el.assetId === id) onIssue(el.id, `Image unavailable: ${error instanceof Error ? error.message : String(error)}`); }))));
  const readyBeats = new Set<number>();
  /** Play waits for the first pictures of every image Change in the beats it starts. */
  function ready(from = 0, to = Number.MAX_SAFE_INTEGER): Promise<void> {
    prepareAll();
    return manifests().then(async () => {
      const list = changes.filter((c) => c.beat >= from && c.beat <= to);
      await Promise.all(list.map((c) => host.ready(c.assetId, first(c), sizeOf(c.pre).width, sizeOf(c.pre).height).catch(() => undefined)));
      for (const c of list) readyBeats.add(c.beat);
    });
  }
  const isReady = (from = 0, to = Number.MAX_SAFE_INTEGER): boolean =>
    prepared && [...assets].every((id) => !!host.manifest(id)) && changes.every((c) => c.beat < from || c.beat > to || readyBeats.has(c.beat));
  let prepared = false;
  /** Every image gets its GL context outside a frame (idle time, or play's readiness), then draws its picture. */
  const prepareAll = (): void => {
    if (prepared || disposed) return;
    prepared = true;
    for (const b of list()) { b.prepare(); b.flush(); }
  };
  // Warming is idle work with no deadline: everything stays correct if it never runs.
  idle(() => {
    if (disposed) return;
    prepareAll();
    void manifests().then(() => {
      if (disposed) return;
      for (const el of images.values()) {
        const manifest = host.manifest(el.assetId);
        if (!manifest) continue;
        const s = sizeOf(el);
        host.warm(el.assetId, [{ view: resolveView(manifest, el.view), crop: clampCrop(manifest, el.crop) }], s.width, s.height);
      }
      for (const c of changes) { const s = sizeOf(c.pre); host.warm(c.assetId, planOf(c)?.upcoming(0, 1, c.ease, 6) ?? [], s.width, s.height); }
      // Marks every Change ready once its first frames can draw, so a later Play starts without waiting a turn.
      void ready().catch(() => undefined);
    });
  });

  let listed = -1, mine: SlideFluximgBinding[] = [];
  const list = (): SlideFluximgBinding[] => {
    if (listed !== bindingGeneration) { listed = bindingGeneration; mine = nodes(root).map((n) => bindings.get(n)).filter((b): b is SlideFluximgBinding => !!b); }
    return mine;
  };
  let aheadAt = -Infinity;
  const lastRaw = new WeakMap<SlideFluximgBinding, number>();
  const insets = hasInsets(slide.elements, changes.map((c) => c.end));
  /**
   * The camera's resting zoom on each image (review B4), read from the camera layer's transform (`translate() scale()`,
   * origin 0 0: the player's camera pose) only while the slide RESTS: a camera move keeps the sizes it started with and
   * its CSS scales them; where it lands, each image is drawn once at the new zoom. The zoom counts only for an image
   * the camera's view meets (as the exports' `cameraZoomOn`).
   */
  let cameraKey: string | null = null, cameraList: SlideFluximgBinding[] | null = null;
  function restZoom(bs: SlideFluximgBinding[]): void {
    const t = root.style.transform;
    if (t === cameraKey && bs === cameraList) return;
    cameraKey = t; cameraList = bs;
    const m = /translate\(\s*(-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)\s*scale\(\s*([\d.e+-]+)\s*\)/.exec(t);
    const tx = m ? Number(m[1]) : 0, ty = m ? Number(m[2]) : 0, z = m ? Number(m[3]) : 1;
    for (const b of bs) {
      const e = b.element;
      let zoom = 1;
      if (z > 1 && Number.isFinite(z)) {
        const x0 = -tx / z, y0 = -ty / z, x1 = stage ? (stage.width - tx) / z : Infinity, y1 = stage ? (stage.height - ty) / z : Infinity;
        if (e.x < x1 && e.x + e.width > x0 && e.y < y1 && e.y + e.height > y0) zoom = z;
      }
      b.setCameraZoom(zoom);
    }
  }
  function flush(moving = false): void {
    if (disposed) return;
    const bs = list();
    if (!moving) restZoom(bs);
    if (insets) linkInsets(bs);
    for (const b of bs) b.flush();
    // Decode ahead along a playing Change's own path, at a low rate (never per frame).
    const now = performance.now();
    if (now - aheadAt < AHEAD_EVERY_MS) return;
    aheadAt = now;
    for (const b of bs) {
      const m = b.motion;
      if (!m || !(m.raw > 0 && m.raw < 1)) continue;
      const before = lastRaw.get(b) ?? 0; lastRaw.set(b, m.raw);
      const s = b.outSize();
      host.warm(b.element.assetId, m.plan.upcoming(m.raw, m.raw >= before ? 1 : 0, m.ease, AHEAD_PICTURES), s.width, s.height);
    }
  }
  // A plane, a still, a layer file or the colour maps landed: bindings that waited draw now (no frame loop at rest).
  const off = host.onChange(() => { if (!disposed) for (const b of list()) b.refresh(); });
  async function settled(): Promise<void> { await ready(); await Promise.all(list().map((b) => b.settled())); }
  return {
    isReady, ready, flush, settled,
    /** Media playback (the next package): the binding of one image of this slide, for `setIndexOverride` / `flush` /
     *  `decodeAhead` / `settled`. */
    binding: (elementId: string): SlideFluximgBinding | undefined => list().find((b) => b.element.id === elementId),
    destroy() { if (disposed) return; disposed = true; off(); for (const node of nodes(root)) bindings.get(node)?.dispose(); },
  };
}
