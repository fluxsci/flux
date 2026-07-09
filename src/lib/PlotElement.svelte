<script lang="ts">
  import type { SemanticPlotElement } from "./types";
  import { assetData } from "./assets";
  import { project } from "./store";
  import { assetDisplaySize } from "./ops";
  import { hasPlotDom, plotGen } from "./plot/store";
  import { mountPlot } from "./plot/mount";

  export let element: SemanticPlotElement;
  $: e = element;
  // Crop honored on the <image> fallback too (P5): nested-svg viewport, same
  // window semantics as the inline mount's viewBox sub-rect.
  $: imgDisp = !hasPlotDom(e.assetId) && e.crop ? assetDisplaySize($project, e.assetId) : null;

  // Inline the tagged SVG when its DOM is cached (the import flow caches it
  // before placement). Otherwise degrade gracefully to the opaque <image> — a
  // semantic plot is never worse than a plain imported SVG (spec P4).
  $: inline = hasPlotDom(e.assetId);
  // F2: re-clone when the plot is regenerated (cached DOM bumped) in place.
  $: gen = $plotGen[e.assetId] ?? 0;
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
