import { elementPaints, gradientSvg } from "../../color/gradient";
// ---------------------------------------------------------------------------
// Flux Slide — the TRANSFORM runtime driver (animation rework §4.3). One
// element tweens from its pre-state (t1) to pre ⊕ to.state (t2). Rides the
// morph seam — a MorphController — so play (rAF), static seek(0|1), scrubbing,
// reduced-motion snap, interruption, and export bundling all come free from
// the player.
//
// Per frame: el = lerpElement(pre, end, t) → wrapper box/transform/opacity
// (exactly renderSlide's wrapper math) → content:
//   • box-only transforms (move/rotate/opacity — the common case) never touch
//     content at all;
//   • content-dirty static elements re-render through the ONE serializer via
//     updateStaticContent — an identity-PRESERVING attribute patch, so inline
//     anim styles (drawOn dash scaffolding) and WAAPI targets on inner
//     geometry survive;
//   • plots update in place (frame compensation + overrides) and delegate
//     data/view changes to the shared projection writer — one track, both halves;
//   • non-interpolable content (text rewrites, closed≠open paths,
//     incompatible plots) CROSSFADES: two stacked content layers, opacity
//     cross-lerped, while the box still lerps — the fallback moves, it never
//     pops. The pre layer keeps the ORIGINAL nodes (moved, not cloned) so
//     earlier inner-node animations stay attached.
//
// Dash-residue rule (the morph lesson): a geometry-dirty transform clears
// stale inline dash on the geometry it rewrites at t>0; at t=0 the dash stays
// (drawOn's pre-beat hidden state needs it).
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import type { Element as FigElement, SemanticPlotElement } from "../../types";
import { plotDom, plotManifests } from "../../plot/store";
import { applyOverrides, partDomId } from "../../plot/parse";
import { compensatePtTrue, restorePtTrue, compilePtTrueBindings, svgIntrinsicPx, cropViewBoxValue } from "../../plot/compensate";
import { applyTextLayout } from "../../text";
import type { FluxPlotManifest } from "../../plot/types";
import { elementBBox, dashAttr, channelOpacity } from "../../geometry";
import { pathRender, pathD } from "../../path";
import { lerpElement, overshootBox, arcBox, contentPlan, type ContentPlan, tweenColorScales } from "../tween";
import { planElementMorph, sampleElementMorph, sampleStrokeBand, arrowFade, fixedHeadOpacity, fixedHeadPoints, dashOffsetAt, type ElementMorphPlan, type BandSample } from "../outline";
import { seriesAxes, seriesTweenable, viewFits, type MorphController } from "../../plot/project";
import { applyPlotView, preparePlotView, restoreProjection, type PlotViewOptions } from "../../plot/projectDom";
import { applyPlotColorScale } from "../../plot/colorScaleDom";
import { applyPlotTheme, plotFollowsTheme } from "../../plot/themeDom";
import { ghostEmergence } from "../ghost";
import { createTextMorph, layoutForMorph, handoverWeights, HANDOVER_LAYER_STYLE, HANDOVER_PARENT_STYLE, type TextMorph } from "./textMorph";
import { shapeWeights, snapWeights, maxShift, LOOK_TRAVEL } from "./shapeHandover";
import type { GlyphProvider } from "./glyphProvider";
import type { TextLook } from "../timing";
import { elementStageOutlines } from "../targetGeometry";
import { planCorrespondence, sampleCorrespondence, type CorrespondencePlan, type SampledPath } from "../correspondence";
import { hasOutline } from "../outline";
import type { TextElement } from "../../types";
import { morphJoin, pairJoin } from "../../strokeStyle";
import { barGrow, type BarGrow } from "../growOrigin";
import { applyWrapperBox, applyWrapperBoxComposite, layoutBoxOf, pureMove, rigidFlight, promoteMovingWrapper, settleWrapper, compilePlotContent, compileStaticContent, compileGhostPartOpacity, updateStaticContent, fillContent, type SlideRenderCtx } from "./render";
import { modelBindingOf, modelContentFrame, modelFieldEndpoints, setSlideModelFrame } from "./model3d";

/** Stage px an invisible stroke inflates a band's ink bounds by (see `bandNode`): enough for a device pixel at any presentation scale >= 1/4. */
const BAND_INK_GUARD = 8;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface TransformCtx extends SlideRenderCtx {
  arc?: number;
  /** Effective source content after earlier cues (may be a crossfade layer). */
  contentHost?: HTMLElement;
  /** assetId → manifest (plot frame updates + the content-morph half). */
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  /** Wrapper props an overlapping same-beat appearance owns (conflict rule —
   *  the transform drops them; the appearance wins for the overlap). */
  skipProps?: ReadonlySet<string>;
  /** The track's duration (the text morph's stagger is bounded in real time). */
  durationMs?: number;
  /** Letter outlines (player/glyphProvider.ts): a text ↔ drawn-shape retype
   *  pours the shape into the letters instead of crossfading. */
  glyphs?: GlyphProvider;
  /** The track's authored text look (`resolveTextLook(track.params)`): leftover fade style and letter flights of a text
   *  rewrite. Absent = today's drift / fade. Every host that plays tracks resolves it the same way (player.ts). */
  textLook?: TextLook;
  /** The stage size: text-morph glide lanes keep ink on stage. */
  stage?: { width: number; height: number };
  /** This is a Ghost's BIRTH flight (the copy leaves its source): its ink emerges with its separation from the source (ghost.ts, the Ghost law). */
  ghost?: boolean;
}

/** The wrapper's local CSS frame in stage px for a frame of state `el`: where its
 *  (0,0) sits and how many stage px one local px spans. Composite frames keep the
 *  frozen base box and scale it onto the exact box; a frame whose transform an
 *  appearance owns rests in the rounded box unscaled (render.ts placement law). */
function wrapperFrame(el: FigElement, base: { x: number; y: number; w: number; h: number }, composite: boolean) {
  const bb = elementBBox({ ...el, rotation: 0 });
  if (composite) return { bb, ox: bb.x, oy: bb.y, sx: Math.max(bb.w, 1) / Math.max(base.w, 1), sy: Math.max(bb.h, 1) / Math.max(base.h, 1), w: Math.max(base.w, 1), h: Math.max(base.h, 1) };
  const lb = layoutBoxOf(bb);
  return { bb, ox: lb.x, oy: lb.y, sx: 1, sy: 1, w: lb.w, h: lb.h };
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Run `job` once the browser is genuinely idle, or on the next macrotask
 *  where there is no idle callback (headless). Deliberately NO idle deadline:
 *  a deadline makes the browser run the job whether or not it has time, which
 *  would let warming compete with the canvas snapshot's own idle callback on a
 *  busy page. Warming work only — every caller must stay correct if it never
 *  runs at all, and on a page too busy to ever go idle, that is the right
 *  answer rather than a stolen frame. */
export function warmWhenIdle(job: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void) => number; setTimeout?: typeof setTimeout };
  if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(job);
  else if (typeof g.setTimeout === "function") g.setTimeout(job, 0);
}

