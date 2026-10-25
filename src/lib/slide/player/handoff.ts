// Cross-object Become: one retained SVG drawing, no wrapper/layout animation.
import type { BecomeSpec } from "../types";
import type { StageOutline, OutlineOwner } from "../stageOutline";
import type { CorrespondencePlan, CorrespondencePair, SampledPath } from "../correspondence";
import { sampleCorrespondence, pairHeadPoints, arcOffset, planBends, pairProgress } from "../correspondence";
import { dashOffsetAt, strokeEndDirection } from "../outline";
import type { MorphController } from "../../plot/project";
import { prefixIds } from "../../plot/parse";
import { pathD, pathRender } from "../../path";
import { gradientDef, gradientId, gradientSvg } from "../../color/gradient";
import { warmWhenIdle } from "./transform";
import { createTextMorph, layoutForMorph, handoverWeights, HANDOVER_LAYER_STYLE, HANDOVER_PARENT_STYLE, type TextMorph } from "./textMorph";
import { shapeWeights, snapWeights, maxShift, pathPoints, LOOK_TRAVEL } from "./shapeHandover";
import type { TextLook } from "../timing";
import type { TextElement } from "../../types";
import { applyWrapperBox, fillContent, type SlideRenderCtx } from "./render";
import { pairJoin } from "../../strokeStyle";

const NS = "http://www.w3.org/2000/svg";
const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const set = (node: Element, name: string, value: string) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
type Styled = HTMLElement | SVGElement;
type Box = StageOutline["bbox"];
let nextId = 0;

interface VisibilityClaim { order: number; active: boolean; hidden: boolean; initial: boolean }
interface VisibilityState { value: string; priority: string; claims: Set<VisibilityClaim> }
const visibility = new WeakMap<Element, VisibilityState>();
function paintVisibility(node: Styled, state: VisibilityState): void {
  let winner: VisibilityClaim | undefined;
  for (const claim of state.claims) {
    if (!winner || claim.active && !winner.active || claim.active === winner.active &&
      (claim.active ? claim.order > winner.order : claim.order < winner.order)) winner = claim;
  }
  const hidden = winner && (winner.active ? winner.hidden : winner.initial);
  const value = hidden ? "hidden" : state.value, priority = hidden ? "" : state.priority;
  if (node.style.getPropertyValue("visibility") !== value || (node.style.getPropertyPriority?.("visibility") ?? "") !== priority) {
    if (value) node.style.setProperty("visibility", value, priority); else node.style.removeProperty("visibility");
  }
}
function claimVisibility(node: Element, order: number, destination: boolean) {
  let state = visibility.get(node);
  if (!state) {
    const style = (node as Styled).style;
    state = { value: style.getPropertyValue("visibility"), priority: style.getPropertyPriority?.("visibility") ?? "", claims: new Set() };
    visibility.set(node, state);
  }
  const claim: VisibilityClaim = { order, active: false, hidden: destination, initial: destination };
  state.claims.add(claim);
  return { node: node as Styled, state, claim };
}

export interface HandoffCtx {
  /** Bound against each element's current content root, before later tracks. */
  node(owner: OutlineOwner): Element | undefined;
  targetRoot?: HTMLElement;
  /** Story order (beat/start), for chains and reverse hand-offs sharing nodes. */
  order?: number;
  crop?(owner: OutlineOwner): { x: number; y: number; width: number; height: number; rotation: number } | undefined;
  /** Letter outlines in this flight (text ↔ shape): play waits for their fonts,
   *  and a plan built while a font was loading is rebuilt once it lands. */
  glyphs?: { ready(): Promise<void>; revision(): number };
}
export interface HandoffOptions {
  flight: SVGSVGElement;
  sourceNodes: Element[];
  destinationNodes: Element[];
  plan: () => CorrespondencePlan;
  spec: BecomeSpec;
  ctx: HandoffCtx;
  media?: HandoffMedia;
  /** Two whole, unrotated text elements: the glyph-matched text morph flies
   *  their words on a stage-level HTML layer beside the flight SVG instead of
   *  the box crossfade (which stays the fallback when the texts cannot be mapped). */
  text?: { a: TextElement; b: TextElement; render: SlideRenderCtx; durationMs: number; textLook?: TextLook; stage?: { width: number; height: number } };
  /** Insert this flight's layer before that one (a merge's last lander, whose
   *  destination leftovers must lie beneath every co-lander's pieces). */
  beneath?: Element | null;
  /** The track's duration: time-based interiors (a dissolve) run in real ms. */
  durationMs?: number;
  /** The track's `arc` (−1…1, WP 3.3): every flight bends about its centre travel like a box move (correspondence `arcOffset`); a plan held
   *  registered with live cover clones (letter strips, a shattering ring: `planBends`), text glides and 3D media fly straight. */
  arc?: number;
  /** Hand the flight over to copies of the real ends (default). A MERGE's landers share one destination: each would add its own copy of it, so the
   *  group lands as it always has (the pieces cover each other's seams). */
  handover?: boolean;
  /** WP 4.3 `Track.pairLag` (0..1): the pieces of a PATH-driver flight peel off in reading order inside the SAME duration (manim's
   *  lag_ratio). Needs `ease`; the glyph driver, a text morph and 3D media ignore it. */
  pairLag?: number;
  /** The track's own curve (un-held): each piece applies it to its own window, as a unison flight applies it to `raw`. */
  ease?: (p: number) => number;
  /** A merge lander's hold factor (its span / its own duration): the pieces' windows run over the first 1/holdK of raw. */
  holdK?: number;
  /** Elements painted BETWEEN the source and the destination that the flight crosses (player: the flight flies on the upper of the two depths).
   *  A paint order cannot be crossfaded, so the flight passes under them by a VEIL: copies of their own rendered wrappers above the flight,
   *  masked to the flight's coverage (dilated by about a device pixel, so the copies close over its anti-aliased edge) and faded with the
   *  motion's progress: in (`sink`: the destination rests under them) or out (the source rested under them). Both ends are the real paint
   *  order exactly (an opaque cover); the frames between sink the shape under the cover, or raise it out, instead of flipping it at the start. */
  covers?: { wrappers: HTMLElement[]; sink: boolean };
}
export interface HandoffController extends MorphController {
  /** The flight layer this controller draws into (one `g.sl-handoff`). */
  readonly layer: SVGGElement;
  /** A later Appear releases the source's exit without affecting its target. */
  releaseSource(): void;
  isReady(): boolean;
  ready(): Promise<void>;
}
export interface HandoffClone { node: SVGGElement; box: Box; opacity: number }
export interface HandoffMedia {
  mount?(parent: SVGElement): { seek(t: number, raw: number): void; dispose(): void };
  clone?(outline: StageOutline, parent: SVGElement): HandoffClone | undefined;
  ready(): Promise<void>;
  dispose(): void;
}
interface FixedHead { node: SVGElement; points: number[][]; side: StageOutline; start: boolean; dir: [number, number] }
interface PathDrawing { node: SVGPathElement; /** the stroke as a band between two contours (correspondence `band`), drawn over `node` */ band?: SVGPathElement; pair: CorrespondencePair; heads: SVGElement[]; fixed: FixedHead[]; id?: string; defs?: SVGDefsElement; defsMarkup?: string }
let gradientSerial = 0;
interface Crossfade { a?: HandoffClone; b?: HandoffClone; pair: CorrespondencePair; index: number; aBox: Box; bBox: Box; travel: { dx: number; dy: number } }
interface Glyph { node: SVGGElement; x: number; y: number; dx: number; dy: number; scale: number; opacity: number }

