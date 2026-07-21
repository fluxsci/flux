<script lang="ts">
  import { onDestroy } from "svelte";
  import type { SemanticPlotElement } from "./types";
  import { assetData } from "./assets";
  import { project } from "./store";
  import { assetDisplaySize } from "./ops";
  import { hasPlotDom, plotGen, requestPlotDom, retainPlot, releasePlot } from "./plot/store";
  import { mountPlot } from "./plot/mount";

  export let element: SemanticPlotElement;
  $: e = element;

  // F2: re-clone when the plot is regenerated (cached DOM bumped) in place.
  // ALSO the lazy-load dependency: cachePlot bumps it when the on-demand parse
  // lands, which is what re-evaluates `inline` below (hasPlotDom reads a
  // non-reactive Map — without `gen` here the <image> fallback would never
  // upgrade).
  $: gen = $plotGen[e.assetId] ?? 0;

  // Inline the tagged SVG when its DOM is cached (the import flow caches it
  // before placement; project open defers it to this component's request
  // below). Otherwise degrade gracefully to the opaque <image> — a semantic
  // plot is never worse than a plain imported SVG (spec P4), and the raster
  // IS the lazy-load's loading state.
  $: inline = (void gen, hasPlotDom(e.assetId));

  // Crop honored on the <image> fallback too (P5): nested-svg viewport, same
  // window semantics as the inline mount's viewBox sub-rect.
  $: imgDisp = !inline && e.crop ? assetDisplaySize($project, e.assetId) : null;

  // Lazy residency (plan §5.5): a mounted plot without a cached DOM asks the
  // parse queue for one (bytes are already resident in assetData). Idempotent
  // and failure-guarded in the store, so re-runs after gen bumps are free.
  $: if (!inline && $assetData[e.assetId]) requestPlotDom(e.assetId);

  // Pin the asset against LRU eviction while any placement of it is mounted
  // (non-reactive box — the §9 memo-box pattern, no self-dependent `$:`).
  const retainBox: { id: string | null } = { id: null };
  $: syncRetain(e.assetId);
  function syncRetain(id: string) {
    if (retainBox.id === id) return;
    if (retainBox.id) releasePlot(retainBox.id);
    retainBox.id = id;
    retainPlot(id);
  }
  onDestroy(() => {
    if (retainBox.id) releasePlot(retainBox.id);
    retainBox.id = null;
  });
</script>

{#if inline}
  <g use:mountPlot={{ element: e, gen }}></g>
{:else if $assetData[e.assetId]}
  {#if e.crop && imgDisp}
    <svg
      x={e.x}
      y={e.y}
      width={e.width}
      height={e.height}
      viewBox={`${e.crop.x} ${e.crop.y} ${e.crop.width} ${e.crop.height}`}
      preserveAspectRatio="none"
      style="overflow:hidden"
    >
      <image x="0" y="0" width={imgDisp.width} height={imgDisp.height} preserveAspectRatio="none" href={$assetData[e.assetId]} />
    </svg>
  {:else}
    <image
      x={e.x}
      y={e.y}
      width={e.width}
      height={e.height}
      preserveAspectRatio="none"
      href={$assetData[e.assetId]}
    />
  {/if}
{:else}
  <rect x={e.x} y={e.y} width={e.width} height={e.height} fill="#eee" stroke="#bbb" />
{/if}