/** The transform controller that last wrote a content host's static markup (per element,
 *  across beats): an endpoint repaint is skipped only while the same controller still owns
 *  the content (see the endpoint rule in seek). */
const contentWriter = new WeakMap<HTMLElement, object>();

/** One id per transform instance: the original markup, the M layer and the B layer of a
 *  Become each define `fxg-<id>-fill` for the SAME element id, and `url(#id)` resolves to
 *  the FIRST definition in the document (a frozen or wrong gradient). Each gets a suffix. */
let transformSerial = 0;
/** Re-id every gradient definition under `host`, and the `fill`/`stroke` url() references beside
 *  them, with `suffix`. Identity when `host` defines none. */
function namespaceGradients(host: Element, suffix: string): void {
  const ids = new Map<string, string>();
  for (const n of Array.from(host.querySelectorAll('[id^="fxg-"]'))) { ids.set(n.id, n.id + suffix); n.id = n.id + suffix; }
  if (!ids.size) return;
  for (const n of Array.from(host.querySelectorAll("*"))) for (const attr of ["fill", "stroke"]) {
    const m = /^url\(#([^)]+)\)$/.exec(n.getAttribute(attr) ?? "");
    if (m && ids.has(m[1])) n.setAttribute(attr, `url(#${ids.get(m[1])})`);
  }
}

/** Keyed bars present in only ONE of the two plot versions, by their manifest bar id (the binder's semantic key) -> the baseline
 *  edge they grow from / shrink to (WP 2.3, D8a). Bars paired by key keep morphing in place. A bar's baseline is read through
 *  `barGrow` from the manifest that lists it, so a Change grows a bar exactly as the `growBaseline` entrance would. */
function unpairedBars(a?: FluxPlotManifest, b?: FluxPlotManifest): Map<string, BarGrow> {
  const out = new Map<string, BarGrow>();
  const ids = (m?: FluxPlotManifest) => new Set((m?.series ?? []).flatMap(s => s.svg?.bars ?? []));
  const inA = ids(a), inB = ids(b);
  for (const [m, other] of [[a, inB], [b, inA]] as const) for (const id of ids(m)) if (!other.has(id)) out.set(id, barGrow(m, id));
  return out;
}

export function createTransform(
  wrap: HTMLElement,
  source: FigElement,
  destination: FigElement,
  ctx: TransformCtx,
): MorphController {
  const [pre, end] = source.type === "model3d" && destination.type === "model3d" ? modelFieldEndpoints(source, destination, ctx) : [source, destination];
  const gradSuffix = "-t" + ++transformSerial;
  const plan: ContentPlan = contentPlan(pre, end);
  // A video is stretched by its retained element. Re-serializing width/height
  // Changes would replace its decoder and restart playback every frame.
  if (pre.type === "video" && end.type === "video") plan.contentDirty = false;
  const isPlot = pre.type === "plot" && end.type === "plot";
  const manifest = (id: string) => ctx.plotManifest ? ctx.plotManifest(id) : get(plotManifests)[id];
  const manifestA = pre.type === "plot" ? manifest(pre.assetId) : undefined;
  const manifestB = end.type === "plot" ? manifest(end.assetId) : undefined;
  const assetChange = isPlot && pre.assetId !== end.assetId;
  // an image whose picture changes crossfades (a stepped href would pop)
  if (pre.type === "image" && end.type === "image" && pre.assetId !== end.assetId) {
    plan.mode = "crossfade";
    plan.contentDirty = true;
  }
  // BECOME between drawn kinds: the outline morph (one live path between the
  // real start and end markup). No plan (degenerate geometry) → crossfade.
  const morphPlan: ElementMorphPlan | null = plan.mode === "morph" ? planElementMorph(pre, end) : null;
  if (plan.mode === "morph" && !morphPlan) plan.mode = "crossfade";
  const contentHost = ctx.contentHost ?? (wrap as HTMLElement & { __slideEffects?: HTMLElement }).__slideEffects ?? wrap;
  // This driver's OWN content node, taken before any later driver of the same element exists. A later Change that rewrites the text
  // (or any layered driver) moves these nodes into its A layer, after which `contentHost.firstElementChild` is that layer: an endpoint
  // repaint through the host would then wipe the later driver's layers and detach this driver's compiled updater (a resize whose text
  // stretched in flight and snapped at landing, and a later rewrite that started from a different picture than the rest it followed).
  const ownContent = contentHost.firstElementChild;
  const ownHost = (): HTMLElement => (ownContent && ownContent.parentElement as HTMLElement | null) || contentHost;
  const staticUpdate = pre.type !== "plot" && plan.contentDirty && plan.mode === "tween"
    ? compileStaticContent(contentHost, pre, end, ctx) : null;
  // Text wrapping can change node topology as metrics change. Keep that
  // deliberate fallback; shape topology changes use prebuilt crossfade layers.
  if (pre.type !== "plot" && pre.type !== "text" && plan.contentDirty && !staticUpdate && plan.mode === "tween") plan.mode = "crossfade";
  const skip = ctx.skipProps;
  const boxOpts = {
    skipOpacity: skip?.has("opacity") ?? false,
    skipTransform: skip?.has("transform") ?? false,
  };
  // The frozen layout box for mid-flight composite frames (= the t1 box the
  // t≤0 endpoint writes). When a same-beat appearance owns the wrapper
  // transform (skipTransform), composite motion is impossible — those rare
  // overlaps keep the classic per-frame layout path.
  // Whole stage pixels, like every resting layout box (render.layoutBoxOf):
  // the composite translate then carries the exact fraction, so frames and
  // endpoints agree to the sub-pixel and nothing snaps at either end.
  const baseBox = layoutBoxOf(elementBBox({ ...pre, rotation: 0 }));
  // An outline morph is a Become between two boxes: the composite is laid on the START's layout box for the first half and on the END's for the
  // second, so the last flight frame is exactly the end's rest law (layout box + the same composite form) and the landing does not change the
  // wrapper's raster (a 12 px ring landing on a different layout box moved its edge by 10 stage px^2 at the swap to the rest box).
  const endBaseBox = layoutBoxOf(elementBBox({ ...end, rotation: 0 }));
  // A pure move rides its own compositor layer for the flight (render.ts,
  // layer hygiene): rasterized once, moved at float precision — text glides
  // instead of stepping, heavy content moves without repainting. Demoted at
  // the endpoints, so rest is always painted in place.
  const glide = !boxOpts.skipTransform && pureMove(pre, end);
  // The player gives a driver's wrapper a flight MARK (a compositor layer baked at rest) for a beat in which it really MOVES: a recolour of the same
  // box is a pure move with no displacement, and a layer for it only costs a step later. A TEXT also rides the mark for a TURN (alone, or with a move:
  // same box, nothing rewritten): unpromoted, a turning text flips between its hinted axis-aligned raster and an unhinted rotated one (a 9 to 66
  // stage px^2 jump at the first frames, ragged all along); on the mark it turns smoothly and lands on the fresh render. Vector shapes rasterise
  // the same either way (a mark on them only adds a first-frame step and a bitmap-soft landing), so they paint in place.
  const displaced = (() => { const a = elementBBox({ ...pre, rotation: 0 }), b = elementBBox({ ...end, rotation: 0 }); return a.x !== b.x || a.y !== b.y; })();
  const turned = pre.rotation !== end.rotation || !!pre.flipX !== !!end.flipX || !!pre.flipY !== !!end.flipY;
  const marks = (glide && displaced) || (pre.type === "text" && !boxOpts.skipTransform && !plan.contentDirty && rigidFlight(pre, end) && (displaced || turned));

  // --- plot half: one projection writer for new data, a new view, or both --
  const sourceRoot = pre.type === "plot" ? (ctx.plotRoot ? ctx.plotRoot(pre.assetId) : plotDom.get(pre.assetId)) : undefined;
  const targetRoot = end.type === "plot" ? (ctx.plotRoot ? ctx.plotRoot(end.assetId) : plotDom.get(end.assetId)) : undefined;
  const project = isPlot &&
    (assetChange || plan.contentDirty && (!!pre.view || !!end.view));
  // The complete binding supplies pristine asset geometry and paint. It must
  // not bake endpoint compensation or views: those belong to this frame's
  // override → projection → compensation pipeline below.
  const neutralPlot = (el: SemanticPlotElement, root: Element | undefined): SemanticPlotElement => {
    const size = root ? svgIntrinsicPx(root) : { w: el.width, h: el.height };
    return { ...el, width: size.w, height: size.h, crop: undefined, contentScale: 1, overrides: undefined, view: undefined };
  };
  // A custom/legacy manifest may carry no series: nothing to project, never a throw.
  const bSeries = new Map(manifestB?.series?.map(s => [s.id, s]));
  const dataSeries = manifestA?.series?.filter(a => !assetChange || !!manifestB && seriesTweenable(a, bSeries.get(a.id), seriesAxes(manifestA, a), bSeries.has(a.id) ? seriesAxes(manifestB, bSeries.get(a.id)!) : undefined)) ?? [];
  const plotUpdate = project ? compilePlotContent(contentHost,
    neutralPlot(pre as SemanticPlotElement, sourceRoot), neutralPlot(end as SemanticPlotElement, targetRoot), ctx, {
      circles: new Set(dataSeries.flatMap(s => (s.points ?? []).map(p => partDomId(pre.id, p.svgId)))),
      lines: new Set(dataSeries.flatMap(s => s.svg?.line ? [partDomId(pre.id, s.svg.line)] : [])),
      growFrom: assetChange ? unpairedBars(manifestA, manifestB) : undefined,
    }) : null;
  // Only unaddressable (raster/id-less) plots need a whole-content crossfade.
  if (project && !plotUpdate) plan.mode = "crossfade";
  if (project) plan.contentDirty = true;
  const projectionOptions: PlotViewOptions | undefined = project && manifestA ? {
    t: 0, from: viewFits(manifestA!, (pre as SemanticPlotElement).view) ?? undefined,
    to: viewFits(manifestB ?? manifestA!, (end as SemanticPlotElement).view) ?? undefined,
    fromView: (pre as SemanticPlotElement).view, toManifest: manifestB,
    sourceRoot, targetRoot, geometryInterpolated: true, assetChange,
    // a Change whose start or end view re-ticks an axis hands the generated ticks off to the nice ones in flight (projectDom buildFlight),
    // an asset Change included (each side's set is read from its own version); an axis no view re-ticks keeps the guide pairing of the
    // two manifests
    tickHandoff: true,
    ...(assetChange ? { series: (a: import("../../plot/types").FluxPlotSeries) => bSeries.get(a.id) ?? null } : {}),
  } : undefined;
  const intrinsic = (() => {
    if (!isPlot) return null;
    const cached = (ctx.plotRoot ? ctx.plotRoot((pre as SemanticPlotElement).assetId) : plotDom.get((pre as SemanticPlotElement).assetId));
    return cached ? svgIntrinsicPx(cached) : null;
  })();
  const naturalViewBox = (() => {
    if (!isPlot) return null;
    const cached = (ctx.plotRoot ? ctx.plotRoot((pre as SemanticPlotElement).assetId) : plotDom.get((pre as SemanticPlotElement).assetId));
    return cached?.getAttribute("viewBox") ?? null;
  })();
  const plotSvg = isPlot ? contentHost.querySelector("svg") : null;
  const ghostOpacity = plotSvg ? compileGhostPartOpacity(plotSvg, pre, ctx) : undefined;
  if (plotSvg && projectionOptions) {
    // The hand-off tick pool is CLONED from the guide templates at bind time, so the templates must be pristine: the static
    // render already pt-true-compensated them, and a clone of a compensated template would be compensated twice.
    restorePtTrue(plotSvg);
    preparePlotView(plotSvg, manifestA, (end as SemanticPlotElement).view, pre.id, projectionOptions);
  }
  const ptTrueBindings = plotSvg ? compilePtTrueBindings(plotSvg) : undefined;

  // --- crossfade layers (built lazily on the first seek that needs them) ----
  let faded = false;
  let layerA: HTMLElement | null = null;
  let layerB: HTMLElement | null = null;
  function ensureLayers(): void {
    if (faded) return;
    faded = true;
    const mk = (): HTMLElement => {
      const d = document.createElement("div");
      d.style.cssText = "position:absolute;inset:0;";
      return d;
    };
    layerA = mk();
    layerB = mk();
    // A (1-t, t) opacity pair leaves an opaque box only 75 % covering at t = .5 (the content dips toward the
    // backdrop). Added in premultiplied space (plus-lighter) inside contentHost's OWN stacking context the pair
    // sums to full coverage; contentHost holds nothing but these two layers, so nothing else is blended. The
    // blend is set once, with the layers, and never toggled: the resting render before, during and after the
    // swap goes through the same compositing path, so no endpoint changes how the content is rasterized.
    contentHost.style.setProperty("isolation", "isolate");
    layerA.style.setProperty("mix-blend-mode", "plus-lighter");
    layerB.style.setProperty("mix-blend-mode", "plus-lighter");
    // move (never clone) the existing content into layer A — inner-node
    // animations from earlier beats stay attached to their live targets.
    while (contentHost.firstChild) layerA.appendChild(contentHost.firstChild);
    // layer B renders the END content once through the ONE renderer; both
    // layers stretch with the wrapper (fillContent svgs are 100% + none-
    // preserveAspectRatio), so even the fallback moves with the box.
    fillContent(layerB, end, ctx);
    namespaceGradients(layerB, gradSuffix);
    contentHost.appendChild(layerA);
    contentHost.appendChild(layerB);
  }


  // --- the outline-morph layers (Become between drawn kinds) ----------------
  // A = the ORIGINAL nodes, moved (never cloned) so earlier inner-node
  //     animations stay attached; shown only at t = 0.
  // M = one live <path> (+ arrowhead nodes) written per frame from the pure
  //     sampler — no serialization, parsing or selectors on the frame path.
  // B = the end markup through the ONE serializer; shown at t = 1 and the
  //     root later tracks bind to.
  let morphLayers: { A: HTMLElement; M: HTMLElement; B: HTMLElement; svg: SVGSVGElement; body: SVGPathElement; band: SVGPathElement | null;
    heads: { start: { poly: SVGPolygonElement; vee: SVGPolylineElement } | null; end: { poly: SVGPolygonElement; vee: SVGPolylineElement } | null };
    fixed: (SVGPolygonElement | SVGPolylineElement)[] } | null = null;
  function ensureMorphLayers(): NonNullable<typeof morphLayers> {
    if (morphLayers) return morphLayers;
    const mk = (): HTMLElement => {
      const d = document.createElement("div");
      d.style.cssText = "position:absolute;inset:0;";
      return d;
    };
    const A = mk(), M = mk(), B = mk();
    while (contentHost.firstChild) A.appendChild(contentHost.firstChild);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.overflow = "visible";
    svg.style.display = "block";
    const body = document.createElementNS(SVG_NS, "path");
    body.setAttribute("stroke-linejoin", morphJoin(pre, end, 0));
    svg.appendChild(body);
    // (the stroke band node, when the pair has one, is created on the first flight frame: `bandNode` below)
    const head = (): { poly: SVGPolygonElement; vee: SVGPolylineElement } => {
      const poly = document.createElementNS(SVG_NS, "polygon");
      const vee = document.createElementNS(SVG_NS, "polyline");
      vee.setAttribute("fill", "none");
      vee.setAttribute("stroke-linecap", "round");
      vee.setAttribute("stroke-linejoin", "round");
      svg.appendChild(poly);
      svg.appendChild(vee);
      return { poly, vee };
    };
    const heads = { start: morphPlan!.arrowStart ? head() : null, end: morphPlan!.arrowEnd ? head() : null };
    // inflate: the stroke side's heads ride along mapped into the box and fade
    const fixed = morphPlan!.fixedHeads.map((h) => {
      const node = document.createElementNS(SVG_NS, h.filled ? "polygon" : "polyline");
      if (!h.filled) { node.setAttribute("fill", "none"); node.setAttribute("stroke-linecap", "round"); node.setAttribute("stroke-linejoin", "round"); }
      svg.appendChild(node);
      return node;
    });
    M.appendChild(svg);
    fillContent(B, end, ctx);
    namespaceGradients(B, gradSuffix);
    contentHost.appendChild(A);
    contentHost.appendChild(M);
    contentHost.appendChild(B);
    morphLayers = { A, M, B, svg, body, band: null, heads, fixed };
    return morphLayers;
  }
  function showMorphLayer(raw: number, w = { a: 0, m: 1, b: 0 }): void {
    const L = ensureMorphLayers();
    if (raw <= 0) w = { a: 1, m: 0, b: 0 }; else if (raw >= 1) w = { a: 0, m: 0, b: 1 };
    for (const [node, weight] of [[L.A, w.a], [L.M, w.m], [L.B, w.b]] as const) {
      const v = weight > 0 ? "" : "hidden", o = weight >= 1 || weight <= 0 ? "" : String(Math.round(weight * 1e6) / 1e6);
      if (node.style.visibility !== v) node.style.visibility = v;
      if (node.style.opacity !== o) node.style.opacity = o;
    }
  }
  /** A Become whose stroke is a BAND hands over to the real renders at its ends: the exact band against the path stroker (a ring) differs by ~0.1 px along
   *  the whole edge, a seam on the first moving frame and the landing frame. A pair without one strokes the same path the resting shape is (no seam, no
   *  layer). Decided at the first flight frame (planning the band never costs the first preview), then the layers are ADDED with distance weights
   *  (shapeHandover.ts): the host isolated and the three layers plus-lighter, set once and never toggled. */
  let handoverOn: boolean | null = null;
  function handoverFor(): boolean {
    if (handoverOn !== null) return handoverOn;
    // (a gradient paint keeps the old law: the browser rounds a gradient one to two levels differently inside an alpha layer than in the direct paint, a
    // second-frame step of 223,000 px at 2 levels on the Release 1 deck's viridis fill, far above the 0.1 px seam it would hide)
    const gradient = (st: { fillMap?: unknown; strokeMap?: unknown }) => !!(st.fillMap || st.strokeMap);
    handoverOn = !!morphPlan!.band?.() && !gradient(morphPlan!.preStyle) && !gradient(morphPlan!.endStyle);
    if (handoverOn) {
      const L = ensureMorphLayers();
      for (const [k, v] of Object.entries(HANDOVER_PARENT_STYLE)) contentHost.style.setProperty(k, v);
      for (const layer of [L.A, L.M, L.B]) for (const [k, v] of Object.entries(HANDOVER_LAYER_STYLE)) layer.style.setProperty(k, v);
    }
    return handoverOn;
  }
  /** The stage-px anchors of the flight's own two ends (sampled once), for the hand-over distances. */
  let morphEnds: { a: number[]; b: number[]; look: number; turn: number } | null = null;
  const anchorsOf = (el: FigElement): number[] => {
    const out: number[] = [];
    if (el.type === "path") for (const n of el.nodes ?? []) out.push(el.x + n.x, el.y + n.y);
    return out;
  };
  /** How far this flight frame is from its start render and from its end render (stage px; every term of change counts). */
  function morphDistances(frame: FigElement, t: number): { away: number; settle: number } {
    const plan = morphPlan!;
    if (!morphEnds) {
      const A = sampleElementMorph(plan, 0), B = sampleElementMorph(plan, 1), ps = plan.preStyle, es = plan.endStyle;
      const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
      const lookDiffers = !same([ps.fill, ps.stroke, ps.dash, plan.pre.opacity, (plan.pre as { fillOpacity?: number }).fillOpacity, (plan.pre as { strokeOpacity?: number }).strokeOpacity],
        [es.fill, es.stroke, es.dash, plan.end.opacity, (plan.end as { fillOpacity?: number }).fillOpacity, (plan.end as { strokeOpacity?: number }).strokeOpacity]) || !same(ps.fillMap, es.fillMap) || !same(ps.strokeMap, es.strokeMap);
      const radius = Math.max(plan.preBox.w, plan.preBox.h, plan.endBox.w, plan.endBox.h) / 2;
      morphEnds = { a: anchorsOf(A), b: anchorsOf(B), look: (lookDiffers ? LOOK_TRAVEL : 0) + Math.abs(es.strokeWidth - ps.strokeWidth),
        turn: Math.abs((plan.end.rotation ?? 0) - (plan.pre.rotation ?? 0)) * Math.PI / 180 * radius };
    }
    const cur = anchorsOf(frame), e = morphEnds;
    return { away: Math.max(maxShift(cur, e.a), t * (e.look + e.turn)), settle: Math.max(maxShift(cur, e.b), (1 - t) * (e.look + e.turn)) };
  }
  // the last `<defs>` markup written (innerHTML never round-trips: SVG serializes `</stop>` end tags)
  let morphDefsMarkup = "";
  let bandSamples: BandSample | undefined;   // the band's reusable contour nodes
  let bandChecked = false;
  /** The stroke drawn as a BAND between two morphing contours (outline.ts planStrokeBand), when the pair has one: the body then paints the fill only.
   *  The band is a FILL, and a fill's ink bounds are tight: the compositor layer this driver promotes snaps its bounds to device pixels and clips the
   *  half-covered anti-aliasing fringe of the band's outer edge (it lies outside the element's box by half the stroke), where the static stroke it
   *  replaces is not clipped (a stroke's ink bounds are inflated by its width). An invisible stroke keeps the fringe inside (measured: a start pop of 72
   *  stage px^2 without it, 0 with). Built on the first flight frame, so planning it never costs the first preview. */
  function bandNode(L: NonNullable<typeof morphLayers>): SVGPathElement | null {
    if (!morphPlan!.band?.()) return null;
    const band = document.createElementNS(SVG_NS, "path");
    band.setAttribute("fill-rule", "evenodd"); band.setAttribute("stroke", "transparent"); band.setAttribute("stroke-width", String(BAND_INK_GUARD));
    L.body.after(band);
    return band;
  }
  function writeMorphFrame(el: FigElement, t: number): void {
    const L = ensureMorphLayers();
    if (el.type !== "path") return;
    const set = (n: Element, name: string, value: string) => { if (n.getAttribute(name) !== value) n.setAttribute(name, value); };
    set(L.svg, "viewBox", `0 0 ${Math.max(el.width, 1)} ${Math.max(el.height, 1)}`);
    // Heads that only one side draws FADE; the body is never trimmed under a
    // fading head (a trimmed body would leave a gap once the head is gone).
    const both = { start: morphPlan!.preStyle.arrowStart && morphPlan!.endStyle.arrowStart, end: morphPlan!.preStyle.arrowEnd && morphPlan!.endStyle.arrowEnd };
    const bodyGeom = pathRender({ ...el, arrowStart: both.start, arrowEnd: both.end });
    const headGeom = !el.closed && (L.heads.start || L.heads.end) ? pathRender(el) : null;
    set(L.body, "d", bodyGeom.d);
    // The A layer (the original markup, hidden but still in the document) owns
    // `fxg-<id>-fill`; an `url(#same-id)` here would resolve to ITS stops (document
    // order) and the gradient would sit frozen until the swap to B. Own namespace.
    const paint = elementPaints(el.fillMap || el.strokeMap ? { ...el, id: el.id + "-morph" + gradSuffix } : el);
    let defs = L.svg.querySelector("defs");
    const markup = paint.defs.map(gradientSvg).join("");
    if (markup) {
      if (!defs) { defs = document.createElementNS(SVG_NS, "defs"); L.svg.prepend(defs); }
      if (morphDefsMarkup !== markup) { defs.innerHTML = markup; morphDefsMarkup = markup; }
    } else { defs?.remove(); morphDefsMarkup = ""; }
    set(L.body, "fill", paint.fill);
    if (!bandChecked) { bandChecked = true; L.band = bandNode(L); }
    // band: the stroke is the ring between two contours (below), not a stroke of the centreline
    set(L.body, "stroke", L.band ? "none" : paint.stroke);
    set(L.body, "stroke-width", L.band ? "0" : String(el.strokeWidth));
    set(L.body, "stroke-linecap", el.closed ? "butt" : (el.cap ?? "round"));
    set(L.body, "stroke-linejoin", morphJoin(pre, end, t));   // T7: inherit the resting join (rect miter / path round)
    const dash = dashAttr(el);
    if (dash) set(L.body, "stroke-dasharray", dash); else L.body.removeAttribute("stroke-dasharray");
    const shift = morphPlan!.dashShift, endDash = morphPlan!.endStyle.dash;
    if (dash && shift != null && endDash?.length) set(L.body, "stroke-dashoffset", String(dashOffsetAt(shift, endDash, t, morphPlan!.dashReversed))); else L.body.removeAttribute("stroke-dashoffset");
    for (const [name, v] of [["fill-opacity", channelOpacity(el.fillOpacity)], ["stroke-opacity", channelOpacity(el.strokeOpacity)]] as const)
      if (v != null) set(L.body, name, String(v)); else L.body.removeAttribute(name);
    if (L.band) {
      const bp = morphPlan!.band!()!, sample = (bandSamples ??= { outer: [], inner: [] });
      sampleStrokeBand(bp, t, sample);
      set(L.band, "d", pathD(sample.outer, true) + " " + pathD(sample.inner, true));
      set(L.band, "fill", paint.stroke);
      const so = channelOpacity(el.strokeOpacity);
      if (so != null) set(L.band, "fill-opacity", String(so)); else L.band.removeAttribute("fill-opacity");
    }
    for (let i = 0; i < L.fixed.length; i++) {
      const h = morphPlan!.fixedHeads[i], node = L.fixed[i];
      const side = h.side === "pre" ? morphPlan!.preStyle : morphPlan!.endStyle;
      set(node, "points", fixedHeadPoints(morphPlan!, h, t).map(([x, y]) => `${x},${y}`).join(" "));
      set(node, h.filled ? "fill" : "stroke", side.stroke);
      if (!h.filled) set(node, "stroke-width", String(side.strokeWidth));
      set(node, "opacity", String(fixedHeadOpacity(h, t)));
    }
    if (headGeom) {
      const filled = (el.arrowStyle ?? "filled") === "filled";
      const geoms = filled ? headGeom.polys : headGeom.vees;
      // pathRender lists the END head first, then the START head
      let gi = 0;
      for (const which of ["end", "start"] as const) {
        const node = L.heads[which];
        if (!node || !(which === "end" ? el.arrowEnd : el.arrowStart)) continue;
        const pts = geoms[gi++];
        const opacity = String(arrowFade(morphPlan!, which, t));
        const points = pts ? pts.map(([px, py]) => `${px},${py}`).join(" ") : "";
        if (filled) {
          set(node.poly, "points", points); set(node.poly, "fill", el.stroke); set(node.poly, "opacity", opacity);
          node.vee.setAttribute("points", "");
        } else {
          set(node.vee, "points", points); set(node.vee, "stroke", el.stroke); set(node.vee, "stroke-width", String(el.strokeWidth)); set(node.vee, "opacity", opacity);
          node.poly.setAttribute("points", "");
        }
      }
    }
  }

  // --- the glyph-matched text morph (a text rewrite; textMatch.ts) ---------
  // A = the ORIGINAL nodes (moved), shown at raw ≤ 0; M = the span layer
  // (player/textMorph.ts: spans paint in place, each side under its own endpoint's
  // residual scale whatever the wrapper's composite scale); B = the end markup
  // through the ONE serializer, shown at raw ≥ 1 and the root later tracks bind
  // to. A, M and B are ADDED (plus-lighter) with the hand-over weights over the
  // first and last stage pixels of change, so the first moving frame is A and the
  // landing frame is B. Unmappable texts (and a host that cannot measure)
  // crossfade A and B at their natural size — the text never stretches with a
  // changing box.
  let textLayers: { A: HTMLElement; M: HTMLElement; B: HTMLElement; morph: TextMorph; preBox: { w: number; h: number }; endBox: { w: number; h: number } } | null = null;
  if (plan.mode === "textMorph") {
    const mk = (): HTMLElement => {
      const d = document.createElement("div");
      d.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";
      return d;
    };
    const A = mk(), M = mk(), B = mk();
    M.className = "sl-text-morph";
    M.style.pointerEvents = "none";
    // The static renders and the span layer are handed over to each other in premultiplied space (textMorph HANDOVER_EPS), so the layers are
    // ADDED, never laid over each other (two coverages c would read 1 - (1 - c)^2, bolder), inside contentHost's own stacking context. Set
    // once, with the layers, and never toggled, like the crossfade layers (ensureLayers): a lone layer renders as it would anywhere.
    for (const [k, v] of Object.entries(HANDOVER_PARENT_STYLE)) contentHost.style.setProperty(k, v);
    for (const layer of [A, M, B]) for (const [k, v] of Object.entries(HANDOVER_LAYER_STYLE)) layer.style.setProperty(k, v);
    while (contentHost.firstChild) A.appendChild(contentHost.firstChild);
    fillContent(B, layoutForMorph(end as TextElement), ctx);
    contentHost.append(A, M, B);
    const pb = elementBBox({ ...pre, rotation: 0 }), eb = elementBBox({ ...end, rotation: 0 });
    textLayers = { A, M, B, morph: createTextMorph(pre as TextElement, end as TextElement, { layer: M, ctx, durationMs: ctx.durationMs ?? 600, textLook: ctx.textLook, stage: ctx.stage, residual: !boxOpts.skipTransform, promote: !displaced }),
      preBox: { w: Math.max(pb.w, 1), h: Math.max(pb.h, 1) }, endBox: { w: Math.max(eb.w, 1), h: Math.max(eb.h, 1) } };
  }
  function writeTextMorph(el: FigElement, u: number, raw: number): void {
    const L = textLayers!, t = clamp01(u);
    const style = (n: HTMLElement, props: Record<string, string>) => { for (const [k, v] of Object.entries(props)) if ((n.style as unknown as Record<string, string>)[k] !== v) (n.style as unknown as Record<string, string>)[k] = v; };
    if (raw <= 0 || raw >= 1) {
      L.morph.hide();
      style(L.A, { visibility: raw <= 0 ? "" : "hidden", opacity: "", transform: "" });
      style(L.B, { visibility: raw >= 1 ? "" : "hidden", opacity: "", transform: "" });
      style(L.M, { visibility: "hidden", opacity: "", transform: "" });
      return;
    }
    const f = wrapperFrame(el, baseBox, !boxOpts.skipTransform);
    const n = (v: number) => Math.round(v * 1e6) / 1e6;
    if (L.morph.ensure()) {
      // A fades into the span layer as the spans leave it, the span layer into B as they settle onto it (textMorph HANDOVER_EPS)
      const h = L.morph.frame(u, raw, { x: f.bb.x - f.ox, y: f.bb.y - f.oy }, { x: f.sx, y: f.sy });
      const { a: wa, b: wb, m: wm } = handoverWeights(h);
      const weight = (w: number) => w >= 1 ? "" : String(n(w));
      style(L.A, { visibility: wa > 0 ? "" : "hidden", opacity: wa > 0 ? weight(wa) : "", transform: "" });
      style(L.B, { visibility: wb > 0 ? "" : "hidden", opacity: wb > 0 ? weight(wb) : "", transform: "" });
      // the span layer is hidden by its OPACITY, never `visibility`: a span sets its own, which a hidden parent does not override
      style(L.M, { visibility: "", opacity: weight(wm), transform: "" });
      return;
    }
    // Fallback: both endpoint renders at their own natural size, anchored to the
    // moving box's top-left, cross-lerped.
    const natural = (box: { w: number; h: number }) => `scale(${n(box.w / (f.w * f.sx))}, ${n(box.h / (f.h * f.sy))})`;
    style(L.M, { visibility: "hidden" });
    style(L.A, { visibility: "", opacity: String(1 - t), transform: natural(L.preBox) });
    style(L.B, { visibility: "", opacity: String(t), transform: natural(L.endBox) });
  }

  // --- text ↔ drawn shape in ONE element (a Consume / retype) ----------------
  // The shape pours into the letters (or the letters fuse into the shape)
  // through the same N↔M correspondence a hand-off flies: A = original nodes,
  // M = one retained <path> per pair in stage coordinates, B = the end markup.
  // The shape side is held over its 15 % end of the flight (it covers the slice
  // seams); glyph BOXES crossfade with the live text there instead.
  const glyphSide = ctx.glyphs && pre.type !== end.type && (pre.type === "text" && hasOutline(end) ? "a" : end.type === "text" && hasOutline(pre) ? "b" : null);
  let glyphLayers: { A: HTMLElement; M: HTMLElement; B: HTMLElement; svg: SVGSVGElement; paths: SVGPathElement[]; plan: CorrespondencePlan | null; out: SampledPath[]; rev: number; failed: boolean; boxes: boolean } | null = null;
  if (glyphSide) {
    const mk = (): HTMLElement => { const d = document.createElement("div"); d.style.cssText = "position:absolute;inset:0;transform-origin:0 0;"; return d; };
    const A = mk(), M = mk(), B = mk();
    M.className = "sl-glyph-morph"; M.style.pointerEvents = "none";
    while (contentHost.firstChild) A.appendChild(contentHost.firstChild);
    fillContent(B, end.type === "text" ? layoutForMorph(end) : end, ctx);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%"); svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "overflow:visible;display:block;";
    M.appendChild(svg);
    contentHost.append(A, M, B);
    glyphLayers = { A, M, B, svg, paths: [], plan: null, out: [], rev: -1, failed: false, boxes: false };
  }
  const upright = (el: FigElement): FigElement => { const n = { ...el, rotation: 0 } as FigElement; delete n.flipX; delete n.flipY; return n; };
  /** Plan the pairs (unrotated stage frame; the wrapper rotates). */
  function glyphPlan(): CorrespondencePlan | null {
    const L = glyphLayers!;
    if (L.plan && L.rev === ctx.glyphs!.revision()) return L.plan;
    const textEl = upright(glyphSide === "a" ? pre : end) as TextElement, shape = upright(glyphSide === "a" ? end : pre);
    const letters = ctx.glyphs!.outlines(textEl);
    if (!letters?.length) { L.failed = true; return null; }
    const shapeOutlines = elementStageOutlines(shape);
    if (!shapeOutlines.length) { L.failed = true; return null; }
    const plan = glyphSide === "a" ? planCorrespondence(letters, shapeOutlines) : planCorrespondence(shapeOutlines, letters);
    plan.prepare();
    L.plan = plan; L.rev = ctx.glyphs!.revision(); L.out = []; L.failed = false;
    L.boxes = letters.some((o) => o.owner.role === "glyph-box");
    for (const p of L.paths) p.remove();
    L.paths = plan.pairs.map((pair) => { const n = document.createElementNS(SVG_NS, "path"); n.setAttribute("stroke-linejoin", pairJoin(pair.a?.paint.join, pair.b?.paint.join, 0)); L.svg.appendChild(n); return n; });
    return plan;
  }
  function writeGlyphMorph(el: FigElement, u: number, raw: number): void {
    const L = glyphLayers!, t = clamp01(u);
    const style = (n: HTMLElement, props: Record<string, string>) => { for (const [k, v] of Object.entries(props)) if ((n.style as unknown as Record<string, string>)[k] !== v) (n.style as unknown as Record<string, string>)[k] = v; };
    if (raw <= 0 || raw >= 1) {
      style(L.A, { visibility: raw <= 0 ? "" : "hidden", opacity: "", transform: "" });
      style(L.B, { visibility: raw >= 1 ? "" : "hidden", opacity: "", transform: "" });
      style(L.M, { visibility: "hidden" });
      return;
    }
    const f = wrapperFrame(el, baseBox, !boxOpts.skipTransform);
    const n = (v: number) => Math.round(v * 1e6) / 1e6;
    const plan = L.failed ? null : glyphPlan();
    // A layer PINNED at its own stage box (its content does not ride the box).
    const pin = (layer: HTMLElement, box: { x: number; y: number; w: number; h: number }, opacity: number) =>
      style(layer, { visibility: opacity > 0 ? "" : "hidden", opacity: String(opacity),
        transform: `translate(${n((box.x - f.ox) / f.sx)}px, ${n((box.y - f.oy) / f.sy)}px) scale(${n(Math.max(box.w, 1) / (f.w * f.sx))}, ${n(Math.max(box.h, 1) / (f.h * f.sy))})` });
    const preBox = elementBBox(upright(pre)), endBox = elementBBox(upright(end));
    if (!plan) {
      // No geometry (unmeasurable host): the classic crossfade, pinned in place.
      style(L.M, { visibility: "hidden" });
      pin(L.A, preBox, 1 - t); pin(L.B, endBox, t);
      return;
    }
    // Ends held on RAW progress: the source over its first 15 %, the
    // destination over its last 15 % — for the shape side (slice seams) always,
    // for the text side only when its letters are boxes.
    const leaving = clamp01(1 - raw / 0.15), landing = clamp01((raw - 0.85) / 0.15);
    const shapeIsSource = glyphSide === "b";
    const aHold = shapeIsSource || L.boxes ? leaving : 0, bHold = !shapeIsSource || L.boxes ? landing : 0;
    const textFade = L.boxes ? (glyphSide === "a" ? leaving : landing) : 0;
    pin(L.A, preBox, aHold); pin(L.B, endBox, bHold);
    style(L.M, { visibility: "" });
    L.svg.setAttribute("viewBox", `${n(f.ox)} ${n(f.oy)} ${n(f.w * f.sx)} ${n(f.h * f.sy)}`);
    sampleCorrespondence(plan, t, L.out);
    for (let i = 0; i < L.paths.length; i++) {
      const node = L.paths[i], sample = L.out[i], p = sample.paint;
      const set = (name: string, value: string) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
      set("d", pathD(sample.nodes, sample.closed));
      set("fill", p.fill); set("stroke", p.stroke); set("stroke-width", String(p.strokeWidth)); set("stroke-linecap", p.cap);
      set("stroke-linejoin", pairJoin(plan.pairs[i]?.a?.paint.join, plan.pairs[i]?.b?.paint.join, t)); // T7: the side just left
      if (p.fillOpacity != null) set("fill-opacity", String(p.fillOpacity)); else node.removeAttribute("fill-opacity");
      if (p.strokeOpacity != null) set("stroke-opacity", String(p.strokeOpacity)); else node.removeAttribute("stroke-opacity");
      set("opacity", String(sample.opacity * (p.opacity ?? 1) * (1 - textFade)));
    }
  }

  const emerge = ctx.ghost ? ghostEmergence(pre, end) : undefined;
  let endpointPhase = -1; // 0 = at the start, 2 = at the end, 1 = in flight; -1 = never painted
  const self = {};        // this controller's identity as a content writer
  function seek(u: number, raw = clamp01(u)): void {
    const t = clamp01(u);
    const content = morphPlan ? (raw <= 0 ? pre : raw >= 1 ? end : sampleElementMorph(morphPlan, t, raw)) : lerpElement(pre, end, t, raw);
    const contentX = content.x, contentY = content.y;
    const el = arcBox(overshootBox(content, pre, end, u), pre, end, u, ctx.arc);
    // a Ghost's birth: the copy's own ink emerges with its separation from the source (the wrapper alone carries it; content is untouched).
    // Two limits, both deliberate: the separation is measured from the source's BIRTH pose (a source that moves in the same beat keeps the overlap
    // longer: no gate pins that case), and a same-beat appearance that owns the wrapper's opacity (`skipOpacity`) takes the law's share with it.
    // never 0: an opacity-0 node is culled and first rasterises in flight, at a fractional offset it then keeps (render.ts primeFlightLayers)
    const share = emerge ? Math.max(0.001, emerge(el, u)) : 1;
    const wrapEl = share >= 1 ? el : { ...el, opacity: (el.opacity ?? 1) * share } as FigElement;
    // text metrics changed mid-tween → re-wrap with the real measurer (GUI);
    // headless applyTextLayout deletes the cache and falls back (documented).
    // The text morph draws measured endpoints instead: its box simply lerps
    // (re-hugging a stepped text per frame made the box jump at t = 0.5).
    if (content.type === "text" && content.needsLayout && !textLayers && !glyphLayers) applyTextLayout(content);
    // A text tween re-lays its own glyphs out per frame (the compiled updater rewrites the viewBox), so its wrapper is placed by the same
    // law as its rest, a whole-pixel layout box plus a residual (about 1:1) transform, not by a frozen box scaled up 1.4x: that scale
    // rasterised the text softly in flight against the hinted rest text and snapped when the flight landed.
    const relayoutsText = staticUpdate && pre.type === "text";
    if (raw > 0 && raw < 1 && !boxOpts.skipTransform && !relayoutsText) {
      applyWrapperBoxComposite(wrap, wrapEl, morphPlan && t >= 0.5 ? endBaseBox : baseBox, { skipOpacity: boxOpts.skipOpacity });
      // a text morph's box rides a layer only when the box itself travels (its spans decide for themselves)
      // ... and an outline morph's box only when it really travels: a Become that keeps its box (a ring into a rect) has nothing a layer could move,
      // and promoting it re-rasters the whole picture at the first flight frame (a 6 stage px^2 step on the first moving frame)
      if (glide && (!textLayers || displaced) && (!morphPlan || displaced)) promoteMovingWrapper(wrap);
    } else {
      applyWrapperBox(wrap, wrapEl, boxOpts);
      if (glide) settleWrapper(wrap);   // the flight mark belongs to the player (applyAt)
    }

    // The frozen content frame must not counter-translate the curved wrapper.
    // Restore the owned content sample after its box has been applied, without a clone.
    if (ctx.arc && el === content) { content.x = contentX; content.y = contentY; }

    if (plan.mode === "model-live" && content.type === "model3d") {
      const sampled = pre.type === 'model3d' && end.type === 'model3d' ? modelContentFrame(pre, end, content, t, raw, ctx) : { element: content, extra: {} };
      setSlideModelFrame(contentHost, sampled.element, sampled.extra);
      return;
    }

    if (morphPlan) {
      if (raw > 0 && raw < 1) {
        writeMorphFrame(content, t);
        if (handoverFor()) { const { away, settle } = morphDistances(content, t); showMorphLayer(raw, snapWeights(shapeWeights(away, settle))); }
        else showMorphLayer(raw);
      } else showMorphLayer(raw);
      return;
    }

    if (textLayers) { writeTextMorph(el, u, raw); return; }
    if (glyphLayers) { writeGlyphMorph(el, u, raw); return; }

    if (plan.mode === "crossfade" && !glyphLayers) {
      ensureLayers();
      // A model that no longer owns the discrete kind keeps only its encoded
      // snapshot during the remaining visual fade, never a live backing canvas.
      if (pre.type !== end.type) {
        if (layerA && pre.type === 'model3d') modelBindingOf(layerA)?.posterOnly(raw >= .5);
        if (layerB && end.type === 'model3d') modelBindingOf(layerB)?.posterOnly(raw < .5);
      }
      if (layerA) layerA.style.opacity = String(1 - t);
      if (layerB) layerB.style.opacity = String(t);
      return;
    }

    if (!plan.contentDirty) return;


    if (isPlot) {
      const p = el as SemanticPlotElement;
      const inst = plotSvg;
      if (inst) {
        // compensatePtTrue is ONE-SHOT (it prepends transforms / multiplies
        // stroke styles) — re-applying per seek COMPOUNDS: glyphs shrank a
        // notch on every beat nav (static seek 0) and exploded to a gray
        // wall during playback. Restore the pristine state first, re-apply
        // the (lerped) overrides, then compensate for THIS frame's box —
        // exactly a fresh mount, idempotent at any t.
        restorePtTrue(inst, ptTrueBindings);
        restoreProjection(inst);
        plotUpdate?.(content, t, raw);
        if (naturalViewBox && intrinsic) {
          if (p.crop) {
            inst.setAttribute("viewBox", cropViewBoxValue(naturalViewBox, intrinsic, p.crop));
            inst.style.overflow = "hidden";
          } else {
            inst.setAttribute("viewBox", naturalViewBox);
            inst.style.overflow = "visible";
          }
        }
        const frameManifest = ctx.plotManifest ? ctx.plotManifest(p.assetId) : get(plotManifests)[p.assetId];
        // this frame's live colour scales (completed from the manifest so an absent end glides),
        // before overrides so explicit paints win
        applyPlotTheme(inst, frameManifest, plotFollowsTheme(p, "slide") ? ctx.theme : null);
        const frameColorScale = tweenColorScales(frameManifest, (pre as SemanticPlotElement).colorScale, (end as SemanticPlotElement).colorScale, t, raw) ?? p.colorScale;
        applyPlotColorScale(inst, frameManifest, frameColorScale, p.id);
        applyOverrides(inst, p.overrides, p.id, frameManifest);
        ghostOpacity?.(p);
        if (projectionOptions) {
          projectionOptions.t = t; projectionOptions.raw = raw; projectionOptions.colorScale = frameColorScale;
          applyPlotView(inst, manifestA, (end as SemanticPlotElement).view, p.id, projectionOptions);
        } else applyPlotView(inst, manifestA, p.view, p.id);
        if (intrinsic) {
          compensatePtTrue(inst, {
            elW: p.width,
            elH: p.height,
            crop: p.crop ?? null,
            contentScale: p.contentScale,
            intrinsic,
          }, ptTrueBindings);
        }
      }
      return;
    }

    // ENDPOINTS PAINT THE COMPLETE STATE (2026-10-06). The compiled updater writes
    // only the attributes that differ between this transform's own two ends — but the
    // content nodes are shared with every other transform of this element, and the
    // player materializes every transform at its start and, on each beat change, resets
    // every later one to its start before applying the past. A later transform whose
    // start sits elsewhere bakes its own position into the content's translate; an
    // earlier transform that never moves the box has no binding for it and would leave
    // it stale (DNA slide: half the bases rested at a later step's position). So an
    // endpoint repaints every attribute in place (identity-preserving) whenever this
    // transform reaches it afresh OR another transform wrote the content since; frames
    // in flight keep the fast per-binding updater, repeated endpoint frames cost nothing.
    const phase = raw <= 0 ? 0 : raw >= 1 ? 2 : 1;
    const owned = contentWriter.get(contentHost) === self;
    if (staticUpdate && phase === 1) staticUpdate(content, t, raw);
    else if (!staticUpdate || !owned || phase !== endpointPhase) updateStaticContent(ownHost(), content, ctx);
    contentWriter.set(contentHost, self);
    endpointPhase = phase;
  }

  // Build in story order, before later tracks resolve their targets. A B-only
  // semantic part after A→B must bind B's nodes even on the first random seek.
  if (plan.mode === "crossfade" && !glyphLayers) { ensureLayers(); layerB!.style.opacity = "0"; }
  if (glyphLayers) {
    writeGlyphMorph(pre, 0, 0);
    const L = glyphLayers;
    // Warm only an UNPLANNED morph: a replan (a font that arrived) belongs to the
    // next frame, which draws it — rebuilt off-frame, the paths would sit blank.
    warmWhenIdle(() => { if (wrap.isConnected && !L.failed && !L.plan) glyphPlan(); });
    return { seek, targetRoot: L.B, glide: marks } as MorphController;
  }
  if (textLayers) {
    writeTextMorph(pre, 0, 0);
    // Measure while the browser is idle so the first mid-flight frame finds the
    // spans built; a seek that arrives first builds them on the spot.
    const L = textLayers;
    warmWhenIdle(() => { if (wrap.isConnected) L.morph.ensure(); });
    return { seek, targetRoot: L.B, glide: marks, dispose: () => L.morph.dispose() } as MorphController;
  }
  if (morphPlan) {
    showMorphLayer(0);
    // The node correspondence is deferred (outline.planElementMorph) so opening
    // the animator does not wait for it. Warm it while the browser is idle, so
    // the first frame of the morph finds it already built; a seek that arrives
    // first just builds it on the spot.
    // …and skip it if this slide was torn down first: scrubbing a deck builds
    // a transform per slide, and a warm for one already off the document is
    // pure waste at exactly the moment the machine is busiest.
    warmWhenIdle(() => { if (wrap.isConnected) morphPlan.prepare?.(); });
    return { seek, targetRoot: ensureMorphLayers().B, glide: marks };
  }
  // No dispose: the hand-off tick pool lives inside the plot's own SVG, so it goes with the slide, and a still (renderStaticAt
  // disposes its controllers after sampling the step) must keep the projected line, the re-ticked axis and the pool it sampled.
  return { seek, targetRoot: layerB ?? contentHost, glide: marks };
}
