<script lang="ts">
  import { onMount, tick } from "svelte";
  import { popIn, fadeRise } from "../../../../lib/motion/actions";
  import { renderFigureSvg, resolveFigure, figRefText, type FigureRef } from "./figures";

  let {
    figures,
    canvases = [],
    nums,
    onInsert,
    onClose,
  }: {
    figures: FigureRef[];
    /** Project canvas list (id + display name, canonical order) for the
     *  scope dropdown; with 0–1 canvases the dropdown is not shown. */
    canvases?: { id: string; name: string }[];
    /** WS-4.2: the owning editor's numbering instance (tbl/eq cross-refs). */
    nums?: import("./numberingFacet").PaperNumbering;
    /** Called with the full reference text to insert, e.g. "@fig-x-a,c". */
    onInsert: (text: string) => void;
    onClose: () => void;
  } = $props();

  // Stage 1 mirrors FigurePicker (search + roving grid); stage 2 is the panel
  // multi-select for the chosen figure. Both stay fully keyboard-driven.
  let stage = $state<"figure" | "panels">("figure");
  let query = $state("");
  let canvasSel = $state(""); // "" = all canvases
  let sel = $state(0);
  let gridEl = $state<HTMLElement | undefined>(undefined);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let panelsEl = $state<HTMLElement | undefined>(undefined);

  let fig = $state<FigureRef | null>(null);
  let hl = $state(0); // focus ring over the panel pills
  let picked = $state<Set<string>>(new Set());

  // `autofocus` is unreliable on dynamically-mounted content (see FigurePicker).
  onMount(() => inputEl?.focus());

  // Canvas scope narrows FIRST, then the text query searches within it.
  const scoped = $derived(canvasSel ? figures.filter((f) => f.canvas === canvasSel) : figures);
  const filtered = $derived(
    query.trim()
      ? scoped.filter((f) =>
          (f.name + " " + (f.nickname ?? "") + " " + f.label + " " + f.caption)
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : scoped,
  );
  $effect(() => {
    void filtered;
    sel = 0;
  });
  $effect(() => {
    gridEl?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  });

  // What Enter will insert, resolved live through the same registry the chips
  // use — the previewed text IS the text the chip will show ("Fig. S4a–c").
  const resultText = $derived(fig ? figRefText(fig, picked) : "");
  const resultDisplay = $derived(
    fig ? (resolveFigure(resultText.slice(1), nums)?.display ?? fig.display) : "",
  );

  function cols(): number {
    if (!gridEl) return 1;
    return getComputedStyle(gridEl).gridTemplateColumns.split(" ").length || 1;
  }
  function move(d: number) {
    sel = Math.max(0, Math.min(filtered.length - 1, sel + d));
  }

  function choose(f: FigureRef) {
    if (f.panels.length) {
      fig = f;
      picked = new Set();
      hl = 0;
      stage = "panels";
      // Letters must toggle pills, not type into the search box.
      void tick().then(() => panelsEl?.focus());
    } else {
      onInsert("@" + f.label); // no known panels — whole figure, done
    }
  }
  function backToFigures() {
    stage = "figure";
    fig = null;
    void tick().then(() => inputEl?.focus());
  }
  function togglePanel(p: string) {
    const next = new Set(picked);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    picked = next;
  }

  function onkeydown(e: KeyboardEvent) {
    // The keydown that OPENED the picker (e.g. Enter accepting /cross-reference)
    // is still bubbling when this window listener mounts.
    if (e.defaultPrevented) return;
    // The canvas dropdown owns its own keyboard when focused (native arrow/
    // Enter behavior) — only Escape still closes the picker from there.
    if (e.target instanceof HTMLSelectElement && e.key !== "Escape") return;
    if (stage === "figure") {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        move(cols());
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-cols());
      } else if (e.key === "ArrowRight" && !query) {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowLeft" && !query) {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[sel]) choose(filtered[sel]);
      }
      return;
    }
    // ---- panels stage ------------------------------------------------------
    if (!fig) return;
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      backToFigures();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      hl = Math.min(fig.panels.length - 1, hl + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      hl = Math.max(0, hl - 1);
    } else if (e.key === " ") {
      e.preventDefault();
      togglePanel(fig.panels[hl]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onInsert(resultText);
    } else if (/^[a-z0-9]$/.test(e.key)) {
      // Direct toggle: press the panel's own letter. Where panels are sub-numbered
      // (b1..b5) a bare letter cannot name one, so it moves the highlight to that
      // letter's first panel instead of toggling — arrows/space then pick within it.
      const exact = fig.panels.indexOf(e.key);
      if (exact >= 0) {
        e.preventDefault();
        togglePanel(e.key);
        hl = exact;
      } else {
        const first = fig.panels.findIndex((p) => p.startsWith(e.key));
        if (first >= 0) {
          e.preventDefault();
          hl = first;
        }
      }
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose} transition:fadeRise={{ y: 0 }}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="picker" onclick={(e) => e.stopPropagation()} transition:popIn>
    {#if stage === "figure"}
      <header>
        <span class="ttl">Reference a figure</span>
        <input
          class="search"
          placeholder="Search figures…"
          bind:this={inputEl}
          bind:value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="figref-grid"
          aria-activedescendant="figrefopt-{sel}" />
        {#if canvases.length > 1}
          <select
            class="canvas-scope"
            bind:value={canvasSel}
            aria-label="Limit to canvas"
            title="Limit to one canvas">
            <option value="">All canvases</option>
            {#each canvases as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
        {/if}
      </header>
      {#if filtered.length}
        <div class="grid" id="figref-grid" bind:this={gridEl} role="listbox" aria-label="Figures">
          {#each filtered as f, i (f.id)}
            {@const svg = renderFigureSvg(f.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
            <div
              class="cell"
              class:sel={i === sel}
              data-i={i}
              id="figrefopt-{i}"
              role="option"
              aria-selected={i === sel}
              onclick={() => choose(f)}>
              <div class="thumb">
                {#if svg}
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  {@html svg}
                {:else}
                  <span class="ph">no preview</span>
                {/if}
              </div>
              <div class="meta">
                <b>{f.display}</b>
                {#if f.nickname}<span class="nm">{f.nickname}</span>{/if}
                {#if f.panels.length}
                  <span class="pcount">{f.panels.length} panels</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty">
          {figures.length ? "No figures match." : "This project has no figures yet."}
        </p>
      {/if}
    {:else if fig}
      <header>
        <button class="back" onclick={backToFigures} title="Back to figures (Esc)">‹</button>
        <span class="ttl">{fig.display}</span>
        {#if fig.nickname}<span class="nm hd">{fig.nickname}</span>{/if}
      </header>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="panelstage" bind:this={panelsEl} tabindex="-1">
        <div class="pv">
          {#if renderFigureSvg(fig.id)}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderFigureSvg(fig.id)}
          {:else}
            <span class="ph">no preview</span>
          {/if}
        </div>
        <div class="pills" role="listbox" aria-label="Panels" aria-multiselectable="true">
          {#each fig.panels as p, i (p)}
            <button
              class="pill"
              class:on={picked.has(p)}
              class:hl={i === hl}
              role="option"
              aria-selected={picked.has(p)}
              onclick={() => {
                togglePanel(p);
                hl = i;
              }}>
              {p}
            </button>
          {/each}
        </div>
        <div class="foot">
          <span class="will">
            Insert <b class="chip">{resultDisplay}</b>
            {#if picked.size === 0}<span class="whole">— whole figure</span>{/if}
          </span>
          <span class="keys"><kbd>a</kbd>–<kbd>z</kbd>/<kbd>Space</kbd> toggle · <kbd>↵</kbd> insert · <kbd>Esc</kbd> back</span>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--c-bg) 62%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 80;
  }
  .picker {
    width: min(680px, 86%);
    max-height: 78%;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-3);
    box-shadow: var(--elev-3);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--c-line);
  }
  .ttl {
    font-weight: 600;
    color: var(--c-tx-hi);
    white-space: nowrap;
  }
  .back {
    background: none;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    color: var(--c-tx-2);
    width: 26px;
    height: 26px;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .back:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .search {
    flex: 1;
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 6px 10px;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
  }
  .search:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .canvas-scope {
    flex: 0 0 auto;
    max-width: 180px;
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 6px 8px;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
  }
  .canvas-scope:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    /* Row floor (issue #10, FigurePicker's twin): without it a
       height-constrained grid compresses every row to fit instead of
       overflowing — cells clip to slivers and the scrollbar never appears. */
    grid-auto-rows: max-content;
    align-content: start;
    gap: var(--sp-3);
    padding: var(--sp-4);
    overflow: auto;
  }
  .cell {
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    overflow: hidden;
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 120ms) ease,
      transform var(--dur-quick, 120ms) ease;
    background: var(--c-bg);
  }
  .cell:hover {
    border-color: var(--c-accent);
    transform: translateY(-2px);
  }
  .cell.sel {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 1px var(--c-accent);
  }
  .thumb {
    height: 120px;
    background: var(--flx-paper, #fdfcfa);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 8px;
  }
  .thumb :global(svg) {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    width: auto;
  }
  .ph {
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    font-style: italic;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    padding: 8px 10px;
    border-top: 1px solid var(--c-line);
  }
  .meta b {
    color: var(--c-accent-bright);
  }
  .nm {
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nm.hd {
    flex: 1;
    min-width: 0;
  }
  .pcount {
    margin-left: auto;
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
    white-space: nowrap;
  }
  .empty {
    padding: var(--sp-6);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .panelstage {
    display: flex;
    flex-direction: column;
    min-height: 0;
    outline: none;
  }
  .pv {
    background: var(--flx-paper, #fdfcfa);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: var(--sp-3);
    max-height: 320px;
  }
  .pv :global(svg) {
    max-width: 100%;
    max-height: 290px;
    height: auto;
    width: auto;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--c-line);
  }
  .pill {
    min-width: 34px;
    height: 30px;
    padding: 0 10px;
    font: inherit;
    font-size: var(--ts-sm);
    font-weight: 600;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: var(--c-bg);
    color: var(--c-tx-2);
    cursor: pointer;
    transition:
      background var(--dur-quick, 120ms) ease,
      border-color var(--dur-quick, 120ms) ease;
  }
  .pill:hover {
    border-color: var(--c-accent);
  }
  .pill.hl {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 55%, transparent);
  }
  .pill.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent, #fff);
  }
  .foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4) var(--sp-3);
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
  }
  .will .chip {
    display: inline-block;
    padding: 1px 8px;
    border-radius: var(--r-pill);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    font-weight: 600;
  }
  .whole {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .keys kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    border: 1px solid var(--c-line);
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 0 4px;
    background: var(--c-bg);
  }
</style>
