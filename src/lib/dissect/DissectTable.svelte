<script lang="ts">
  import { nativeClick, nativeScroll } from "../ui/nativeEvents";
  // CSV/TSV as a table: sticky header, windowed body rows (all N rows in the DOM is never
  // acceptable — same discipline as the sidebar/library windows), numeric columns right-
  // aligned, click a header to sort (asc → desc → file order; numeric-aware). The window is
  // the classic spacer + translateY: one spacer supplies scroll height, only visible rows
  // exist. Horizontal overflow scrolls inside this container (header rides along — same
  // scroll box).
  import { parseDelimited, parseDelimitedAsync, numericColumns, tableOrder, type ParsedTable } from "./csv";

  let { text, name, inputTruncated = false }: { text: string; name: string; inputTruncated?: boolean } = $props();

  const ROW_H = 26;
  const OVERSCAN = 6;

  let table: ParsedTable = $state(parseDelimited(""));
  let counting = $state(false);
  $effect(() => {
    const controller = new AbortController();
    const value = text, filename = name, truncated = inputTruncated;
    counting = true;
    table = parseDelimited("");
    void parseDelimitedAsync(value, { name: filename, inputTruncated: truncated, signal: controller.signal,
      onProgress: prefix => { if (!controller.signal.aborted) table = prefix; },
    }).then(result => { if (!controller.signal.aborted) { table = result; counting = false; } }, error => {
      if (!controller.signal.aborted) { counting = false; console.error(error); }
    });
    return () => controller.abort();
  });
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
  const order = $derived(tableOrder(table, sortCol, sortDir, numeric));
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
    (viewport?.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      rafPending = false;
      if (viewport) scrollTop = viewport.scrollTop;
    });
  }
  $effect(() => {
    const el = viewport;
    if (!el) return;
    const view = el.ownerDocument.defaultView as Window & typeof globalThis;
    const ro = new view.ResizeObserver(() => (vh = el.clientHeight));
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

<div class="tbl" data-dissect-table>
 <div class="tbl-scroll" bind:this={viewport} use:nativeScroll={onScroll}>
  <div class="hdr" style:grid-template-columns={gridCols} style:width={`${totalW}px`}>
    {#each table.header as hcell, c}
      <button
        class="hcell"
        class:num={numeric[c]}
        class:sorted={sortCol === c}
        title={hcell}
        use:nativeClick={() => clickHeader(c)}
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
 </div>
  {#if table.truncated || counting}
    <div class="note" role="status">
      Showing the first {table.rows.length.toLocaleString()} rows{table.complete ? ` of ${table.totalRows.toLocaleString()}` : counting ? " · counting…" : " from the first 16 MiB"}.
      {#if table.totalRows > table.rows.length} Sorting applies to the displayed rows.{/if}
      {#if table.diagnostics.columns} Columns limited to 128.{/if}
      {#if table.diagnostics.cells} Long cells or retained text were shortened.{/if}
      {#if table.diagnostics.input} Open the source file for the complete dataset.{/if}
    </div>
  {/if}
</div>

<style>
  .tbl {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--c-tx);
  }
  .tbl-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
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
    cursor: var(--cursor-cross-hover);
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
    flex-shrink: 0;
    border-top: 1px solid var(--c-line);
    background: var(--c-bg-raised);
    padding: 8px 12px;
    color: var(--c-tx-muted);
    font-style: italic;
  }
</style>
