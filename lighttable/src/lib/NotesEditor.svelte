<script lang="ts">
  // Notes overlay ('n'): view/edit the notes for the selected item in the
  // active annotation class. Saves as you type (main debounces the disk
  // write); Esc / Ctrl+Enter / backdrop click close it. Sits above Detail and
  // Compare so 'n' works from anywhere. All keydowns stop here — typing must
  // never reach the app keymap.
  import { store } from "./store.svelte";

  // The selection cannot change while the editor is open (the keymap is inert
  // behind the focused textarea and the backdrop eats clicks), so capture it.
  const itemKey = store.selectedKey;
  let text = $state(store.annotFor(itemKey)?.notes ?? "");
  let ta = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  });

  function save() {
    if (itemKey) store.setNotes(itemKey, text);
  }
  function closeEditor() {
    save();
    store.closeNotes();
  }
  function onKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      closeEditor();
    }
  }
  function onBackdropPointerDown(e: PointerEvent) {
    if (e.target === e.currentTarget) closeEditor();
  }
</script>

<div
  class="backdrop"
  data-notes-editor
  role="dialog"
  aria-label="Notes"
  tabindex="-1"
  onpointerdown={onBackdropPointerDown}
  onkeydown={onKeydown}
>
  <div class="panel">
    <div class="head">
      <span class="key">{itemKey}</span>
      <span class="grow"></span>
      <span class="cls">◈ {store.annot?.name}</span>
    </div>
    <textarea
      bind:this={ta}
      value={text}
      placeholder="Notes for this item…"
      oninput={(e) => {
        text = e.currentTarget.value;
        save();
      }}
    ></textarea>
    <div class="foot">Esc or Ctrl+Enter to close</div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .panel {
    width: min(560px, 90vw);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--radius-m);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--c-line);
    font-size: 12px;
  }
  .key {
    color: var(--c-tx-hi);
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .cls {
    color: var(--c-tx-muted);
  }
  textarea {
    min-height: 160px;
    resize: vertical;
    padding: 10px 12px;
    background: var(--c-bg-raised);
    border: none;
    outline: none;
    color: var(--c-tx);
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
  }
  .foot {
    padding: 6px 12px;
    font-size: 11px;
    color: var(--c-tx-faint);
    border-top: 1px solid var(--c-line);
  }
</style>
