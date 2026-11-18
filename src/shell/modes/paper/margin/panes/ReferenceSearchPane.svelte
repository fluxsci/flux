<script lang="ts">
  // Reference Search: the whole FluxLib, filterable, as a list you walk with the keyboard.
  // Rows are two lines (who · where · when, then the full title) because a 340 px margin
  // cannot hold four columns: the old grid showed "Yüzgeç, P…" beside "Pupil Size Couplin…".
  // The list is WINDOWED: with an empty query the result is the entire library, and mounting
  // 1,600 rows on every Alt+R (then re-rendering them per keystroke) was the pane's whole cost.
  import { onMount, untrack } from "svelte";
  import type { MarginHost, MarginApi } from "../types";
  import { runQuery } from "./refQuery";
  import { paperTextScale } from "../../view-mode/paperTextScaleStore";
  import { clampScale } from "../../view-mode/paperTextScale";

  let {
    host,
    margin,
    initialQuery = "",
  }: { host: MarginHost; margin: MarginApi; initialQuery?: string } = $props();

  let query = $state(untrack(() => initialQuery));
  let highlighted = $state(0);
  // `marked` accumulates ACROSS searches (never cleared on query change) and is
  // an ORDERED array: the inserted group preserves the order you marked in.
  // Editing an EXISTING group lives in CitationGroupPane (Alt-C / chip dblclick)
  // — this pane is pure insert.
  let marked = $state<string[]>([]);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let gridEl = $state<HTMLElement | undefined>(undefined);
  // Enter with nothing marked inserts the row you are on, but only once you have typed or
  // moved: a stray Enter on a freshly opened pane must not cite the library's first entry.
  let engaged = $state(untrack(() => !!initialQuery.trim()));

  // Fixed row pitch, scaled with the margin's text size (real type, so the arithmetic and the
  // CSS use the same number; see marginKit --ts-scale).
  const ROW = $derived(Math.round(46 * clampScale($paperTextScale.scale.margin)));
  const OVERSCAN = 6;
  let scrollTop = $state(0);
  let viewH = $state(0);

  // Search the whole FluxLib (not just this project's cited subset) — you search to
  // find any paper to cite. Citing one materializes it into the project (writeCites).
  const results = $derived(runQuery(host.libraryReferences, query));

  // Show the OpenAlex citation count when a FluxLib entry has been hydrated (enrich).
  function citedBy(r: unknown): string {
    const n = (r as { enrich?: { citedByCount?: number } }).enrich?.citedByCount;
    if (n == null) return "";
    return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }

  onMount(() => {
    inputEl?.focus();
  });

  $effect(() => {
    if (highlighted > results.length - 1) highlighted = Math.max(0, results.length - 1);
  });
  // A new query starts at the top: its best match is row one.
  $effect(() => {
    void query;
    untrack(() => {
      highlighted = 0;
      if (gridEl) gridEl.scrollTop = 0;
      scrollTop = 0;
    });
  });

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const last = $derived(Math.min(results.length, Math.ceil((scrollTop + (viewH || 400)) / ROW) + OVERSCAN));
  const windowed = $derived(results.slice(first, last));
  const markOrder = $derived(new Map(marked.map((k, i) => [k, i + 1])));

  /** Keep the keyboard's row inside the viewport (no smooth scroll: the list follows the key). */
  function reveal(i: number) {
    if (!gridEl) return;
    const top = i * ROW, bottom = top + ROW;
    if (top < gridEl.scrollTop) gridEl.scrollTop = top;
    else if (bottom > gridEl.scrollTop + gridEl.clientHeight) gridEl.scrollTop = bottom - gridEl.clientHeight;
  }
  function move(to: number) {
    highlighted = Math.max(0, Math.min(results.length - 1, to));
    engaged = true;
    reveal(highlighted);
  }
  function who(authors: string[]): string {
    if (!authors.length) return "Unknown";
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
    return `${authors[0]} et al.`;
  }

  function labelFor(key: string): string {
    const r = host.libraryReferences.find((x) => x.key === key);
    return r ? `${r.authors[0] ?? key}${r.year ? ` ${r.year}` : ""}` : key;
  }
  function toggleMark(key: string) {
    marked = marked.includes(key) ? marked.filter((k) => k !== key) : [...marked, key];
  }
  function toggleCite(key: string) {
    if (host.citedKeys.has(key)) host.removeCite(key);
    else host.writeCites([key]);
  }
  /** What Enter would insert right now: the marked group, else the row the keyboard is on. */
  const pending = $derived(marked.length ? marked : engaged && results[highlighted] ? [results[highlighted].key] : []);
  function confirm() {
    if (pending.length) host.writeCites(pending);
    margin.closePane();
  }

  function gridKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(highlighted + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlighted <= 0) inputEl?.focus();
      else move(highlighted - 1);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const page = Math.max(1, Math.floor((gridEl?.clientHeight ?? ROW * 8) / ROW) - 1);
      move(highlighted + (e.key === "PageDown" ? page : -page));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? 0 : results.length - 1);
    } else if (e.key === " ") {
      e.preventDefault();
      if (results[highlighted]) toggleMark(results[highlighted].key);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      const r = results[highlighted];
      if (r && marked.includes(r.key)) toggleMark(r.key);
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
      engaged = true;
      gridEl?.focus();
      reveal(highlighted);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      margin.closePane();
    }
  }
</script>

