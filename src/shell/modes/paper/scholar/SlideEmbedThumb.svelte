<script lang="ts">
  import { onMount } from "svelte";
  import type { SlideRepository } from "../../../../lib/slide/embedRepository";
  import { renderSlidePosterSvg } from "../../../../lib/slide/embedRender";
  let { repository, deckId, slideId, steps }: { repository: SlideRepository; deckId: string; slideId: string; steps: number } = $props();
  let src = $state("");
  let error = $state("");
  onMount(() => {
    let alive = true;
    void repository.load({ deck: deckId, slide: slideId }).then(snapshot => {
      if (alive) src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSlidePosterSvg(snapshot.payload, steps))}`;
    }).catch(e => { if (alive) error = String(e.message || e); });
    return () => { alive = false; };
  });
</script>
<div class="slide-thumb">
  {#if src}<img {src} alt="Slide preview" draggable="false" />{:else}<span title={error}>{error ? "Preview unavailable" : "…"}</span>{/if}
</div>
<style>
  .slide-thumb{height:112px;display:flex;align-items:center;justify-content:center;background:var(--c-bg);overflow:hidden}
  img{width:100%;height:100%;object-fit:contain}span{font-size:var(--ts-xs);color:var(--c-tx-2)}
</style>
