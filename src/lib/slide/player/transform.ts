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
import { compensatePtTrue, restorePtTrue, svgIntrinsicPx, cropViewBoxValue } from "../../plot/compensate";
import { applyTextLayout } from "../../text";
import type { FluxPlotManifest } from "../../plot/types";
import { lerpElement, contentPlan, type ContentPlan } from "../tween";
import { createMorph, type MorphController } from "./morph";
import { applyWrapperBox, updateStaticContent, fillContent, type SlideRenderCtx } from "./render";

export interface TransformCtx extends SlideRenderCtx {
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
  const skip = ctx.skipProps;
  const boxOpts = {
    skipOpacity: skip?.has("opacity") ?? false,
    skipTransform: skip?.has("transform") ?? false,
  };

  // --- plot half: in-place frame/override updates + optional content morph --
  const isPlot = pre.type === "plot" && end.type === "plot";
  let innerMorph: MorphController | null = null;
  if (isPlot && ctx.morphTo) {
    innerMorph = createMorph(wrap, pre.id, ctx.morphTo.A, ctx.morphTo.B);
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
    while (wrap.firstChild) layerA.appendChild(wrap.firstChild);
    // layer B renders the END content once through the ONE renderer; both
    // layers stretch with the wrapper (fillContent svgs are 100% + none-
    // preserveAspectRatio), so even the fallback moves with the box.
    fillContent(layerB, end, ctx);
    wrap.appendChild(layerA);
    wrap.appendChild(layerB);
  }

  let clearedDash = false;

  function seek(raw: number): void {
    const t = clamp01(raw);
    const el = lerpElement(pre, end, t);
    // text metrics changed mid-tween → re-wrap with the real measurer (GUI);
    // headless applyTextLayout deletes the cache and falls back (documented).
    if (el.type === "text" && el.needsLayout) applyTextLayout(el);
    applyWrapperBox(wrap, el, boxOpts);

    if (plan.mode === "crossfade") {
      ensureLayers();
      if (layerA) layerA.style.opacity = String(1 - t);
      if (layerB) layerB.style.opacity = String(t);
      return;
    }

    if (!plan.contentDirty) {
      if (innerMorph) innerMorph.seek(t); // pure content morph, frame static
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
      const inst = wrap.querySelector("svg");
      if (inst) {
        // compensatePtTrue is ONE-SHOT (it prepends transforms / multiplies
        // stroke styles) — re-applying per seek COMPOUNDS: glyphs shrank a
        // notch on every beat nav (static seek 0) and exploded to a gray
        // wall during playback. Restore the pristine state first, re-apply
        // the (lerped) overrides, then compensate for THIS frame's box —
        // exactly a fresh mount, idempotent at any t.
        restorePtTrue(inst);
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
          });
        }
      }
      if (innerMorph) innerMorph.seek(t);
      return;
    }

    updateStaticContent(wrap, el, ctx);
  }

  return { seek };
}
