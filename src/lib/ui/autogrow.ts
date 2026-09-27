// autogrow — size a <textarea> to its content so it never scrolls internally.
//
// Figure-Meta fields grow while their column scrolls. Layout measurements stay
// independent of canvas zoom. Reconnect observers after a move into a utility
// document: its window may keep painting while the opener is hidden.

/** Extra px added to the measured height. scrollHeight is an integer while line
 *  boxes are fractional (13px × 1.45 = 18.85px), so the rounded value can land
 *  below the true content height and shave the last line's descenders — an error
 *  the canvas zoom then multiplies. */
const ROUND_SLACK = 2;

export interface AutogrowParams {
  /** The textarea's current value. Drives the refit for changes that produce no
   *  input event — undo/redo and the headless `set-caption` verb. */
  value: string;
  /** Font size in px. A font-size change resizes no box, so neither the input
   *  listener nor the ResizeObserver fires and the content would silently
   *  overflow a frozen height. It has to arrive as a param. */
  fs: number;
  /** Called after EVERY fit of this element — keystroke or batched (mount,
   *  external value change, font-size change, fonts-ready). Always runs after
   *  the new height is written, so it is the safe place to re-measure a scroll
   *  container or keep the growing element in view. */
  onFit?: (node: HTMLTextAreaElement) => void;
}

// Batched refits: collect nodes, then flush as write-all → read-all → write-all
// so N textareas cost one forced layout instead of N. Used by the mount, the
// fonts-ready pass, and the font-size change — all of which touch every block at
// once. The keystroke path deliberately bypasses this (see below).
const pending = new Set<HTMLTextAreaElement>();
const fitCallbacks = new WeakMap<HTMLTextAreaElement, (node: HTMLTextAreaElement) => void>();
let flushQueued = false;

function flush() {
  flushQueued = false;
  const nodes = [...pending];
  pending.clear();
  for (const el of nodes) el.style.height = "0px";
  const heights = nodes.map((el) => el.scrollHeight + ROUND_SLACK);
  nodes.forEach((el, i) => (el.style.height = `${heights[i]}px`));
  // After all heights are written — so an onFit that measures the scroll
  // container (fades, keep-in-view) always sees the settled layout.
  for (const el of nodes) fitCallbacks.get(el)?.(el);
}

function queueFit(el: HTMLTextAreaElement) {
  pending.add(el);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

const live = new Set<HTMLTextAreaElement>();
let fontsHooked = false;

export function autogrow(node: HTMLTextAreaElement, params: AutogrowParams) {
  let last = { value: params.value, fs: params.fs };
  if (params.onFit) fitCallbacks.set(node, params.onFit);

  // scrollHeight includes padding; ROUND_SLACK also covers the 1px borders.
  const fit = () => {
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight + ROUND_SLACK}px`;
  };

  // The keystroke path. Synchronous and un-deferred on purpose: a rAF- or
  // debounce-deferred fit paints one frame of clipped text at every wrap
  // boundary while typing. Cost is two style writes plus one forced layout
  // scoped to the caption page — comfortably inside the instantaneous budget.
  const onInput = () => {
    last = { value: node.value, fs: last.fs };
    fit();
    fitCallbacks.get(node)?.(node);
  };
  node.addEventListener("input", onInput);

  // Width is the only box change that invalidates the fit. Guard on it, because
  // an unguarded callback refires on our own height writes and can raise
  // Chrome's "ResizeObserver loop completed with undelivered notifications"
  // console error — which the verify harness treats as a failure.
  let lastWidth = 0;
  let ro: ResizeObserver;
  function reconnect() {
    ro?.disconnect();
    const owner = node.ownerDocument.defaultView as Window & typeof globalThis;
    ro = new owner.ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w === lastWidth) return;
      lastWidth = w; queueFit(node);
    });
    lastWidth = 0; ro.observe(node); queueFit(node);
    void node.ownerDocument.fonts?.ready.then(() => { if (node.isConnected) queueFit(node); });
  }
  reconnect();
  node.addEventListener('flux:document-change', reconnect);

  // Georgia does not exist on Linux, so captions render in bundled Gelasio with
  // font-display: swap. A cold cache measures fallback metrics and then re-wraps.
  // Resolves immediately once loaded, so this costs nothing in steady state.
  live.add(node);
  if (!fontsHooked) {
    fontsHooked = true;
    void document.fonts?.ready.then(() => {
      for (const el of live) queueFit(el);
    });
  }

  queueFit(node);

  return {
    update(next: AutogrowParams) {
      if (next.onFit) fitCallbacks.set(node, next.onFit);
      else fitCallbacks.delete(node);
      if (next.value === last.value && next.fs === last.fs) return;
      last = { value: next.value, fs: next.fs };
      queueFit(node);
    },
    destroy() {
      node.removeEventListener("input", onInput);
      ro.disconnect();
      node.removeEventListener("flux:document-change", reconnect);
      live.delete(node);
      pending.delete(node);
      fitCallbacks.delete(node);
    },
  };
}
