<script lang="ts">
  import { store } from "./store.svelte";

  let open = $state(false);
  let anchor = $state<HTMLDivElement | null>(null);

  function onWindowPointerDown(e: PointerEvent) {
    if (open && anchor && !anchor.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="set-switcher" bind:this={anchor}>
  <button class="nav" aria-label="Previous set (Shift+Tab)" onclick={() => store.stepSet(-1)}>‹</button>
  <button class="current" aria-expanded={open} data-set-name onclick={() => (open = !open)}>
    <span class="name">{store.currentSet?.name ?? "—"}</span>
    <span class="count">{store.currentSet?.count ?? 0}</span>
  </button>
  <button class="nav" aria-label="Next set (Tab)" onclick={() => store.stepSet(1)}>›</button>
  {#if open}
    <div class="dropdown" role="listbox" aria-label="Sets">
      {#each store.manifest?.sets ?? [] as s, i (s.id)}
        <button
          role="option"
          aria-selected={i === store.setIndex}
          class:active={i === store.setIndex}
          onclick={() => {
            store.switchSet(i);
            open = false;
          }}
        >
          <span class="idx">{i < 9 ? String(i + 1) : ""}</span>
          <span class="name">{s.name}</span>
          <span class="count">{s.count}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .set-switcher {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .nav {
    width: 22px;
    height: 22px;
    border-radius: var(--radius-s);
    color: var(--c-tx-2);
    font-size: 14px;
    line-height: 1;
  }
  .nav:hover {
    background: var(--c-surface);
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
    max-width: 260px;
  }
  .current:hover {
    border-color: var(--c-line-strong);
  }
  .current .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--c-tx-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .dropdown {
    position: absolute;
    left: 24px;
    top: 30px;
    z-index: 20;
    min-width: 220px;
    max-height: 60vh;
    overflow-y: auto;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--radius-m);
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .dropdown button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 5px 10px;
    border-radius: var(--radius-s);
    color: var(--c-tx);
  }
  .dropdown button:hover {
    background: var(--c-ui-hover);
  }
  .dropdown button.active {
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
  }
  .idx {
    width: 12px;
    color: var(--c-tx-faint);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .dropdown .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
