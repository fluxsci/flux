<script lang="ts">
  /** The property menu's measure, on the object (interact/measure.ts): one dimension of the ONE selected element,
   * drawn where it is. Mounted by the canvas only while the menu has a geometric row in hand, so it costs nothing
   * otherwise; it reads the model and never writes it, and it takes no pointer events. */
  import { fluxFigMeasure, measureDrawing, type Measured } from './interact/measure';
  import { selection, partSelections } from './store';
  import type { Element, Viewport } from './types';
  export let viewport: Viewport;
  export let figureX = 0;
  export let figureY = 0;
  export let elements: Element[] = [];
  // Explicit projection dependencies (legacy Svelte cannot see reads inside helper closures).
  $: projection = { zoom: viewport.zoom, x: viewport.panX + figureX * viewport.zoom, y: viewport.panY + figureY * viewport.zoom };
  // One object, and the object itself: several selected, or a plot's parts, have no single dimension to draw.
  $: only = $selection.size === 1 && !$partSelections.length ? (elements.find((e) => $selection.has(e.id)) ?? null) : null;
  $: m = only && $fluxFigMeasure ? measureDrawing($fluxFigMeasure, only as unknown as Measured, projection) : null;
  $: pillW = m ? Math.ceil(m.pill.text.length * 6.5) + 14 : 0;
</script>

{#if m}
  <g class="fm-measure" data-fm-measure={$fluxFigMeasure} aria-hidden="true">
    {#if m.wedge}<path class="wedge" d={m.wedge} />{/if}
    {#if m.dash}<path class="dash" d={m.dash} />{/if}
    <path d={m.d} />
    {#if m.dot}<circle cx={m.dot.x} cy={m.dot.y} r="2.5" />{/if}
    <rect class="pill" x={m.pill.x - pillW / 2} y={m.pill.y - 9} width={pillW} height="18" rx="9" />
    <text x={m.pill.x} y={m.pill.y + 0.5}>{m.pill.text}</text>
  </g>
{/if}

<style>
  /* The menu's blue on the menu's paper: legible on any artwork, like the gap badge and the Crystallize word. */
  .fm-measure { pointer-events: none; }
  .fm-measure path { fill: none; stroke: var(--flx-blue-400, #4385be); stroke-width: 1.25; }
  .fm-measure path.dash { stroke-dasharray: 3 3; opacity: 0.85; }
  .fm-measure path.wedge { fill: color-mix(in oklab, var(--flx-paper, #fffcf0) 50%, transparent); }
  .fm-measure circle { fill: var(--flx-blue-400, #4385be); stroke: var(--flx-paper, #fffcf0); stroke-width: 1.2; }
  .fm-measure rect.pill { fill: var(--flx-paper, #fffcf0); stroke: color-mix(in oklab, var(--flx-blue-400, #4385be) 55%, transparent); stroke-width: 1; }
  .fm-measure text { fill: var(--flx-blue-600, #205ea6); font: 600 10.5px var(--font-mono, monospace); text-anchor: middle; dominant-baseline: central; stroke: none; }
</style>
