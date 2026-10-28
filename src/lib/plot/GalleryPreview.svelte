<script lang="ts">
  import { onMount } from "svelte";
  import { previewBackdrop } from "./previewBackdrop";
  import type { createGalleryPreviews } from "./galleryPreviews";
  export let path: string;
  export let previews: ReturnType<typeof createGalleryPreviews>;
  let url = "", ready = false, failed = false;
  let width = 1, height = 1, aspect = 4 / 3;
  $: pageW = Math.min(width, height * aspect);
  $: pageH = pageW / aspect;
  onMount(() => previews.acquire(path, value => { url = value; ready = true; }));
</script>

<span class="preview" class:failed bind:clientWidth={width} bind:clientHeight={height}>
  <span class="page" style:width={`${pageW}px`} style:height={`${pageH}px`} use:previewBackdrop={{ path }}>
    {#if url && !failed}
      <img src={url} alt="" decoding="async" on:load={e => { const im = e.currentTarget as HTMLImageElement; if (im.naturalHeight) aspect = im.naturalWidth / im.naturalHeight; }} on:error={() => failed = true} />
    {:else if ready}<span>Preview unavailable</span>{/if}
  </span>
</span>

<style>
  .preview { display:flex; align-items:center; justify-content:center; width:100%; height:100%; overflow:hidden; }
  .page { display:flex; align-items:center; justify-content:center; overflow:hidden; background:var(--flx-paper); border-radius:var(--r-0); box-shadow:0 0 0 1px var(--c-line); }
  img { display:block; width:100%; height:100%; object-fit:contain; }
  .page > span { color:var(--c-tx-muted); font:11px var(--font-ui); padding:6px; }
</style>
