<script lang="ts">
  // Compare view (Ctrl+click a cell / Ctrl+Enter): ONE item shown across ALL
  // sets at once, tiles packed as large as they fit. Captions carry the SET
  // name (the item name is identical by definition — it lives in the header).
  // Click a tile to fullscreen that set's image (Esc returns here); ←/→ move
  // to the previous/next item without leaving the view; Esc goes back to Grid.
  import { store, bucketFor } from "./store.svelte";
  import CompareTile from "./CompareTile.svelte";

  const itemKey = $derived(store.selectedKey);
  const sets = $derived(store.manifest?.sets ?? []);
  const pos = $derived(store.selIdx);
  const count = $derived(store.filteredKeys.length);

  const GAP = 12;
  const CAP_H = 22;

  let stage = $state<HTMLDivElement | null>(null);
  let sw = $state(0);
  let sh = $state(0);

  $effect(() => {
    const el = stage;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      sw = el.clientWidth;
      sh = el.clientHeight;
    });
    ro.observe(el);
    sw = el.clientWidth;
    sh = el.clientHeight;
    return () => ro.disconnect();
  });

  // Principled packing: for each column count, the tile size is limited by
  // width or height — take the column count that maximises tile area for the
  // known image aspect.
  const layout = $derived.by(() => {
    const n = Math.max(1, sets.length);
    const aspect = store.layoutAspect;
    let best = { cols: 1, w: 1, h: 1 };
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const availW = sw - (c + 1) * GAP;
      const availH = sh - (r + 1) * GAP - r * CAP_H;
      if (availW <= 0 || availH <= 0) continue;
      let w = Math.floor(availW / c);
      let h = Math.floor(w / aspect);
      const maxH = Math.floor(availH / r);
      if (h > maxH) {
        h = maxH;
        w = Math.floor(h * aspect);
      }
      if (w > best.w) best = { cols: c, w, h };
    }
    return best;
  });
  const tilePx = $derived(bucketFor(Math.max(layout.w, layout.h) * (window.devicePixelRatio || 1)));
</script>

<div class="compare" data-compare>
  <div class="header">
    <span class="item" data-compare-item>{itemKey}</span>
    <span class="pos">{pos + 1} / {count}</span>
    <span class="grow"></span>
    <span class="hint">←/→ item · click tile to fullscreen · Esc back</span>
  </div>
  <div class="stage" bind:this={stage}>
    {#if itemKey}
      <div
        class="tiles"
        style:grid-template-columns={`repeat(${layout.cols}, ${layout.w}px)`}
        style:gap={`${GAP}px`}
      >
        {#each sets as s, i (s.id)}
          {@const cell = store.cellFor(s.id, itemKey)}
          <button
            class="tile"
            data-compare-tile
            data-set={s.id}
            data-missing={cell && !cell.present ? "" : undefined}
            style:width={`${layout.w}px`}
            tabindex="-1"
            onclick={() => store.openDetailFromCompare(i)}
            title={s.name}
          >
            <div class="img" style:height={`${layout.h}px`}>
              {#if cell?.present}
                <CompareTile setId={s.id} {itemKey} px={tilePx} />
              {:else}
                <div class="missing">not in “{s.name}”</div>
              {/if}
            </div>
            <div class="cap" style:height={`${CAP_H}px`}>{s.name}</div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .compare {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    background: var(--c-detail-surface);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    font-size: 12px;
    flex: none;
  }
  .item {
    color: var(--c-tx-hi);
    font-weight: 600;
    font-size: 13px;
  }
  .pos {
    color: var(--c-tx-muted);
    font-variant-numeric: tabular-nums;
  }
  .grow {
    flex: 1;
  }
  .hint {
    color: var(--c-tx-faint);
  }
  .stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .tiles {
    display: grid;
    justify-content: center;
    align-content: center;
  }
  .tile {
    display: block;
    text-align: left;
    border-radius: var(--radius-s);
  }
  .tile .img {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--c-image-surface);
    border-radius: var(--radius-s);
    overflow: hidden;
    outline: 1px solid var(--c-line);
    outline-offset: -1px;
  }
  .tile:hover .img {
    outline: 2px solid var(--c-accent);
    outline-offset: 0;
  }
  .missing {
    color: var(--c-tx-faint);
    font-size: 12px;
    padding: 8px;
  }
  .cap {
    color: var(--c-tx-2);
    font-size: 12px;
    line-height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 2px;
  }
</style>
