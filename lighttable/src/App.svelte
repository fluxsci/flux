<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte";
  import { handleKey } from "./lib/keymap";
  import TopBar from "./lib/TopBar.svelte";
  import Grid from "./lib/Grid.svelte";
  import Detail from "./lib/Detail.svelte";
  import Compare from "./lib/Compare.svelte";
  import NotesEditor from "./lib/NotesEditor.svelte";
  import EmptyState from "./lib/EmptyState.svelte";

  onMount(() => {
    const api = store.api;
    if (!api) return;
    api.onOpen((m) => store.setManifest(m));
    void (async () => {
      const p = await api.prefsGet();
      store.cols = p.columns;
      store.captions = p.captions;
      store.hGap = p.hGap ?? 8;
      store.vGap = p.vGap ?? 8;
      await store.refreshRecents();
    })();
  });

  // Selection clamps into the filtered view: if the search hid the selected
  // item, select the first visible one instead (converges in one re-run).
  $effect(() => {
    const list = store.filteredKeys;
    if (!store.manifest || list.length === 0) return;
    if (!store.selectedKey || !list.includes(store.selectedKey)) store.selectedKey = list[0];
  });

  function onKeydown(e: KeyboardEvent) {
    handleKey(e, store);
  }
  function onDragOver(e: DragEvent) {
    e.preventDefault();
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    const api = store.api;
    if (!f || !api) return;
    const p = api.pathForFile(f);
    if (p) void store.openPath(p);
  }
</script>

<svelte:window onkeydown={onKeydown} ondragover={onDragOver} ondrop={onDrop} />

{#if !store.manifest}
  <EmptyState />
{:else}
  <TopBar />
  {#if store.manifest.keys.length === 0}
    <!-- keep the top bar: the sister-folder menu is the way back out -->
    <div class="no-images">
      <p>No images found in “{store.manifest.name}”.</p>
      <p class="hint">Click the collection name for sister folders, or Ctrl+click it to open another collection.</p>
    </div>
  {:else}
    <Grid />
    {#if store.view === "detail"}
      <Detail />
    {/if}
    {#if store.view === "compare"}
      <Compare />
    {/if}
    {#if store.notesOpen}
      {#key store.selectedKey}
        <NotesEditor />
      {/key}
    {/if}
  {/if}
{/if}

<style>
  .no-images {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    color: var(--c-tx-muted);
  }
  .no-images p {
    margin: 0;
  }
  .no-images .hint {
    font-size: 11px;
    color: var(--c-tx-faint);
  }
</style>
