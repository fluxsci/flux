<script lang="ts">
  import { tick } from "svelte";
  import type { MarginHost, MarginApi } from "../types";
  import { bibError } from "../../scholar/bib";
  // WS-4.2 / dual-paper: numbering, the caret-tracked citation group, and the
  // reveal request all come through the margin host (module imports were
  // cross-pane singletons).
  import { pdfKeys, refreshPdfKeys, hasPdfIn } from "../../../../../lib/references/pdfPresence";
  import { revealReader } from "../../../../scholar/nav";
  import { fileBridge } from "../../../../../lib/project/types";

  let { host, margin }: { host: MarginHost; margin: MarginApi } = $props();
  // These STORES are created once per PaperMode mount and never swap
  // identity — capturing them off the initial host is deliberate (we want the
  // stores, not a reactive read of the host object).
  // svelte-ignore state_referenced_locally
  const citationOrdinals = host.numbering.ordinals;
  // svelte-ignore state_referenced_locally
  const citationStyle = host.numbering.style;
  // svelte-ignore state_referenced_locally
  const activeCitationGroup = host.activeCitationGroup;
  // svelte-ignore state_referenced_locally
  const refRevealReq = host.refReveal;

  let doi = $state("");
  let adding = $state(false);
  let failed = $state(false);

  // ---- per-row twirl (expanded details) + hover-card reveal handshake ------
  let rootEl = $state<HTMLDivElement>();
  let expanded = $state<Set<string>>(new Set());
  let flashKey = $state("");
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRevealN = 0;

  refreshPdfKeys();

  function toggleExpand(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  // The hover card's "References" pill lands here: untwirl the row, scroll it
  // to center, flash it. Guarded by the request counter so re-runs from our
  // own `expanded` write are inert.
  $effect(() => {
    const req = $refRevealReq;
    if (!req.n || req.n === lastRevealN || !req.key) return;
    lastRevealN = req.n;
    // Consume the request (same n, empty key) so a later manual visit to this
    // view doesn't replay a stale reveal; the guard above makes this inert.
    refRevealReq.set({ key: "", n: req.n });
    expanded = new Set(expanded).add(req.key);
    flashKey = req.key;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashKey = ""), 1800);
    void tick().then(() => {
      rootEl
        ?.querySelector(`[data-refkey="${CSS.escape(req.key)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  });

  function openDoi(d: string) {
    fileBridge()?.openExternal?.("https://doi.org/" + d);
  }

  const refs = $derived([...host.references].sort((a, b) => a.authors[0]?.localeCompare(b.authors[0] ?? "") ?? 0));
  const citedCount = $derived(refs.filter((r) => host.citedKeys.has(r.key)).length);
  // The live group under the caret — a passive card here; Alt-C / "Edit…"
  // opens the full CitationGroupPane.
  const group = $derived($activeCitationGroup);
  const byKey = $derived(new Map(host.libraryReferences.map((r) => [r.key, r])));
  function memberLabel(key: string): string {
    const r = byKey.get(key);
    if (!r) return key;
    const who = r.authors.length > 2 ? `${r.authors[0]} et al.` : r.authors.join(" & ") || key;
    return r.year ? `${who}, ${r.year}` : who;
  }

  function toggle(key: string) {
    if (host.citedKeys.has(key)) host.removeCite(key);
    else host.writeCites([key]);
  }
  function removeFromGroup(key: string) {
    if (!group) return;
    host.writeCites(
      group.keys.filter((k) => k !== key),
      { from: group.from, to: group.to },
    );
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

<div class="bib mk-pane" bind:this={rootEl}>
  <div class="head mk-row-flex">
    <span class="count mk-grow"><b class="mk-num">{refs.length}</b> reference{refs.length === 1 ? "" : "s"}<span class="dot" aria-hidden="true">·</span><span class="cited"><b class="mk-num">{citedCount}</b> cited</span></span>
    <!-- 2.2: citation-style toggle — writes `citation-style:` into the front
         matter (single-line dispatch); chips + References re-render live. -->
    <span class="style-toggle mk-seg" role="group" aria-label="Citation style">
      <button
        class="stbtn"
        class:on={$citationStyle !== "numeric"}
        title="Author–year citations: (Smith et al., 2021)"
        onclick={() => host.setCitationStyle("author-year")}>Au–Yr</button>
      <button
        class="stbtn"
        class:on={$citationStyle === "numeric"}
        title="Numbered (Vancouver) citations: [1], [2–4]"
        onclick={() => host.setCitationStyle("numeric")}>[1]</button>
    </span>
  </div>
  {#if $bibError}
    <div class="biberr" role="status">{$bibError}</div>
  {/if}

  {#if group}
    <div class="grpcard">
      <div class="grphead mk-row-flex">
        <span class="mk-eyebrow mk-grow">At the cursor · {group.keys.length}</span>
        <button class="grpedit mk-btn sm" onclick={() => margin.summon("citation-group")}>Edit…<kbd>Alt C</kbd></button>
      </div>
      <div class="grpchips">
        {#each group.keys as key (key)}
          <span class="gchip mk-chip">
            {#if $citationStyle === "numeric"}
              <b class="mk-num">[{$citationOrdinals.get(key) ?? "?"}]</b>
            {/if}
            <span class="mk-clip">{memberLabel(key)}</span>
            <button onclick={() => removeFromGroup(key)} aria-label="Remove {key} from group">✕</button>
          </span>
        {/each}
      </div>
    </div>
  {/if}

  <div class="tools">
    <button class="search" onclick={() => margin.summon("reference-search")}>
      <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.2" /><path d="M9.2 9.2l3.3 3.3" /></svg>
      <span class="mk-grow">Search references…</span><kbd>Alt R</kbd>
    </button>
    <div class="adddoi" class:failed>
      <input
        class="mk-input"
        bind:value={doi}
        placeholder="Add by DOI or URL…"
        aria-label="Add a reference by DOI or URL"
        spellcheck="false"
        oninput={() => (failed = false)}
        onkeydown={(e) => e.key === "Enter" && add()} />
      <button class="mk-btn icon" onclick={add} disabled={adding || !doi.trim()} title="Fetch this reference" aria-label="Fetch reference">{adding ? "…" : "+"}</button>
    </div>
    {#if failed}<p class="doierr" role="status">Could not resolve that DOI or URL.</p>{/if}
  </div>

  {#if refs.length === 0}
    <p class="mk-empty">No references in this project yet. Paste a DOI above, or cite one from Reference Search.</p>
  {:else}
    <ul class="list mk-list">
      {#each refs as r (r.key)}
        {@const cited = host.citedKeys.has(r.key)}
        {@const open = expanded.has(r.key)}
        <li class="ref mk-item" class:on={cited} class:flash={flashKey === r.key} data-refkey={r.key}>
          <button class="mk-dot" class:on={cited} title={cited ? "Cited: click to remove every citation of it" : "Cite at the caret"} onclick={() => toggle(r.key)} aria-label="Toggle citation" aria-pressed={cited}></button>
          <div class="body">
            <button class="t" onclick={() => toggleExpand(r.key)} aria-expanded={open}>
              <svg class="tw" class:open viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M2.5 1.2L5.8 4 2.5 6.8" /></svg>
              <span class="title">
                {#if $citationStyle === "numeric" && $citationOrdinals.get(r.key) !== undefined}
                  <span class="ord mk-num">[{$citationOrdinals.get(r.key)}]</span>
                {/if}
                {r.title || r.key}
              </span>
            </button>
            <div class="m">{r.authors.slice(0, 3).join(", ")}{r.authors.length > 3 ? " et al." : ""}{#if r.year}<span class="mk-num"> · {r.year}</span>{/if}{#if r.container}<i> · {r.container}</i>{/if}</div>
            {#if open}
              <div class="detail">
                {#if r.authors.length > 3}
                  <div class="d-authors">{r.authors.join(", ")}</div>
                {/if}
                <div class="d-actions">
                  {#if hasPdfIn($pdfKeys, r.key)}
                    <button class="d-pill mk-btn sm" onclick={() => revealReader(r.key)}>Read PDF</button>
                  {/if}
                  {#if r.doi}
                    <button class="d-doi mk-btn sm quiet" title="Open doi.org/{r.doi}" onclick={() => openDoi(r.doi!)}>DOI ↗</button>
                  {/if}
                  <code class="d-key">@{r.key}</code>
                </div>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .head {
    flex: 0 0 auto;
    min-height: calc(26px * var(--ts-scale, 1));
  }
  .count {
    color: var(--c-tx);
    font-size: var(--ts-sm);
  }
  .count b {
    font-weight: 600;
    font-size: 1em;
  }
  .cited {
    color: var(--pane-c);
  }
  .dot {
    margin: 0 6px;
    color: var(--c-tx-faint);
  }
  .biberr,
  .doierr {
    margin: 0;
    padding: 7px 10px;
    border: 1px solid color-mix(in oklab, var(--c-danger) 55%, transparent);
    border-radius: var(--r-1);
    background: color-mix(in oklab, var(--c-danger) 8%, transparent);
    color: var(--c-tx);
    font-size: var(--ts-xs);
    line-height: 1.4;
  }
  .doierr {
    padding: 4px 9px;
  }
  .grpcard {
    flex: 0 0 auto;
    display: grid;
    gap: 7px;
    padding: 8px 9px 9px;
    border: 1px solid color-mix(in oklab, var(--pane-c) 30%, var(--c-line-strong));
    border-radius: var(--r-1);
    background: var(--mk-tint);
  }
  .grpedit kbd {
    margin-left: 2px;
  }
  .grpchips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .gchip b {
    font-weight: 600;
  }
  .tools {
    flex: 0 0 auto;
    display: grid;
    gap: 7px;
  }
  /* A way into Reference Search that looks like the field it opens. */
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    height: calc(32px * var(--ts-scale, 1));
    padding: 0 8px 0 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--mk-field);
    color: var(--c-tx-faint);
    font: var(--ts-sm) var(--font-serif);
    text-align: left;
    cursor: var(--cursor-cross-hover);
    transition:
      border-color 80ms linear,
      background 80ms linear,
      color 80ms linear;
  }
  .search svg {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .search:hover {
    border-color: var(--mk-edge);
    background: var(--mk-tint);
    color: var(--c-tx-2);
  }
  .search:active {
    background: var(--mk-tint-2);
  }
  .adddoi {
    display: flex;
    gap: 6px;
  }
  .adddoi :global(.mk-input) {
    flex: 1 1 0;
    width: auto;
    min-width: 0;
  }
  .search span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search kbd {
    flex: 0 0 auto;
  }
  .adddoi.failed :global(.mk-input) {
    border-color: var(--c-danger);
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ref {
    display: grid;
    grid-template-columns: calc(24px * var(--ts-scale, 1)) minmax(0, 1fr);
    align-items: start;
    padding: calc(7px * var(--ts-scale, 1)) 9px calc(7px * var(--ts-scale, 1)) 6px;
    cursor: default;
  }
  .ref :global(.mk-dot) {
    justify-self: center;
    margin-top: calc(4px * var(--ts-scale, 1));
  }
  /* "Revealed from a citation's hover card": one flash of the pane's tint, then rest. */
  .ref.flash {
    animation: bib-flash 1500ms ease-out 1;
  }
  @keyframes bib-flash {
    0%,
    35% {
      background: var(--mk-tint-2);
      box-shadow: inset 2px 0 0 var(--pane-c);
    }
    100% {
      background: transparent;
      box-shadow: inset 2px 0 0 transparent;
    }
  }
  .body {
    min-width: 0;
  }
  .t {
    display: flex;
    align-items: baseline;
    gap: 5px;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--c-tx);
    font: var(--ts-sm) / 1.3 var(--font-serif);
    text-align: left;
    cursor: var(--cursor-cross-hover);
  }
  .t:focus-visible {
    outline: 2px solid var(--pane-c);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .tw {
    flex: 0 0 auto;
    fill: none;
    stroke: var(--c-tx-faint);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 80ms linear;
  }
  .tw.open {
    transform: rotate(90deg);
    stroke: var(--pane-c);
  }
  .t:hover .tw {
    stroke: var(--pane-c);
  }
  .title {
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .t[aria-expanded="true"] .title {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .ord {
    color: var(--pane-c);
    font-weight: 600;
    margin-right: 3px;
  }
  .m {
    margin: calc(2px * var(--ts-scale, 1)) 0 0 13px;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail {
    display: grid;
    gap: 6px;
    margin: 6px 0 2px 13px;
    animation: bib-open var(--dur-fade) linear both;
  }
  @keyframes bib-open {
    from {
      opacity: 0;
    }
  }
  .d-authors {
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    line-height: 1.4;
  }
  .d-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .d-key {
    margin-left: auto;
    padding: 1px 5px;
    border-radius: var(--r-ui);
    background: var(--c-surface);
    color: var(--c-tx-muted);
    font: calc(10.5px * var(--ts-scale, 1)) var(--font-mono);
    user-select: all;
  }
</style>
