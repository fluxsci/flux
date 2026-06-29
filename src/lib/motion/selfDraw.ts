// Shared self-drawing accent frame (M16). The FluxFig Menu and the Plot X-Ray
// both open with the same signature: a glass panel whose accent border draws
// itself, then content rises. The geometry (the mirrored half-paths) and the
// "draw" transition lived in both components and could drift — they live here
// now, so the two panels stay identical from one source (P7). The scoped CSS
// (@property --draw/--content, .frame/.fline stroke-dashoffset) stays in each
// component but is driven entirely by the --draw/--content values produced here.

import { smoothstep } from "./tokens";
import { prefersReducedMotion } from "./motion";

export const FRAME_R = 14; // panel corner radius (matches --r-3)

/**
 * One mirrored half of the panel border. Each half runs top-centre →
 * bottom-centre (left or right side), so the two strokes seal at the bottom as
 * --draw reaches 1. `inset` keeps the stroke inside the panel's rounded edge.
 */
export function halfFrame(w: number, h: number, right: boolean, inset = 1.4): string {
  if (!w || !h) return "";
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  const r = Math.max(0, Math.min(FRAME_R - inset, (x1 - x0) / 2, (y1 - y0) / 2));
  const cx = w / 2;
  return right
    ? `M ${cx} ${y0} L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} L ${cx} ${y1}`
    : `M ${cx} ${y0} L ${x0 + r} ${y0} A ${r} ${r} 0 0 0 ${x0} ${y0 + r} L ${x0} ${y1 - r} A ${r} ${r} 0 0 0 ${x0 + r} ${y1} L ${cx} ${y1}`;
}

/**
 * The signature "draw" open (~180ms): the glass + halo materialise fast, the
 * accent line draws itself (the hero), and the controls rise in as it completes.
 * Reversible mid-flight (P4) since it is a pure function of t; collapses to
 * instant under reduced motion (P6). Returns a Svelte transition config.
 */
export function drawForge(_node: Element) {
  if (prefersReducedMotion()) return { duration: 0 };
  const seg = (a: number, b: number, t: number) =>
    smoothstep(Math.min(1, Math.max(0, (t - a) / (b - a))));
  return {
    duration: 180,
    css: (t: number) => {
      const panel = seg(0, 0.16, t); // glass + halo materialise fast
      const draw = seg(0.04, 0.82, t); // the accent line draws itself (the hero)
      const content = seg(0.42, 1, t); // controls rise in as the line completes
      return `opacity:${panel}; --draw:${draw}; --content:${content}; transform: scale(${0.978 + 0.022 * panel});`;
    },
  };
}
