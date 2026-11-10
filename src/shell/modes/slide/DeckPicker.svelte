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
    onRename,
    activeTitle = null,
    busy = false,
  }: {
    decks: DeckListItem[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDuplicate: (id: string) => void;
    onDelete: (id: string) => void;
    /** Rename a deck (double-click its name, as a canvas is renamed in Figure). Absent: names are not editable here. */
    onRename?: (id: string, title: string) => void | Promise<void>;
    /** The open deck's title as it is in the editor right now (the list itself is read from disk after each save). */
    activeTitle?: string | null;
    busy?: boolean;
  } = $props();

  // Inline rename, the Figure sidebar's canvas rename exactly: double-click, type, Enter or click away commits, Esc cancels, an empty
  // name is no rename.
  let editing = $state<string | null>(null);
  let editVal = $state("");
  const titleOf = (d: DeckListItem) => (d.id === activeId && activeTitle != null ? activeTitle : d.title);
  function startRename(d: DeckListItem) {
    if (!onRename || busy) return;
    editing = d.id;
    editVal = titleOf(d);
  }
  function commitRename() {
    const id = editing, title = editVal.trim();
    editing = null;
    const deck = decks.find((d) => d.id === id);
    if (!id || !deck || !title || title === titleOf(deck)) return;
    void onRename?.(id, title);
  }
  function onRenameKey(e: KeyboardEvent) {
    e.stopPropagation();   // typing a name is not a slide shortcut
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    else if (e.key === "Escape") { e.preventDefault(); editing = null; }
  }
  function focusSelect(node: HTMLInputElement) { node.focus(); node.select(); }
</script>

{#if decks.length}
  <aside class="deckpicker">
    <div class="dp-head">Decks</div>
    <ul>
      {#each decks as d (d.id)}
        <li>
          {#if editing === d.id}
            <input class="dp-rename" bind:value={editVal} use:focusSelect onkeydown={onRenameKey} onblur={commitRename}
              spellcheck="false" aria-label="Deck name" />
          {:else}
          <button class="dp-item" class:active={d.id === activeId} title={onRename ? `${titleOf(d)}\nClick to open · double-click to rename` : titleOf(d)}
            onclick={() => onSelect(d.id)} ondblclick={() => startRename(d)}>
            <span class="dp-title">{titleOf(d)}</span>
            <span class="dp-count">{d.slides}</span>
          </button>
          {/if}
          <span class="dp-actions" class:off={editing === d.id}>
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
    color: var(--c-tx-2); font: inherit; font-size: 12px; cursor: var(--cursor-cross-hover);
  }
  .dp-actions {
    position: absolute; top: 50%; right: 4px; transform: translateY(-50%);
    display: none; gap: 1px; background: var(--c-surface, var(--c-bg-raised));
  }
  li:hover .dp-actions { display: flex; }
  li:hover .dp-actions.off { display: none; }
  .dp-rename {
    width: 100%; box-sizing: border-box; border: 1px solid var(--c-accent); border-radius: var(--r-1); padding: 4px 6px;
    background: var(--c-bg, transparent); color: var(--c-tx-hi); font: inherit; font-size: 12px; font-weight: 600; outline: none;
  }
  .dp-act {
    border: none; background: none; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover);
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
    border-radius: var(--r-1); padding: 5px 7px; color: var(--c-tx-muted); font: inherit; font-size: 12px; cursor: var(--cursor-cross-hover);
  }
  .dp-new:hover { color: var(--c-tx-hi); border-color: var(--c-accent); }
  .dp-new:disabled, .dp-act:disabled { opacity: 0.5; cursor: var(--cursor-cross); }
</style>
