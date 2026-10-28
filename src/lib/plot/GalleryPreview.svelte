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

  // The same mounted tile moves into/out of a native utility document.
  // Svelte's shared bind:size observer stays in the opener; reconnect the
  // observer to the actual owner window after each DOM adoption instead.
  function trackSize(node: HTMLSpanElement) {
    let observer: ResizeObserver;
    const measure = () => { width = node.clientWidth; height = node.clientHeight; };
    const reconnect = () => {
      observer?.disconnect();
      const owner = node.ownerDocument.defaultView as Window & typeof globalThis;
      observer = new owner.ResizeObserver(measure);
      observer.observe(node);
      measure();
    };
    node.addEventListener('flux:document-change', reconnect);
    reconnect();
    return { destroy() { observer.disconnect(); node.removeEventListener('flux:document-change', reconnect); } };
  }
</script>

<span class="preview" class:failed data-gallery-preview-size use:trackSize>
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
