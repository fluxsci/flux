<script lang="ts">
  import { onMount } from "svelte";
  import { previewBackdrop } from "./previewBackdrop";
  import type { createGalleryPreviews } from "./galleryPreviews";
  export let path: string;
  export let previews: ReturnType<typeof createGalleryPreviews>;
  let url = "", ready = false, failed = false, aspect = 4 / 3;
  onMount(() => previews.acquire(path, value => { url = value; ready = true; }));
</script>

<!-- The page fits its tile in CSS (container units): no per-tile size observer, so the
     same mounted grid stays correct when it moves into a pinned utility window. -->
<span class="preview" class:failed>
  <span class="page" style:--aspect={aspect} use:previewBackdrop={{ path }}>
    {#if url && !failed}
      <img src={url} alt="" decoding="async" on:load={e => { const im = e.currentTarget as HTMLImageElement; if (im.naturalHeight) aspect = im.naturalWidth / im.naturalHeight; }} on:error={() => failed = true} />
    {:else if ready}<span>Preview unavailable</span>{/if}
  </span>
</span>

<style>
  .preview { container-type:size; display:flex; align-items:center; justify-content:center; width:100%; height:100%; overflow:hidden; }
  .page { display:flex; align-items:center; justify-content:center; width:min(100cqw - 6px, (100cqh - 6px) * var(--aspect)); aspect-ratio:var(--aspect); overflow:hidden; background:var(--flx-paper); border-radius:var(--r-0); box-shadow:0 0 0 1px var(--c-line); }
  img { display:block; width:100%; height:100%; object-fit:contain; }
  .page > span { color:var(--c-tx-muted); font:11px var(--font-ui); padding:6px; }
</style>
