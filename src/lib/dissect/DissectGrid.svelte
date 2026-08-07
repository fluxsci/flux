<script lang="ts">
  // The dissection grid — the lighttable pattern re-grown in Flux (patterns ported, never
  // imported: the sidecar boundary is a hard rule). Fixed columns make windowing O(1)
  // integer math; cells are sized to the MEASURED image aspect (median of the first 64
  // decoded sizes, damped 2% so it settles instead of jittering) — wide plots waste no
  // vertical space. Only visible-ish rows exist in the DOM; one spacer supplies scroll
  // height and the window container is translateY'd into place.
  import DissectCell from "./DissectCell.svelte";
  import type { DissectFile } from "./loader";

  let {
    files,
    cols,
    selectedIdx,
    onSelect,
    onOpen,
  }: {
    files: DissectFile[];
    cols: number;
    selectedIdx: number;
    onSelect: (i: number) => void;
    onOpen: (i: number) => void;
  } = $props();

  const GRID_PAD = 14;
  const CAPTION_H = 20;
  const OVERSCAN_ROWS = 2;
  const H_GAP = 10;
  const V_GAP = 10;

  let viewport = $state<HTMLDivElement | null>(null);
  let vw = $state(0);
  let vh = $state(0);
  let scrollTop = $state(0);

  let rafPending = false;
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (viewport) scrollTop = viewport.scrollTop;
    });
  }

  $effect(() => {
    const el = viewport;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      vw = el.clientWidth;
      vh = el.clientHeight;
    });
    ro.observe(el);
    vw = el.clientWidth;
    vh = el.clientHeight;
    return () => ro.disconnect();
  });

  // Measured aspect: median of the first 64 decoded sizes, committed only on a >2% move.
  let layoutAspect = $state(4 / 3);
  const samples: number[] = [];
  function reportAspect(w: number, h: number) {
    if (!w || !h || samples.length >= 64) return;
    samples.push(Math.min(8, Math.max(0.2, w / h)));
    const sorted = [...samples].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(med - layoutAspect) / layoutAspect > 0.02) layoutAspect = med;
  }

  const n = $derived(files.length);
  const cellW = $derived(Math.max(24, Math.floor((vw - 2 * GRID_PAD - (cols - 1) * H_GAP) / cols)));
  const cellH = $derived(Math.max(24, Math.round(cellW / layoutAspect)));
  const rowH = $derived(cellH + CAPTION_H + V_GAP);
  const rows = $derived(Math.ceil(n / cols));
  const totalH = $derived(rows * rowH + 2 * GRID_PAD);
  const firstRow = $derived(Math.max(0, Math.floor((scrollTop - GRID_PAD) / rowH) - OVERSCAN_ROWS));
  const lastRow = $derived(Math.min(Math.max(0, rows - 1), Math.ceil((scrollTop - GRID_PAD + vh) / rowH) + OVERSCAN_ROWS));
  const startIdx = $derived(Math.min(n, firstRow * cols));
  const endIdx = $derived(Math.min(n, (lastRow + 1) * cols));
  const visible = $derived(files.slice(startIdx, endIdx));

  // Keep the keyboard selection in view (arrow navigation lives in the overlay).
  $effect(() => {
    const i = selectedIdx;
    const el = viewport;
    if (i < 0 || !el) return;
    const row = Math.floor(i / cols);
    const top = GRID_PAD + row * rowH;
    const bot = top + rowH;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 8);
    else if (bot > el.scrollTop + vh) el.scrollTop = bot - vh + 8;
  });
</script>

<div class="grid-viewport" data-dissect-grid bind:this={viewport} onscroll={onScroll}>
  <div class="spacer" style:height={`${totalH}px`}>
    <div
      class="window"
      style:transform={`translateY(${GRID_PAD + firstRow * rowH}px)`}
      style:grid-template-columns={`repeat(${cols}, ${cellW}px)`}
      style:column-gap={`${H_GAP}px`}
      style:row-gap={`${V_GAP}px`}
      style:padding-left={`${GRID_PAD}px`}
    >
      {#each visible as file, vi (file.abs)}
        <DissectCell
          {file}
          {cellW}
          {cellH}
          capH={CAPTION_H}
          selected={startIdx + vi === selectedIdx}
          onSelect={() => onSelect(startIdx + vi)}
          onOpen={() => onOpen(startIdx + vi)}
          {reportAspect}
        />
      {/each}
    </div>
  </div>
</div>

<style>
  .grid-viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    contain: strict;
  }
  .spacer {
    position: relative;
    width: 100%;
  }
  .window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: grid;
    align-content: start;
    will-change: transform;
  }
</style>
