<script lang="ts">
  // Search your whole reference library from inside the reader (Alt+R) — the reader's
  // counterpart to the manuscript writer's reference-search pane, minus the citation
  // machinery: here a hit is something to OPEN (its PDF as a tab, or its DOI in the
  // browser), never something to insert.
  //
  // It reads FluxLib directly rather than the shared `fluxLibEntries` store, which is
  // only ever refreshed by Paper mode — in a reader-only session that store is empty.
  import { onMount } from "svelte";
  import { attachHaystacks, createQueryRunner } from "../../../lib/references/query";
  import { loadFluxLib } from "../../../lib/references/fluxlibBridge";
  import { fluxLibRevision } from "../../../lib/references/revision";
  import { pdfKeys, refreshPdfKeys, hasPdfIn } from "../../../lib/references/pdfPresence";
  import { fileBridge } from "../../../lib/project/types";
  import { bareDoi } from "../../../lib/references/pdfFinder";
  import { readerTabs } from "./readerStore";
  import type { RefEntry } from "../../../lib/references/types";

  let {
    focusReq = 0,
    onOpenPdf,
  }: {
    /** Bumped by Alt+R to focus the search box (works when already open). */
    focusReq?: number;
    onOpenPdf: (citekey: string) => void;
  } = $props();

  let entries = $state.raw<RefEntry[]>([]);
  let query = $state("");
  let input = $state<HTMLInputElement | undefined>();
  let expanded = $state("");

  // Search-as-you-type is the instantaneous class (§6): no debounce — the runner
  // refines incrementally and the haystacks are stamped once per library load.
  const runner = createQueryRunner<RefEntry>();
  const SHOWN = 200;
  const found = $derived(query.trim() ? runner(entries, query) : entries);
  /** How many references the query matches (all of them, when there is no query). */
  const matched = $derived(found.length);
  const results = $derived(found.slice(0, SHOWN));

  let reloadEpoch = 0;
  let reloadError = $state("");
  async function reload() {
    const epoch = ++reloadEpoch;
    try {
      const lib = await loadFluxLib();
      if (epoch !== reloadEpoch) return;
      attachHaystacks(lib); entries = lib; reloadError = "";
    } catch (error) { if (epoch === reloadEpoch) reloadError = `Library could not be refreshed: ${String(error)}`; }
  }
  onMount(() => {
    void reload();
    refreshPdfKeys();
    let first = true;
    const unsubscribe = fluxLibRevision.subscribe(() => {
      if (first) { first = false; return; }
      void reload();
      refreshPdfKeys(0);
    });
    return () => { reloadEpoch++; unsubscribe(); };
  });

  // Focus (and select) on every Alt+R, including when the panel is already showing.
  $effect(() => {
    void focusReq;
    if (focusReq > 0) setTimeout(() => input?.select(), 0);
  });

  const openTabs = $derived(new Set($readerTabs.tabs.map((t) => t.key)));
  const authorLine = (e: RefEntry) =>
    `${(e.authors ?? []).slice(0, 2).join(", ")}${(e.authors ?? []).length > 2 ? " et al." : ""}${e.year ? ` · ${e.year}` : ""}`;
  const openDoi = (doi: string) => void fileBridge()?.openExternal?.(`https://doi.org/${bareDoi(doi)}`);
</script>

