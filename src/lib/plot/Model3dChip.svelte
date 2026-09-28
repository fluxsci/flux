<script lang="ts">
  import { onMount } from 'svelte';
  import Model3dIcon from './Model3dIcon.svelte';
  import type { createGalleryPreviews } from './galleryPreviews';
  export let path: string;
  export let previews: ReturnType<typeof createGalleryPreviews>;
  export let tile = false;
  /** Seeded from the row scan (a sibling `.fluxplot.json` exists), so the mark
   *  does not flip from muted to accent once metadata validation finishes. */
  export let initial = false;
  let semantic = initial, checked = false;
  onMount(() => previews.acquireMetadata(path, value => { semantic = value; checked = true; }));
</script>
<span class="model-chip" class:tile class:semantic data-model3d-checked={checked} data-model3d-kind={semantic ? 'fluxplot' : 'mesh'}
  title={semantic ? '3D fluxplot: named parts, value fields and labels' : '3D mesh (no fluxplot metadata)'}>{#if tile}<Model3dIcon />{/if}3D</span>
<style>
  /* Reads as a sibling of the importer's mono badges (semantic / snip / video). */
  .model-chip { display:inline-flex; align-items:center; gap:3px; flex-shrink:0; margin-left:auto; padding:0 4px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); color:var(--c-tx-muted); background:transparent; font:600 9px/14px var(--font-mono); letter-spacing:.06em; }
  .semantic { color:var(--c-accent); background:var(--c-accent-tint); border-color:var(--c-accent); }
  /* Top-LEFT: fluxplot puts legends and colorbars top-right. A light scrim
     keeps the muted mark legible on paper-coloured thumbnails. */
  /* Thumbnails always render on paper (#FFFCF0) whatever the app theme, so the
     tile mark uses paper-toned ink rather than the dark chrome background. */
  .tile { position:absolute; top:6px; left:6px; margin-left:0; color:#6F6E69; border-color:#B7B5AC; background:rgba(255,252,240,.88); }
  .tile.semantic { color:#205EA6; border-color:#4385BE; background:rgba(230,238,248,.92); }
</style>
