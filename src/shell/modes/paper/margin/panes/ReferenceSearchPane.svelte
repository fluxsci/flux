<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { MarginHost, MarginApi } from "../types";
  import { runQuery } from "./refQuery";

  let {
    host,
    margin,
    initialQuery = "",
  }: { host: MarginHost; margin: MarginApi; initialQuery?: string } = $props();

  let query = $state(untrack(() => initialQuery));
  let highlighted = $state(0);
  // `marked` accumulates ACROSS searches — never cleared on query change.
  let marked = $state<Set<string>>(new Set());
  let editTarget = $state<{ from: number; to: number } | null>(null);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let gridEl = $state<HTMLElement | undefined>(undefined);

  // Search the whole FluxLib (not just this project's cited subset) — you search to
  // find any paper to cite. Citing one materializes it into the project (writeCites).
  const results = $derived(runQuery(host.libraryReferences, query));
  const markedList = $derived([...marked]);

  // Show the OpenAlex citation count when a FluxLib entry has been hydrated (enrich).
  function citedBy(r: unknown): string {
    const n = (r as { enrich?: { citedByCount?: number } }).enrich?.citedByCount;
    if (n == null) return "";
    return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }

  onMount(() => {
    // Edit-the-citation-at-the-cursor: pre-seed the tray from the group the caret sits in.
    const g = host.citationAtCaret();
    if (g && g.keys.length) {
      marked = new Set(g.keys);
      editTarget = { from: g.from, to: g.to };
    }
    inputEl?.focus();
  });

  $effect(() => {
    if (highlighted > results.length - 1) highlighted = Math.max(0, results.length - 1);
  });

  function labelFor(key: string): string {
    const r = host.libraryReferences.find((x) => x.key === key);
    return r ? `${r.authors[0] ?? key}${r.year ? ` ${r.year}` : ""}` : key;
  }
  function toggleMark(key: string) {
    const next = new Set(marked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    marked = next;
  }
  function toggleCite(key: string) {
    if (host.citedKeys.has(key)) host.removeCite(key);
    else host.writeCites([key]);
  }
  function confirm() {
    if (marked.size || editTarget) host.writeCites([...marked], editTarget ?? undefined);
    margin.closePane();
  }

  function gridKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(results.length - 1, highlighted + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlighted <= 0) inputEl?.focus();
      else highlighted -= 1;
    } else if (e.key === " ") {
      e.preventDefault();
      if (results[highlighted]) toggleMark(results[highlighted].key);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      const r = results[highlighted];
      if (r && marked.has(r.key)) toggleMark(r.key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      margin.closePane();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      inputEl?.focus();
    }
  }
  function inputKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = 0;
      gridEl?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      margin.closePane();
    }
  }
</script>

<div class="rsp">
  <div class="head">
    <span class="title">{editTarget ? "Edit citation" : "Reference Search"}</span>
    <button class="x" onclick={() => margin.closePane()} aria-label="Close">✕</button>
  </div>

  <input
    bind:this={inputEl}
    bind:value={query}
    onkeydown={inputKey}
    placeholder="author:smith year:2020 journal:nature"
    spellcheck="false"
    autocomplete="off" />

  {#if markedList.length}
    <div class="tray">
      {#each markedList as key (key)}
        <span class="chip">
          {labelFor(key)}
          <button onclick={() => toggleMark(key)} aria-label="Unmark">✕</button>
        </span>
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
  <div class="grid" tabindex="0" bind:this={gridEl} onkeydown={gridKey}>
    <div class="grow ghead">
      <span class="gd"></span><span>Authors</span><span>Title</span><span>Journal</span><span class="gy"
        >Year</span>
    </div>
    {#each results as r, i (r.key)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="grow"
        class:hl={i === highlighted}
        class:marked={marked.has(r.key)}
        onclick={() => {
          highlighted = i;
          toggleMark(r.key);
        }}>
        <button
          class="gd dot"
          class:on={host.citedKeys.has(r.key)}
          title={host.citedKeys.has(r.key) ? "Cited — click to remove" : "Click to cite"}
          aria-label="Toggle citation"
          onclick={(e) => {
            e.stopPropagation();
            toggleCite(r.key);
          }}></button>
        <span class="ga">{r.authors.slice(0, 2).join(", ")}{r.authors.length > 2 ? " et al." : ""}</span>
        <span class="gt" title={(r as { enrich?: { abstract?: string } }).enrich?.abstract || r.title}
          >{r.title}</span>
        <span class="gj">{r.container ?? ""}</span>
        <span class="gy">{r.year}{citedBy(r) ? ` · ${citedBy(r)}` : ""}</span>
      </div>
    {/each}
    {#if results.length === 0}
      <div class="none">No matches{host.libraryReferences.length ? "" : " — your FluxLib is empty"}.</div>
    {/if}
  </div>

  <div class="foot">
    <span class="hint">Space marks · Enter {editTarget ? "replaces" : "inserts"} {marked.size || ""}</span>
    <div class="btns">
      <button class="ghost" onclick={() => margin.closePane()}>Cancel</button>
      <button class="primary" onclick={confirm}>{editTarget ? "Replace" : "Insert"}</button>
    </div>
  </div>
</div>

<style>
  .rsp {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--sp-3);
    gap: var(--sp-2);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .title {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-md);
    color: var(--c-accent-bright);
  }
  .x {
    background: none;
    border: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
  }
  .x:hover {
    color: var(--c-tx-hi);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 11px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font-family: var(--font-mono);
    font-size: var(--ts-sm);
    outline: none;
  }
  .tray {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 4px 2px 9px;
    font-size: var(--ts-xs);
    background: var(--c-accent-tint);
    color: var(--c-accent); /* blue-600 on the tint ≈ 5:1 (AA); blue-500 is ~3.9:1 */
    border-radius: var(--r-pill);
  }
  .chip button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
    font-size: 10px;
    padding: 0 2px;
  }
  .chip button:hover {
    opacity: 1;
  }
  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    outline: none;
  }
  .grid:focus-within {
    border-color: var(--c-accent);
  }
  .grow {
    display: grid;
    grid-template-columns: 22px 1.1fr 2fr 1fr 0.5fr;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--c-line);
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .ghead {
    position: sticky;
    top: 0;
    background: var(--c-surface);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    cursor: default;
  }
  .grow.hl {
    background: var(--c-accent-tint-2);
  }
  .grow.marked {
    background: var(--c-accent-tint);
  }
  .gd {
    display: flex;
    justify-content: center;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--c-danger);
    background: transparent;
    cursor: pointer;
    padding: 0;
  }
  .dot.on {
    background: var(--c-danger);
  }
  .ga {
    color: var(--c-tx);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gt {
    color: var(--c-tx-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gj {
    color: var(--c-tx-muted);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gy {
    color: var(--c-tx-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .none {
    padding: var(--sp-4);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
  }
  .foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hint {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .btns {
    display: flex;
    gap: var(--sp-2);
  }
  .btns button {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 5px 14px;
    border-radius: var(--r-1);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .ghost {
    background: none;
    border-color: var(--c-line-strong);
    color: var(--c-tx-2);
  }
  .primary {
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-weight: 600;
  }
</style>
