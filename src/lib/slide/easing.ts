/** Compatibility entry points; timing curves have one shared resolver. */
import { resolveCurve } from "./curves";
import type { EasingToken, Influence } from "./types";

export function resolveEasing(token?: EasingToken, influence?: Influence): string {
  return resolveCurve({ easing: token, influence }).css;
}

export function resolveEasingFn(token?: EasingToken, influence?: Influence): (t: number) => number {
  return resolveCurve({ easing: token, influence }).clamped;
}
