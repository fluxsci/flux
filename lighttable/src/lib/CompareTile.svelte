<script lang="ts">
  // One Compare tile: the (usually cached) thumbnail paints first, the
  // full-resolution original swaps in after decode — same pattern as Detail.
  import { store } from "./store.svelte";

  let { setId, itemKey, px }: { setId: string; itemKey: string; px: number } = $props();

  let thumbSrc = $state<string | null>(null);
  let fullSrc = $state<string | null>(null);
  let gen = 0;

  $effect(() => {
    const s = setId;
    const k = itemKey;
    const p = px;
    const my = ++gen;
    thumbSrc = null;
    fullSrc = null;
    void (async () => {
      const t = await store.api?.thumbUrl(s, k, p);
      if (my === gen && t) {
        const ti = new Image();
        ti.src = t;
        try {
          await ti.decode();
        } catch {}
        if (my === gen && !fullSrc) thumbSrc = t;
      }
      const f = await store.api?.fullUrl(s, k);
      if (!f || my !== gen) return;
      const im = new Image();
      im.decoding = "async";
      im.src = f;
      try {
        await im.decode();
      } catch {}
      if (my !== gen) return;
      fullSrc = f;
    })();
  });
</script>

{#if fullSrc || thumbSrc}
  <img src={fullSrc ?? thumbSrc} alt={itemKey} draggable="false" />
{/if}

<style>
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
