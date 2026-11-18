<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";
  import { figureThumb, figRefText, resolveFigure } from "../../scholar/figures";
  import { plainCaption } from "../../scholar/figText";
  import FigureStage from "../../scholar/FigureStage.svelte";

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

  // A new figure starts with no panels chosen (the stage resets its own view).
  $effect(() => {
    void current?.id;
    panels = [];
  });
</script>

<div class="fv mk-pane">
  {#if figures.length === 0}
    <p class="mk-empty">No figures in this project yet. Compose one in Figure mode and it appears here.</p>
  {:else}
    <FigureStage figureId={current?.id ?? null} />
    {#if current}
      <div class="meta">
        <p class="cap" title={plainCaption(current.caption) || current.nickname || ""}><b>{current.captionLabel.trimEnd()}</b> {plainCaption(current.caption) || current.nickname || ""}</p>
        {#if current.panels.length}
          <div class="panels" role="group" aria-label="Panels to reference">
            <span class="mk-eyebrow">Panels</span>
            <span class="letters mk-letters">
              {#each current.panels as panel}
                <button class="mk-letter" class:chosen={panels.includes(panel)} aria-pressed={panels.includes(panel)} aria-label={`Panel ${panel}`} onclick={() => togglePanel(panel)}>{panel}</button>
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
  /* A thumbnail still being drawn has no bitmap yet: hide the broken-picture box and hatch its
     frame instead. (The stage above does the same for itself: FigureStage.svelte.) */
  .thumb img:global([data-figure-state="pending"]) {
    visibility: hidden;
  }
  .thumb img:global([data-figure-state="ready"]) {
    animation: fv-arrive var(--dur-fade) linear both;
  }
  @keyframes fv-arrive {
    from {
      opacity: 0;
    }
  }
  /* Hatched on the THUMBNAIL's own box: the hidden image keeps its reserved size, which can be
     wider than the cell, and a hatch placed inside it drifted off to one side. */
  .thumb:has(img:global([data-figure-state="pending"]))::after {
    content: "";
    position: absolute;
    inset: 16% 18% 34%;
    border-radius: var(--r-ui);
    background: repeating-linear-gradient(135deg, var(--c-line) 0 1px, transparent 1px 7px);
    opacity: 0.9;
  }
  .thumb img:global([data-figure-state="missing"]) {
    font: italic var(--ts-xs) var(--font-serif);
    color: var(--c-tx-faint);
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
    position: relative;
    overflow: hidden;
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
