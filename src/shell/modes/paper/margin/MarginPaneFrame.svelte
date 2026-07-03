<script lang="ts">
  // A dynamic pane's chrome: a frosted-glass card with a colored outline whose
  // title breaks the border at the top-left. The notch is NOT a native
  // <fieldset>/<legend> — Chrome mispaints the legend notch when the fieldset
  // sits at a fractional y offset (which the equal flex split produces for
  // every pane after the first, drawing the border straight through the
  // title). Instead the border lives on a masked ::before: two mask layers
  // (union) erase exactly the top-border segment behind the measured label,
  // at any offset, deterministically. Panes split the margin height equally
  // (flex: 1 1 0). Materialize/dematerialize are compositor-only (opacity +
  // transform) so the canvas behind never relayouts.
  import type { Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "../../../../lib/motion/motion";
  import type { PaneDescriptor } from "./types";

  let {
    desc,
    active = false,
    badge = null,
    onClose,
    children,
  }: {
    desc: PaneDescriptor;
    active?: boolean;
    badge?: string | number | null;
    onClose: () => void;
    children: Snippet;
  } = $props();

  // Measured label width drives the border-notch mask (updates live when the
  // badge count changes the label's size).
  let labelW = $state(0);

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
  class="pane"
  class:active
  data-pane-id={desc.id}
  style="--pane-c: {desc.color}; --notch-w: {labelW}px"
  role="group"
  aria-label={desc.title}
  tabindex="-1"
  in:materialize
  out:dematerialize>
  <div class="legend" bind:offsetWidth={labelW}>
    <span class="t">{desc.title}</span>
    {#if badge != null}<span class="badge">{badge}</span>{/if}
    <button class="x" onclick={onClose} aria-label="Close {desc.title} pane" title="Close (Alt+P)">✕</button>
  </div>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .pane {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    pointer-events: auto;
    border-radius: var(--r-2);
    /* the quiet-glass recipe (FluxFigMenu), thinned so the art reads through */
    background:
      linear-gradient(180deg, color-mix(in oklab, var(--c-tx-hi) 5%, transparent), transparent 42%),
      color-mix(in oklab, var(--c-surface) 72%, transparent);
    backdrop-filter: blur(16px) saturate(120%);
    -webkit-backdrop-filter: blur(16px) saturate(120%);
    outline: none;
  }
  /* The outline, with the title notch erased from its top segment. Layer 1 is
     opaque outside the label's x-band; layer 2 is opaque below the border
     strip; their union leaves exactly (band × top strip) transparent. */
  .pane::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: 1.5px solid var(--pane-c);
    border-radius: var(--r-2);
    -webkit-mask-image:
      linear-gradient(to right, #000 0 14px, transparent 14px calc(14px + var(--notch-w)), #000 calc(14px + var(--notch-w))),
      linear-gradient(to bottom, transparent 0 4px, #000 4px);
    mask-image:
      linear-gradient(to right, #000 0 14px, transparent 14px calc(14px + var(--notch-w)), #000 calc(14px + var(--notch-w))),
      linear-gradient(to bottom, transparent 0 4px, #000 4px);
  }
  .pane.active::before {
    border-width: 2.5px;
  }
  .pane.active {
    box-shadow: 0 0 18px -8px var(--pane-c);
  }
  .legend {
    position: absolute;
    top: 0;
    left: 14px;
    transform: translateY(-52%);
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    max-width: calc(100% - 48px);
    padding: 0 7px;
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-sm);
    color: var(--pane-c);
    line-height: 1.2;
    white-space: nowrap;
    user-select: none;
  }
  .badge {
    font-family: var(--font-sans, inherit);
    font-style: normal;
    font-size: var(--ts-xs);
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--pane-c) 14%, transparent);
  }
  .x {
    background: none;
    border: none;
    padding: 0 2px;
    font-style: normal;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .pane:hover .x,
  .pane:focus-within .x {
    opacity: 0.8;
  }
  .x:hover {
    opacity: 1;
    color: var(--pane-c);
  }
  .body {
    position: absolute;
    inset: 10px 1px 1px;
    overflow: auto;
    border-radius: calc(var(--r-2) - 2px);
  }
</style>
