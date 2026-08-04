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
  const results = $derived(query.trim() ? runner(entries, query).slice(0, 200) : entries.slice(0, 200));

  async function reload() {
    const lib = await loadFluxLib();
    attachHaystacks(lib);
    entries = lib;
  }
  onMount(() => {
    void reload();
    refreshPdfKeys();
    let first = true;
    return fluxLibRevision.subscribe(() => {
      if (first) { first = false; return; }
      void reload();
      refreshPdfKeys(0);
    });
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
  <input
    class="libsearch"
    bind:this={input}
    bind:value={query}
    placeholder="Search your library — author:, year:, journal:…"
    aria-label="Search reference library"
    spellcheck="false" />
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
          <div class="lmeta">
            <span class="lauth">{authorLine(e)}</span>
            {#if openTabs.has(e.key)}<span class="lopen" title="Already open as a tab">open</span>{/if}
          </div>
          <div class="ltitle" class:unclamped={expanded === e.key} title={e.title}>{e.title}</div>
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
    </ul>
  {/if}
</div>

<style>
  .libpanel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
  }
  .libsearch {
    flex: 0 0 auto;
    margin: 8px;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 4px 8px;
    font: inherit;
    font-size: var(--ts-xs);
  }
  .libsearch:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .smsg {
    padding: 12px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
    line-height: 1.5;
  }
  .liblist {
    list-style: none;
    margin: 0;
    padding: 0 0 4px;
    overflow: auto;
    min-height: 0;
  }
  .libitem {
    padding: 7px 12px;
    border-bottom: 1px solid var(--c-line);
    cursor: pointer;
  }
  .libitem:hover {
    background: var(--c-bg);
  }
  .libitem.open {
    box-shadow: inset 2px 0 0 var(--c-accent);
  }
  .lmeta {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .lopen {
    color: var(--c-accent);
  }
  .ltitle {
    font-size: var(--ts-sm);
    color: var(--c-tx-1);
    margin: 2px 0 5px;
    line-height: 1.3;
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
  .lcontainer {
    font-size: var(--ts-xs);
    font-style: italic;
    color: var(--c-tx-2);
    margin-bottom: 3px;
  }
  .lkey {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-family: var(--font-mono, monospace);
    margin-bottom: 3px;
  }
  .lactions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .lpill {
    border: 1px solid var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: var(--r-1);
    padding: 1px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .lpill:hover {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .lnopdf {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .ldoi {
    border: none;
    background: none;
    color: var(--c-accent);
    font: inherit;
    font-size: var(--ts-xs);
    padding: 0;
    cursor: pointer;
  }
  .ldoi:hover {
    text-decoration: underline;
  }
</style>
