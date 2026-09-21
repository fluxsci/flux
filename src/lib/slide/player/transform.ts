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
//     content to the data-space morph when `to.assetId` names a compatible
//     plot — one green track, both halves;
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
import { applyOverrides } from "../../plot/parse";
import { compensatePtTrue, restorePtTrue, compilePtTrueBindings, svgIntrinsicPx, cropViewBoxValue } from "../../plot/compensate";
import { applyTextLayout } from "../../text";
import type { FluxPlotManifest } from "../../plot/types";
import { elementBBox, dashAttr } from "../../geometry";
import { pathRender } from "../../path";
import { lerpElement, contentPlan, type ContentPlan } from "../tween";
import { planElementMorph, sampleElementMorph, arrowFade, fixedHeadOpacity, type ElementMorphPlan } from "../outline";
import { createMorph, type MorphController } from "./morph";
import { applyWrapperBox, applyWrapperBoxComposite, layoutBoxOf, pureMove, promoteMovingWrapper, settleWrapper, armFlightMark, compileStaticContent, compileGhostPartOpacity, updateStaticContent, fillContent, type SlideRenderCtx } from "./render";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface TransformCtx extends SlideRenderCtx {
  /** Effective source content after earlier cues (may be a crossfade layer). */
  contentHost?: HTMLElement;
  /** assetId → manifest (plot frame updates + the content-morph half). */
  plotManifest?: (assetId: string) => FluxPlotManifest | undefined;
  /** Content-morph target for plots (track.to.assetId), when compatible. */
  morphTo?: { A: FluxPlotManifest; B: FluxPlotManifest };
  /** Wrapper props an overlapping same-beat appearance owns (conflict rule —
   *  the transform drops them; the appearance wins for the overlap). */
  skipProps?: ReadonlySet<string>;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export function createTransform(
  wrap: HTMLElement,
  pre: FigElement,
  end: FigElement,
  ctx: TransformCtx,
): MorphController {
  const plan: ContentPlan = contentPlan(pre, end);
  // A video is stretched by its retained element. Re-serializing width/height
  // Changes would replace its decoder and restart playback every frame.
  if (pre.type === "video" && end.type === "video") plan.contentDirty = false;
  if (pre.type === "plot" && end.type === "plot" && pre.assetId !== end.assetId && !ctx.morphTo) {
    plan.mode = "crossfade";
    plan.contentDirty = true;
  }
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
  // A pure move rides its own compositor layer for the flight (render.ts,
  // layer hygiene): rasterized once, moved at float precision — text glides
  // instead of stepping, heavy content moves without repainting. Demoted at
  // the endpoints, so rest is always painted in place.
  const glide = !boxOpts.skipTransform && pureMove(pre, end);

  // --- plot half: in-place frame/override updates + optional content morph --
  const isPlot = pre.type === "plot" && end.type === "plot";
  let innerMorph: MorphController | null = null;
  const plotUpdate = isPlot && ctx.morphTo ? compileStaticContent(contentHost, pre, end, ctx, {
    circles: new Set(ctx.morphTo.A.series.flatMap((s) => (s.points ?? []).map((p) => `${pre.id}__${p.svgId}`))),
    lines: new Set(ctx.morphTo.A.series.flatMap((s) => s.svg?.line ? [`${pre.id}__${s.svg.line}`] : [])),
  }) : null;
  if (isPlot && ctx.morphTo) {
    // A compatible data match with different SVG topology needs a complete
    // crossfade; a geometry-only tween would silently leave old labels/axes.
    if (plotUpdate) innerMorph = createMorph(contentHost, pre.id, ctx.morphTo.A, ctx.morphTo.B, true);
    else plan.mode = "crossfade";
  }
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
    // move (never clone) the existing content into layer A — inner-node
    // animations from earlier beats stay attached to their live targets.
    while (contentHost.firstChild) layerA.appendChild(contentHost.firstChild);
    // layer B renders the END content once through the ONE renderer; both
    // layers stretch with the wrapper (fillContent svgs are 100% + none-
    // preserveAspectRatio), so even the fallback moves with the box.
    fillContent(layerB, end, ctx);
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
  let morphLayers: { A: HTMLElement; M: HTMLElement; B: HTMLElement; svg: SVGSVGElement; body: SVGPathElement;
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
    body.setAttribute("stroke-linejoin", "round");
    svg.appendChild(body);
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
    contentHost.appendChild(A);
    contentHost.appendChild(M);
    contentHost.appendChild(B);
    morphLayers = { A, M, B, svg, body, heads, fixed };
    return morphLayers;
  }
  function showMorphLayer(t: number): void {
    const L = ensureMorphLayers();
    L.A.style.visibility = t <= 0 ? "" : "hidden";
    L.M.style.visibility = t > 0 && t < 1 ? "" : "hidden";
    L.B.style.visibility = t >= 1 ? "" : "hidden";
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
    const paint = elementPaints(el);
    let defs = L.svg.querySelector("defs");
    const markup = paint.defs.map(gradientSvg).join("");
    if (markup) {
      if (!defs) { defs = document.createElementNS(SVG_NS, "defs"); L.svg.prepend(defs); }
      if (defs.innerHTML !== markup) defs.innerHTML = markup;
    } else defs?.remove();
    set(L.body, "fill", paint.fill);
    set(L.body, "stroke", paint.stroke);
    set(L.body, "stroke-width", String(el.strokeWidth));
    set(L.body, "stroke-linecap", el.closed ? "butt" : (el.cap ?? "round"));
    const dash = dashAttr(el);
    if (dash) set(L.body, "stroke-dasharray", dash); else L.body.removeAttribute("stroke-dasharray");
    for (let i = 0; i < L.fixed.length; i++) {
      const h = morphPlan!.fixedHeads[i], node = L.fixed[i];
      const w = Math.max(el.width, 1e-6), hh = Math.max(el.height, 1e-6);
      const side = h.side === "pre" ? morphPlan!.preStyle : morphPlan!.endStyle;
      set(node, "points", h.pts.map(([u, v]) => `${u * w},${v * hh}`).join(" "));
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

  function seek(raw: number): void {
    const t = clamp01(raw);
    const el = morphPlan ? (t <= 0 ? pre : t >= 1 ? end : sampleElementMorph(morphPlan, t)) : lerpElement(pre, end, t);
    // text metrics changed mid-tween → re-wrap with the real measurer (GUI);
    // headless applyTextLayout deletes the cache and falls back (documented).
    if (el.type === "text" && el.needsLayout) applyTextLayout(el);
    if (t > 0 && t < 1 && !boxOpts.skipTransform) {
      applyWrapperBoxComposite(wrap, el, baseBox, { skipOpacity: boxOpts.skipOpacity });
      if (glide) promoteMovingWrapper(wrap);
    } else {
      applyWrapperBox(wrap, el, boxOpts);
      if (glide) { settleWrapper(wrap); armFlightMark(wrap); }
    }

    if (morphPlan) {
      if (t > 0 && t < 1) writeMorphFrame(el, t);
      showMorphLayer(t);
      return;
    }

    if (plan.mode === "crossfade") {
      ensureLayers();
      if (layerA) layerA.style.opacity = String(1 - t);
      if (layerB) layerB.style.opacity = String(t);
      return;
    }

    if (!plan.contentDirty) {
      if (innerMorph) { plotUpdate?.(el, t); innerMorph.seek(t); }
      return;
    }


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
        if (naturalViewBox && intrinsic) {
          if (p.crop) {
            inst.setAttribute("viewBox", cropViewBoxValue(naturalViewBox, intrinsic, p.crop));
            inst.style.overflow = "hidden";
          } else {
            inst.setAttribute("viewBox", naturalViewBox);
            inst.style.overflow = "visible";
          }
        }
        applyOverrides(inst, p.overrides, p.id, (ctx.plotManifest ? ctx.plotManifest(p.assetId) : get(plotManifests)[p.assetId]));
        ghostOpacity?.(p);
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
      if (innerMorph) { plotUpdate?.(el, t); innerMorph.seek(t); }
      return;
    }

    if (staticUpdate) staticUpdate(el, t);
    else updateStaticContent(contentHost, el, ctx);
  }

  // Build in story order, before later tracks resolve their targets. A B-only
  // semantic part after A→B must bind B's nodes even on the first random seek.
  if (plan.mode === "crossfade") { ensureLayers(); layerB!.style.opacity = "0"; }
  if (morphPlan) { showMorphLayer(0); return { seek, targetRoot: ensureMorphLayers().B }; }
  return { seek, targetRoot: layerB ?? contentHost };
}
