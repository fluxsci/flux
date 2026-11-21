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
import type { FluximgSurface } from "../../fluximg/slideHost";
import type { PixelRect, ResolvedFurniture, ResolvedLayer } from "../../fluximg/view";
import { planViewTween, withIndex, type TweenPicture, type ViewTweenFrame, type ViewTweenPlan } from "../../fluximg/viewTween";
import { pixelKey, resolveView } from "../../fluximg/viewOps";
// crop.ts, never still.ts: the exported deck's runtime loads this module, and still.ts pulls the reader and renderer.
import { clampCrop, tieredStillSize } from "../../fluximg/crop";
import { cropTransform, FURNITURE_FONT, FURNITURE_WEIGHT, imageStrokeWidth, layerMarkup, namePlacements, namesFontPx, objectIndex, preciseNum, svgNum, type LayerObject } from "../../fluximg/layers";
import { furnitureSvg } from "../../fluximg/furniture";
import { fluximgIdPrefix, layerStyles, layerSvgPath, layerTablePath, PLACEHOLDER_FILL, stylesToDraw, unflipTransform, wantsTable } from "../../fluximg/static";
import { missingStyle, type ObjectLegend, type ObjectStyles } from "../../fluximg/objectStyle";
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

const manifestOf = (ctx: SlideRenderCtx, assetId: string): FluximgManifest | undefined => ctx.fluximg?.manifest(assetId) ?? ctx.fluximgManifest?.(assetId);

/** What a Change's driver (transform.ts, mode "fluximg-live") needs: the frame at (u, raw), and a readiness hook while
 *  the manifest is still loading (play waits for it). */
