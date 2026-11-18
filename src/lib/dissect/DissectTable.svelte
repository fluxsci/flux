<script lang="ts">
  import { nativeClick, nativeScroll } from "../ui/nativeEvents";
  // CSV/TSV as a table: sticky header, windowed body rows (all N rows in the DOM is never
  // acceptable — same discipline as the sidebar/library windows), numeric columns right-
  // aligned, click a header to sort (asc → desc → file order; numeric-aware). The window is
  // the classic spacer + translateY: one spacer supplies scroll height, only visible rows
  // exist. Horizontal overflow scrolls inside this container (header rides along — same
  // scroll box).
  //
  // 2026-11-18 (owner: "better formatting for tables, stats"): numbers are shown as a reader
  // wants them (format.ts: short values as written, long ones rounded, powers of ten instead of
  // e-notation), with the file's own text in each cell's tooltip and one click away ("As
  // written"); p-value columns carry the conventional marks; and a table that IS a set of test
  // results is also read out as sentences that can be copied into a manuscript.
  import { parseDelimited, parseDelimitedAsync, numericColumns, tableOrder, type ParsedTable } from "./csv";
  import { columnKind, formatCell, significance, statsReport } from "./format";

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
  const kinds = $derived(table.header.map((name, c) => columnKind(name, !!numeric[c])));
  /** As written = the file's own text in every cell. */
  let exact = $state(false);
  const show = (value: string, c: number) => (exact ? value : formatCell(value, kinds[c] ?? "text"));
  const rounds = $derived(kinds.some((k) => k !== "text"));
  const report = $derived(statsReport(table.header, table.rows));
  let copied = $state(-2);
  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      copied = index;
      setTimeout(() => { if (copied === index) copied = -2; }, 1200);
    } catch { /* the sentence is selectable text: it can still be copied by hand */ }
  }

  // Column widths from a character-count sample (header + first 200 rows): stable, cheap,
  // no measurement pass. Clamped so one long cell can't blow the layout (title shows all).
  const widths = $derived.by(() => {
    const out: number[] = [];
    const sample = table.rows.slice(0, 200);
    for (let c = 0; c < table.cols; c++) {
      let m = (table.header[c] ?? "").length;
      // Measured on what is shown: a rounded column is as narrow as its rounded values.
      for (const r of sample) m = Math.max(m, show(r[c] ?? "", c).length);
      // A power of ten sets its "×" and superscripts wider than a mono cell; a p-value also keeps a gutter for its marks.
      out.push(Math.round(Math.min(Math.max(m, 4), 42) * 7.2 + (kinds[c] === "p" ? 62 : kinds[c] === "number" ? 30 : 20)));
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
  <div class="tbar">
    <span class="dim"><b>{(table.complete ? table.totalRows : table.rows.length).toLocaleString()}</b> row{table.totalRows === 1 ? "" : "s"} <i>×</i> <b>{table.cols}</b> column{table.cols === 1 ? "" : "s"}</span>
    <span class="grow"></span>
    {#if rounds}
      <span class="seg" role="group" aria-label="How numbers are shown">
        <button class:chosen={!exact} aria-pressed={!exact} title="Long numbers rounded to 4 significant digits (p-values to 2); short ones as written" use:nativeClick={() => (exact = false)}>Rounded</button>
        <button class:chosen={exact} aria-pressed={exact} title="Every cell exactly as the file has it" use:nativeClick={() => (exact = true)}>As written</button>
      </span>
    {/if}
  </div>
  {#if report}
    <div class="report" data-dissect-report>
      <div class="rhead"><span>Reads as</span><span class="grow"></span><button class="copy" use:nativeClick={() => void copy(report.map((l) => l.sentence).join("\n"), -1)}>{copied === -1 ? "Copied" : report.length > 1 ? "Copy all" : "Copy"}</button></div>
      <ol>
        {#each report.slice(0, 12) as line, i (i)}
          <li>
            {#if line.groups}<b class="groups">{line.groups}</b>{/if}
            <span class="what">{#if line.test}<span class="test">{line.test}</span>{/if}{#if line.statistic}<span class="stat">{line.statistic}</span>{/if}<span class="p" data-sig={line.marks || undefined}>{line.p}</span>{#each line.corrected as c}<span class="corr">{c}</span>{/each}{#if line.effect}<span class="effect">{line.effect}</span>{/if}{#if line.n}<span class="n">{line.n}</span>{/if}</span>
            {#if report.length > 1}<button class="copy one" title="Copy this result as a sentence" use:nativeClick={() => void copy(line.sentence, i)}>{copied === i ? "Copied" : "Copy"}</button>{/if}
          </li>
        {/each}
      </ol>
      {#if report.length > 12}<p class="more">and {report.length - 12} more rows below</p>{/if}
    </div>
  {/if}
 <div class="tbl-scroll" bind:this={viewport} use:nativeScroll={onScroll}>
  <div class="hdr" style:grid-template-columns={gridCols} style:width={`${totalW}px`}>
    {#each table.header as hcell, c}
      <button
        class="hcell"
        class:num={numeric[c]}
        class:sorted={sortCol === c}
        title={`${hcell}${kinds[c] === "p" ? " · p-values: * < .05, ** < .01, *** < .001" : ""} · click to sort`}
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
            <div class="cell" class:num={numeric[c]} class:p={kinds[c] === "p"} data-sig={kinds[c] === "p" ? significance(v) || undefined : undefined} title={v}>{show(v, c)}</div>
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
  .tbl { flex: 1; min-height: 0; display: flex; flex-direction: column; font: 12px var(--font-mono, ui-monospace, monospace); color: var(--c-tx); background: var(--c-bg); }
  .grow { flex: 1; }
  .tbar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px 0 14px; background: var(--c-surface); border-bottom: 1px solid var(--c-line); }
  .dim { color: var(--c-tx-muted); font: 11px var(--font-mono); font-variant-numeric: tabular-nums; } .dim b { color: var(--c-tx-2); font-weight: 600; } .dim i { font-style: normal; color: var(--c-tx-faint); margin: 0 2px; }
  button { cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear; }
  .seg { display: inline-flex; padding: 1px; gap: 1px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: var(--c-bg); }
  .seg button { height: 20px; padding: 0 9px; border: 0; border-radius: 1px; background: transparent; color: var(--c-tx-muted); font: 11.5px var(--font-serif); }
  .seg button:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .seg button.chosen { background: var(--c-accent-tint); color: var(--c-tx-hi); box-shadow: inset 0 -1px 0 var(--c-accent); }

  /* The table read as results: one line per test, as a results section would write it. */
  .report { flex: 0 0 auto; max-height: 42%; overflow: auto; padding: 10px 14px 12px; background: var(--c-surface); border-bottom: 1px solid var(--c-line); user-select: text; }
  .rhead { display: flex; align-items: center; margin-bottom: 6px; color: var(--c-tx-muted); font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
  .report ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
  .report li { display: grid; grid-template-columns: minmax(120px, max-content) minmax(0, 1fr) auto; align-items: baseline; column-gap: 14px; font: 13.5px/1.5 var(--font-serif); color: var(--c-tx); }
  .groups { font-weight: 600; color: var(--c-tx-hi); }
  .what { display: flex; flex-wrap: wrap; column-gap: 12px; min-width: 0; }
  .test { color: var(--c-tx-2); font-style: italic; }
  .stat, .p, .corr, .effect, .n { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .p { color: var(--c-tx-hi); }
  .p[data-sig]::after, .cell[data-sig]::after { content: attr(data-sig); color: var(--c-comment); font: 600 11px var(--font-mono); letter-spacing: .5px; }
  .p[data-sig]::after { margin-left: 3px; vertical-align: 2px; }
  .corr, .n { color: var(--c-tx-muted); }
  .copy { height: 20px; padding: 0 8px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: transparent; color: var(--c-tx-muted); font: 11px var(--font-ui); letter-spacing: 0; text-transform: none; }
  .copy:hover { border-color: var(--c-line-strong); background: var(--c-surface-2); color: var(--c-tx-hi); }
  .copy.one { opacity: 0; } .report li:hover .copy.one, .copy.one:focus-visible { opacity: 1; }
  .more { margin: 6px 0 0; color: var(--c-tx-muted); font: italic 11.5px var(--font-serif); }

  .tbl-scroll { flex: 1; min-height: 0; overflow: auto; }
  .hdr { position: sticky; top: 0; z-index: 1; display: grid; background: var(--c-bg-raised); border-bottom: 1px solid var(--c-line-strong); }
  .hcell { display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 9px; background: none; border: none; border-right: 1px solid var(--c-line); color: var(--c-tx-2); font: 600 11.5px var(--font-mono); text-align: left; overflow: hidden; }
  .hcell.num { justify-content: flex-end; text-align: right; }
  .hcell:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .hcell.sorted { color: var(--c-accent-bright); box-shadow: inset 0 -2px 0 var(--c-accent); }
  .ht { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .arrow { font-size: 8px; flex: 0 0 auto; }
  .spacer { position: relative; }
  .window { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
  .row { display: grid; border-bottom: 1px solid var(--c-line); }
  .row:nth-child(2n) { background: color-mix(in oklab, var(--c-tx-hi) 2.5%, transparent); }
  .row:hover { background: var(--c-accent-tint-2); }
  .cell { position: relative; padding: 0 9px; line-height: 25px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-right: 1px solid var(--c-line); }
  .cell.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--c-tx-hi); }
  /* A p-value keeps its digits aligned: the marks sit in a gutter of their own. */
  .cell.p { padding-right: 34px; }
  .cell[data-sig]::after { position: absolute; right: 7px; top: 3px; }
  .note { flex-shrink: 0; border-top: 1px solid var(--c-line); background: var(--c-bg-raised); padding: 8px 14px; color: var(--c-tx-muted); font: italic 12px var(--font-serif); }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
