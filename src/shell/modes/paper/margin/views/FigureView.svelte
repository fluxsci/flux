<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";
  import { figureImage, figureThumb, figRefText, resolveFigure } from "../../scholar/figures";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  let selId = $state<string | null>(null);
  // Panels the reference button cites; none = the whole figure.
  let panels = $state<string[]>([]);
  function togglePanel(panel: string) {
    panels = panels.includes(panel) ? panels.filter((value) => value !== panel) : [...panels, panel];
  }
  const figures = $derived(host.figures);
  const current = $derived(figures.find((f) => f.id === selId) ?? figures[0]);
  const reference = $derived(current ? figRefText(current, panels) : "");
  const referenceLabel = $derived(resolveFigure(reference.slice(1))?.display ?? current?.display ?? "");

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
    panels = [];
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

<div class="fv mk-pane">
  {#if figures.length === 0}
    <p class="mk-empty">No figures in this project yet. Compose one in Figure mode and it appears here.</p>
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
        {#if current}
          <img use:figureImage={current.id} alt="" draggable="false" />
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
    {#if current}
      <div class="meta">
        <p class="cap" title={current.caption || current.nickname || ""}><b>{current.captionLabel.trimEnd()}</b> {current.caption || current.nickname || ""}</p>
        {#if current.panels.length}
          <div class="panels" role="group" aria-label="Panels to reference">
            <span class="mk-eyebrow">Panels</span>
            <span class="letters">
              {#each current.panels as panel}
                <button class:chosen={panels.includes(panel)} aria-pressed={panels.includes(panel)} aria-label={`Panel ${panel}`} onclick={() => togglePanel(panel)}>{panel}</button>
              {/each}
            </span>
          </div>
        {/if}
        <div class="acts">
          <button class="mk-btn primary" onclick={() => host.insertFigure(current)} title="Insert the figure itself at the caret">Insert figure</button>
          <button class="mk-btn" onclick={() => host.insertFigureReference(reference)} title={`Insert a cross-reference (${reference})`}>Insert {referenceLabel}</button>
          <button class="mk-btn quiet ghost" onclick={() => host.openFigure(current.id)} title="Open this figure in Figure mode">Open in Figure</button>
        </div>
      </div>
    {/if}
    <div class="thumbs" role="listbox" aria-label="Figures">
      {#each figures as f (f.id)}
        <button
          class="thumb"
          class:sel={f.id === current?.id}
          role="option"
          aria-selected={f.id === current?.id}
          title={f.nickname ? `${f.name}: ${f.nickname}` : f.name}
          onclick={() => (selId = f.id)}>
          <div class="art"><img use:figureThumb={f.id} alt="" draggable="false" /></div>
          <span class="tn mk-clip">{f.display}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .fv {
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklab, var(--c-tx) 22%, transparent) transparent;
  }
  /* The viewing stage: the figure on white, with room to look closely. */
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
  .fv img:global([data-figure-state="pending"]) {
    visibility: hidden;
  }
  .fv img:global([data-figure-state="ready"]) {
    animation: fv-arrive var(--dur-fade) linear both;
  }
  @keyframes fv-arrive {
    from {
      opacity: 0;
    }
  }
  .zoomer:has(img:global([data-figure-state="pending"]))::after,
  .thumb .art:has(img:global([data-figure-state="pending"]))::after {
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
  .fv img:global([data-figure-state="missing"]) {
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
  .meta {
    flex: 0 0 auto;
    display: grid;
    gap: 8px;
  }
  .cap {
    margin: 0;
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .cap b {
    color: var(--pane-c);
    font-weight: 600;
  }
  .panels {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .letters {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .letters button {
    min-width: calc(22px * var(--ts-scale, 1));
    height: calc(22px * var(--ts-scale, 1));
    padding: 0 5px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    background: var(--mk-field);
    color: var(--c-tx-2);
    font: 600 calc(11px * var(--ts-scale, 1)) / 1 var(--font-mono);
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      border-color 80ms linear,
      color 80ms linear,
      transform 60ms linear;
  }
  .letters button:hover {
    border-color: var(--mk-edge);
    background: var(--mk-tint);
  }
  .letters button:active {
    transform: scale(0.94);
  }
  .letters button.chosen {
    border-color: var(--pane-c);
    background: var(--mk-tint-2);
    color: var(--pane-c);
    box-shadow: inset 0 -2px 0 var(--pane-c);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .thumbs {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(74px * var(--ts-scale, 1)), 1fr));
    gap: 6px;
    padding-top: 9px;
    border-top: 1px solid var(--c-line);
  }
  .thumb {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 3px;
    aspect-ratio: 4 / 3;
    padding: 4px 4px 3px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: #fff;
    cursor: var(--cursor-cross-hover);
    transition:
      border-color 80ms linear,
      box-shadow 80ms linear,
      transform 60ms linear;
  }
  .thumb:hover {
    border-color: var(--mk-edge);
  }
  .thumb:active {
    transform: scale(0.97);
  }
  .thumb.sel {
    border-color: var(--pane-c);
    box-shadow: 0 0 0 2px var(--mk-ring);
  }
  .thumb .art {
    position: relative;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    pointer-events: none;
  }
  .tn {
    color: var(--c-tx-muted);
    font: calc(9.5px * var(--ts-scale, 1)) / 1.2 var(--font-mono);
    text-align: left;
  }
  .thumb.sel .tn {
    color: var(--pane-c);
  }
</style>
