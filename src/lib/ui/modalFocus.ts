/** Contain keyboard focus in a modal and return it to the invoking control on
 * close. Recompute candidates on Tab so dynamic/disabled controls stay correct. */
export function modalFocus(node: HTMLElement) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  function key(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const items = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const first = items[0], last = items.at(-1);
    if (!first) { e.preventDefault(); node.focus(); return; }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      e.preventDefault(); last?.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  }
  node.addEventListener('keydown', key);
  return { destroy() {
    node.removeEventListener('keydown', key);
    if (previous?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
  } };
}
