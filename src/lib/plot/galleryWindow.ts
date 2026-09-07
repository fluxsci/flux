/** Move the mounted view, retaining its Svelte state and the opener's store/IO.
 * The destination is an inert same-origin document with no application scripts.
 * All listeners/observers and the native window are owned by this one handle. */
export function openGalleryWindow(node: HTMLElement, onClose: () => void) {
  const owner = node.ownerDocument;
  const parent = node.parentNode!;
  const marker = owner.createComment("plot gallery");
  const opened = window.open(new URL("plot-gallery.html", owner.baseURI).href,
    "flux-plot-gallery", "popup,width=1060,height=780,resizable=yes,scrollbars=no");
  if (!opened) throw new Error("The gallery window could not open. Allow pop-up windows and try again.");
  const popup: Window = opened;
  parent.insertBefore(marker, node);
  let disposed = false;
  const copies: Node[] = [];
  function syncStyles() {
    if (disposed || popup.closed) return;
    const doc = popup.document;
    for (const copy of copies) copy.parentNode?.removeChild(copy);
    copies.length = 0;
    for (const source of owner.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const copy = source.cloneNode(true) as HTMLElement;
      if (source instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = source.href;
      doc.head.appendChild(copy);
      copies.push(copy);
    }
    for (const [source, target] of [[owner.documentElement, doc.documentElement], [owner.body, doc.body]]) {
      for (const a of [...target.attributes]) target.removeAttribute(a.name);
      for (const a of [...source.attributes]) target.setAttribute(a.name, a.value);
    }
  }
  const styles = new MutationObserver(syncStyles);
  const theme = new MutationObserver(syncStyles);
  function mount() {
    if (disposed || popup.closed) return;
    syncStyles();
    popup.document.body.appendChild(node);
    popup.document.title = "Plot gallery";
    styles.observe(owner.head, { childList: true, subtree: true, characterData: true });
    theme.observe(owner.documentElement, { attributes: true });
    theme.observe(owner.body, { attributes: true });
    popup.addEventListener("pagehide", closed);
    node.querySelector<HTMLInputElement>(".search-in")?.focus();
  }
  function closed() { if (!disposed) onClose(); }
  popup.addEventListener("load", mount, { once: true });
  // The opener's document may unload before Svelte can run its destruction.
  const unload = () => dispose();
  window.addEventListener("pagehide", unload);
  function dispose() {
    if (disposed) return;
    disposed = true;
    styles.disconnect(); theme.disconnect();
    window.removeEventListener("pagehide", unload);
    popup.removeEventListener("load", mount);
    popup.removeEventListener("pagehide", closed);
    marker.parentNode?.insertBefore(node, marker);
    marker.remove();
    if (!popup.closed) popup.close();
  }
  return { close: dispose, focus: () => popup.focus() };
}
