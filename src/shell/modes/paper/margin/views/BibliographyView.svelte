<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";

  let { host, margin }: { host: MarginHost; margin: MarginApi } = $props();

  let doi = $state("");
  let adding = $state(false);
  let failed = $state(false);

  const refs = $derived([...host.references].sort((a, b) => a.authors[0]?.localeCompare(b.authors[0] ?? "") ?? 0));
  const citedCount = $derived(refs.filter((r) => host.citedKeys.has(r.key)).length);

  function toggle(key: string) {
    if (host.citedKeys.has(key)) host.removeCite(key);
    else host.writeCites([key]);
  }
  async function add() {
    const d = doi.trim();
    if (!d) return;
    adding = true;
    failed = false;
    const key = await host.addDoi(d);
    adding = false;
    if (key) doi = "";
    else failed = true;
  }
</script>

<div class="bib">
  <div class="head">
    <span class="count">{refs.length} reference{refs.length === 1 ? "" : "s"}</span>
    <span class="cited">{citedCount} cited</span>
  </div>
  <button class="search" onclick={() => margin.openPane("reference-search")}>Search references…</button>

  <div class="adddoi" class:failed>
    <input
      bind:value={doi}
      placeholder="Add by DOI or URL…"
      spellcheck="false"
      onkeydown={(e) => e.key === "Enter" && add()} />
    <button onclick={add} disabled={adding} title="Fetch reference">{adding ? "…" : "+"}</button>
  </div>

  {#if refs.length === 0}
    <p class="empty">Your library is empty. Paste a DOI above, or add entries to references/library.bib.</p>
  {:else}
    <ul class="list">
      {#each refs as r (r.key)}
        <li class="ref" class:on={host.citedKeys.has(r.key)}>
          <button class="dot" title={host.citedKeys.has(r.key) ? "Cited — click to remove" : "Click to cite"} onclick={() => toggle(r.key)} aria-label="Toggle citation"></button>
          <div class="body">
            <div class="t">{r.title || r.key}</div>
            <div class="m">{r.authors.slice(0, 3).join(", ")}{r.authors.length > 3 ? " et al." : ""}{r.year ? ` · ${r.year}` : ""}{r.container ? ` · ${r.container}` : ""}</div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .bib {
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    height: 100%;
    overflow: auto;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: var(--ts-sm);
  }
  .count {
    color: var(--c-tx);
    font-weight: 600;
  }
  .cited {
    color: var(--c-accent-bright);
  }
  .search {
    font: inherit;
    font-size: var(--ts-sm);
    text-align: left;
    padding: 7px 11px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
  }
  .search:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .adddoi {
    display: flex;
    gap: 5px;
  }
  .adddoi input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
    outline: none;
  }
  .adddoi.failed input {
    border-color: var(--c-danger);
  }
  .adddoi input:focus {
    border-color: var(--c-accent);
  }
  .adddoi button {
    flex: 0 0 auto;
    width: 30px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
    font-size: var(--ts-md);
  }
  .empty {
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
    line-height: 1.5;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .ref {
    display: flex;
    gap: var(--sp-2);
    padding: var(--sp-2) 4px;
    border-bottom: 1px solid var(--c-line);
  }
  .dot {
    flex: 0 0 auto;
    margin-top: 4px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--c-danger);
    background: transparent;
    cursor: pointer;
    padding: 0;
  }
  .ref.on .dot {
    background: var(--c-danger);
  }
  .body {
    min-width: 0;
  }
  .t {
    font-size: var(--ts-sm);
    color: var(--c-tx);
    line-height: 1.35;
  }
  .m {
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    margin-top: 2px;
  }
</style>
