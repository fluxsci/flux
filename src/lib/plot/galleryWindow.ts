import { get } from "svelte/store";
import { isAnnotateChord, requestAnnotation, annotationOpen } from "../../shell/agent/annotateChord";
/** Move the mounted view, retaining its Svelte state and the opener's store/IO.
 * The destination is an inert same-origin document with no application scripts.
 * All listeners/observers and the native window are owned by this one handle. */
export function openUtilityWindow(node: HTMLElement, onClose: () => void, onDocumentChange: () => void, options: { page: string; frame: string; title: string; focus: string }) {
  const owner = node.ownerDocument;
  const parent = node.parentNode!;
  const marker = owner.createComment(options.title);
  const opened = window.open(new URL(options.page, owner.baseURI).href,
    options.frame, "popup,width=1060,height=780,resizable=yes,scrollbars=no");
  if (!opened) throw new Error("The window could not open. Allow pop-up windows and try again.");
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
  function annotationKey(e: KeyboardEvent) {
    if (isAnnotateChord(e)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) requestAnnotation({ utility: { name: options.frame === "flux-plot-gallery" ? "gallery" : options.frame === "flux-ai-status" ? "ai-status" : "figure-meta", window: popup } });
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyS") {
      e.preventDefault(); e.stopImmediatePropagation();
    } else if (get(annotationOpen)) {
      e.preventDefault(); e.stopImmediatePropagation();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, bubbles: true, cancelable: true }));
    }
  }
  const annotationPointer = (e: Event) => { if (get(annotationOpen)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  function mount() {
    if (disposed || popup.closed) return;
    syncStyles();
    popup.addEventListener("keydown", annotationKey, true);
    popup.addEventListener("pointerdown", annotationPointer, true);
    popup.addEventListener("wheel", annotationPointer, { capture: true, passive: false });
    popup.document.body.appendChild(node);
    onDocumentChange();
    popup.document.title = options.title;
    styles.observe(owner.head, { childList: true, subtree: true, characterData: true });
    theme.observe(owner.documentElement, { attributes: true });
    theme.observe(owner.body, { attributes: true });
    popup.addEventListener("pagehide", closed);
    node.querySelector<HTMLElement>(options.focus)?.focus();
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
    popup.removeEventListener("keydown", annotationKey, true);
    popup.removeEventListener("pointerdown", annotationPointer, true);
    popup.removeEventListener("wheel", annotationPointer, true);
    popup.removeEventListener("load", mount);
    popup.removeEventListener("pagehide", closed);
    marker.parentNode?.insertBefore(node, marker);
    marker.remove();
    onDocumentChange();
    if (!popup.closed) popup.close();
  }
  return { close: dispose, focus: () => popup.focus() };
}

export function openGalleryWindow(node: HTMLElement, onClose: () => void, onDocumentChange: () => void) {
  return openUtilityWindow(node, onClose, onDocumentChange, { page: "plot-gallery.html", frame: "flux-plot-gallery", title: "Plot gallery", focus: ".search-in" });
}
