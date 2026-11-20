<script lang="ts">
  /**
   * A channel's histogram in the width of a word: the part inside its display window in the channel's own ink,
   * the rest muted, with the black and white points as ticks. It makes a channel row of the panel a small plot of
   * the channel, the way a rail is a small plot of the stack: you see where the window sits before you open it.
   */
  import type { FluximgStats } from "../types";
  import { histDomain, histogramPath, valueToX } from "./histogram";

  let { stats, range, ink, width = 84, height = 16, off = false }: {
    stats: FluximgStats;
    range: readonly [number, number];
    ink: string;
    width?: number;
    height?: number;
    /** The channel is hidden: drawn muted throughout. */
    off?: boolean;
  } = $props();

  const uid = `fxm-${Math.random().toString(36).slice(2)}`;
  const domain = $derived(histDomain(stats, range));
  const area = $derived(histogramPath(stats.hist, domain, width, height, "sqrt"));
  const xb = $derived(Math.min(width, Math.max(0, valueToX(range[0], domain, width))));
  const xw = $derived(Math.min(width, Math.max(0, valueToX(range[1], domain, width))));
</script>

<svg class="mini" class:off {width} {height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
  <defs><clipPath id={uid}><rect x={xb} y="0" width={Math.max(0, xw - xb)} height={height} /></clipPath></defs>
  {#if area}
    <path class="out" d={area} />
    <path class="in" d={area} clip-path={`url(#${uid})`} style={`fill:${ink}`} />
  {/if}
  <line class="pt" x1={xb} y1="0" x2={xb} y2={height} />
  <line class="pt" x1={xw} y1="0" x2={xw} y2={height} />
</svg>

<style>
  .mini { display: block; flex: none; background: var(--c-bg); outline: 1px solid var(--c-line); border-radius: var(--r-ui); }
  .out { fill: var(--c-tx-faint); opacity: 0.5; }
  .in { opacity: 0.9; }
  .pt { stroke: var(--c-tx-hi); stroke-width: 1; opacity: 0.85; }
  .mini.off .in { fill: var(--c-tx-faint) !important; opacity: 0.5; }
  .mini.off .pt { opacity: 0.35; }
</style>
