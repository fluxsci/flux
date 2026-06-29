<script lang="ts">
  import Icon from "../../../Icon.svelte";
  import { fadeRise } from "../../../../lib/motion/actions";
  import { renderFigureSvg, type FigureRef } from "./figures";
  import type { BibEntry } from "./bib";

  let {
    figures,
    references,
    citedKeys,
    onInsertFigure,
    onInsertCite,
    onAddDoi,
    onClose,
  }: {
    figures: FigureRef[];
    references: BibEntry[];
    citedKeys: Set<string>;
    onInsertFigure: (ref: FigureRef) => void;
    onInsertCite: (key: string) => void;
    onAddDoi: (doi: string) => Promise<string | null>;
    onClose: () => void;
  } = $props();

  let tab = $state<"figures" | "references">("figures");
  let q = $state("");
  let doi = $state("");
  let adding = $state(false);
  let addErr = $state(false);

  const figs = $derived(
    q.trim()
      ? figures.filter((f) =>
          (f.name + " " + f.label).toLowerCase().includes(q.toLowerCase()),
        )
      : figures,
  );
  const refs = $derived(
    q.trim()
      ? references.filter((r) =>
          (r.title + " " + r.authors.join(" ") + " " + r.key + " " + r.year)
            .toLowerCase()
            .includes(q.toLowerCase()),
        )
      : references,
  );

  async function submitDoi() {
    if (!doi.trim() || adding) return;
    adding = true;
    addErr = false;
    const key = await onAddDoi(doi.trim());
    adding = false;
    if (key) doi = "";
    else addErr = true;
  }
  function authorLabel(r: BibEntry): string {
    if (!r.authors.length) return r.key;
    if (r.authors.length === 1) return r.authors[0];
    return r.authors[0] + " et al.";
  }
</script>

<aside class="panel" transition:fadeRise={{ y: 6 }}>
  <header>
    <div class="tabs">
      <button class:on={tab === "figures"} onclick={() => (tab = "figures")}>Figures</button>
      <button class:on={tab === "references"} onclick={() => (tab = "references")}>
        References
      </button>
    </div>
    <button class="x" title="Close" aria-label="Close panel" onclick={onClose}>
      <Icon name="x" size={14} />
    </button>
  </header>

  <div class="search">
    <Icon name="search" size={13} />
    <input placeholder={tab === "figures" ? "Search figures…" : "Search library…"} bind:value={q} />
  </div>

  <div class="body">
    {#if tab === "figures"}
      {#if figs.length}
        {#each figs as f (f.id)}
          {@const svg = renderFigureSvg(f.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="frow" title="Insert {f.name}" onclick={() => onInsertFigure(f)}>
            <div class="fthumb">
              {#if svg}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html svg}
              {/if}
            </div>
            <div class="ftext"><b>Fig {f.number}</b><span>{f.name || f.label}</span></div>
          </div>
        {/each}
      {:else}
        <p class="empty">No figures.</p>
      {/if}
    {:else}
      <div class="adddoi">
        <input
          placeholder="Add by DOI or URL…"
          bind:value={doi}
          onkeydown={(e) => e.key === "Enter" && submitDoi()}
          class:err={addErr} />
        <button onclick={submitDoi} disabled={adding} aria-label="Add reference">
          {#if adding}…{:else}+{/if}
        </button>
      </div>
      {#if refs.length}
        {#each refs as r (r.key)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="rrow" title="Cite {r.key}" onclick={() => onInsertCite(r.key)}>
            <div class="rtop">
              <span class="rwho">{authorLabel(r)}{r.year ? ", " + r.year : ""}</span>
              {#if citedKeys.has(r.key)}<span class="cited" title="Cited">●</span>{/if}
            </div>
            <div class="rttl">{r.title || r.key}</div>
            {#if r.container}<div class="rven">{r.container}</div>{/if}
          </div>
        {/each}
      {:else}
        <p class="empty">{references.length ? "No matches." : "Library is empty."}</p>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .panel {
    flex: 0 0 268px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--c-surface);
    border-left: 1px solid var(--c-line);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-2) 0 var(--sp-3);
    height: 38px;
    border-bottom: 1px solid var(--c-line);
    flex: 0 0 auto;
  }
  .tabs {
    display: flex;
    gap: var(--sp-3);
  }
  .tabs button {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: var(--ts-sm);
    color: var(--c-tx-faint);
    cursor: pointer;
    height: 38px;
    border-bottom: 2px solid transparent;
  }
  .tabs button.on {
    color: var(--c-tx-hi);
    border-bottom-color: var(--c-accent);
  }
  .x {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: none;
    background: none;
    color: var(--c-tx-faint);
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .x:hover {
    color: var(--c-tx);
    background: var(--c-ui-hover);
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    color: var(--c-tx-faint);
    border-bottom: 1px solid var(--c-line);
    flex: 0 0 auto;
  }
  .search input {
    flex: 1;
    background: none;
    border: none;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
  }
  .search input:focus {
    outline: none;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: var(--sp-2);
  }
  .frow {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
    padding: 6px;
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .frow:hover {
    background: var(--c-ui-hover);
  }
  .fthumb {
    flex: 0 0 56px;
    height: 40px;
    background: var(--flx-paper, #fdfcfa);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .fthumb :global(svg) {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
  }
  .ftext {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ftext b {
    color: var(--c-accent-bright);
    font-size: var(--ts-sm);
  }
  .ftext span {
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .adddoi {
    display: flex;
    gap: 4px;
    margin: 0 0 var(--sp-2);
  }
  .adddoi input {
    flex: 1;
    min-width: 0;
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 5px 8px;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-xs);
  }
  .adddoi input.err {
    border-color: var(--c-danger, #d14d41);
  }
  .adddoi input:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .adddoi button {
    flex: 0 0 28px;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: var(--r-1);
    cursor: pointer;
    font-size: 15px;
  }
  .adddoi button:disabled {
    opacity: 0.6;
  }
  .rrow {
    padding: 7px 6px;
    border-radius: var(--r-1);
    cursor: pointer;
    border-bottom: 1px solid var(--c-line);
  }
  .rrow:hover {
    background: var(--c-ui-hover);
  }
  .rtop {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .rwho {
    color: var(--c-tx-hi);
    font-size: var(--ts-sm);
    font-weight: 600;
  }
  .cited {
    color: var(--c-accent);
    font-size: 9px;
  }
  .rttl {
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    line-height: 1.4;
    margin-top: 1px;
  }
  .rven {
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-style: italic;
    margin-top: 1px;
  }
  .empty {
    padding: var(--sp-4);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
  }
</style>
