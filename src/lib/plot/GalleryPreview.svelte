<script lang="ts">
  import { onMount } from "svelte";
  import type { createGalleryPreviews } from "./galleryPreviews";
  export let path: string;
  export let previews: ReturnType<typeof createGalleryPreviews>;
  let url = "", ready = false, failed = false;
  onMount(() => previews.acquire(path, value => { url = value; ready = true; }));
</script>

<span class="preview" class:failed>
  {#if url && !failed}
    <img src={url} alt="" decoding="async" on:error={() => failed = true} />
  {:else if ready}
    <span>Preview unavailable</span>
  {/if}
</span>

<style>
  .preview { display:flex; align-items:center; justify-content:center; width:100%; height:100%; overflow:hidden; background:var(--flx-paper); border-radius:4px; }
  img { display:block; width:100%; height:100%; object-fit:contain; padding:8px; }
  .preview > span { color:var(--c-tx-muted); font-size:11px; }
</style>