export interface FluximgTween {
  frame(u: number, raw: number): ViewTweenFrame | null;
  motion(raw: number): { plan: ViewTweenPlan; raw: number; ease: (raw: number) => number } | undefined;
  ready?: { isReady(): boolean; ready(): Promise<void> };
}
export function fluximgTween(pre: FluximgElement, end: FluximgElement, ctx: SlideRenderCtx & { fluximgBlend?: boolean; fluximgEase?: (raw: number) => number }): FluximgTween {
  const blend = !!ctx.fluximgBlend, ease = ctx.fluximgEase ?? ((raw: number) => raw);
  let plan: ViewTweenPlan | undefined;
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
    motion: (raw) => (plan ? { plan, raw, ease } : undefined),
    ...(ready ? { ready } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The vector overlay
// ---------------------------------------------------------------------------------------------

interface LayerGroup { g: SVGGElement; sig: string; tint: boolean; last: Record<string, string | null> }
/** A colour no layer file or style writes: a tinted layer is BUILT in it, then every shape that took it reads the
 *  layer's colour from a custom property instead (styled shapes keep their own colours). */
const TINT_SENTINEL = "#fd03fb";
/** Identity of a table or a styles object in a build signature (the stores hand out the same object until it changes). */
const identities = new WeakMap<object, number>();
let identitySerial = 0;
const identity = (o: object | null | undefined): number => { if (!o) return 0; let n = identities.get(o); if (!n) identities.set(o, n = ++identitySerial); return n; };
interface NamesGroup { g: SVGGElement; sig: string; index: LayerObject[]; nodes: Map<string, SVGTextElement>; place: string }

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
    this.wordsG.append(this.namesG, this.furnG);
    svg.append(this.layersG, this.wordsG);
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

  update(manifest: FluximgManifest, assetId: string, el: FluximgElement, pic: TweenPicture, fade: ViewTweenFrame["furnitureOpacity"], cull: PixelRect): void {
    // The plan's pictures are shared and read-only: the same overlay picture on the same element state is nothing new.
    const L = this.last;
    if (L && L.manifest === manifest && L.el === el && L.pic === pic && L.fade === fade && L.cull === cull) return;
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
    for (const lv of rv.layers) {
      if (lv.kind === "intensity") continue;
      const entry = this.layers.get(lv.id);
      const wanted = lv.visible && lv.opacity > 0;
      if (!wanted) { if (entry) attr(entry.last, entry.g, "display", "none"); continue; }
      const source = this.layerText(manifest, assetId, lv);
      if (!source || source.text === undefined) continue;
      const tint = lv.color !== null;
      // A layer styled by its table (W4 styleBy): per-object colours and opacities, from the same objectStyle cache the
      // element at rest uses; they change only when styleBy, the table or the colour maps change (never per frame).
      const styles = this.stylesOf(source.layer, lv, assetId);
      const sig = `${source.text.length}|${tint ? "tint" : "own"}|${cullKey}|${lv.styleBy ? JSON.stringify(lv.styleBy) : ""}|${identity(styles)}`;
      let group = entry;
      if (!group || group.sig !== sig) {
        group?.g.remove();
        group = this.buildLayer(source.layer, source.text, lv, cull, box, sig, styles);
        this.layers.set(lv.id, group);
        this.order = "";
      }
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

  /** The styles a shown layer is drawn with (null when it is not styled or its table has not landed). */
  private stylesOf(layer: FluximgLayer, lv: ResolvedLayer, assetId: string): ObjectStyles | null {
    if (!wantsTable(lv)) return null;
    const path = layerTablePath(layer);
    const table = path ? this.ctx.fluximgTable?.(assetId, path) : null;
    return stylesToDraw(layerStyles(layer, lv, table, this.ctx.fluximgLut));
  }

  private buildLayer(layer: FluximgLayer, text: string, lv: ResolvedLayer, cull: PixelRect, box: { width: number; height: number }, sig: string, styles: ObjectStyles | null): LayerGroup {
    let markup = "";
    const tint = lv.color !== null;
    // A layer file anyone may have written can be refused by the sanitizer: draw nothing rather than break the slide.
    try { markup = layerMarkup(layer, text, { ...lv, visible: true, opacity: 1, ...(tint ? { color: TINT_SENTINEL } : {}) }, cull, box, this.prefix, styles?.byKey, styles ? missingStyle(lv.styleBy) : null); } catch { markup = ""; }
    const holder = document.createElementNS(SVG, "svg");
    holder.innerHTML = markup;
    const g = (holder.firstElementChild as SVGGElement | null) ?? document.createElementNS(SVG, "g");
    if (tint) {
      // One colour for the whole layer: shapes read it from a custom property, so a colour tween writes ONE style per
      // frame instead of every shape's stroke and fill.
      for (const node of [g, ...Array.from(g.children)]) for (const name of ["stroke", "fill"]) {
        if (node.getAttribute(name) === TINT_SENTINEL) { node.removeAttribute(name); (node as SVGElement).style.setProperty(name, "var(--fx-tint)"); }
      }
      g.style.setProperty("--fx-tint", lv.color!);
    }
    this.layersG.append(g);
    return { g, sig, tint, last: { "--tint": lv.color, transform: g.getAttribute("transform"), "stroke-width": g.getAttribute("stroke-width"), "fill-opacity": g.getAttribute("fill-opacity"), opacity: g.getAttribute("opacity"), display: null } };
  }

  private updateNames(manifest: FluximgManifest, assetId: string, el: FluximgElement, pic: TweenPicture, box: { width: number; height: number }, fade: number | undefined): void {
    const n = pic.view.furniture.names, seen = new Set<string>();
    if (n) for (const id of n.layers) {
      const lv = pic.view.layers.find((l) => l.id === id);
      if (!lv || !lv.visible || lv.kind === "intensity") continue;
      const source = this.layerText(manifest, assetId, lv);
      if (!source || source.text === undefined) continue;
      const color = lv.color ?? source.layer.color ?? "#ffffff";
      const sig = `${source.text.length}|${n.fontSize}|${color}`;
      let group = this.names.get(id);
      if (!group || group.sig !== sig) {
        group?.g.remove();
        const g = document.createElementNS(SVG, "g");
        g.setAttribute("id", `${this.prefix}names.${id}`); g.setAttribute("data-part", "names"); g.setAttribute("fill", color);
        g.setAttribute("font-family", FURNITURE_FONT); g.setAttribute("font-weight", String(FURNITURE_WEIGHT)); g.setAttribute("font-size", svgNum(namesFontPx(n.fontSize)));
        let index: LayerObject[] = [];
        try { index = objectIndex(source.text); } catch { index = []; }
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

  /** The DOM nodes the overlay owns (gates: the same objects before and after a tween). */
  nodes(): Element[] { return [this.layersG, this.wordsG, ...[...this.layers.values()].map((l) => l.g), ...[...this.names.values()].map((n) => n.g)]; }
}

// ---------------------------------------------------------------------------------------------
// The binding
// ---------------------------------------------------------------------------------------------

export interface FluximgMotion { plan: ViewTweenPlan; raw: number; ease: (raw: number) => number }

export interface SlideFluximgBinding {
  readonly root: HTMLElement;
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
  outSize(): { width: number; height: number };
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
  let stillKey = "", failed: Error | undefined;
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
  function outSize(): { width: number; height: number } {
    const scale = Math.max(.01, typeof ctx.pixelScale === "function" ? ctx.pixelScale() : ctx.pixelScale ?? 1);
    const dpr = Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const factor = Math.min(scale * dpr, 4096 / Math.max(1, el.width, el.height));
    return { width: Math.max(1, Math.round(el.width * factor)), height: Math.max(1, Math.round(el.height * factor)) };
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
    const size = tieredStillSize(pic.crop, { width: el.width, height: el.height }, STILL_SCALE);
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
    const live = !!surface?.shown;
    if (live && canvas.style.display !== "block") { canvas.style.display = "block"; stillLayer.style.display = "none"; }
    else if (!live && canvas.style.display !== "none") { canvas.style.display = "none"; stillLayer.style.display = "block"; }
  };

  const handle: SlideFluximgBinding = {
    root, canvas, element,
    get motion() { return motion; },
    set(next, nextFrame = null, nextMotion) {
      el = next; handle.element = next; frame = nextFrame ?? null; motion = nextMotion;
      if (nextMotion && !cullFrom.has(nextMotion.plan)) { cullFrom.add(nextMotion.plan); widen(nextMotion.plan.start.crop); widen(nextMotion.plan.end.crop); }
    },
    outSize,
    refresh() { overlay.invalidate(); handle.flush(); },
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
      const f = withMovie(handle, frame ?? resting(manifest));
      if (!cull) widen(clampCrop(manifest, el.crop));
      overlay.update(manifest, el.assetId, el, f.overlay, f.furnitureOpacity, cull!);
      if (!ctx.fluximg) { showStill(manifest, f.a); return; }
      // The observer reports asynchronously: confirm an offscreen flag against current layout, so a seek's output never
      // depends on the previous frame (T24). Onscreen flags need no layout read.
      if (!intersects && root.getClientRects().length && rectInViewport(root.getBoundingClientRect(), window.innerWidth, window.innerHeight)) intersects = true;
      if (!intersects || !liveVisible(root)) {
        // Hidden surfaces own no backing store and no textures; the still stands in (nobody sees it while hidden).
        surface?.release();
        drawnKey = ""; pending = false; setPending(handle, false);
        showStill(manifest, f.a); publish();
        return;
      }
      const { width, height } = outSize();
      const key = frameKey(manifest, f, width, height);
      // A frame that waited for its planes is drawn by the surface the moment they land: nothing to ask again.
      if (key === drawnKey && pending && surface?.exact) { pending = false; setPending(handle, false); }
      if (key !== drawnKey || pending) {
        if (!surface?.shown) showStill(manifest, f.a);
        surface ??= ctx.fluximg.surface(canvas);
        pending = !surface.draw(el.assetId, f, width, height);
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
      if (!surface || !ctx.fluximg) return;
      await surface.settled();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true; bindingGeneration++;
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
  return handle;
}

// ---------------------------------------------------------------------------------------------
// W6 (movie playback, player/fluximgMedia.ts): a running movie drives ONE dimension over whatever frame the binding
// shows (its resting state or a Change's frame): viewTween.withIndex, the one definition of "the same frame at another
// plane". One WeakMap lookup per flush for a binding without a movie; the composed frame is memoised per (frame, plane)
// so its pictures keep their identity (and their keys) while the plane holds.
// ---------------------------------------------------------------------------------------------
const movieIndex = new WeakMap<SlideFluximgBinding, { dim: string; index: number }>();
const movieMemo = new WeakMap<SlideFluximgBinding, { base: ViewTweenFrame; dim: string; index: number; out: ViewTweenFrame }>();
/** Override the plane of `dim` on a binding (a running or paused movie), or drop the override (Stop: the state's own plane). */
export function setSlideFluximgMovie(binding: SlideFluximgBinding, at: { dim: string; index: number } | null): void {
  if (at) movieIndex.set(binding, at); else { movieIndex.delete(binding); movieMemo.delete(binding); }
}
function withMovie(binding: SlideFluximgBinding, f: ViewTweenFrame): ViewTweenFrame {
  const o = movieIndex.get(binding);
  if (!o) return f;
  const m = movieMemo.get(binding);
  if (m && m.base === f && m.dim === o.dim && m.index === o.index) return m.out;
  const out = withIndex(f, o.dim, o.index);
  movieMemo.set(binding, { base: f, dim: o.dim, index: o.index, out });
  return out;
}
// ---------------------------------------------------------------------------------------------

export function fluximgBindingOf(root: HTMLElement): SlideFluximgBinding | undefined {
  return bindings.get(root) ?? (root.querySelector<HTMLElement>("[data-slide-fluximg-root]") ? bindings.get(root.querySelector<HTMLElement>("[data-slide-fluximg-root]")!) : undefined);
}
export function setSlideFluximgFrame(root: HTMLElement, element: FluximgElement, frame: ViewTweenFrame | null, motion?: FluximgMotion): void {
  fluximgBindingOf(root)?.set(element, frame, motion);
}
/** Flush every image binding under `root` (static renders: each shows the cached still of its sampled state). */
export function flushSlideFluximgs(root: HTMLElement): void {
  for (const node of nodes(root)) bindings.get(node)?.flush();
}

// ---------------------------------------------------------------------------------------------
// The per-slide controller (live hosts only)
// ---------------------------------------------------------------------------------------------

interface ImageChange { beat: number; assetId: string; target: string; plan?: ViewTweenPlan; pre: FluximgElement; end: FluximgElement; blend: boolean; ease: (raw: number) => number }

/** Created by the player for a slide that holds images, and only when a live host is present. Warms what the slide
 *  will show in idle time, gates play until the first frames of each Change can draw, flushes every binding once per
 *  frame, decodes ahead along a playing Change's path, and frees everything with the slide. */
export function createFluximgController(root: HTMLElement, compiled: CompiledSlide, ctx: SlideRenderCtx, onIssue: (target: string, reason: string) => void = () => {}) {
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
    return manifests().then(async () => {
      const list = changes.filter((c) => c.beat >= from && c.beat <= to);
      await Promise.all(list.map((c) => host.ready(c.assetId, first(c), sizeOf(c.pre).width, sizeOf(c.pre).height).catch(() => undefined)));
      for (const c of list) readyBeats.add(c.beat);
    });
  }
  const isReady = (from = 0, to = Number.MAX_SAFE_INTEGER): boolean =>
    [...assets].every((id) => !!host.manifest(id)) && changes.every((c) => c.beat < from || c.beat > to || readyBeats.has(c.beat));
  // Warming is idle work with no deadline: everything stays correct if it never runs.
  idle(() => {
    if (disposed) return;
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
  function flush(): void {
    if (disposed) return;
    const bs = list();
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
    destroy() { if (disposed) return; disposed = true; off(); for (const node of nodes(root)) bindings.get(node)?.dispose(); },
  };
}
