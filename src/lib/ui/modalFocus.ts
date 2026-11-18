/** Contain keyboard focus in a modal and return it to the invoking control on
 * close. Recompute candidates on Tab so dynamic/disabled controls stay correct. */
export function modalFocus(node: HTMLElement) {
  const document = node.ownerDocument;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  function key(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const items = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const first = items[0], last = items.at(-1);
    if (!first) { e.preventDefault(); node.focus(); return; }
    if (e.shiftKey && (node.ownerDocument.activeElement === first || node.ownerDocument.activeElement === node)) {
      e.preventDefault(); last?.focus();
    } else if (!e.shiftKey && (node.ownerDocument.activeElement === last || !node.contains(node.ownerDocument.activeElement))) {
      e.preventDefault(); first.focus();
    }
  }
  node.addEventListener('keydown', key);
  // Take the focus on opening: the first control that can hold it. (A disabled first control used
  // to be chosen, `focus()` on it did nothing, and the focus stayed outside the modal: Figure-Meta's
  // first control is its Undo button, disabled until there is something to undo, so none of the
  // dialog's own keys worked until you clicked in it.)
  queueMicrotask(() => {
    if (!node.isConnected || node.contains(node.ownerDocument.activeElement)) return;
    const first = [...node.querySelectorAll<HTMLElement>('textarea,input,button,[tabindex="0"]')].find(el => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
    (first ?? node).focus();
  });
  return { destroy() {
    node.removeEventListener('keydown', key);
    if (previous?.isConnected && (node.contains(node.ownerDocument.activeElement) || document.activeElement === document.body)) previous.focus();
  } };
}
