/** Numeric label drag. Pointer mechanics only: the owner supplies its editing
 * transaction (or edits a local tool parameter without touching history). */
export interface ScrubParams {
  get: () => number;
  onStep: (value: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onCancel?: () => void;
  step?: number;
  min?: number | null;
  max?: number | null;
  disabled?: boolean;
}
const precisionOf = (step: number) => step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0;
export function scrub(node: HTMLElement, params: ScrubParams) {
  let p = params;
  let startX = 0, startVal = 0, lastVal = 0;
  let pointer: number | null = null;
  let began = false;
  function finish(cancel: boolean) {
    if (pointer === null) return;
    const id = pointer;
    pointer = null;
    node.classList.remove('scrubbing');
    if (began) (cancel ? p.onCancel : p.onEnd)?.();
    began = false;
    try { node.releasePointerCapture(id); } catch { /* capture already lost */ }
  }
  function down(e: PointerEvent) {
    if (p.disabled || node.closest('fieldset:disabled') || e.button !== 0 || pointer !== null) return;
    e.preventDefault();
    e.stopPropagation();
    pointer = e.pointerId;
    startX = e.clientX;
    startVal = lastVal = p.get();
    began = false;
    node.setPointerCapture(e.pointerId);
    node.classList.add('scrubbing');
  }
  function move(e: PointerEvent) {
    if (pointer !== e.pointerId) return;
    const dx = e.clientX - startX;
    if (!began && Math.abs(dx) < 2) return;
    const step = (p.step ?? 1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    let value = startVal + Math.round(dx) * step;
    if (p.min != null) value = Math.max(p.min, value);
    if (p.max != null) value = Math.min(p.max, value);
    value = +value.toFixed(precisionOf(step));
    if (value === lastVal) return;
    if (!began) { p.onStart?.(); began = true; }
    lastVal = value;
    p.onStep(value);
  }
  const up = () => finish(false);
  const cancel = () => finish(true);
  function key(e: KeyboardEvent) {
    if (pointer === null || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  }
  node.style.cursor = 'ew-resize';
  node.style.touchAction = 'none';
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('lostpointercapture', cancel);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  return {
    update(next: ScrubParams) { if (next.disabled) cancel(); p = next; },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
    },
  };
}
