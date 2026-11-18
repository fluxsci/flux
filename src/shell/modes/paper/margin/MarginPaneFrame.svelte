<script lang="ts">
  // A dynamic pane's chrome: a card of the manuscript's own paper, outlined in the pane's ink,
  // with its title seated IN the outline at the top-left and its close button in the outline at
  // the top-right.
  //
  // The top edge is BUILT, not masked: corner cap · title · rule · close · corner cap, laid out
  // as one flex row whose caps and rule carry the border. The outline is therefore really absent
  // behind the title (no measured notch width, no mask, nothing to mispaint at the fractional y
  // offsets the equal flex split produces; a native <legend> drew its border straight through
  // the title there). The card is opaque paper and the title carries a plate of the same paper,
  // so the whole title sits on ONE surface: it used to straddle a frosted grey card and the cream
  // margin (owner, 2026-11-18: "this looks SO hideous"). Opaque also means no backdrop blur to
  // recompute over the animated background on every frame.
  //
  // Panes split the margin height equally (flex: 1 1 0). Materialize/dematerialize are
  // compositor-only (opacity + transform), so the canvas behind never relayouts.
  import type { Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "../../../../lib/motion/motion";
  import type { PaneDescriptor } from "./types";

  let {
    desc,
    active = false,
    badge = null,
    onClose,
    closeHint = "Close this pane (Alt+P closes the focused one)",
    children,
  }: {
    /** Only id, title and color are read: a picker that borrows this chrome passes just those. */
    desc: Pick<PaneDescriptor, "id" | "title" | "color">;
    active?: boolean;
    badge?: string | number | null;
    onClose: () => void;
    /** The close button's tooltip (a picker over the page closes with Esc, not Alt+P). */
    closeHint?: string;
    children: Snippet;
  } = $props();

  function materialize(_node: Element) {
    if (prefersReducedMotion()) return { duration: 0 };
    return {
      duration: 140,
      easing: cubicOut,
      css: (t: number, u: number) =>
        `opacity:${t}; transform: translate3d(0, ${u * 6}px, 0) scale(${0.985 + 0.015 * t});`,
    };
  }
  function dematerialize(_node: Element) {
    if (prefersReducedMotion()) return { duration: 0 };
    return {
      duration: 110,
      easing: cubicOut,
      css: (t: number) => `opacity:${t}; transform: scale(${0.99 + 0.01 * t});`,
    };
  }
</script>

<section
  class="pane mk"
  class:active
  data-pane-id={desc.id}
  style="--pane-c: {desc.color}"
  role="group"
  aria-label={desc.title}
  tabindex="-1"
  in:materialize
  out:dematerialize>
  <header class="edge">
    <i class="cap l" aria-hidden="true"></i>
    <div class="legend">
      <span class="t">{desc.title}</span>
      {#if badge != null}<span class="badge">{badge}</span>{/if}
    </div>
    <i class="rule" aria-hidden="true"></i>
    <button class="x" onclick={onClose} aria-label="Close {desc.title} pane" title={closeHint}>
      <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
    </button>
    <i class="cap r" aria-hidden="true"></i>
  </header>
  <div class="body mk-scroll">
    {@render children()}
  </div>
</section>

<style>
  .pane {
    /* The outline rests a little lighter than the title's ink and comes up to full strength
       when the pane holds focus (or is the active one of several). */
    --edge: color-mix(in oklab, var(--pane-c) 58%, var(--flx-paper));
    --bw: 1.5px;
    /* the height of the title's seat on the outline; it grows with the margin's text size */
    --seat: calc(20px * var(--ts-scale, 1));
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    border-radius: var(--r-2);
    background: var(--flx-paper);
    /* A short shadow: it must not reach the title of the card below (the gap is ~18 px). */
    box-shadow:
      0 1px 0 rgba(16, 15, 15, 0.03),
      0 5px 12px -8px rgba(74, 56, 16, 0.4);
    outline: none;
    transition: box-shadow 90ms linear;
  }
  .pane:focus-within,
  .pane.active {
    --edge: var(--pane-c);
  }
  .pane.active {
    box-shadow:
      0 0 0 3px color-mix(in oklab, var(--pane-c) 11%, transparent),
      0 5px 12px -8px rgba(74, 56, 16, 0.45);
  }

  /* ---- the built top edge ---------------------------------------------------------------- */
  .edge {
    /* tall enough for the corner arc AND for the half of the title that hangs below the line,
       so the title never reaches into the content */
    --edge-h: max(var(--r-2), calc(var(--seat) / 2 + 1px));
    flex: 0 0 var(--edge-h);
    height: var(--edge-h);
    display: flex;
    align-items: flex-start;
    /* above the body, whose first row may scroll under the title's lower half */
    position: relative;
    z-index: 1;
  }
  .cap,
  .rule {
    box-sizing: border-box;
    height: 100%;
    border-top: var(--bw) solid var(--edge);
    transition: border-color 90ms linear;
  }
  .cap {
    flex: 0 0 14px;
  }
  .cap.l {
    border-left: var(--bw) solid var(--edge);
    border-top-left-radius: var(--r-2);
  }
  .cap.r {
    border-right: var(--bw) solid var(--edge);
    border-top-right-radius: var(--r-2);
  }
  .rule {
    flex: 1 1 auto;
    min-width: 8px;
  }
  /* Title and close sit centred on the outline: a fixed height and half of it as a negative
     margin (never a transform, which would put the text on half pixels). */
  .legend,
  .x {
    flex: 0 0 auto;
    height: var(--seat);
    margin-top: calc(var(--seat) / -2 + 1px);
    background: var(--flx-paper);
    border-radius: var(--r-1);
  }
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: calc(100% - 78px);
    padding: 0 8px;
    font-family: var(--font-serif);
    font-style: italic;
    font-weight: 600;
    font-size: var(--ts-sm);
    letter-spacing: 0.005em;
    color: var(--pane-c);
    line-height: 1;
    white-space: nowrap;
    user-select: none;
  }
  .t {
    overflow: hidden;
    text-overflow: ellipsis;
    /* italic descenders and the J of "Journal" need a hair of room inside the clip */
    padding: 2px 1px;
  }
  .badge {
    flex: 0 0 auto;
    min-width: calc(16px * var(--ts-scale, 1));
    box-sizing: border-box;
    padding: 2px 5px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--pane-c) 13%, transparent);
    font: 600 calc(10px * var(--ts-scale, 1)) / 1 var(--font-mono);
    font-style: normal;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .x {
    width: var(--seat);
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 0;
    color: color-mix(in oklab, var(--pane-c) 55%, var(--flx-paper));
    cursor: var(--cursor-cross-hover);
    transition:
      color 80ms linear,
      background 80ms linear;
  }
  .x svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .pane:hover .x,
  .pane:focus-within .x {
    color: var(--pane-c);
  }
  .x:hover {
    background: color-mix(in oklab, var(--pane-c) 14%, var(--flx-paper));
  }
  .x:active {
    background: color-mix(in oklab, var(--pane-c) 24%, var(--flx-paper));
  }
  .x:focus-visible {
    outline: 2px solid var(--pane-c);
    outline-offset: 1px;
  }

  /* ---- the rest of the outline, and the content ------------------------------------------- */
  .body {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    overflow: auto;
    border: var(--bw) solid var(--edge);
    border-top: 0;
    border-radius: 0 0 var(--r-2) var(--r-2);
    transition: border-color 90ms linear;
  }
</style>
