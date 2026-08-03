// autogrow — size a <textarea> to its content so it never scrolls internally.
//
// Built for the caption editor, where the requirement is that every caption is
// fully visible on open and the PAGE scrolls between blocks (CaptionEditor.svelte).
// Reusable for any textarea that should grow with its text.
//
// Measurement rule: layout properties only (scrollHeight/clientHeight), never
// getBoundingClientRect. The caption page lives inside a `transform: scale(zoom)`
// world-space layer; layout values are pre-transform (what we want to write back)
// while gBCR is transform-scaled and would corrupt the fit at any zoom ≠ 1. The
// corollary is that a zoom change needs no re-fit at all.

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
  /** Called after a keystroke-driven fit, with the freshly sized element — the
   *  hook for keeping a growing element in view inside a scroll container. */
  onFit?: (node: HTMLTextAreaElement) => void;
}

// Batched refits: collect nodes, then flush as write-all → read-all → write-all
// so N textareas cost one forced layout instead of N. Used by the mount, the
// fonts-ready pass, and the font-size change — all of which touch every block at
// once. The keystroke path deliberately bypasses this (see below).
const pending = new Set<HTMLTextAreaElement>();
let flushQueued = false;

function flush() {
  flushQueued = false;
  const nodes = [...pending];
  pending.clear();
  for (const el of nodes) el.style.height = "0px";
  const heights = nodes.map((el) => el.scrollHeight + ROUND_SLACK);
  nodes.forEach((el, i) => (el.style.height = `${heights[i]}px`));
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
  let onFit = params.onFit;

  // Height is measured with box-sizing: border-box and no border/padding on the
  // element (see .cap-text) — if a border is ever added here, the block border
  // width has to be added to the written height.
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
    onFit?.(node);
  };
  node.addEventListener("input", onInput);

  // Width is the only box change that invalidates the fit. Guard on it, because
  // an unguarded callback refires on our own height writes and can raise
  // Chrome's "ResizeObserver loop completed with undelivered notifications"
  // console error — which the verify harness treats as a failure.
  let lastWidth = 0;
  const ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (w === lastWidth) return;
    lastWidth = w;
    queueFit(node);
  });
  ro.observe(node);

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
      onFit = next.onFit;
      if (next.value === last.value && next.fs === last.fs) return;
      last = { value: next.value, fs: next.fs };
      queueFit(node);
    },
    destroy() {
      node.removeEventListener("input", onInput);
      ro.disconnect();
      live.delete(node);
      pending.delete(node);
    },
  };
}
