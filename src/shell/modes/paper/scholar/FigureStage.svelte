<script lang="ts">
  // A figure on white, with room to look closely: wheel zooms toward the pointer, drag pans,
  // double-click (or the % chip) resets. Pure transforms on the stage's content: no layout.
  // One stage for the margin's Figures card and the figure pickers over the manuscript, so a
  // figure is looked at the same way wherever it is chosen. Built on the margin kit: its
  // ancestor supplies --pane-c and the --mk-* tints.
  import { figureImage } from "./figures";

  let { figureId }: {
    /** The figure to show; null shows "No preview". */
    figureId: string | null;
  } = $props();

  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let stageEl = $state<HTMLDivElement | undefined>(undefined);
  let dragging = $state(false);
  let drag: { px: number; py: number; x0: number; y0: number } | null = null;

  // A new figure gets a fresh view: the previous crop rarely fits it.
  $effect(() => {
    void figureId;
    resetView();
  });

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = stageEl?.getBoundingClientRect();
    if (!r) return;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * Math.exp(-e.deltaY * 0.0015)));
    // Keep the content point under the cursor fixed while the scale changes.
    const cx = (e.clientX - r.left - panX) / zoom;
    const cy = (e.clientY - r.top - panY) / zoom;
    panX = e.clientX - r.left - cx * z;
    panY = e.clientY - r.top - cy * z;
    zoom = z;
  }
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { px: panX, py: panY, x0: e.clientX, y0: e.clientY };
    dragging = true;
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    panX = drag.px + (e.clientX - drag.x0);
    panY = drag.py + (e.clientY - drag.y0);
  }
  function onPointerUp() {
    drag = null;
    dragging = false;
  }
  export function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="stage"
  class:dragging
  bind:this={stageEl}
  onwheel={onWheel}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={resetView}>
  <div class="zoomer" style="transform: translate3d({panX}px, {panY}px, 0) scale({zoom})">
    {#if figureId}
      <img use:figureImage={figureId} alt="" draggable="false" />
    {:else}
      <div class="noprev">No preview</div>
    {/if}
  </div>
  {#if zoom !== 1 || panX !== 0 || panY !== 0}
    <button class="zreset mk-num" onclick={resetView} title="Reset the view (or double-click the figure)">
      {Math.round(zoom * 100)}%
    </button>
  {:else}
    <span class="ztip" aria-hidden="true">scroll to zoom · drag to pan</span>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: calc(170px * var(--ts-scale, 1));
    background: #fff;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    contain: layout paint;
    transition: border-color 80ms linear;
  }
  .stage:hover {
    border-color: var(--mk-edge);
  }
  .stage.dragging {
    cursor: grabbing;
  }
  .zoomer {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    transform-origin: 0 0;
    will-change: transform;
  }
  .stage img {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    user-select: none;
    pointer-events: none;
  }
  /* A figure still being drawn has no bitmap yet: an <img> without a source paints the
     browser's broken-picture box. Hide it and let its frame say "coming" instead. */
  .stage img:global([data-figure-state="pending"]) {
    visibility: hidden;
  }
  .stage img:global([data-figure-state="ready"]) {
    animation: stage-arrive var(--dur-fade) linear both;
  }
  @keyframes stage-arrive {
    from {
      opacity: 0;
    }
  }
  .zoomer:has(img:global([data-figure-state="pending"]))::after {
    content: "";
    position: absolute;
    inset: 22%;
    border-radius: var(--r-ui);
    background: repeating-linear-gradient(135deg, var(--c-line) 0 1px, transparent 1px 7px);
    opacity: 0.9;
  }
  .zoomer:has(img:global([data-figure-state="pending"]))::before {
    content: "drawing the figure…";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 12px;
    text-align: center;
    font: italic var(--ts-xs) var(--font-serif);
    color: var(--c-tx-faint);
  }
  .stage img:global([data-figure-state="missing"]) {
    font: italic var(--ts-xs) var(--font-serif);
    color: var(--c-tx-faint);
  }
  .noprev {
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
  }
  .zreset,
  .ztip {
    position: absolute;
    right: 7px;
    bottom: 7px;
    height: calc(20px * var(--ts-scale, 1));
    padding: 0 7px;
    border-radius: var(--r-pill);
    font-size: calc(10px * var(--ts-scale, 1));
    line-height: calc(20px * var(--ts-scale, 1));
  }
  .zreset {
    border: 1px solid var(--mk-edge);
    background: var(--flx-paper);
    color: var(--pane-c);
    cursor: var(--cursor-cross-hover);
    transition: background 80ms linear;
  }
  .zreset:hover {
    background: color-mix(in oklab, var(--pane-c) 12%, var(--flx-paper));
  }
  /* Says what the stage can do, then gets out of the way the moment you use it. */
  .ztip {
    font-family: var(--font-serif);
    font-style: italic;
    color: var(--c-tx-faint);
    background: color-mix(in oklab, #fff 82%, transparent);
    opacity: 0;
    transition: opacity var(--dur-fade) linear;
    pointer-events: none;
  }
  .stage:hover .ztip {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .stage,
    .zreset,
    .ztip {
      transition: none;
    }
    .stage img:global([data-figure-state="ready"]) {
      animation: none;
    }
  }
</style>
