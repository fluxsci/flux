<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";
  import { renderFigureSvg } from "../../scholar/figures";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  let selId = $state<string | null>(null);
  const figures = $derived(host.figures);
  const current = $derived(figures.find((f) => f.id === selId) ?? figures[0]);
  const svg = $derived(current ? renderFigureSvg(current.id) : undefined);
</script>

<div class="fv">
  {#if figures.length === 0}
    <p class="empty">No figures in this project yet.</p>
  {:else}
    <div class="stage">
      {#if svg}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html svg}
      {:else}
        <div class="noprev">No preview</div>
      {/if}
    </div>
    {#if current}
      <div class="meta">
        <p class="cap"><b>Figure {current.number}.</b> {current.caption || current.name}</p>
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
          title={f.name}
          onclick={() => (selId = f.id)}>
          <div class="art">{@html renderFigureSvg(f.id) ?? ""}</div>
          <span class="tn">{f.number}</span>
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
    background: var(--flx-paper);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    padding: var(--sp-4);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 180px;
  }
  .stage :global(svg) {
    max-width: 100%;
    max-height: 320px;
    height: auto;
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
