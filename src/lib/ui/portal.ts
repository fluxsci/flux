// Svelte action for shell modals (Annotate, Inbox): move the node into the
// fullscreen root, or Present's root, when there is one, because a sibling
// cannot paint over fullscreen. Only then: a node moved out of its block's
// anchor range is not removed when the block is, so destroy() removes it
// itself. (Re-appending it to its own parent once left a closed composer on
// screen after every save.)
export function fullscreenPortal(node: HTMLElement): { destroy?: () => void } {
  const root = node.ownerDocument.fullscreenElement ?? node.ownerDocument.querySelector(".present");
  if (!root || root === node.parentNode || root.contains(node)) return {};
  root.appendChild(node);
  return { destroy() { node.remove(); } };
}
