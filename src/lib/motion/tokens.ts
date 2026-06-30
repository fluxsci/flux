// Motion tokens — the JS-accessible mirror of the CSS motion tokens in
// styles/tokens.css. Keep the two in sync. See style_principles.md §2.

export const DUR = {
  instant: 110,
  quick: 200,
  gentle: 320,
  deliberate: 540,
} as const;

export const EASE = {
  standard: "cubic-bezier(0.4, 0, 0.2, 1)",
  enter: "cubic-bezier(0.16, 1, 0.3, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  smooth: "cubic-bezier(0.45, 0, 0.55, 1)",
} as const;

/** manim's "easy-ease": the 5th-order smoothstep S-curve, 6t⁵ − 15t⁴ + 10t³. */
export function smoothstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// --- After Effects-style "influence" velocity profile ------------------------
// Outgoing influence pulls the START handle along x (slow-out); incoming pulls the
// END handle (slow-in). 0/0 = linear, ~33/33 ≈ a standard ease, 100/100 = a strong
// slow-in/slow-out. Both handles keep y at the baseline (0 and 1), so only the
// timing — not overshoot — changes.
export type Bezier = [number, number, number, number];
export function influenceToBezier(inf: { in: number; out: number }): Bezier {
  const out = Math.max(0, Math.min(100, inf.out)) / 100;
  const inc = Math.max(0, Math.min(100, inf.in)) / 100;
  return [out, 0, 1 - inc, 1];
}
export function influenceToCss(inf: { in: number; out: number }): string {
  const [x1, y1, x2, y2] = influenceToBezier(inf);
  return `cubic-bezier(${x1.toFixed(3)}, ${y1}, ${x2.toFixed(3)}, ${y2})`;
}

/** A JS sampler y(x) for a cubic-bezier easing (x,y ∈ [0,1]) — Newton's method
 *  with a bisection fallback. Used by the morph driver (which eases time in rAF,
 *  not via WAAPI) so it honours the same influence profile as keyframe anims. */
export function cubicBezierFn([x1, y1, x2, y2]: Bezier): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const e = sampleX(t) - x;
      if (Math.abs(e) < 1e-5) return sampleY(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    // bisection fallback if Newton stalled
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const e = sampleX(t) - x;
      if (Math.abs(e) < 1e-5) break;
      if (e > 0) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/**
 * The true smoothstep sampled into a WAAPI `linear()` easing string (supported
 * in Chromium 113+, i.e. Electron 33). Use for the signature self-draw moments
 * where we want manim's exact curve rather than the bezier approximation.
 */
export function smoothEasing(steps = 24): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) pts.push(smoothstep(i / steps).toFixed(4));
  return `linear(${pts.join(",")})`;
}
