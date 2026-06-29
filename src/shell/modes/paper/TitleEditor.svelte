<script lang="ts">
  import { untrack } from "svelte";
  import { popIn } from "../../../lib/motion/actions";

  let {
    title,
    authors,
    onSave,
    onClose,
  }: {
    title: string;
    authors: string[];
    onSave: (title: string, authorsCsv: string) => void;
    onClose: () => void;
  } = $props();

  // Seed the form once from the props (the component is re-mounted each open).
  let t = $state(untrack(() => title));
  let a = $state(untrack(() => authors.join(", ")));
  let tEl = $state<HTMLInputElement | undefined>(undefined);

  $effect(() => {
    tEl?.focus();
    tEl?.select();
  });

  function save() {
    onSave(t.trim(), a);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose}></div>
<div class="te" transition:popIn>
  <label>
    <span>Title</span>
    <input bind:this={tEl} bind:value={t} onkeydown={onKey} spellcheck="false" />
  </label>
  <label>
    <span>Authors</span>
    <input bind:value={a} onkeydown={onKey} placeholder="comma, separated" spellcheck="false" />
  </label>
  <div class="row">
    <button class="ghost" onclick={onClose}>Cancel</button>
    <button class="primary" onclick={save}>Save</button>
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 70;
  }
  .te {
    position: absolute;
    top: 58px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 71;
    width: min(440px, 80%);
    padding: var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-3);
    box-shadow: var(--elev-3);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  label span {
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-tx-faint);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 11px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-base);
    outline: none;
  }
  input:focus {
    border-color: var(--c-accent);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: 2px;
  }
  button {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 6px 14px;
    border-radius: var(--r-1);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .ghost {
    background: none;
    border-color: var(--c-line-strong);
    color: var(--c-tx-2);
  }
  .ghost:hover {
    color: var(--c-tx-hi);
  }
  .primary {
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-weight: 600;
  }
  .primary:hover {
    filter: brightness(1.06);
  }
</style>
