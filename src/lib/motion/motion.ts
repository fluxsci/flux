// The motion spine: a thin wrapper over the Web Animations API.
//
// Why WAAPI (see SciForge_Stack_Decision.md §3.4): transform/opacity animations
// run on the compositor thread (Tier 1 — survive a busy main thread), and the
// returned Animation is interruptible (pause/reverse/cancel/commitStyles), which
// the feel principles require (style_principles.md P4, P5).

import { DUR, EASE } from "./tokens";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface AnimOpts {
  duration?: number;
  delay?: number;
  easing?: string;
  fill?: FillMode;
  /**
   * Explicit reduced-motion decision. When omitted, falls back to the OS setting
   * (`prefers-reduced-motion`). SLD-3: the slide player computes its OWN reduced flag
   * (so Present/Export can force motion ON with the `M` toggle) and passes it here —
   * otherwise this primitive would re-read the OS and zero the duration regardless,
   * defeating the flag for every keyframe preset.
   */
  reduce?: boolean;
}

/**
 * Animate an element via WAAPI with our token defaults baked in:
 *  - collapses to instant when the user prefers reduced motion (P6)
 *  - layer hygiene: promote with `will-change` during, release on finish (P5)
 * Returns the Animation so callers can sequence (`.finished`) or interrupt it.
 */
export function animate(
  el: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  opts: AnimOpts = {},
): Animation {
  const reduce = opts.reduce ?? prefersReducedMotion();
  const node = el as HTMLElement;
  const anim = node.animate(keyframes, {
    duration: reduce ? 0 : opts.duration ?? DUR.quick,
    delay: reduce ? 0 : opts.delay ?? 0,
    easing: opts.easing ?? EASE.standard,
    fill: opts.fill ?? "both",
  });

  const prevWillChange = node.style.willChange;
  node.style.willChange = "transform, opacity";
  const release = () => {
    node.style.willChange = prevWillChange;
  };
  anim.finished.then(release, release);
  return anim;
}

/** Resolve once every supplied animation has finished (errors swallowed). */
export function allDone(...anims: Animation[]): Promise<void> {
  return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {});
}
