// The compositor drive — per-frame transforms that never re-layerize.
//
// Chromium re-runs PaintArtifactCompositor::Update (layerization, O(paint
// chunks)) after EVERY inline-style transform write, even on a will-change
// layer. Over a dense scene (15k mounted plot nodes ≈ thousands of chunks) that
// is 4–7 ms per frame — the whole budget of a compositor-only pan spent on the
// main thread (measured 2026-09-16: 6.7 ms/frame on the neural-populations
// example; scripts/perf/layerize-lab.mjs reproduces it standalone). A paused
// Web Animation whose keyframes are replaced per change is different: the
// compositor OWNS the value, and the lab shows ONE layerization per gesture
// (the same for a native scroll offset), with the base inline style free to
// track the value alongside.
//
// Lifecycle mirrors the P6 will-change rule: hot() while an interaction is
// live (the animation exists → the element is composited), cool() at idle
// (the animation is cancelled the same frame the base style already holds the
// value → no flash, no permanent promotion, crisp-at-rest re-raster intact).
// `el.style.transform` is ALWAYS current, so getComputedStyle-based probes and
// at-rest gates read the truth whether or not a gesture is live.

export interface TransformDrive {
  /** Publish the current transform (any time). */
  set(transform: string): void;
  /** Enter compositor-driven mode (idempotent). */
  hot(): void;
  /** Back to the plain inline style (idempotent, same-frame, no flash). */
  cool(): void;
  destroy(): void;
  /** Diagnostic: is the paused animation carrying the value right now? */
  readonly driven: boolean;
}

type Animatable = Element & ElementCSSInlineStyle & { animate?: Element["animate"] };

export function createTransformDrive(el: Animatable): TransformDrive {
  let anim: Animation | null = null;
  let current = el.style.transform || "";
  const frames = (t: string) => [{ transform: t }, { transform: t }];
  const drop = () => {
    try {
      anim?.cancel();
    } catch {
      /* already gone */
    }
    anim = null;
  };
  return {
    get driven() {
      return anim !== null;
    },
    set(t) {
      current = t;
      el.style.transform = t; // the base value: truth at rest, mirror while driven
      if (!anim) return;
      try {
        (anim.effect as KeyframeEffect).setKeyframes(frames(t));
      } catch {
        drop(); // an effect that refuses keyframes falls back to the style write above
      }
    },
    hot() {
      if (anim || typeof el.animate !== "function") return;
      try {
        anim = el.animate(frames(current), { duration: 1000, fill: "both" });
        anim.pause();
      } catch {
        anim = null;
      }
    },
    cool() {
      if (!anim) return;
      el.style.transform = current; // already equal — explicit, so cancel() can never expose a stale base
      drop();
    },
    destroy: drop,
  };
}
