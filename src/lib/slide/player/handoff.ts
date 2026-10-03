// Cross-object Become: one retained SVG drawing, no wrapper/layout animation.
import type { BecomeSpec } from "../types";
import type { StageOutline, OutlineOwner } from "../stageOutline";
import type { CorrespondencePlan, CorrespondencePair, SampledPath } from "../correspondence";
import { sampleCorrespondence } from "../correspondence";
import type { MorphController } from "../../plot/project";
import { prefixIds } from "../../plot/parse";
import { pathD, pathRender } from "../../path";
import { warmWhenIdle } from "./transform";
import { createTextMorph, type TextMorph } from "./textMorph";
import type { TextElement } from "../../types";
import type { SlideRenderCtx } from "./render";

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
  text?: { a: TextElement; b: TextElement; render: SlideRenderCtx; durationMs: number };
  /** Insert this flight's layer before that one (a merge's last lander, whose
   *  destination leftovers must lie beneath every co-lander's pieces). */
  beneath?: Element | null;
  /** The track's duration: time-based interiors (a dissolve) run in real ms. */
  durationMs?: number;
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
interface FixedHead { node: SVGElement; points: number[][]; side: StageOutline; start: boolean }
interface PathDrawing { node: SVGPathElement; pair: CorrespondencePair; heads: SVGElement[]; fixed: FixedHead[] }
interface Crossfade { a?: HandoffClone; b?: HandoffClone; pair: CorrespondencePair; aBox: Box; bBox: Box }
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
  const custom = opts.media?.mount?.(layer);
  let readyState = !opts.media && !ctx.glyphs, preparation: Promise<void> | undefined;
  let disposed = false, prepared = false, plan: CorrespondencePlan | undefined, sampled: CorrespondencePlan | undefined;
  let lastPhase = -1;
  const out: SampledPath[] = [], paths: PathDrawing[] = [], crosses: Crossfade[] = [], glyphs: Glyph[] = [];
  const clips = new Map<string, string>();
  // The text-morph layer: camera-local, stage px, BEFORE the flight svg so the
  // flight stays the camera's last child.
  let textLayer: HTMLElement | null = null, textMorph: TextMorph | null = null;
  if (opts.text) {
    textLayer = document.createElement("div");
    textLayer.className = "sl-flight-text";
    textLayer.dataset.handoff = id;
    textLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:visible;visibility:hidden;";
    flight.parentNode?.insertBefore(textLayer, flight);
    textMorph = createTextMorph(opts.text.a, opts.text.b, { layer: textLayer, ctx: opts.text.render, durationMs: opts.text.durationMs });
  }
  /** True while the text morph owns this flight (it never falls back mid-way:
   *  the box crossfade below takes over only if the texts cannot be mapped). */
  const textOwns = () => !!textMorph && !textMorph.failed() && textMorph.ensure();

  function container(pair: CorrespondencePair): SVGElement {
    const owner = pair.b?.owner ?? pair.a!.owner, crop = ctx.crop?.(owner);
    if (!crop) return layer;
    let clipId = clips.get(owner.elementId);
    if (!clipId) {
      clipId = `${id}-clip-${clips.size}`;
      const clip = document.createElementNS(NS, "clipPath"), rect = document.createElementNS(NS, "rect");
      clip.id = clipId; clip.setAttribute("clipPathUnits", "userSpaceOnUse");
      for (const key of ["x", "y", "width", "height"] as const) rect.setAttribute(key, String(crop[key]));
      if (crop.rotation) rect.setAttribute("transform", `rotate(${crop.rotation} ${crop.x + crop.width / 2} ${crop.y + crop.height / 2})`);
      clip.appendChild(rect); layer.appendChild(clip); clips.set(owner.elementId, clipId);
    }
    const g = document.createElementNS(NS, "g"); g.setAttribute("clip-path", `url(#${clipId})`); layer.appendChild(g);
    return g;
  }

  function clone(outline: StageOutline, parent: SVGElement, centered = false): HandoffClone | undefined {
    const mediaClone = opts.media?.clone?.(outline, parent);
    if (mediaClone) return mediaClone;
    const bound = ctx.node(outline.owner);
    const original = bound?.namespaceURI === NS ? bound as SVGGraphicsElement : bound?.querySelector<SVGGraphicsElement>("svg");
    if (!original) return undefined;
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
    prepared = false; paths.length = 0; crosses.length = 0; glyphs.length = 0; boxFades.length = 0; out.length = 0;
    for (const child of Array.from(layer.childNodes)) child.remove();
  }
  /** Live clones held over the flight's ends, on RAW progress over 15 %:
   *  - a shape sliced into letter strips covers its own seams (it dissolves
   *    into the strips leaving, the strips fuse under it landing);
   *  - glyph BOXES (no font outline) crossfade with the live text, so the boxes
   *    land on each letter and then become it (`boxes`: the paths fade too). */
  const boxFades: { clone: HandoffClone; landing: boolean; boxes: boolean }[] = [];

  function ensure(): void {
    if (prepared || disposed) return;
    builtRevision = ctx.glyphs?.revision() ?? -1;
    if (custom) { prepared = true; layer.setAttribute("data-driver", "model3d"); return; }
    plan = opts.plan(); plan.prepare();
    layer.setAttribute("data-driver", plan.driver);
    // Allocate sampling/paint buffers in preparation, including when a first
    // seek beats the idle warm. Every subsequent seek reuses them.
    sampled = plan.driver === "path" ? plan : { ...plan, pairs: plan.pairs.filter(pair => !pair.a) };
    sampleCorrespondence(sampled, 0, out);
    const cloned = new Set<Element>();
    const next = layer.nextSibling;
    layer.remove(); // clone writes must not invalidate the next marker's layout read
    try {
      for (const pair of plan.pairs) {
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
          const a = pair.a ? clone(pair.a, parent) : undefined, b = pair.b ? clone(pair.b, parent) : undefined;
          const aBox = pair.a?.paint.text ? a?.box : pair.a?.bbox, bBox = pair.b?.paint.text ? b?.box : pair.b?.bbox;
          crosses.push({ a, b, pair, aBox: aBox ?? bBox!, bBox: bBox ?? aBox! });
        } else if (plan.driver === "path" || !pair.a) {
          const node = document.createElementNS(NS, "path");
          node.setAttribute("class", "sl-handoff-path"); node.setAttribute("stroke-linejoin", "round");
          // a fill piece of a sliced shape (letter strip, interior triangle) — for probes and gates
          if (pair.a?.owner.role === "slice" || pair.b?.owner.role === "slice") node.setAttribute("data-piece", "slice");
          parent.appendChild(node);
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
                  fixed.push({ node: head, side, start: side === pair.a, points: points.map(([x, y]) => [(x - side.bbox.x) / (side.bbox.w || 1), (y - side.bbox.y) / (side.bbox.h || 1)]) });
                }
              }
            } else {
              for (let i = 0; i < 4; i++) { const head = document.createElementNS(NS, i < 2 ? "polygon" : "polyline"); parent.appendChild(head); heads.push(head); }
            }
          }
          paths.push({ node, pair, heads, fixed });
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
      prepared = true;
    } finally { flight.insertBefore(layer, next); }
  }

  function drawPath(drawing: PathDrawing, sample: SampledPath, u: number, fade = 1): void {
    const { node, pair, heads, fixed } = drawing, p = sample.paint;
    const d = pathD(sample.nodes, sample.closed);
    if (!heads.length) set(node, "d", d);
    set(node, "fill", p.fill); set(node, "stroke", p.stroke);
    set(node, "stroke-width", String(p.strokeWidth)); set(node, "stroke-linecap", p.cap);
    set(node, "stroke-dasharray", p.dash?.join(" ") || "none");
    set(node, "opacity", String(sample.opacity * (p.opacity ?? 1) * fade));
    for (const head of fixed) {
      const a = pair.a?.bbox ?? pair.b!.bbox, b = pair.b?.bbox ?? a;
      const x = lerp(a.x, b.x, u), y = lerp(a.y, b.y, u), w = lerp(a.w, b.w, u), h = lerp(a.h, b.h, u);
      let points = "";
      for (const point of head.points) points += `${point[0] * w + x},${point[1] * h + y} `;
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
    const t = clamp01(u), phase = raw <= 0 ? 0 : raw >= 1 ? 2 : 1;
    if (lastPhase !== phase) {
      for (const entry of sources) { entry.claim.active = phase !== 0; entry.claim.hidden = phase !== 0; }
      for (const entry of destinations) { entry.claim.active = phase !== 0; entry.claim.hidden = phase !== 2; }
      for (const entry of claims) paintVisibility(entry.node, entry.state);
      set(layer, "visibility", phase === 1 ? "visible" : "hidden");
      if (textLayer) textLayer.style.visibility = phase === 1 ? "" : "hidden";
      lastPhase = phase;
    }
    if (phase !== 1) { textMorph?.hide(); return; }
    if (textMorph && textOwns()) {
      // Anything the box fallback drew while the host could not measure yet stays hidden.
      set(layer, "visibility", "hidden");
      const a = opts.text!.a, b = opts.text!.b;
      textMorph.frame(u, raw, { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });
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
    if (paths.length) {
      sampleCorrespondence(sampled!, t, out, { raw, durationMs: opts.durationMs ?? 600 });
      let i = 0;
      for (const drawing of paths) {
        while (sampled!.pairs[i] !== drawing.pair) i++;
        drawPath(drawing, out[i], t, 1 - textWeight);
      }
    }
    const fade = raw < .85 ? 1 : clamp01((1 - raw) / .15);
    for (const glyph of glyphs) {
      set(glyph.node, "transform", `translate(${glyph.x + glyph.dx * t} ${glyph.y + glyph.dy * t}) scale(${1 + glyph.scale * t})`);
      set(glyph.node, "opacity", String(glyph.opacity * fade));
    }
    for (const cross of crosses) {
      const a = cross.aBox, b = cross.bBox;
      const x = lerp(a.x, b.x, t), y = lerp(a.y, b.y, t), w = lerp(a.w, b.w, t), h = lerp(a.h, b.h, t);
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
      textMorph?.dispose(); textLayer?.remove();
      for (const entry of claims) {
        entry.state.claims.delete(entry.claim); paintVisibility(entry.node, entry.state);
        if (!entry.state.claims.size) visibility.delete(entry.node);
      }
    },
  };
}
