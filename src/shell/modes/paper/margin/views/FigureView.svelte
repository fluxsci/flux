<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";
  import { renderFigureSvg } from "../../scholar/figures";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  let selId = $state<string | null>(null);
  const figures = $derived(host.figures);
  const current = $derived(figures.find((f) => f.id === selId) ?? figures[0]);
  const svg = $derived(current ? renderFigureSvg(current.id) : undefined);

  // Zoom/pan on the selected figure (wheel = zoom toward the cursor, drag =
  // pan, double-click = reset) — pure transforms on the stage content, no
  // layout. Same exp-zoom pattern as SlideStage.
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let stageEl = $state<HTMLDivElement | undefined>(undefined);
  let dragging = $state(false);
  let drag: { px: number; py: number; x0: number; y0: number } | null = null;

  // A new figure gets a fresh view — the previous crop rarely fits it.
  $effect(() => {
    void current?.id;
    zoom = 1;
    panX = 0;
    panY = 0;
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
  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }
</script>

<div class="fv">
  {#if figures.length === 0}
    <p class="empty">No figures in this project yet.</p>
  {:else}
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
        {#if svg}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html svg}
        {:else}
          <div class="noprev">No preview</div>
        {/if}
      </div>
      {#if zoom !== 1 || panX !== 0 || panY !== 0}
        <button class="zreset" onclick={resetView} title="Reset view (double-click)">
          {Math.round(zoom * 100)}%
        </button>
      {/if}
    </div>
    {#if current}
      <div class="meta">
        <p class="cap"><b>{current.captionLabel.trimEnd()}</b> {current.caption || current.nickname || ""}</p>
        <div class="acts">
          <button onclick={() => host.insertFigure(current)}>Insert</button>
          <button class="ghost" onclick={() => host.openFigure(current.id)}>Open in Figure</button>
        </div>
      </div>
    {/if}
    <div class="thumbs">
      {#each figures as f (f.id)}
        <button
          class="thumb"
          class:sel={f.id === current?.id}
          title={f.nickname ? `${f.name} — ${f.nickname}` : f.name}
          onclick={() => (selId = f.id)}>
          <div class="art">{@html renderFigureSvg(f.id) ?? ""}</div>
          <span class="tn">{f.display}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .fv {
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    height: 100%;
    overflow: auto;
  }
  .empty {
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
    padding: var(--sp-4);
    text-align: center;
  }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 160px;
    background: var(--flx-paper);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    overflow: hidden;
    cursor: grab;
    touch-action: none;
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
    padding: var(--sp-4);
    transform-origin: 0 0;
    will-change: transform;
  }
  .stage :global(svg) {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    pointer-events: none;
    user-select: none;
  }
  .zreset {
    position: absolute;
    right: 6px;
    bottom: 6px;
    font: inherit;
    font-size: var(--ts-xs);
    font-variant-numeric: tabular-nums;
    padding: 2px 8px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--flx-paper) 82%, transparent);
    color: var(--c-tx-muted);
    cursor: pointer;
  }
  .zreset:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-accent);
  }
  .noprev {
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
  }
  .cap {
    margin: 0 0 var(--sp-2);
    font-size: var(--ts-sm);
    line-height: 1.5;
    color: var(--c-tx-2);
  }
  .cap b {
    color: var(--c-accent-bright);
  }
  .acts {
    display: flex;
    gap: var(--sp-2);
  }
  .acts button {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 5px 12px;
    border-radius: var(--r-1);
    cursor: pointer;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: 1px solid transparent;
    font-weight: 600;
  }
  .acts button.ghost {
    background: none;
    border-color: var(--c-line-strong);
    color: var(--c-tx-2);
    font-weight: 400;
  }
  .acts button:hover {
    filter: brightness(1.05);
  }
  .acts button.ghost:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-accent);
    filter: none;
  }
  .thumbs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    gap: var(--sp-2);
  }
  .thumb {
    position: relative;
    aspect-ratio: 4 / 3;
    background: var(--flx-paper);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 5px;
    cursor: pointer;
    overflow: hidden;
  }
  .thumb.sel {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 1px var(--c-accent);
  }
  .thumb .art {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumb :global(svg) {
    max-width: 100%;
    max-height: 100%;
    height: auto;
  }
  .tn {
    position: absolute;
    left: 3px;
    bottom: 2px;
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    background: color-mix(in oklab, var(--flx-paper) 80%, transparent);
    padding: 0 4px;
    border-radius: 3px;
  }
</style>