<div class="libpanel" data-testid="reader-library">
  {#if reloadError}<div class="lerr" role="status"><span>{reloadError}</span><button onclick={() => reload()}>Retry</button></div>{/if}
  <label class="libbar">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
    <input
      class="libsearch"
      bind:this={input}
      bind:value={query}
      placeholder="Search your library"
      title="Search your library: words, or author: year: journal: tag:"
      aria-label="Search reference library"
      spellcheck="false" />
    {#if query}<button class="libx" title="Clear" aria-label="Clear search" onclick={() => { query = ""; input?.focus(); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>{/if}
  </label>
  {#if entries.length}
    <div class="libcount" aria-live="polite">{#if query.trim()}{matched.toLocaleString()} of {entries.length.toLocaleString()}{:else}{entries.length.toLocaleString()} reference{entries.length === 1 ? "" : "s"}{/if}</div>
  {/if}
  {#if !entries.length}
    <div class="smsg">Your library is empty — add references in the Library.</div>
  {:else if !results.length}
    <div class="smsg">No matches in {entries.length.toLocaleString()} references.</div>
  {:else}
    <ul class="liblist">
      {#each results as e (e.key)}
        {@const readable = hasPdfIn($pdfKeys, e.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <li class="libitem" class:expanded={expanded === e.key} class:open={openTabs.has(e.key)}
          onclick={() => (expanded = expanded === e.key ? "" : e.key)}>
          <div class="ltitle" class:unclamped={expanded === e.key} title={e.title}>{e.title}</div>
          <div class="lmeta">
            <span class="lauth">{authorLine(e)}</span>
            {#if openTabs.has(e.key)}<span class="lopen" title="Already open as a tab">open</span>{/if}
          </div>
          {#if expanded === e.key}
            {#if e.container}<div class="lcontainer">{e.container}</div>{/if}
            <div class="lkey">{e.key}</div>
          {/if}
          <div class="lactions">
            {#if readable}
              <button class="lpill" title="Open this PDF in a tab"
                onclick={(ev) => { ev.stopPropagation(); onOpenPdf(e.key); }}>Open PDF</button>
            {:else}
              <span class="lnopdf" title="No PDF on disk — fetch it in the Library">no PDF</span>
            {/if}
            {#if e.doi}
              <button class="ldoi" title="Open the DOI in your browser"
                onclick={(ev) => { ev.stopPropagation(); openDoi(e.doi!); }}>DOI ↗</button>
            {/if}
          </div>
        </li>
      {/each}
      {#if matched > results.length}<li class="lmore">The first {results.length} of {matched.toLocaleString()}. Search to narrow them.</li>{/if}
    </ul>
  {/if}
</div>

<style>
  /* The library, from inside the Reader: the sidebars' vocabulary (ReaderDoc.svelte): the title
     first, who and when under it, then what you can do. */
  .libpanel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
  }
  .libpanel svg {
    display: block;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .libbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    margin: 8px 8px 6px;
    padding: 0 6px 0 8px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
    transition: border-color 80ms linear;
  }
  .libbar > svg {
    width: 13px;
    height: 13px;
  }
  .libbar:hover {
    border-color: var(--c-tx-muted);
  }
  .libbar:focus-within {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 3px var(--c-accent-tint-2);
  }
  .libsearch {
    flex: 1 1 auto;
    min-width: 0;
    height: 26px;
    padding: 0;
    background: transparent;
    color: var(--c-tx-hi);
    border: 0;
    outline: none;
    font: 13px var(--font-serif);
  }
  .libsearch::placeholder {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .libx {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    cursor: var(--cursor-cross-hover);
  }
  .libx svg {
    width: 10px;
    height: 10px;
    stroke-width: 1.6;
  }
  .libx:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .libcount {
    flex: 0 0 auto;
    padding: 0 12px 7px;
    border-bottom: 1px solid var(--c-line);
    color: var(--c-tx-muted);
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .lerr {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--c-line);
    background: color-mix(in oklab, var(--c-danger) 10%, transparent);
    box-shadow: inset 2px 0 0 var(--c-danger);
    color: var(--c-tx);
    font: 12px/1.4 var(--font-serif);
  }
  .lerr span {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .lerr button {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--c-accent-bright);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: var(--cursor-cross-hover);
  }
  .smsg {
    padding: 16px 14px;
    font: italic 12.5px/1.5 var(--font-serif);
    color: var(--c-tx-muted);
  }
  .liblist {
    list-style: none;
    margin: 0;
    padding: 0 0 6px;
    overflow: auto;
    min-height: 0;
  }
  .libitem {
    padding: 9px 12px 9px 14px;
    border-bottom: 1px solid var(--c-line);
    cursor: var(--cursor-cross-hover);
  }
  .libitem:hover {
    background: var(--c-surface-2);
  }
  .libitem.expanded {
    background: var(--c-accent-tint-2);
  }
  /* Already open as a tab: the rail. */
  .libitem.open {
    box-shadow: inset 2px 0 0 var(--c-accent);
  }
  .ltitle {
    font: 13px/1.35 var(--font-serif);
    color: var(--c-tx-hi);
    margin: 0 0 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ltitle.unclamped {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .lmeta {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    color: var(--c-tx-muted);
    font: 11.5px var(--font-serif);
  }
  .lauth {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lopen {
    flex: 0 0 auto;
    color: var(--c-accent-bright);
    font: 9.5px var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .lcontainer {
    margin-top: 5px;
    font: italic 11.5px var(--font-serif);
    color: var(--c-tx-2);
  }
  .lkey {
    margin-top: 3px;
    font: 10.5px var(--font-mono);
    color: var(--c-tx-faint);
    overflow-wrap: anywhere;
  }
  .lactions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 7px;
  }
  .lpill {
    height: 22px;
    padding: 0 9px;
    border: 1px solid color-mix(in oklab, var(--c-accent) 60%, transparent);
    border-radius: var(--r-ui);
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
    font: 12px var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, border-color 80ms linear;
  }
  .lpill:hover {
    background: color-mix(in oklab, var(--c-accent) 28%, transparent);
    border-color: var(--c-accent);
  }
  .lnopdf {
    font: 11.5px var(--font-serif);
    color: var(--c-tx-faint);
  }
  .ldoi {
    border: none;
    background: none;
    color: var(--c-accent-bright);
    font: 11.5px var(--font-serif);
    padding: 0;
    cursor: var(--cursor-cross-hover);
  }
  .ldoi:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .lmore {
    padding: 10px 14px;
    color: var(--c-tx-muted);
    font: italic 11.5px var(--font-serif);
  }
  @media (prefers-reduced-motion: reduce) {
    .libbar,
    .lpill {
      transition: none;
    }
  }
</style>
