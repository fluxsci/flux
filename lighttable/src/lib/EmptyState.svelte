<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./store.svelte";

  let { message = null }: { message?: string | null } = $props();

  onMount(() => void store.refreshRecents());
</script>

<div class="empty">
  <div class="panel">
    <h1>Lighttable</h1>
    <p class="tag">{message ?? "Open a folder of image sets"}</p>
    <button class="open" onclick={() => void store.openViaDialog()}>Open folder…</button>
    {#if store.recents.length > 0}
      <div class="recents">
        <div class="label">Recent</div>
        {#each store.recents as r (r.path)}
          <button title={r.path} onclick={() => void store.openPath(r.path)}>{r.name}</button>
        {/each}
      </div>
    {/if}
    <p class="hint">…or drop a folder anywhere in this window</p>
  </div>
</div>

<style>
  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 40px 56px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line);
    border-radius: var(--radius-m);
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--c-tx-hi);
    letter-spacing: 0.01em;
  }
  .tag {
    margin: 0;
    color: var(--c-tx-muted);
  }
  .open {
    margin-top: 6px;
    padding: 7px 18px;
    border-radius: var(--radius-s);
    background: var(--c-accent-deep);
    color: var(--c-tx-hi);
    font-weight: 500;
  }
  .open:hover {
    background: var(--c-accent);
  }
  .recents {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    margin-top: 10px;
    min-width: 220px;
  }
  .label {
    font-size: 11px;
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 2px;
    text-align: center;
  }
  .recents button {
    padding: 5px 10px;
    border-radius: var(--radius-s);
    color: var(--c-tx-2);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recents button:hover {
    background: var(--c-surface);
    color: var(--c-tx);
  }
  .hint {
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--c-tx-faint);
  }
</style>
