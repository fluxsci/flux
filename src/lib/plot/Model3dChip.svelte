<script lang="ts">
  import { onMount } from 'svelte';
  import Model3dIcon from './Model3dIcon.svelte';
  import type { createGalleryPreviews } from './galleryPreviews';
  export let path: string;
  export let previews: ReturnType<typeof createGalleryPreviews>;
  export let tile = false;
  let semantic = false, checked = false;
  onMount(() => previews.acquireMetadata(path, value => { semantic = value; checked = true; }));
</script>
<span class="model-chip" class:tile class:semantic data-model3d-checked={checked} data-model3d-kind={semantic ? 'fluxplot' : 'mesh'} title={semantic ? '3D fluxplot' : '3D mesh'}><Model3dIcon />3D</span>
<style>
  .model-chip { display:inline-flex; align-items:center; gap:3px; flex-shrink:0; padding:1px 5px; border:1px solid var(--c-line); border-radius:var(--r-0); color:var(--c-tx-muted); background:var(--c-bg-2); font:10px var(--font-ui); }
  .semantic { color:var(--c-accent); background:var(--c-accent-tint); border-color:var(--c-accent); }
  .tile { position:absolute; top:6px; right:6px; }
</style>
