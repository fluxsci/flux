<script lang="ts">
  import type { SemanticPlotElement } from "./types";
  import { assetData } from "./assets";
  import { hasPlotDom, plotGen } from "./plot/store";
  import { mountPlot } from "./plot/mount";

  export let element: SemanticPlotElement;
  $: e = element;

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
  <image
    x={e.x}
    y={e.y}
    width={e.width}
    height={e.height}
    preserveAspectRatio="none"
    href={$assetData[e.assetId]}
  />
{:else}
  <rect x={e.x} y={e.y} width={e.width} height={e.height} fill="#eee" stroke="#bbb" />
{/if}
