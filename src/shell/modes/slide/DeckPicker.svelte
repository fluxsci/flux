<script lang="ts">
  // D: the project's deck list, above the slide filmstrip. Lists every deck,
  // highlights the active one, shows its slide count, and offers "+ New deck".
  // Modeled on Paper's DocumentPicker.svelte.
  import type { DeckListItem } from "../../../lib/project/slideBridge";

  let {
    decks,
    activeId,
    onSelect,
    onNew,
  }: {
    decks: DeckListItem[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
  } = $props();
</script>

{#if decks.length}
  <aside class="deckpicker">
    <div class="dp-head">Decks</div>
    <ul>
      {#each decks as d (d.id)}
        <li>
          <button class="dp-item" class:active={d.id === activeId} title={d.title} onclick={() => onSelect(d.id)}>
            <span class="dp-title">{d.title}</span>
            <span class="dp-count">{d.slides}</span>
          </button>
        </li>
      {/each}
    </ul>
    <button class="dp-new" onclick={onNew}>+ New deck</button>
  </aside>
{/if}

<style>
  .deckpicker {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    margin-bottom: 8px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    background: var(--c-surface, var(--c-bg-raised));
  }
  .dp-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--c-tx-faint);
    padding: 2px 4px 6px;
  }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .dp-item {
    width: 100%; display: flex; align-items: center; gap: 6px; text-align: left;
    background: none; border: none; border-radius: var(--r-1); padding: 5px 7px;
    color: var(--c-tx-2); font: inherit; font-size: 12px; cursor: pointer;
  }
  .dp-item:hover { background: var(--c-accent-tint-2); color: var(--c-tx-hi); }
  .dp-item.active { background: var(--c-accent-tint-2); color: var(--c-tx-hi); font-weight: 600; }
  .dp-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dp-count {
    flex: 0 0 auto; font-size: 10px; color: var(--c-tx-muted);
    font-variant-numeric: tabular-nums; min-width: 14px; text-align: right;
  }
  .dp-new {
    margin-top: 6px; text-align: left; background: none; border: 1px dashed var(--c-line-strong);
    border-radius: var(--r-1); padding: 5px 7px; color: var(--c-tx-muted); font: inherit; font-size: 12px; cursor: pointer;
  }
  .dp-new:hover { color: var(--c-tx-hi); border-color: var(--c-accent); }
</style>
