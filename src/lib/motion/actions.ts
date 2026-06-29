// Reusable motion primitives as Svelte transitions + actions, built on the
// motion tokens. Transitions use the `css` form (emits a real keyframe →
// accelerated) per SciForge_Stack_Decision.md §3.4. The `drawOn` action is the
// SVG self-draw used by the logomark.

import { cubicOut, quintOut } from "svelte/easing";
import { DUR, EASE, smoothEasing } from "./tokens";
import { prefersReducedMotion } from "./motion";

/** Fade + a small upward rise. The house "enter" for content. */
export function fadeRise(
  _node: Element,
  { duration = DUR.gentle, delay = 0, y = 10, easing = quintOut } = {},
) {
  if (prefersReducedMotion()) return { duration: 0, delay };
  return {
    duration,
    delay,
    easing,
    css: (t: number, u: number) =>
      `opacity:${t}; transform: translate3d(0, ${u * y}px, 0);`,
  };
}

/** Scale up slightly + fade. For small surfaces (chips, cards, popovers). */
export function popIn(
  _node: Element,
  { duration = DUR.quick, delay = 0, from = 0.96, easing = cubicOut } = {},
) {
  if (prefersReducedMotion()) return { duration: 0, delay };
  return {
    duration,
    delay,
    easing,
    css: (t: number) => `opacity:${t}; transform: scale(${from + (1 - from) * t});`,
  };
}

export interface DrawOnParams {
  /** When false the action is a no-op (element shows fully drawn). */
  play?: boolean;
  duration?: number;
  delay?: number;
  /** Use the exact manim smoothstep curve rather than the bezier approximation. */
  smooth?: boolean;
}

/**
 * The self-draw: animate `stroke-dashoffset` so an SVG stroke draws itself along
 * its path. Tier-2 paint — deliberately reserved for the few, small, idle-time
 * signature moments (here, the logomark on the Home screen). For straight UI
 * edges prefer transform-growth instead (style_principles.md P5).
 */
export function drawOn(node: SVGGeometryElement, params: DrawOnParams = {}) {
  let anim: Animation | undefined;

  const apply = (p: DrawOnParams) => {
    if (p.play === false) return;
    let len = 0;
    try {
      len = node.getTotalLength();
    } catch {
      len = 0;
    }
    if (!len) return;
    node.style.strokeDasharray = `${len}`;
    if (prefersReducedMotion()) {
      node.style.strokeDashoffset = "0";
      return;
    }
    anim = node.animate(
      [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      {
        duration: p.duration ?? DUR.deliberate,
        delay: p.delay ?? 0,
        easing: p.smooth ? smoothEasing() : EASE.smooth,
        fill: "both",
      },
    );
  };

  apply(params);

  return {
    destroy() {
      anim?.cancel();
    },
  };
}
