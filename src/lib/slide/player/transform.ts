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
import { elementBBox } from "../../geometry";
import { lerpElement, contentPlan, type ContentPlan } from "../tween";
import { createMorph, type MorphController } from "./morph";
import { applyWrapperBox, applyWrapperBoxComposite, compileStaticContent, updateStaticContent, fillContent, type SlideRenderCtx } from "./render";

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

function clearDash(scope: ParentNode): void {
  const nodes = scope.querySelectorAll?.("path,line,polyline,polygon,rect,ellipse,circle") ?? [];
  for (const n of Array.from(nodes) as (Element & { style?: CSSStyleDeclaration })[]) {
    n.style?.removeProperty?.("stroke-dasharray");
    n.style?.removeProperty?.("stroke-dashoffset");
  }
}

export function createTransform(
  wrap: HTMLElement,
  pre: FigElement,
  end: FigElement,
  ctx: TransformCtx,
): MorphController {
  const plan: ContentPlan = contentPlan(pre, end);
  if (pre.type === "plot" && end.type === "plot" && pre.assetId !== end.assetId && !ctx.morphTo) {
    plan.mode = "crossfade";
    plan.contentDirty = true;
  }
  const contentHost = ctx.contentHost ?? (wrap as HTMLElement & { __slideEffects?: HTMLElement }).__slideEffects ?? wrap;
  const staticUpdate = pre.type !== "plot" && plan.contentDirty && plan.mode !== "crossfade"
    ? compileStaticContent(contentHost, pre, end, ctx) : null;
  // Text wrapping can change node topology as metrics change. Keep that
  // deliberate fallback; shape topology changes use prebuilt crossfade layers.
  if (pre.type !== "plot" && pre.type !== "text" && plan.contentDirty && !staticUpdate) plan.mode = "crossfade";
  const skip = ctx.skipProps;
  const boxOpts = {
    skipOpacity: skip?.has("opacity") ?? false,
    skipTransform: skip?.has("transform") ?? false,
  };
  // The frozen layout box for mid-flight composite frames (= the t1 box the
  // t≤0 endpoint writes). When a same-beat appearance owns the wrapper
  // transform (skipTransform), composite motion is impossible — those rare
  // overlaps keep the classic per-frame layout path.
  const baseBB = elementBBox({ ...pre, rotation: 0 });
  const baseBox = { x: baseBB.x, y: baseBB.y, w: baseBB.w, h: baseBB.h };

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
    const cached = plotDom.get((pre as SemanticPlotElement).assetId);
    return cached ? svgIntrinsicPx(cached) : null;
  })();
  const naturalViewBox = (() => {
    if (!isPlot) return null;
    const cached = plotDom.get((pre as SemanticPlotElement).assetId);
    return cached?.getAttribute("viewBox") ?? null;
  })();
  const plotSvg = isPlot ? contentHost.querySelector("svg") : null;
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

  let clearedDash = false;

  function seek(raw: number): void {
    const t = clamp01(raw);
    const el = lerpElement(pre, end, t);
    // text metrics changed mid-tween → re-wrap with the real measurer (GUI);
    // headless applyTextLayout deletes the cache and falls back (documented).
    if (el.type === "text" && el.needsLayout) applyTextLayout(el);
    if (t > 0 && t < 1 && !boxOpts.skipTransform) {
      applyWrapperBoxComposite(wrap, el, baseBox, { skipOpacity: boxOpts.skipOpacity });
    } else {
      applyWrapperBox(wrap, el, boxOpts);
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

    if (t > 0 && plan.geometryDirty && !clearedDash) {
      // the transform owns the geometry from here — stale dash windows sized
      // to the OLD geometry would truncate it (the morph lesson). t=0 keeps
      // them: drawOn's pre-beat hidden state depends on its dasharray.
      clearDash(wrap);
      clearedDash = true;
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
        applyOverrides(inst, p.overrides, p.id, ctx.plotManifest?.(p.assetId) ?? get(plotManifests)[p.assetId]);
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
  return { seek, targetRoot: layerB ?? contentHost };
}
