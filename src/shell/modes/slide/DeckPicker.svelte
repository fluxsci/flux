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
    onDuplicate,
    onDelete,
    busy = false,
  }: {
    decks: DeckListItem[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDuplicate: (id: string) => void;
    onDelete: (id: string) => void;
    busy?: boolean;
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
          <span class="dp-actions">
            <button class="dp-act" title="Duplicate deck" aria-label="Duplicate deck" disabled={busy}
              onclick={(e) => { e.stopPropagation(); onDuplicate(d.id); }}>⧉</button>
            {#if decks.length > 1}
              <button class="dp-act dp-del" title="Remove deck from project" aria-label="Remove deck"
                onclick={(e) => { e.stopPropagation(); onDelete(d.id); }}>✕</button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    <button class="dp-new" onclick={onNew} disabled={busy}>{busy ? "Working…" : "+ New deck"}</button>
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
  li { position: relative; }
  .dp-item {
    width: 100%; display: flex; align-items: center; gap: 6px; text-align: left;
    background: none; border: none; border-radius: var(--r-1); padding: 5px 7px;
    color: var(--c-tx-2); font: inherit; font-size: 12px; cursor: pointer;
  }
  .dp-actions {
    position: absolute; top: 50%; right: 4px; transform: translateY(-50%);
    display: none; gap: 1px; background: var(--c-surface, var(--c-bg-raised));
  }
  li:hover .dp-actions { display: flex; }
  .dp-act {
    border: none; background: none; color: var(--c-tx-muted); cursor: pointer;
    border-radius: var(--r-1); padding: 2px 5px; font-size: 12px; line-height: 1;
  }
  .dp-act:hover { color: var(--c-tx-hi); background: var(--c-accent-tint-2); }
  .dp-del:hover { color: var(--c-danger); }
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
  .dp-new:disabled, .dp-act:disabled { opacity: 0.5; cursor: default; }
</style>
