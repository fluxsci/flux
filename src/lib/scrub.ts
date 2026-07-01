// ---------------------------------------------------------------------------
// `scrub` — a Svelte action for label-drag numeric scrubbing (Feature 8).
//
// Attach to a field's LABEL: pointer-dragging it changes the value (right =
// increase), the cursor becomes ew-resize, and modifiers change the step
// (Shift = ×10, Alt = ÷10). The whole drag is ONE undo entry: we defer the
// history snapshot (beginGesture) until the first real move, so a plain click
// creates no history, then apply each step through the caller's `onStep`, which
// is expected to use `mutate` (no new history) — mirroring the Canvas gesture
// pattern. Values snap to a clean grid of the effective step (precision for
// scientific layout), starting from the rounded current value (no jump).
// ---------------------------------------------------------------------------

import { beginGesture } from "./store";

export interface ScrubParams {
  get: () => number; // current value at gesture start
  onStep: (v: number) => void; // apply a new value (should use `mutate`)
  step?: number; // base step per pixel (default 1)
  min?: number | null;
  max?: number | null;
}

const precisionOf = (eff: number) => (eff < 1 ? Math.min(4, Math.ceil(-Math.log10(eff))) : 0);

export function scrub(node: HTMLElement, params: ScrubParams) {
  let p = params;
  let startX = 0;
  let startVal = 0;
  let began = false; // beginGesture fired for this gesture
  let active = false;

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // don't focus the wrapped input on a label click
    e.stopPropagation();
    active = true;
    began = false;
    startX = e.clientX;
    startVal = p.get();
    node.setPointerCapture(e.pointerId);
    node.classList.add("scrubbing");
  }

  function move(e: PointerEvent) {
    if (!active) return;
    const dx = e.clientX - startX;
    if (!began) {
      if (Math.abs(dx) < 2) return; // ignore micro-jitter → keep clicks clean
      beginGesture();
      began = true;
    }
    const base = p.step ?? 1;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const eff = base * mult;
    const anchor = Math.round(startVal / eff) * eff;
    let v = anchor + Math.round(dx) * eff;
    if (p.min != null) v = Math.max(p.min, v);
    if (p.max != null) v = Math.min(p.max, v);
    v = +v.toFixed(precisionOf(eff));
    p.onStep(v);
  }

  function up(e: PointerEvent) {
    if (!active) return;
    active = false;
    node.classList.remove("scrubbing");
    try {
      node.releasePointerCapture(e.pointerId);
    } catch {}
  }

  node.style.cursor = "ew-resize";
  node.style.touchAction = "none";
  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);

  return {
    update(next: ScrubParams) {
      p = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    },
  };
}
