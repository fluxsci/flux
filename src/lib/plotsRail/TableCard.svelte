<script lang="ts">
  import { isNumericCell } from "../dissect/csv";
  import type { TablePreview } from "./tableCard";
  // A CSV/TSV dissection file as a real mini-table (not an icon): header + the first rows, mono,
  // numbers right-aligned, clipped at the card's right edge with a fade. A one-row wide table is
  // shown transposed (key · value) — `test, statistic, df, p` would otherwise be cut at 300 px.
  let { name, preview, selected = false, focused = false }: { name: string; preview: TablePreview | null; selected?: boolean; focused?: boolean } = $props();
  const pad = (row: string[], n: number) => Array.from({ length: n }, (_, i) => row[i] ?? "");
  const meta = $derived(!preview ? "" : preview.error ? "unreadable" : `${preview.complete ? preview.rowCount : `≥${preview.rowCount}`} × ${preview.cols}`);
  const cols = $derived(preview ? Math.min(preview.cols, 24) : 0);
</script>

<div class="card" class:selected class:focused data-table-card={name}>
  <div class="title"><span class="ic">▦</span><span class="nm" title={name}>{name}</span><span class="meta">{meta}</span></div>
  {#if !preview}
    <div class="msg">Reading…</div>
  {:else if preview.error}
    <div class="msg">{preview.error}</div>
  {:else if preview.transposed}
    <div class="kv">
      {#each pad(preview.header, preview.cols).slice(0, 8) as key, i (i)}
        <div class="kv-row"><span class="k">{key}</span><span class="v" class:num={isNumericCell(preview.rows[0]?.[i] ?? "")}>{preview.rows[0]?.[i] ?? ""}</span></div>
      {/each}
    </div>
  {:else}
    <div class="table" style:grid-template-columns={`repeat(${cols}, max-content)`}>
      {#each pad(preview.header, cols) as h, i (i)}<span class="th">{h}</span>{/each}
      {#each preview.rows as row, r (r)}
        {#each pad(row, cols) as cell, i (i)}<span class="td" class:num={isNumericCell(cell)}>{cell}</span>{/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  .card { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 0 6px 6px; overflow: hidden; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: var(--c-bg-raised); font: 10px/15px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--c-tx-2); }
  .card::after { content: ""; position: absolute; top: 20px; right: 0; bottom: 0; width: 18px; background: linear-gradient(to right, transparent, var(--c-bg-raised)); pointer-events: none; }
  .card.selected { border-color: var(--c-accent); box-shadow: 0 0 0 1px var(--c-accent); }
  .card.focused { outline: 1px solid var(--c-accent-bright, var(--c-accent)); outline-offset: 2px; }
  .title { display: flex; align-items: center; gap: 5px; height: 20px; flex-shrink: 0; font: 11px var(--font-ui); color: var(--c-tx); }
  .ic { color: var(--c-accent-bright, var(--c-accent)); }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { margin-left: auto; padding-left: 6px; flex-shrink: 0; color: var(--c-tx-faint); font: 10px var(--font-mono); }
  .table { display: grid; column-gap: 10px; min-width: 0; overflow: hidden; white-space: nowrap; }
  .th { color: var(--c-tx-hi); font-weight: 600; }
  .td.num, .v.num { text-align: right; font-variant-numeric: tabular-nums; }
  .kv { display: flex; flex-direction: column; min-width: 0; }
  .kv-row { display: flex; gap: 10px; white-space: nowrap; }
  .k { flex: 0 0 auto; min-width: 72px; max-width: 55%; overflow: hidden; text-overflow: ellipsis; color: var(--c-tx-muted); }
  .v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--c-tx-hi); }
  .msg { color: var(--c-tx-muted); font: 11px var(--font-ui); }
</style>
