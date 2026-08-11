<script lang="ts">
  // Top-bar annotation control: shows which annotation class is open (the
  // user's "which set of marks am I in?" anchor), and drops down to switch
  // class, close it, or create a new one (inline input — window.prompt does
  // not exist in Electron renderers).
  import { store } from "./store.svelte";

  let open = $state(false);
  let creating = $state(false);
  let newName = $state("");
  let anchor = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  function onWindowPointerDown(e: PointerEvent) {
    if (open && anchor && !anchor.contains(e.target as Node)) close();
  }
  function close() {
    open = false;
    creating = false;
    newName = "";
  }
  function startCreate() {
    creating = true;
    newName = "";
  }
  $effect(() => {
    if (creating) inputEl?.focus();
  });
  async function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    await store.createAnnotClass(name);
    close();
  }
  // Keys typed in the input must not reach the global keymap (Enter would
  // blur, v/x would mark once focus left).
  function onInputKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void submitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="annot-switcher" bind:this={anchor}>
  <button
    class="current"
    class:none={!store.annot}
    data-annot
    aria-expanded={open}
    title="Annotation class — v valid · x exclude · n notes"
    onclick={() => (open ? close() : (open = true))}
  >
    <span class="tag">◈</span>
    <span class="name">{store.annot?.name ?? "No annotations"}</span>
  </button>
  {#if open}
    <div class="menu" data-annot-menu>
      {#each store.annotClasses as c (c)}
        <button
          class:active={c === store.annot?.name}
          onclick={() => {
            void store.openAnnotClass(c);
            close();
          }}>{c}</button
        >
      {/each}
      {#if store.annot}
        <button
          class="quiet"
          onclick={() => {
            void store.closeAnnotClass();
            close();
          }}>Close annotation class</button
        >
      {/if}
      {#if store.annotClasses.length > 0 || store.annot}
        <div class="sep"></div>
      {/if}
      {#if creating}
        <input
          class="new-input"
          data-annot-input
          placeholder="Class name…  Enter"
          bind:value={newName}
          bind:this={inputEl}
          onkeydown={onInputKeydown}
        />
      {:else}
        <button class="quiet" data-annot-new onclick={startCreate}>New annotation class…</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .annot-switcher {
    position: relative;
  }
  .current {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--radius-s);
    background: var(--c-surface);
    border: 1px solid var(--c-line);
    color: var(--c-tx);
    max-width: 220px;
  }
  .current:hover {
    border-color: var(--c-line-strong);
  }
  .current.none {
    color: var(--c-tx-muted);
  }
  .current .tag {
    color: var(--c-accent);
    font-size: 11px;
  }
  .current.none .tag {
    color: var(--c-tx-faint);
  }
  .current .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .menu {
    position: absolute;
    left: 0;
    top: 30px;
    z-index: 20;
    min-width: 220px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--radius-m);
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .menu > button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border-radius: var(--radius-s);
    color: var(--c-tx);
  }
  .menu > button:hover {
    background: var(--c-ui-hover);
  }
  .menu > button.active {
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
  }
  .menu > button.quiet {
    color: var(--c-tx-2);
  }
  .sep {
    height: 1px;
    background: var(--c-line);
    margin: 4px 6px;
  }
  .new-input {
    display: block;
    width: calc(100% - 8px);
    margin: 4px;
    height: 26px;
    padding: 0 8px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line);
    border-radius: var(--radius-s);
    color: var(--c-tx);
    outline: none;
  }
  .new-input:focus {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
</style>
