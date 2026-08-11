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

<div class="bib" bind:this={rootEl}>
  <div class="head">
    <span class="count">{refs.length} reference{refs.length === 1 ? "" : "s"}</span>
    <span class="cited">{citedCount} cited</span>
    <!-- 2.2: citation-style toggle — writes `citation-style:` into the front
         matter (single-line dispatch); chips + References re-render live. -->
    <span class="style-toggle" role="group" aria-label="Citation style">
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
      <div class="grphead">
        <span>At cursor · {group.keys.length} ref{group.keys.length === 1 ? "" : "s"}</span>
        <button class="grpedit" onclick={() => margin.summon("citation-group")}>Edit… <kbd>Alt+C</kbd></button>
      </div>
      <div class="grpchips">
        {#each group.keys as key (key)}
          <span class="gchip">
            {#if $citationStyle === "numeric"}
              <b>[{$citationOrdinals.get(key) ?? "?"}]</b>
            {/if}
            {memberLabel(key)}
            <button onclick={() => removeFromGroup(key)} aria-label="Remove {key} from group">✕</button>
          </span>
        {/each}
      </div>
    </div>
  {/if}

  <button class="search" onclick={() => margin.summon("reference-search")}>Search references…</button>

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
        <li class="ref" class:on={host.citedKeys.has(r.key)} class:flash={flashKey === r.key} data-refkey={r.key}>
          <button class="dot" title={host.citedKeys.has(r.key) ? "Cited — click to remove" : "Click to cite"} onclick={() => toggle(r.key)} aria-label="Toggle citation"></button>
          <div class="body">
            <button class="t" onclick={() => toggleExpand(r.key)} aria-expanded={expanded.has(r.key)}>
              <span class="tw" class:open={expanded.has(r.key)}>▸</span>
              {#if $citationStyle === "numeric" && $citationOrdinals.get(r.key) !== undefined}
                <span class="ord">[{$citationOrdinals.get(r.key)}]</span>
              {/if}
              {r.title || r.key}
            </button>
            <div class="m">{r.authors.slice(0, 3).join(", ")}{r.authors.length > 3 ? " et al." : ""}{r.year ? ` · ${r.year}` : ""}{r.container ? ` · ${r.container}` : ""}</div>
            {#if expanded.has(r.key)}
              <div class="detail">
                {#if r.authors.length > 3}
                  <div class="d-authors">{r.authors.join(", ")}</div>
                {/if}
                {#if r.doi}
                  <button class="d-doi" onclick={() => openDoi(r.doi!)}>doi.org/{r.doi}</button>
                {/if}
                <div class="d-actions">
                  {#if hasPdfIn($pdfKeys, r.key)}
                    <button class="d-pill" onclick={() => revealReader(r.key)}>Read PDF</button>
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
    gap: 8px;
    font-size: var(--ts-sm);
  }
  .style-toggle {
    display: inline-flex;
    border: 1px solid var(--c-line);
    border-radius: var(--r-pill);
    overflow: hidden;
  }
  .stbtn {
    background: none;
    border: none;
    font: inherit;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    padding: 1px 8px;
    cursor: pointer;
  }
  .stbtn.on {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .count {
    color: var(--c-tx);
    font-weight: 600;
  }
  .cited {
    color: var(--c-accent-bright);
  }
  .biberr {
    font-size: var(--ts-xs);
    line-height: 1.4;
    padding: 7px 10px;
    border: 1px solid var(--c-danger);
    border-radius: var(--r-1);
    background: color-mix(in srgb, var(--c-danger) 12%, transparent);
    color: var(--c-tx);
  }
  .grpcard {
    border: 1px solid var(--c-accent);
    border-radius: var(--r-2);
    padding: var(--sp-2) var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    background: var(--c-surface);
  }
  .grphead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .grpedit {
    font: inherit;
    font-size: var(--ts-xs);
    text-transform: none;
    letter-spacing: 0;
    background: none;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    color: var(--c-tx-2);
    padding: 2px 7px;
    cursor: pointer;
  }
  .grpedit:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .grpedit kbd {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--c-tx-faint);
  }
  .grpchips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .gchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 4px 2px 9px;
    font-size: var(--ts-xs);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: var(--r-pill);
  }
  .gchip b {
    font-variant-numeric: tabular-nums;
  }
  .gchip button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
    font-size: 10px;
    padding: 0 2px;
  }
  .gchip button:hover {
    opacity: 1;
  }
  .ord {
    color: var(--c-accent-bright);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
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
    border-radius: var(--r-1);
    transition: background 600ms ease;
  }
  .ref.flash {
    background: var(--c-accent-tint);
    transition: none;
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
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: var(--ts-sm);
    color: var(--c-tx);
    line-height: 1.35;
  }
  .tw {
    display: inline-block;
    width: 0.9em;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    transition: transform var(--dur-quick, 120ms) ease;
  }
  .tw.open {
    transform: rotate(90deg);
  }
  .m {
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    margin-top: 2px;
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
    padding: var(--sp-2) 0 2px var(--sp-2);
    border-left: 2px solid var(--c-line);
  }
  .d-authors {
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    line-height: 1.4;
  }
  .d-doi {
    background: none;
    border: none;
    padding: 0;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    text-align: left;
    color: var(--c-accent-bright);
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
    cursor: pointer;
    text-decoration: underline;
  }
  .d-actions {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 3px var(--sp-2);
  }
  .d-pill {
    font: inherit;
    font-size: var(--ts-xs);
    line-height: 1.5;
    padding: 1px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
  }
  .d-pill:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .d-key {
    margin-left: auto;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    color: var(--c-tx-faint);
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
  }
</style>
