<script lang="ts">
  // The virtualized grid (§3.4): fixed columns make windowing O(1) integer
  // math. Cells are sized to the MEASURED image aspect ratio (median of the
  // decoded sizes, collection-global so the flip-book keeps its row heights)
  // instead of square — wide plots waste no vertical space; the user trades
  // plot size against spacing via the hGap/vGap prefs. Only visible-ish rows
  // exist in the DOM, whatever the set size; a single spacer supplies the
  // scroll height and the window container is translateY'd into place. Cells
  // are keyed by item KEY, so a set switch swaps images inside stable DOM
  // nodes — the flip-book hard cut.
  import { store, GRID_PAD, CAPTION_H, OVERSCAN_ROWS, bucketFor, BUCKETS } from "./store.svelte";
  import Cell from "./Cell.svelte";

  let viewport = $state<HTMLDivElement | null>(null);
  let vw = $state(0);
  let vh = $state(0);
  let scrollTop = $state(0);

  // rAF-coalesced scroll handler: read scrollTop, integer math, nothing else.
  let rafPending = false;
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (viewport) scrollTop = viewport.scrollTop;
    });
  }

  const n = $derived(store.filteredKeys.length);
  const cols = $derived(store.cols);
  const hGap = $derived(store.hGap);
  const vGap = $derived(store.vGap);
  const cellW = $derived(Math.max(24, Math.floor((vw - 2 * GRID_PAD - (cols - 1) * hGap) / cols)));
  const cellH = $derived(Math.max(24, Math.round(cellW / store.layoutAspect)));
  const capH = $derived(store.captions ? CAPTION_H : 0);
  const rowH = $derived(cellH + capH + vGap);
  const rows = $derived(Math.ceil(n / cols));
  const totalH = $derived(rows * rowH + 2 * GRID_PAD);
  const firstRow = $derived(Math.max(0, Math.floor((scrollTop - GRID_PAD) / rowH) - OVERSCAN_ROWS));
  const lastRow = $derived(Math.min(Math.max(0, rows - 1), Math.ceil((scrollTop - GRID_PAD + vh) / rowH) + OVERSCAN_ROWS));
  const startIdx = $derived(Math.min(n, firstRow * cols));
  const endIdx = $derived(Math.min(n, (lastRow + 1) * cols));
  const visible = $derived.by(() => {
    const out: string[] = [];
    const list = store.filteredKeys;
    for (let i = startIdx; i < endIdx; i++) out.push(list[i]);
    return out;
  });
  // Thumbs are keyed by longest edge — bucket by the cell's longer side.
  // Past the largest bucket a thumb could only be UPSCALED (blurry) into the
  // cell: 0 means "serve the original file" (Cell switches to fullUrl).
  const pxBucket = $derived.by(() => {
    const want = Math.max(cellW, cellH) * (window.devicePixelRatio || 1);
    return want > BUCKETS[BUCKETS.length - 1] ? 0 : bucketFor(want);
  });
  const setId = $derived(store.currentSet?.id ?? "");

  // Imperative hooks for the keymap (closures read the current derived values).
  $effect(() => {
    store.gridApi = {
      ensureVisible(i: number) {
        if (!viewport) return;
        const row = Math.floor(i / cols);
        const top = GRID_PAD + row * rowH;
        const bot = top + rowH;
        if (top < viewport.scrollTop) viewport.scrollTop = Math.max(0, top - 8);
        else if (bot > viewport.scrollTop + vh) viewport.scrollTop = bot - vh + 8;
      },
      pageBy(d: 1 | -1) {
        if (viewport) viewport.scrollTop += d * Math.max(rowH, vh - rowH);
      },
    };
    return () => {
      store.gridApi = null;
    };
  });

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

  // Prefetch the ADJACENT sets' visible thumbnails in idle time so the first
  // flip to a neighbouring set is instant too (Electron path; the mock is
  // already instant).
  $effect(() => {
    const api = store.api;
    const m = store.manifest;
    const si = store.setIndex;
    const s0 = startIdx;
    const s1 = endIdx;
    const px = pxBucket;
    if (!api || !m) return;
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (!w.requestIdleCallback) return;
    const id = w.requestIdleCallback(
      () => {
        for (const d of [1, -1]) {
          const s = m.sets[si + d];
          if (!s) continue;
          for (let i = s0; i < s1; i++) {
            const key = store.filteredKeys[i];
            const c = key ? store.cellFor(s.id, key) : null;
            if (c?.present) void api.thumbUrl(s.id, c.key, px);
          }
        }
      },
      { timeout: 2000 }
    );
    return () => w.cancelIdleCallback?.(id);
  });

  // Dev introspection for the gates (bounded-DOM structural budget).
  $effect(() => {
    store.gridDebug = { firstRow, lastRow, cellPx: cellW, cellH, rowH, thumbPx: pxBucket, dom: endIdx - startIdx };
  });
</script>

<div class="grid-viewport" bind:this={viewport} onscroll={onScroll} data-grid>
  <div class="spacer" style:height={`${totalH}px`}>
    <div
      class="window"
      style:transform={`translateY(${GRID_PAD + firstRow * rowH}px)`}
      style:grid-template-columns={`repeat(${cols}, ${cellW}px)`}
      style:column-gap={`${hGap}px`}
      style:row-gap={`${vGap}px`}
      style:padding-left={`${GRID_PAD}px`}
    >
      {#each visible as key (key)}
        <Cell itemKey={key} {setId} px={pxBucket} {cellW} {cellH} {capH} />
      {/each}
    </div>
  </div>
</div>

<style>
  .grid-viewport {
    flex: 1;
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