export function createHandoff(opts: HandoffOptions): HandoffController {
  const { flight, ctx } = opts, id = `sl-handoff-${++nextId}`;
  const order = ctx.order ?? nextId;
  const sources = opts.sourceNodes.map(node => claimVisibility(node, order, false));
  const destinations = opts.destinationNodes.map(node => claimVisibility(node, order, true));
  const claims = [...sources, ...destinations];
  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("class", "sl-handoff");
  layer.setAttribute("data-handoff", id);
  layer.setAttribute("visibility", "hidden");
  if (opts.beneath && opts.beneath.parentNode === flight) flight.insertBefore(layer, opts.beneath); else flight.appendChild(layer);
  // The veil (opts.covers): built at the flight's first frame from the covers' wrappers as they rest then, removed with the controller.
  let veil: { div: HTMLElement; defs: SVGElement[] } | null = null;
  const VEIL_DILATE = 0.75;   // stage px: a device pixel and more at any stage fit above 1.33 device px per stage px
  function ensureVeil(): HTMLElement | null {
    if (veil || !opts.covers?.wrappers.length || !flight.parentElement) return veil?.div ?? null;
    layer.setAttribute("id", id);
    const fid = `${id}-veil-dilate`, mid = `${id}-veil-mask`;
    const defs = document.createElementNS(NS, "defs");
    const filter = document.createElementNS(NS, "filter");
    for (const [k, v] of [["id", fid], ["filterUnits", "userSpaceOnUse"], ["x", "-1e4"], ["y", "-1e4"], ["width", "2e4"], ["height", "2e4"]]) filter.setAttribute(k, v);
    const dilate = document.createElementNS(NS, "feMorphology"); dilate.setAttribute("operator", "dilate"); dilate.setAttribute("radius", String(VEIL_DILATE));
    filter.appendChild(dilate);
    const mask = document.createElementNS(NS, "mask");
    for (const [k, v] of [["id", mid], ["maskUnits", "userSpaceOnUse"], ["maskContentUnits", "userSpaceOnUse"], ["x", "-1e4"], ["y", "-1e4"], ["width", "2e4"], ["height", "2e4"]]) mask.setAttribute(k, v);
    mask.style.setProperty("mask-type", "alpha");
    const use = document.createElementNS(NS, "use"); use.setAttribute("href", `#${id}`); use.setAttribute("filter", `url(#${fid})`);
    mask.appendChild(use); defs.append(filter, mask); flight.insertBefore(defs, flight.firstChild);
    const div = document.createElement("div");
    div.className = "sl-handoff-veil";
    div.style.cssText = "position:absolute;inset:0;pointer-events:none;visibility:hidden;";
    div.style.setProperty("mask", `url(#${mid})`); div.style.setProperty("-webkit-mask", `url(#${mid})`);
    for (const w of opts.covers.wrappers) {
      const copy = w.cloneNode(true) as HTMLElement;
      // a copy, never an element: no identity the player or a host could find, its internal references renamed with its ids
      for (const n of [copy, ...Array.from(copy.querySelectorAll("[data-el-id]"))]) n.removeAttribute("data-el-id");
      prefixIds(copy, `${id}-veil`);
      copy.style.removeProperty("will-change"); copy.style.removeProperty("visibility");
      div.appendChild(copy);
    }
    flight.after(div);
    veil = { div, defs: [defs] };
    return div;
  }
  const custom = opts.media?.mount?.(layer);
  let readyState = !opts.media && !ctx.glyphs, preparation: Promise<void> | undefined;
  let disposed = false, prepared = false, plan: CorrespondencePlan | undefined, sampled: CorrespondencePlan | undefined;
  /** The arc this plan's flights bend by (decided once, at `ensure`: 0 for a plan that must fly straight) and `arcOffset`'s scratch (no
   *  per-frame allocation). */
  let arc = 0;
  const bend = { x: 0, y: 0 };
  let lastPhase = -1;
  const out: SampledPath[] = [], paths: PathDrawing[] = [], crosses: Crossfade[] = [], glyphs: Glyph[] = [];
  const lagTs: number[] = [], lagRs: number[] = [];   // WP 4.3: the per-piece clocks of a lagged flight, reused every frame
  const clips = new Map<string, string>();
  // The text-morph layer: camera-local, stage px, BEFORE the flight svg so the
  // flight stays the camera's last child.
  let textLayer: HTMLElement | null = null, textMorph: TextMorph | null = null;
  // The flight's own copies of the two endpoint renders (placed by the resting law, exactly as their wrappers are) and the span layer, handed
  // over to each other at both ends (textMorph HANDOVER_EPS): the real source and destination stay hidden for the whole flight.
  let textStatic: { a: HTMLElement; m: HTMLElement; b: HTMLElement } | null = null;
  if (opts.text) {
    textLayer = document.createElement("div");
    textLayer.className = "sl-flight-text";
    textLayer.dataset.handoff = id;
    textLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:visible;visibility:hidden;";
    for (const [k, v] of Object.entries(HANDOVER_PARENT_STYLE)) textLayer.style.setProperty(k, v);
    const fill = (d: HTMLElement, el: TextElement) => {
      const laid = layoutForMorph(el);
      d.replaceChildren(); fillContent(d, laid, opts.text!.render); applyWrapperBox(d, { ...laid, rotation: 0 } as TextElement);
    };
    const copy = (el: TextElement): HTMLElement => {
      const d = document.createElement("div");
      // hidden until the text morph owns the flight (the box crossfade draws the texts when it cannot be mapped)
      d.style.cssText = "position:absolute;box-sizing:border-box;visibility:hidden;";
      for (const [k, v] of Object.entries(HANDOVER_LAYER_STYLE)) d.style.setProperty(k, v);
      fill(d, el);
      return d;
    };
    const m = document.createElement("div");
    m.style.cssText = "position:absolute;inset:0;";
    for (const [k, v] of Object.entries(HANDOVER_LAYER_STYLE)) m.style.setProperty(k, v);
    textStatic = { a: copy(opts.text.a), m, b: copy(opts.text.b) };
    textLayer.append(textStatic.a, m, textStatic.b);
    flight.parentNode?.insertBefore(textLayer, flight);
    // a web font still loading wrapped the copies with fallback metrics (the span layer rebuilds itself the same way): lay them out again once it lands
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts, ends = opts.text;
    if (fonts && fonts.status === "loading") void fonts.ready.then(() => { if (!disposed && textStatic) { fill(textStatic.a, ends.a); fill(textStatic.b, ends.b); } });
    textMorph = createTextMorph(opts.text.a, opts.text.b, { layer: m, ctx: opts.text.render, durationMs: opts.text.durationMs, textLook: opts.text.textLook, stage: opts.text.stage });
  }
  /** True while the text morph owns this flight (it never falls back mid-way:
   *  the box crossfade below takes over only if the texts cannot be mapped). */
  const textOwns = () => !!textMorph && !textMorph.failed() && textMorph.ensure();

  /** Where the flight's own drawings go: the layer, or (a path-only flight) the hand-over's flight group. */
  let root: SVGElement = layer;
  function container(pair: CorrespondencePair): SVGElement {
    const owner = pair.b?.owner ?? pair.a!.owner, crop = ctx.crop?.(owner);
    if (!crop) return root;
    let clipId = clips.get(owner.elementId);
    if (!clipId) {
      clipId = `${id}-clip-${clips.size}`;
      const clip = document.createElementNS(NS, "clipPath"), rect = document.createElementNS(NS, "rect");
      clip.id = clipId; clip.setAttribute("clipPathUnits", "userSpaceOnUse");
      for (const key of ["x", "y", "width", "height"] as const) rect.setAttribute(key, String(crop[key]));
      if (crop.rotation) rect.setAttribute("transform", `rotate(${crop.rotation} ${crop.x + crop.width / 2} ${crop.y + crop.height / 2})`);
      clip.appendChild(rect); layer.appendChild(clip); clips.set(owner.elementId, clipId);
    }
    const g = document.createElementNS(NS, "g"); g.setAttribute("clip-path", `url(#${clipId})`); root.appendChild(g);
    return g;
  }

  function clone(outline: StageOutline, parent: SVGElement, centered = false): HandoffClone | undefined {
    const mediaClone = opts.media?.clone?.(outline, parent);
    if (mediaClone) return mediaClone;
    const bound = ctx.node(outline.owner);
    const original = bound?.namespaceURI === NS ? bound as SVGGraphicsElement : bound?.querySelector<SVGGraphicsElement>("svg");
    // (no layout engine, e.g. a headless linkedom player: nothing to measure, so no copy; the callers fall back to their plain law)
    if (!original || typeof original.getBBox !== "function" || typeof original.getScreenCTM !== "function") return undefined;
    const g = document.createElementNS(NS, "g"), content = document.createElementNS(NS, "g");
    // Read layout once, before the first flight frame. Text anchors supplied by
    // the pure bridge may have no size; the actual glyph run supplies its box.
    const local = original.getBBox();
    const matrix = flight.getScreenCTM()?.inverse().multiply(original.getScreenCTM()!);
    if (!matrix) return undefined;
    const points = [[local.x, local.y], [local.x + local.width, local.y], [local.x + local.width, local.y + local.height], [local.x, local.y + local.height]]
      .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const measured = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const box = outline.paint.text ? measured : outline.bbox;
    // The outline's alpha includes the drawable and its ancestors. A clone
    // already carries alpha inside the copied subtree; only its outside
    // factor belongs on the flight group (otherwise .8 becomes .64).
    let insideOpacity = 1;
    if (outline.owner.partId) {
      let node: Element | null = original.matches("path,circle,ellipse,rect,line,polyline,polygon,text,image") ? original : original.querySelector("path,circle,ellipse,rect,line,polyline,polygon,text,image");
      while (node) {
        const opacity = parseFloat(getComputedStyle(node).opacity);
        if (Number.isFinite(opacity)) insideOpacity *= opacity;
        if (node === original) break;
        node = node.parentElement;
      }
    }
    const copy = original.cloneNode(true) as SVGElement;
    copy.removeAttribute("transform");
    for (const property of ["visibility", "transform", "translate", "scale", "rotate"]) copy.style.removeProperty(property);
    copy.removeAttribute("visibility");
    // A root SVG's CTM already includes its viewBox. Move its children into a
    // group rather than applying a second nested-viewport mapping.
    if (original.tagName.toLowerCase() === "svg") {
      for (const attr of Array.from(copy.attributes)) if (!["viewBox", "width", "height", "x", "y", "preserveAspectRatio", "style"].includes(attr.name)) content.setAttribute(attr.name, attr.value);
      while (copy.firstChild) content.appendChild(copy.firstChild);
    } else {
      const root = original.ownerSVGElement;
      for (const defs of Array.from(root?.querySelectorAll(":scope > defs") ?? [])) content.appendChild(defs.cloneNode(true));
      content.appendChild(copy);
      // Inherited font/paint otherwise disappears when a part leaves its SVG.
      const style = getComputedStyle(original);
      for (const prop of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "letter-spacing"]) copy.style.setProperty(prop, style.getPropertyValue(prop));
    }
    const transform = `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e - measured.x - (centered ? measured.w / 2 : 0)} ${matrix.f - measured.y - (centered ? measured.h / 2 : 0)})`;
    if (centered && original.tagName.toLowerCase() !== "svg") {
      // A glyph needs only its flying group and the original marker. Fold the
      // normalization into the marker's attribute instead of two more groups.
      copy.setAttribute("transform", transform);
      while (content.firstChild) g.appendChild(content.firstChild);
    } else { content.setAttribute("transform", transform); g.appendChild(content); }
    prefixIds(g as unknown as SVGSVGElement, `${id}-clone-${nextId++}`);
    parent.appendChild(g);
    return { node: g, box: { ...box, w: measured.w || box.w, h: measured.h || box.h }, opacity: (outline.paint.opacity ?? 1) / (insideOpacity || 1) };
  }

  let builtRevision = -1;
  /** A plan built while a font was still loading drew letters as boxes:
   *  discard its drawings so the next frame plans real outlines. */
  function invalidateIfStale(): void {
    if (!prepared || !ctx.glyphs || builtRevision === ctx.glyphs.revision()) return;
    prepared = false; paths.length = 0; crosses.length = 0; glyphs.length = 0; boxFades.length = 0; out.length = 0; handover = null; root = layer;
    for (const child of Array.from(layer.childNodes)) child.remove();
  }
  /** Live clones held over the flight's ends, on RAW progress over 15 %:
   *  - a shape sliced into letter strips covers its own seams (it dissolves
   *    into the strips leaving, the strips fuse under it landing);
   *  - glyph BOXES (no font outline) crossfade with the live text, so the boxes
   *    land on each letter and then become it (`boxes`: the paths fade too). */
  const boxFades: { clone: HandoffClone; landing: boolean; boxes: boolean }[] = [];
  /** The hand-over of a flight made of PATHS alone to the real renders at its two ends (shapeHandover.ts): copies of the sources and of the
   *  destinations inside the flight, ADDED (plus-lighter, isolated) with the flight's own layer by distance still to travel, so the way the flight is
   *  rasterised (an exact stroke band, pieces re-cut at other stations than the resting ellipse) never shows as a seam on the first moving frame or
   *  the landing frame. Absent for a flight that carries text, rasters, glyphs, slices or media (their own laws hold the ends). */
  let handover: { host: SVGGElement; flight: SVGGElement; sides: { a: SVGGElement; b: SVGGElement }; a: HandoffClone[]; b: HandoffClone[]; refA: number[][]; refB: number[][]; look: number } | null = null;

  function ensure(): void {
    if (prepared || disposed) return;
    builtRevision = ctx.glyphs?.revision() ?? -1;
    if (custom) { prepared = true; layer.setAttribute("data-driver", "model3d"); return; }
    plan = opts.plan(); plan.prepare();
    arc = opts.arc && planBends(plan) ? opts.arc : 0;
    layer.setAttribute("data-driver", plan.driver);
    // Allocate sampling/paint buffers in preparation, including when a first
    // seek beats the idle warm. Every subsequent seek reuses them.
    sampled = plan.driver === "path" ? plan : { ...plan, pairs: plan.pairs.filter(pair => !pair.a) };
    sampleCorrespondence(sampled, 0, out);
    const cloned = new Set<Element>();
    const next = layer.nextSibling;
    layer.remove(); // clone writes must not invalidate the next marker's layout read
    try {
      // a flight made of path pairs alone hands over to the real renders at its ends (see `handover`)
      const pathLike = (pair: CorrespondencePair) => !(plan!.driver === "glyph" && pair.a) && !(pair.crossfade || pair.a?.paint.text || pair.b?.paint.text || pair.a?.paint.raster || pair.b?.paint.raster) && (plan!.driver === "path" || !pair.a);
      const roles = plan.pairs.some(p => ["glyph-box", "slice"].some(r => p.a?.owner.role === r || p.b?.owner.role === r));
      // ... when it has a seam to hide: a stroke band (a corner Become: the exact band against the path stroker) or pieces cut at other stations than the
      // resting render (a shape split into several, or several merged into one). A plain round pair strokes the SAME path the resting ellipse is, so its ends
      // already agree (R2 F1: 0.0), and copies would only add a layer.
      const owners = new Map<string, number>();
      for (const pair of plan.pairs) for (const side of [pair.a, pair.b]) if (side) { const k = `${side.owner.elementId}|${side.owner.partId ?? ""}`; owners.set(k, (owners.get(k) ?? 0) + 1); }
      const seam = plan.pairs.some(pair => !!pair.band?.()) || [...owners.values()].some(n => n > 1);
      const gradient = plan.pairs.some(pair => [pair.a?.paint, pair.b?.paint].some(paint => !!(paint?.fillMap?.stops?.length || paint?.strokeMap?.stops?.length)));   // gradients keep the old law (see transform.ts handoverFor)
      if (seam && !gradient && plan.pairs.length && plan.pairs.every(pathLike) && !roles && !opts.media && !opts.text && opts.handover !== false) {
        // the end renders: one copy per source and per destination (each placed by the live render's own matrix, the resting law), ADDED to the
        // flight's group in an isolated host
        const host = document.createElementNS(NS, "g"), flightGroup = document.createElementNS(NS, "g");
        host.setAttribute("class", "sl-handover"); for (const [k, v] of Object.entries(HANDOVER_PARENT_STYLE)) host.style.setProperty(k, v);
        // an isolated group is rasterised into a buffer sized to the union of its children, and that union moves with the flight (a piece a hundredth of a
        // pixel outside the copies shifts the buffer's origin off the pixel grid and softens the copies' edges, measured as a 10 stage px^2 step when the flight
        // leaves): a transparent rect over the whole stage pins the bounds
        const [vx, vy, vw, vh] = (flight.getAttribute("viewBox") ?? "0 0 0 0").split(/\s+/).map(Number);
        const stagePin = (painted: boolean) => { const pin = document.createElementNS(NS, "rect"); for (const [k, v] of [["x", vx], ["y", vy], ["width", vw], ["height", vh]] as const) pin.setAttribute(k, String(v)); pin.setAttribute("pointer-events", "none"); if (painted) { pin.setAttribute("fill", "#000"); pin.setAttribute("fill-opacity", "0.0001"); } else pin.setAttribute("fill", "none"); return pin; };
        if (vw > 0 && vh > 0) host.appendChild(stagePin(false));
        // Each ADDED layer (the two ends, the flight) opens with a stage-sized paint at alpha 1e-4 (nothing in 8 bits): Chromium keeps a blend group
        // in its parent's layer only while its pieces merge into one, and pieces spread over the stage (a circle here, a path there) were split
        // into compositor layers of their own, rasterised apart (the end render landed a step softer than the rest: 28 at devicePixelRatio 1.25).
        // One stage-sized first paint makes the group one dense piece.
        const pinned = (group: SVGGElement) => { if (vw > 0 && vh > 0) group.appendChild(stagePin(true)); return group; };
        flightGroup.setAttribute("class", "sl-handover-flight"); for (const [k, v] of Object.entries(HANDOVER_LAYER_STYLE)) flightGroup.style.setProperty(k, v);
        pinned(flightGroup);
        // Each END is ONE added layer: its copies are painted inside it in their own paint order (a part over the part it overlaps), and the
        // hand-over weight is the layer's. Added copy by copy, two overlapping parts summed where they overlap (a logo's touching circles
        // flashed near-white along every overlap at both ends of a Become, the sum of two inks).
        const ends: { a: HandoffClone[]; b: HandoffClone[] } = { a: [], b: [] };
        const sides = { a: document.createElementNS(NS, "g"), b: document.createElementNS(NS, "g") };
        let whole = true;
        for (const side of ["a", "b"] as const) {
          if (side === "b") host.appendChild(flightGroup);
          const group = sides[side];
          group.setAttribute("class", `sl-handover-${side}`); for (const [k, v] of Object.entries(HANDOVER_LAYER_STYLE)) group.style.setProperty(k, v);
          host.appendChild(pinned(group));
          const seen = new Set<string>(), outlines: NonNullable<CorrespondencePair["a"]>[] = [];
          for (const pair of plan.pairs) {
            const outline = pair[side]; if (!outline) continue;
            const key = `${outline.owner.elementId}|${outline.owner.partId ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key); outlines.push(outline);
          }
          // ... in the paint order of the renders they stand for, not the pairing's: a part pairs with whatever lies nearest, so a copy that came
          // first in the pairing was painted under one it overlaps in the real render (the last frame of a line becoming a logo showed a purple
          // circle over the pink it lies under, and the landing swapped them)
          const nodeOf = (o: (typeof outlines)[number]) => ctx.node(o.owner);
          outlines.sort((p, q) => { const a = nodeOf(p), b = nodeOf(q); return !a || !b || a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
          for (const outline of outlines) {
            const copy = clone({ ...outline, paint: { ...outline.paint, text: true } }, group);
            if (!copy) { whole = false; break; }
            copy.node.setAttribute("class", `sl-handover-copy`);
            set(copy.node, "transform", `translate(${copy.box.x} ${copy.box.y})`);
            if (copy.opacity !== 1) set(copy.node, "opacity", String(copy.opacity));
            ends[side].push(copy);
          }
          if (!whole) break;
        }
        if (whole) { layer.appendChild(host); handover = { host, flight: flightGroup, sides, a: ends.a, b: ends.b, refA: [], refB: [], look: 0 }; root = flightGroup; }
      }
      for (const [pairIndex, pair] of plan.pairs.entries()) {
        if (plan.driver === "glyph" && pair.a) {
          const bound = ctx.node(pair.a.owner);
          if (!bound || cloned.has(bound)) continue;
          cloned.add(bound);
        }
        const parent = container(pair);
        if (plan.driver === "glyph" && pair.a) {
          const c = clone(pair.a, parent, true);
          if (!c) continue;
          c.node.setAttribute("class", "sl-handoff-glyph");
          const x = pair.a.bbox.x + pair.a.bbox.w / 2, y = pair.a.bbox.y + pair.a.bbox.h / 2;
          const land = pair.landing ?? { x, y, scale: 1 };
          glyphs.push({ node: c.node, x, y, dx: land.x - x, dy: land.y - y, scale: land.scale - 1, opacity: c.opacity });
        } else if (pair.crossfade || pair.a?.paint.text || pair.b?.paint.text || pair.a?.paint.raster || pair.b?.paint.raster) {
          // A (1-t, t) opacity pair leaves two opaque boxes only 75 % covering at t = .5 (the content dips
          // toward the backdrop). Added in premultiplied space (`plus-lighter`) the pair sums to full
          // coverage. The blend is confined to the PAIR: each two-sided pair gets its own isolated group,
          // so its clones add only to each other, never to a flight path or another pair beneath them.
          // One-sided crossfades (a plain fade in or out) and glyph / piece flights keep plain opacity.
          let host: SVGElement = parent;
          if (pair.a && pair.b) {
            host = document.createElementNS(NS, "g");
            host.setAttribute("data-xfade", ""); host.style.setProperty("isolation", "isolate");
            parent.appendChild(host);
          }
          const a = pair.a ? clone(pair.a, host) : undefined, b = pair.b ? clone(pair.b, host) : undefined;
          const aBox = pair.a?.paint.text ? a?.box : pair.a?.bbox, bBox = pair.b?.paint.text ? b?.box : pair.b?.bbox;
          const from = aBox ?? bBox!, to = bBox ?? aBox!;
          crosses.push({ a, b, pair, index: pairIndex, aBox: from, bBox: to, travel: { dx: to.x + to.w / 2 - from.x - from.w / 2, dy: to.y + to.h / 2 - from.y - from.h / 2 } });
          if (a && b) for (const c of [a, b]) c.node.style.setProperty("mix-blend-mode", "plus-lighter");
        } else if (plan.driver === "path" || !pair.a) {
          const node = document.createElementNS(NS, "path");
          node.setAttribute("class", "sl-handoff-path"); node.setAttribute("stroke-linejoin", pairJoin(pair.a?.paint.join, pair.b?.paint.join, 0));
          // a fill piece of a sliced shape (letter strip, interior triangle) — for probes and gates
          if (pair.a?.owner.role === "slice" || pair.b?.owner.role === "slice") node.setAttribute("data-piece", "slice");
          parent.appendChild(node);
          let band: SVGPathElement | undefined;
          if (pair.band?.()) {
            band = document.createElementNS(NS, "path") as SVGPathElement;
            band.setAttribute("class", "sl-handoff-band"); band.setAttribute("fill-rule", "evenodd"); band.setAttribute("stroke", "none");
            parent.appendChild(band);
          }
          const heads: SVGElement[] = [], fixed: FixedHead[] = [];
          if (pair.a?.paint.arrowStart || pair.a?.paint.arrowEnd || pair.b?.paint.arrowStart || pair.b?.paint.arrowEnd) {
            if (pair.plan?.closed) {
              // An open arrow inflating into a ring keeps its authored head until
              // it fades. The ring has no endpoint at which to synthesize one.
              for (const side of [pair.a, pair.b]) {
                if (!side || side.closed) continue;
                const p = side.paint, geometry = pathRender({ ...p, d: "", nodes: side.nodes, closed: false });
                for (const [filled, geometries] of [[true, geometry.polys], [false, geometry.vees]] as const) for (const points of geometries) {
                  const head = document.createElementNS(NS, filled ? "polygon" : "polyline");
                  head.setAttribute("fill", filled ? p.stroke : "none"); head.setAttribute("stroke", filled ? "none" : p.stroke);
                  head.setAttribute("stroke-width", String(p.strokeWidth)); parent.appendChild(head);
                  // the head rides the stroke end it sits on (the nearer of the first / last node)
                  const f = side.nodes[0], l = side.nodes[side.nodes.length - 1];
                  const cx = points.reduce((m, q) => m + q[0] / points.length, 0), cy = points.reduce((m, q) => m + q[1] / points.length, 0);
                  const at = (cx - f.x) ** 2 + (cy - f.y) ** 2 < (cx - l.x) ** 2 + (cy - l.y) ** 2 ? f : l;
                  fixed.push({ node: head, side, start: side === pair.a, points, dir: strokeEndDirection(side.nodes, at === f) });
                }
              }
            } else {
              for (let i = 0; i < 4; i++) { const head = document.createElementNS(NS, i < 2 ? "polygon" : "polyline"); parent.appendChild(head); heads.push(head); }
            }
          }
          paths.push({ node, band, pair, heads, fixed });
        }
      }
      for (const side of ["a", "b"] as const) for (const role of ["glyph-box", "slice"] as const) {
        const sample = plan.pairs.find(p => p[side]?.owner.role === role)?.[side];
        if (!sample) continue;
        // `text: true` makes the clone place itself by its MEASURED live box (the
        // whole element), not by this strip's or letter's outline box.
        // A sliced plot PART covers with its own node, never the whole plot.
        const live = clone({ ...sample, owner: { elementId: sample.owner.elementId, ...(sample.owner.partId ? { partId: sample.owner.partId } : {}) }, paint: { ...sample.paint, text: true } }, layer);
        if (!live) continue;
        live.node.setAttribute("class", role === "slice" ? "sl-handoff-shape" : "sl-handoff-text");
        boxFades.push({ clone: live, landing: side === "b", boxes: role === "glyph-box" });
      }
      if (handover) {
        // where the flight starts and ends (anchors, stage px) and what changes in place (a colour, a width, a piece that fades in or out)
        const tmp0: SampledPath[] = [], tmp1: SampledPath[] = [];
        // (just inside the flight: the exact endpoints sample the pair's ORIGINAL chains, which have other node counts than the aligned flight chains)
        sampleCorrespondence(sampled, 1e-9, tmp0, { raw: 1e-9, durationMs: opts.durationMs ?? 600, arc }); sampleCorrespondence(sampled, 1 - 1e-9, tmp1, { raw: 1 - 1e-9, durationMs: opts.durationMs ?? 600, arc });
        handover.refA = tmp0.map(sp => pathPoints(sp.nodes)); handover.refB = tmp1.map(sp => pathPoints(sp.nodes));
        let look = 0;
        for (const pair of plan.pairs) {
          const pa = pair.a?.paint, pb = pair.b?.paint;
          if (!pa || !pb) { look = Math.max(look, LOOK_TRAVEL); continue; }
          const diff = (x: unknown, y: unknown) => JSON.stringify(x) !== JSON.stringify(y);
          if (diff([pa.fill, pa.stroke, pa.dash, pa.opacity, pa.fillOpacity, pa.strokeOpacity, pa.fillMap, pa.strokeMap], [pb.fill, pb.stroke, pb.dash, pb.opacity, pb.fillOpacity, pb.strokeOpacity, pb.fillMap, pb.strokeMap])) look = Math.max(look, LOOK_TRAVEL);
          look = Math.max(look, Math.abs((pb.strokeWidth ?? 0) - (pa.strokeWidth ?? 0)));
        }
        handover.look = look;
      }
      prepared = true;
    } finally { flight.insertBefore(layer, next); }
  }

  function drawPath(drawing: PathDrawing, sample: SampledPath, u: number, fade = 1): void {
    const { node, pair, heads, fixed } = drawing, p = sample.paint;
    const d = pathD(sample.nodes, sample.closed);
    if (!heads.length) set(node, "d", d);
    // colormap gradients (own `<defs>` per drawing; the main path used to drop them) and per-channel alpha
    let fillPaint = p.fill, strokePaint = p.stroke;
    if (p.fillMap?.stops?.length || p.strokeMap?.stops?.length) {
      // userSpaceOnUse over the SOURCE ELEMENT's box (lerped to the destination's): a piece of a
      // split/merged shape shows its slice of one ramp, and a zero-extent piece still paints
      const ba = pair.a?.paint.gradBox ?? pair.a?.bbox ?? pair.b!.bbox, bb = pair.b?.paint.gradBox ?? pair.b?.bbox ?? ba;
      const gradBox = { x: lerp(ba.x, bb.x, u), y: lerp(ba.y, bb.y, u), w: lerp(ba.w, bb.w, u), h: lerp(ba.h, bb.h, u) };
      const gid = (which: "fill" | "stroke") => gradientId(drawing.id ??= "ho" + (gradientSerial++), which);
      const defs: string[] = [];
      for (const [which, g] of [["fill", p.fillMap], ["stroke", p.strokeMap]] as const) {
        const def = g?.stops?.length ? gradientDef(gid(which), g, gradBox) : null;
        if (!def) continue;
        defs.push(gradientSvg(def));
        if (which === "fill") fillPaint = `url(#${def.id})`; else strokePaint = `url(#${def.id})`;
      }
      const host = (drawing.defs ??= (() => { const d = document.createElementNS(NS, "defs"); node.parentNode?.insertBefore(d, node); return d; })());
      const markup = defs.join("");
      if (drawing.defsMarkup !== markup) { host.innerHTML = markup; drawing.defsMarkup = markup; }
    } else if (drawing.defs) { drawing.defs.remove(); drawing.defs = undefined; drawing.defsMarkup = undefined; }
    set(node, "fill", fillPaint); set(node, "stroke", strokePaint);
    if (p.fillOpacity != null) set(node, "fill-opacity", String(p.fillOpacity)); else node.removeAttribute("fill-opacity");
    if (p.strokeOpacity != null) set(node, "stroke-opacity", String(p.strokeOpacity)); else node.removeAttribute("stroke-opacity");
    set(node, "stroke-width", String(p.strokeWidth)); set(node, "stroke-linecap", p.cap);
    set(node, "stroke-linejoin", pairJoin(pair.a?.paint.join, pair.b?.paint.join, u)); // T7: the side just left (no corner pop at the swap)
    set(node, "stroke-dasharray", p.dash?.join(" ") || "none");
    // a pair with a band plan paints its stroke as the ring between two contours, over the fill
    if (drawing.band) {
      const b = sample.band;
      if (b) {
        set(node, "stroke", "none"); set(node, "stroke-width", "0");
        set(drawing.band, "d", pathD(b.outer, true) + " " + pathD(b.inner, true));
        set(drawing.band, "fill", strokePaint); drawing.band.removeAttribute("visibility");   // inherit the flight layer's own visibility (an explicit "visible" would show at rest)
        if (p.strokeOpacity != null) set(drawing.band, "fill-opacity", String(p.strokeOpacity)); else drawing.band.removeAttribute("fill-opacity");
        const bandOpacity = sample.opacity * (p.opacity ?? 1) * fade;
        set(drawing.band, "opacity", String(bandOpacity));
        if (bandOpacity > 0) drawing.band.removeAttribute("display"); else set(drawing.band, "display", "none");
      } else set(drawing.band, "visibility", "hidden");
    }
    const shift = pair.plan?.dashShift;
    if (shift != null && pair.b?.paint.dash?.length) set(node, "stroke-dashoffset", String(dashOffsetAt(shift, pair.b.paint.dash, u, pair.plan?.dashReversed)));
    else node.removeAttribute("stroke-dashoffset");
    const opacity = sample.opacity * (p.opacity ?? 1) * fade;
    set(node, "opacity", String(opacity));
    // A piece that is not there (opacity 0) is not drawn at all: an invisible path still widens the bounds of the group it sits in, and that moved the
    // rasterisation of the hand-over's end copies by ~0.1 px (a 10 stage px^2 step when the flight left; R2 F3)
    if (opacity > 0) node.removeAttribute("display"); else set(node, "display", "none");
    // a fixed head rides its chain's support point, which bends with the flight
    const bent = arcOffset(pair.travel, u, arc, bend);
    for (const head of fixed) {
      let points = "";
      for (const point of pairHeadPoints(pair, head.points, head.dir, u, !head.start)) points += `${point[0] + bent.x},${point[1] + bent.y} `;
      set(head.node, "points", points);
      set(head.node, "opacity", String((head.start ? clamp01(1 - u / .4) : clamp01((u - .6) / .4)) * (head.side.paint.opacity ?? 1)));
    }
    if (!heads.length) return;
    const body = { d, nodes: sample.nodes, closed: sample.closed,
      strokeWidth: p.strokeWidth, arrowStart: pair.a?.paint.arrowStart && pair.b?.paint.arrowStart,
      arrowEnd: pair.a?.paint.arrowEnd && pair.b?.paint.arrowEnd, arrowStyle: p.arrowStyle, arrowSize: p.arrowSize };
    set(node, "d", pathRender(body).d);
    const geometry = pathRender({ ...body,
      strokeWidth: p.strokeWidth, arrowStart: pair.a?.paint.arrowStart || pair.b?.paint.arrowStart,
      arrowEnd: pair.a?.paint.arrowEnd || pair.b?.paint.arrowEnd, arrowStyle: p.arrowStyle, arrowSize: p.arrowSize });
    let index = 0;
    for (const which of ["arrowEnd", "arrowStart"] as const) {
      const a = !!pair.a?.paint[which], b = !!pair.b?.paint[which];
      if (!a && !b) continue;
      const opacity = (a && b ? 1 : a ? clamp01(1 - u / .4) : clamp01((u - .6) / .4)) * sample.opacity * (p.opacity ?? 1);
      for (let kind = 0; kind < 2; kind++) {
        const head = heads[index + kind * 2], points = (kind ? geometry.vees : geometry.polys)[index];
        set(head, "points", points?.map(point => point.join(",")).join(" ") ?? "");
        set(head, "fill", kind ? "none" : p.stroke); set(head, "stroke", kind ? p.stroke : "none");
        set(head, "stroke-width", String(p.strokeWidth)); set(head, "opacity", String(opacity));
      }
      index++;
    }
  }

  function seek(u: number, raw = clamp01(u)): void {
    if (disposed) return;
    const t = clamp01(u), tFlight = t, phase = raw <= 0 ? 0 : raw >= 1 ? 2 : 1;
    if (lastPhase !== phase) {
      for (const entry of sources) { entry.claim.active = phase !== 0; entry.claim.hidden = phase !== 0; }
      for (const entry of destinations) { entry.claim.active = phase !== 0; entry.claim.hidden = phase !== 2; }
      for (const entry of claims) paintVisibility(entry.node, entry.state);
      set(layer, "visibility", phase === 1 ? "visible" : "hidden");
      if (textLayer) textLayer.style.visibility = phase === 1 ? "" : "hidden";
      lastPhase = phase;
    }
    if (opts.covers) {
      if (phase !== 1) { if (veil && veil.div.style.visibility !== "hidden") veil.div.style.visibility = "hidden"; }
      else { const div = ensureVeil(); if (div) { div.style.visibility = ""; div.style.opacity = String(Math.round((opts.covers.sink ? t : 1 - t) * 1e6) / 1e6); } }
    }
    if (phase !== 1) { textMorph?.hide(); return; }
    if (textMorph && textOwns()) {
      // Anything the box fallback drew while the host could not measure yet stays hidden.
      set(layer, "visibility", "hidden");
      const a = opts.text!.a, b = opts.text!.b;
      const h = textMorph.frame(u, raw, { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });
      const w = handoverWeights(h), layers = textStatic!;
      for (const [node, weight] of [[layers.a, w.a], [layers.m, w.m], [layers.b, w.b]] as const) {
        const v = weight > 0 ? "" : "hidden", o = weight >= 1 ? "" : String(Math.round(weight * 1e6) / 1e6);
        // the span layer is hidden by its opacity: a span sets its own `visibility`, which a hidden parent does not override
        if (node !== layers.m && node.style.visibility !== v) node.style.visibility = v;
        if (node.style.opacity !== o) node.style.opacity = o;
      }
      return;
    }
    invalidateIfStale();
    ensure();
    if (custom) { custom.seek(t, raw); return; }
    // The box crossfade runs on RAW progress (a phase, never an eased overshoot).
    let textWeight = 0;
    for (const f of boxFades) {
      const w = f.landing ? clamp01((raw - 0.85) / 0.15) : clamp01(1 - raw / 0.15);
      if (f.boxes) textWeight = Math.max(textWeight, w);
      set(f.clone.node, "transform", `translate(${f.clone.box.x} ${f.clone.box.y})`); set(f.clone.node, "opacity", String(w * f.clone.opacity));
    }
    // WP 4.3: a lagged flight gives each piece of a PATH-driver plan its own clock (one array per frame, read by shapes, heads, interiors
    // and crossfades alike); a unison flight shares `t`, byte for byte as before
    const lagged = !!opts.pairLag && opts.pairLag > 0 && !!opts.ease && plan?.driver === "path";
    const flightMs = opts.durationMs ?? 600;
    const share = lagged ? pairProgress(sampled!, Math.min(1, raw * (opts.holdK ?? 1)), opts.pairLag!, opts.ease!, lagTs, lagRs) : 0;
    if (paths.length) {
      sampleCorrespondence(sampled!, t, out, lagged ? { raw, durationMs: flightMs, arc, ts: lagTs, rs: lagRs, ...(share > 0 ? { interiorMs: flightMs * share } : {}) } : { raw, durationMs: flightMs, arc });
      let i = 0;
      for (const drawing of paths) {
        while (sampled!.pairs[i] !== drawing.pair) i++;
        drawPath(drawing, out[i], lagged ? lagTs[i] : t, 1 - textWeight);
      }
      if (handover) {
        // how far the flight has come from its start render and has still to go to its end render (stage px; a change in place counts too)
        let away = t * handover.look, settle = (1 - t) * handover.look;
        for (let i = 0; i < out.length; i++) { const cur = pathPoints(out[i].nodes); away = Math.max(away, maxShift(cur, handover.refA[i])); settle = Math.max(settle, maxShift(cur, handover.refB[i])); }
        const w = snapWeights(shapeWeights(away, settle));
        const put = (node: SVGElement, weight: number, factor = 1) => {
          const o = Math.round(weight * factor * 1e6) / 1e6;   // a weight under a millionth is none: hidden, never an invisible layer that still composites
          // `display`, never `visibility`: a hidden effect group still changes how its siblings are rasterised (the copies' edges moved by ~0.1 px)
          if (o > 0) node.removeAttribute("display"); else set(node, "display", "none");
          if (o !== 1 && o > 0) set(node, "opacity", String(o)); else node.removeAttribute("opacity");
        };
        put(handover.sides.a, w.a);
        put(handover.sides.b, w.b);
        put(handover.flight, w.m);
      }
    }
    const fade = raw < .85 ? 1 : clamp01((1 - raw) / .15);
    for (const glyph of glyphs) {
      const bent = arcOffset(glyph, t, arc, bend);   // a glyph's travel is its own (dx, dy) to the landing
      set(glyph.node, "transform", `translate(${glyph.x + glyph.dx * t + bent.x} ${glyph.y + glyph.dy * t + bent.y}) scale(${1 + glyph.scale * t})`);
      set(glyph.node, "opacity", String(glyph.opacity * fade));
    }
    for (const cross of crosses) {
      const t = lagged ? lagTs[cross.index] : tFlight;
      const a = cross.aBox, b = cross.bBox, bent = arcOffset(cross.travel, t, arc, bend);
      const x = lerp(a.x, b.x, t) + bent.x, y = lerp(a.y, b.y, t) + bent.y, w = lerp(a.w, b.w, t), h = lerp(a.h, b.h, t);
      // A text clone scales UNIFORMLY (by height): glyphs never stretch with a
      // box whose aspect changes; rasters and shapes still fill the lerped box.
      const fit = (c: HandoffClone, text: boolean | undefined) => {
        const sy = h / (c.box.h || 1);
        return `translate(${x} ${y}) scale(${text ? sy : w / (c.box.w || 1)} ${sy})`;
      };
      if (cross.a) {
        set(cross.a.node, "transform", fit(cross.a, cross.pair.a?.paint.text));
        set(cross.a.node, "opacity", String((cross.pair.b ? 1 - t : clamp01(1 - t / .4)) * cross.a.opacity));
      }
      if (cross.b) {
        set(cross.b.node, "transform", fit(cross.b, cross.pair.b?.paint.text));
        set(cross.b.node, "opacity", String((cross.pair.a ? t : clamp01((t - .6) / .4)) * cross.b.opacity));
      }
    }
  }

  warmWhenIdle(() => { if (!disposed && flight.isConnected) { if (!(textMorph && textOwns())) ensure(); } });
  return { seek, layer, targetRoot: ctx.targetRoot,
    isReady: () => readyState,
    ready() { ensure(); return preparation ??= Promise.all([opts.media?.ready(), ctx.glyphs?.ready()]).then(() => {}).finally(() => { readyState = true; }); },
    releaseSource() {
      for (const entry of sources) { entry.claim.hidden = false; paintVisibility(entry.node, entry.state); }
      lastPhase = -1;
    },
    dispose() {
      if (disposed) return;
      disposed = true; custom?.dispose(); opts.media?.dispose(); layer.remove();
      if (veil) { veil.div.remove(); for (const d of veil.defs) d.remove(); veil = null; }
      textMorph?.dispose(); textLayer?.remove();
      if (flight.hasAttribute("data-depth") && !flight.childElementCount) flight.remove();   // a depth surface nothing flies on any more
      for (const entry of claims) {
        entry.state.claims.delete(entry.claim); paintVisibility(entry.node, entry.state);
        if (!entry.state.claims.size) visibility.delete(entry.node);
      }
    },
  };
}
