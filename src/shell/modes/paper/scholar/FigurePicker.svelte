<script lang="ts">
  import { popIn, fadeRise } from "../../../../lib/motion/actions";
  import { renderFigureSvg, type FigureRef } from "./figures";

  let {
    figures,
    onSelect,
    onClose,
  }: {
    figures: FigureRef[];
    onSelect: (ref: FigureRef) => void;
    onClose: () => void;
  } = $props();

  let query = $state("");
  const filtered = $derived(
    query.trim()
      ? figures.filter((f) =>
          (f.name + " " + f.label + " " + f.caption)
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : figures,
  );

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose} transition:fadeRise={{ y: 0 }}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="picker" onclick={(e) => e.stopPropagation()} transition:popIn>
    <header>
      <span class="ttl">Insert figure</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="search"
        placeholder="Search figures…"
        bind:value={query}
        autofocus />
    </header>

    {#if filtered.length}
      <div class="grid">
        {#each filtered as f (f.id)}
          {@const svg = renderFigureSvg(f.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="cell" onclick={() => onSelect(f)}>
            <div class="thumb">
              {#if svg}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html svg}
              {:else}
                <span class="ph">no preview</span>
              {/if}
            </div>
            <div class="meta">
              <b>Fig {f.number}</b>
              <span class="nm">{f.name || f.label}</span>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="empty">
        {figures.length ? "No figures match." : "This project has no figures yet."}
      </p>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--c-bg) 62%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 80;
  }
  .picker {
    width: min(680px, 86%);
    max-height: 78%;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-3);
    box-shadow: var(--elev-3);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--c-line);
  }
  .ttl {
    font-weight: 600;
    color: var(--c-tx-hi);
    white-space: nowrap;
  }
  .search {
    flex: 1;
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 6px 10px;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
  }
  .search:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--sp-3);
    padding: var(--sp-4);
    overflow: auto;
  }
  .cell {
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    overflow: hidden;
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 120ms) ease,
      transform var(--dur-quick, 120ms) ease;
    background: var(--c-bg);
  }
  .cell:hover {
    border-color: var(--c-accent);
    transform: translateY(-2px);
  }
  .thumb {
    height: 120px;
    background: var(--flx-paper, #fdfcfa);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 8px;
  }
  .thumb :global(svg) {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    width: auto;
  }
  .ph {
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-style: italic;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    padding: 8px 10px;
    border-top: 1px solid var(--c-line);
  }
  .meta b {
    color: var(--c-accent-bright);
  }
  .nm {
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: var(--sp-6);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
  }
</style>
