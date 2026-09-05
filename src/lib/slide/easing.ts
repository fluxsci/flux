/** One timing curve for native effects, geometry, and inspected frames. */
import { EASE, smoothEasing, smoothstep, influenceToCss, cubicBezierFn, type Bezier } from "../motion/tokens";
import type { EasingToken, Influence } from "./types";

export function resolveEasing(token?: EasingToken, influence?: Influence): string {
  if (influence && (influence.in > 0 || influence.out > 0)) return influenceToCss(influence);
  if (token === "smooth") return smoothEasing();
  if (token === "linear") return "linear";
  return EASE[token ?? "standard"] ?? EASE.standard;
}

const curves = new Map<string, (t: number) => number>();
export function resolveEasingFn(token?: EasingToken, influence?: Influence): (t: number) => number {
  if (token === "smooth" && !(influence && (influence.in > 0 || influence.out > 0))) return smoothstep;
  const css = resolveEasing(token, influence);
  if (css === "linear") return (t) => t;
  let curve = curves.get(css);
  if (!curve) {
    const coefficients = css.match(/-?\d*\.?\d+/g)?.map(Number) as Bezier | undefined;
    curve = coefficients?.length === 4 ? cubicBezierFn(coefficients) : smoothstep;
    curves.set(css, curve);
  }
  return curve;
}
