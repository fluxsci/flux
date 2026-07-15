<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte";
  import { handleKey } from "./lib/keymap";
  import TopBar from "./lib/TopBar.svelte";
  import Grid from "./lib/Grid.svelte";
  import Detail from "./lib/Detail.svelte";
  import EmptyState from "./lib/EmptyState.svelte";

  onMount(() => {
    const api = store.api;
    if (!api) return;
    api.onOpen((m) => store.setManifest(m));
    void (async () => {
      const p = await api.prefsGet();
      store.cols = p.columns;
      store.captions = p.captions;
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
{:else if store.manifest.keys.length === 0}
  <EmptyState message={`No images found in “${store.manifest.name}”`} />
{:else}
  <TopBar />
  <Grid />
  {#if store.view === "detail"}
    <Detail />
  {/if}
{/if}
