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
