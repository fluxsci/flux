/** Shared lifecycle for rail/dock resizing. Preserve double-click behavior,
 * restore the original preference on cancellation, and always release capture. */
export function pointerDrag(event: PointerEvent, move: (event: PointerEvent) => void, rollback: () => void, ended: () => void) {
  const node = event.currentTarget as HTMLElement;
  const pointer = event.pointerId;
  const userSelect = document.body.style.userSelect;
  let active = true;
  document.body.style.userSelect = 'none';
  try { node.setPointerCapture(pointer); } catch { /* synthetic pointer */ }
  const onMove = (e: PointerEvent) => { if (e.pointerId === pointer) move(e); };
  const onUp = (e: PointerEvent) => { if (e.pointerId === pointer) finish(false); };
  const cancel = () => finish(true);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
  };
  function finish(cancelled: boolean) {
    if (!active) return;
    active = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', key, true);
    node.removeEventListener('lostpointercapture', cancel);
    document.body.style.userSelect = userSelect;
    try { node.releasePointerCapture(pointer); } catch { /* already lost */ }
    if (cancelled) rollback();
    ended();
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', key, true);
  node.addEventListener('lostpointercapture', cancel);
  return cancel;
}