<div class="rsp mk-pane">
  <div class="query">
    <input
      class="mk-input mono"
      bind:this={inputEl}
      bind:value={query}
      oninput={() => (engaged = true)}
      onkeydown={inputKey}
      placeholder="author:smith year:2020 journal:nature"
      aria-label="Search references"
      spellcheck="false"
      autocomplete="off" />
    <span class="count mk-num" aria-live="polite">{results.length.toLocaleString()}</span>
  </div>

  {#if marked.length}
    <div class="tray" aria-label="Marked references">
      {#each marked as key, i (key)}
        <span class="mk-chip">
          <b class="mk-num">{i + 1}</b>
          <span class="mk-clip">{labelFor(key)}</span>
          <button onclick={() => toggleMark(key)} aria-label="Unmark {labelFor(key)}">✕</button>
        </span>
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="rs-list mk-list keys"
    role="listbox"
    aria-label="References"
    aria-multiselectable="true"
    aria-activedescendant={results[highlighted] ? `rs-${results[highlighted].key}` : undefined}
    tabindex="0"
    bind:this={gridEl}
    bind:clientHeight={viewH}
    onscroll={() => (scrollTop = gridEl?.scrollTop ?? 0)}
    onkeydown={gridKey}>
    <div class="rs-space" style="height:{results.length * ROW}px">
      {#each windowed as r, w (r.key)}
        {@const i = first + w}
        {@const cited = host.citedKeys.has(r.key)}
        {@const order = markOrder.get(r.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="rs-row mk-item"
          class:hl={i === highlighted}
          class:on={order != null}
          id="rs-{r.key}"
          role="option"
          tabindex="-1"
          aria-selected={order != null}
          style="top:{i * ROW}px;height:{ROW}px"
          onclick={() => {
            highlighted = i;
            engaged = true;
            toggleMark(r.key);
          }}>
          <button
            class="mk-dot"
            class:on={cited}
            title={cited ? "Cited in this document: click to remove every citation of it" : "Cite at the caret now"}
            aria-label="Toggle citation"
            aria-pressed={cited}
            tabindex="-1"
            onclick={(e) => {
              e.stopPropagation();
              toggleCite(r.key);
            }}></button>
          <div class="rs-main">
            <div class="rs-who">
              <span class="who mk-clip">{who(r.authors)}</span>
              <i class="where mk-clip">{r.container ?? ""}</i>
              {#if order != null}
                <b class="order mk-num" title="Marked: number {order} in the citation">{order}</b>
              {:else if citedBy(r)}
                <span class="mk-num cites" title="Times cited (OpenAlex)">{citedBy(r)}×</span>
              {/if}
              <span class="mk-num year">{r.year ?? ""}</span>
            </div>
            <div class="rs-title mk-clip" title={(r as { enrich?: { abstract?: string } }).enrich?.abstract || r.title}>{r.title}</div>
          </div>
        </div>
      {/each}
    </div>
    {#if results.length === 0}
      <p class="mk-empty">No matches{host.libraryReferences.length ? "" : ": your FluxLib is empty"}.</p>
    {/if}
  </div>

  <div class="mk-foot">
    <span class="mk-hint mk-grow"><kbd>Space</kbd>mark<span class="sep">·</span><kbd>↵</kbd>insert</span>
    <button class="mk-btn quiet ghost" onclick={() => margin.closePane()}>Cancel</button>
    <button class="mk-btn primary" onclick={confirm} disabled={!pending.length}>Insert{pending.length > 1 ? ` ${pending.length}` : ""}</button>
  </div>
</div>

<style>
  .query {
    position: relative;
    flex: 0 0 auto;
  }
  .query input {
    padding-right: calc(46px * var(--ts-scale, 1) + 12px);
  }
  .count {
    position: absolute;
    right: 10px;
    top: 50%;
    translate: 0 -50%;
    color: var(--c-tx-faint);
    font-size: calc(10.5px * var(--ts-scale, 1));
    pointer-events: none;
  }
  .tray {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    max-height: calc(72px * var(--ts-scale, 1));
    overflow: auto;
  }
  .tray b {
    font-weight: 600;
    opacity: 0.75;
  }
  .rs-space {
    position: relative;
  }
  .rs-row {
    position: absolute;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: calc(26px * var(--ts-scale, 1)) minmax(0, 1fr);
    align-items: center;
    column-gap: 4px;
    padding: 0 9px 0 8px;
    outline: none;
  }
  .rs-row :global(.mk-dot) {
    justify-self: center;
  }
  .rs-main {
    min-width: 0;
    display: grid;
    row-gap: calc(3px * var(--ts-scale, 1));
  }
  .rs-who {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
    font-size: var(--ts-sm);
    line-height: 1.15;
  }
  .who {
    flex: 0 1 auto;
    color: var(--c-tx);
    font-weight: 600;
  }
  .where {
    flex: 1 1 0;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
  }
  .rs-title {
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    line-height: 1.2;
  }
  .year {
    flex: 0 0 auto;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
  }
  .cites {
    flex: 0 0 auto;
    color: var(--c-tx-faint);
    font-size: calc(10px * var(--ts-scale, 1));
  }
  .order {
    flex: 0 0 auto;
    min-width: calc(15px * var(--ts-scale, 1));
    box-sizing: border-box;
    padding: 1px 4px;
    border-radius: var(--r-pill);
    background: var(--pane-c);
    color: var(--flx-paper);
    font-size: calc(10px * var(--ts-scale, 1));
    font-weight: 600;
    text-align: center;
  }
</style>
