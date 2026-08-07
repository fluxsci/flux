<script lang="ts">
  // CSV/TSV as a table: sticky header, windowed body rows (all N rows in the DOM is never
  // acceptable — same discipline as the sidebar/library windows), numeric columns right-
  // aligned, click a header to sort (asc → desc → file order; numeric-aware). The window is
  // the classic spacer + translateY: one spacer supplies scroll height, only visible rows
  // exist. Horizontal overflow scrolls inside this container (header rides along — same
  // scroll box).
  import { parseDelimited, numericColumns, isNumericCell, numericValue, type ParsedTable } from "./csv";

  let { text, name }: { text: string; name: string } = $props();

  const ROW_H = 26;
  const OVERSCAN = 6;

  const table: ParsedTable = $derived(parseDelimited(text, { name }));
  const numeric = $derived(numericColumns(table));

  // Column widths from a character-count sample (header + first 200 rows): stable, cheap,
  // no measurement pass. Clamped so one long cell can't blow the layout (title shows all).
  const widths = $derived.by(() => {
    const out: number[] = [];
    const sample = table.rows.slice(0, 200);
    for (let c = 0; c < table.cols; c++) {
      let m = (table.header[c] ?? "").length;
      for (const r of sample) m = Math.max(m, (r[c] ?? "").length);
      out.push(Math.round(Math.min(Math.max(m, 4), 42) * 7.2 + 18));
    }
    return out;
  });
  const gridCols = $derived(widths.map((w) => `${w}px`).join(" "));
  const totalW = $derived(widths.reduce((a, b) => a + b, 0));

  // Sort: a permutation over the body rows — the parsed table itself is never reordered.
  let sortCol = $state(-1);
  let sortDir = $state<1 | -1>(1);
  const order = $derived.by(() => {
    const idx = table.rows.map((_, i) => i);
    if (sortCol < 0) return idx;
    const c = sortCol;
    const dir = sortDir;
    const num = numeric[c];
    return idx.sort((a, b) => {
      const va = table.rows[a][c] ?? "";
      const vb = table.rows[b][c] ?? "";
      if (va === "" && vb === "") return a - b;
      if (va === "") return 1; // empties last, either direction
      if (vb === "") return -1;
      let d: number;
      if (num && isNumericCell(va) && isNumericCell(vb)) d = numericValue(va) - numericValue(vb);
      else d = va.localeCompare(vb, undefined, { numeric: true });
      return d !== 0 ? d * dir : a - b; // stable
    });
  });
  function clickHeader(c: number) {
    if (sortCol !== c) {
      sortCol = c;
      sortDir = 1;
    } else if (sortDir === 1) sortDir = -1;
    else sortCol = -1;
  }

  // Row window.
  let viewport = $state<HTMLDivElement | null>(null);
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
    const ro = new ResizeObserver(() => (vh = el.clientHeight));
    ro.observe(el);
    vh = el.clientHeight;
    return () => ro.disconnect();
  });
  const n = $derived(order.length);
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const last = $derived(Math.min(n, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN));
  const visible = $derived(order.slice(first, last));

  const cells = (r: string[]): string[] => {
    const out: string[] = [];
    for (let c = 0; c < table.cols; c++) out.push(r[c] ?? "");
    return out;
  };
</script>

<div class="tbl" data-dissect-table bind:this={viewport} onscroll={onScroll}>
  <div class="hdr" style:grid-template-columns={gridCols} style:width={`${totalW}px`}>
    {#each table.header as hcell, c}
      <button
        class="hcell"
        class:num={numeric[c]}
        class:sorted={sortCol === c}
        title={hcell}
        onclick={() => clickHeader(c)}
      >
        <span class="ht">{hcell}</span>{#if sortCol === c}<span class="arrow">{sortDir === 1 ? "▲" : "▼"}</span>{/if}
      </button>
    {/each}
  </div>
  <div class="spacer" style:height={`${n * ROW_H}px`} style:width={`${totalW}px`}>
    <div class="window" style:transform={`translateY(${first * ROW_H}px)`}>
      {#each visible as ri (ri)}
        <div class="row" style:grid-template-columns={gridCols} style:height={`${ROW_H}px`}>
          {#each cells(table.rows[ri]) as v, c}
            <div class="cell" class:num={numeric[c]} title={v}>{v}</div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
  {#if table.truncated}
    <div class="note">Showing the first {table.rows.length.toLocaleString()} of {table.totalRows.toLocaleString()} rows.</div>
  {/if}
</div>

<style>
  .tbl {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--c-tx);
  }
  .hdr {
    position: sticky;
    top: 0;
    z-index: 1;
    display: grid;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line-strong);
  }
  .hcell {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    background: none;
    border: none;
    border-right: 1px solid var(--c-line);
    color: var(--c-tx-2);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }
  .hcell.num {
    justify-content: flex-end;
    text-align: right;
  }
  .hcell:hover {
    color: var(--c-accent-bright);
  }
  .hcell.sorted {
    color: var(--c-accent-bright);
  }
  .ht {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arrow {
    font-size: 8px;
    flex: 0 0 auto;
  }
  .spacer {
    position: relative;
  }
  .window {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }
  .row {
    display: grid;
    border-bottom: 1px solid var(--c-line);
  }
  .row:nth-child(2n) {
    background: color-mix(in oklab, var(--c-tx-hi) 2.5%, transparent);
  }
  .cell {
    padding: 4px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid var(--c-line);
  }
  .cell.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .note {
    position: sticky;
    left: 0;
    padding: 8px 12px;
    color: var(--c-tx-muted);
    font-style: italic;
  }
</style>
