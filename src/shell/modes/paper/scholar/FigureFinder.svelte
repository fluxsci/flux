<script lang="ts">
  // Find a figure: a search, an optional canvas scope, and a grid of small cells you walk with
  // the arrows. One finder for both pickers over the manuscript (`@@` cites a figure, `/figure`
  // places one), built on the margin kit so it reads like the Figures card. The focus stays in
  // the search (aria-activedescendant): cells are highlighted, never focused.
  import { onMount } from "svelte";
  import { figureThumb, type FigureRef } from "./figures";

  let { figures, canvases = [], query = $bindable(""), canvas = $bindable(""), gridId, optionPrefix, note = "", onChoose }: {
    figures: FigureRef[];
    /** Project canvases (id + name, canonical order); the scope shows only with more than one. */
    canvases?: { id: string; name: string }[];
    /** Held by the picker, so going on to a figure's panels and back keeps what you typed. */
    query?: string;
    canvas?: string;
    gridId: string;
    optionPrefix: string;
    /** One quiet line under the grid. */
    note?: string;
    onChoose: (figure: FigureRef) => void;
  } = $props();

  let sel = $state(0);
  let gridEl = $state<HTMLElement | undefined>(undefined);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  // `autofocus` is unreliable on dynamically mounted content: without a real focus() the editor
  // keeps the keyboard and eats Enter and the arrows.
  onMount(() => inputEl?.focus());
  export function focus() { inputEl?.focus(); }

  // Canvas scope narrows FIRST, then the text query searches within it.
  const scoped = $derived(canvas ? figures.filter((f) => f.canvas === canvas) : figures);
  const filtered = $derived(
    query.trim()
      ? scoped.filter((f) => (f.name + " " + (f.nickname ?? "") + " " + f.label + " " + f.caption).toLowerCase().includes(query.toLowerCase()))
      : scoped,
  );
  $effect(() => { void filtered; sel = 0; });
  $effect(() => { gridEl?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); });
  const canvasName = (id: string) => canvases.find((c) => c.id === id)?.name ?? id;

  function cols(): number {
    if (!gridEl) return 1;
    return getComputedStyle(gridEl).gridTemplateColumns.split(" ").length || 1;
  }
  function move(d: number) { sel = Math.max(0, Math.min(filtered.length - 1, sel + d)); }
  /** The picker's key handler passes its keys here; true when one was used. Up/Down move by the
   *  LIVE column count; Left/Right join in when there is no query to edit. */
  export function handleKey(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") move(cols());
    else if (e.key === "ArrowUp") move(-cols());
    else if (e.key === "ArrowRight" && !query) move(1);
    else if (e.key === "ArrowLeft" && !query) move(-1);
    else if (e.key === "Enter") { if (filtered[sel]) onChoose(filtered[sel]); }
    else return false;
    e.preventDefault();
    return true;
  }
</script>

<div class="finder mk-pane">
  <div class="bar">
    <input
      class="search mk-input"
      placeholder="Search figures…"
      spellcheck="false"
      bind:this={inputEl}
      bind:value={query}
      role="combobox"
      aria-expanded="true"
      aria-controls={gridId}
      aria-activedescendant="{optionPrefix}{sel}" />
    {#if canvases.length > 1}
      <select class="canvas-scope mk-select" bind:value={canvas} aria-label="Limit to canvas" title="Limit to one canvas">
        <option value="">All canvases</option>
        {#each canvases as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select>
    {/if}
  </div>
  {#if filtered.length}
    <div class="grid" id={gridId} bind:this={gridEl} role="listbox" aria-label="Figures">
      {#each filtered as f, i (f.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <div
          class="cell"
          class:sel={i === sel}
          data-i={i}
          id="{optionPrefix}{i}"
          role="option"
          aria-selected={i === sel}
          title={`${f.nickname ? `${f.name}: ${f.nickname}` : f.name} · @${f.label}${canvases.length > 1 ? ` · ${canvasName(f.canvas)}` : ""}`}
          onclick={() => onChoose(f)}>
          <div class="thumb"><div class="art">
            {#if f.id}<img use:figureThumb={f.id} alt="" draggable="false" />{:else}<span class="ph">no preview</span>{/if}
          </div></div>
          <div class="meta">
            <b class="mk-clip">{f.nickname || f.name}</b>
            <span class="line"><span class="designation">{f.display}</span>{#if f.panels.length}<span class="pcount">{f.panels.length} panel{f.panels.length === 1 ? "" : "s"}</span>{/if}{#if canvases.length > 1 && !canvas}<span class="nm mk-clip">{canvasName(f.canvas)}</span>{/if}</span>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty mk-empty">{figures.length ? "No figures match." : "This project has no figures yet."}</p>
  {/if}
  <div class="mk-foot">
    <span class="mk-hint mk-grow"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd>move<span class="sep">·</span><kbd>↵</kbd>choose<span class="sep">·</span><kbd>Esc</kbd>close</span>
    {#if note}<span class="note">{note}</span>{/if}
  </div>
</div>

<style>
  /* As tall as its figures need, up to the picker's limit; then the GRID scrolls, and the search
     and the keys stay where they are. */
  .finder {
    flex: 0 1 auto;
    height: auto;
    min-height: 0;
  }
  .bar {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
  }
  .search {
    flex: 1 1 auto;
    min-width: 0;
  }
  .canvas-scope {
    flex: 0 1 150px;
    min-width: 0;
    width: auto;
  }
  /* Small cells, four to a row at the picker's width: a thumbnail on white, then its name. */
  .grid {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(128px * var(--ts-scale, 1)), 1fr));
    grid-auto-rows: max-content;
    gap: 7px;
    overflow: auto;
    /* room for the chosen cell's ring */
    padding: 3px;
    margin: -3px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklab, var(--c-tx) 22%, transparent) transparent;
  }
  .cell {
    display: grid;
    grid-template-rows: auto auto;
    min-width: 0;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: #fff;
    cursor: var(--cursor-cross-hover);
    transition:
      border-color 80ms linear,
      box-shadow 80ms linear,
      transform 60ms linear;
  }
  .cell:hover {
    border-color: var(--mk-edge);
  }
  .cell:active {
    transform: scale(0.985);
  }
  /* "This one": the pane's ink as an edge and a ring (the Figures card's own treatment). */
  .cell.sel {
    border-color: var(--pane-c);
    box-shadow: 0 0 0 2px var(--mk-ring);
  }
  /* A 4:3 window whatever the picture's own size: the height is the WIDTH's three quarters (a
     percentage padding), and the picture is laid inside it, so a large or unloaded image can
     never set the cell's size. */
  .thumb {
    position: relative;
    height: 0;
    padding-bottom: 75%;
  }
  .art {
    position: absolute;
    inset: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    pointer-events: none;
  }
  /* A thumbnail still being drawn: hide the broken-picture box and hatch its frame instead. */
  .thumb img:global([data-figure-state="pending"]) {
    visibility: hidden;
  }
  .thumb img:global([data-figure-state="ready"]) {
    animation: finder-arrive var(--dur-fade) linear both;
  }
  @keyframes finder-arrive {
    from {
      opacity: 0;
    }
  }
  .art:has(img:global([data-figure-state="pending"]))::after {
    content: "";
    position: absolute;
    inset: 18%;
    border-radius: var(--r-ui);
    background: repeating-linear-gradient(135deg, var(--c-line) 0 1px, transparent 1px 7px);
    opacity: 0.9;
  }
  .thumb img:global([data-figure-state="missing"]),
  .ph {
    font: italic var(--ts-xs) var(--font-serif);
    color: var(--c-tx-faint);
  }
  .meta {
    display: grid;
    gap: 2px;
    min-width: 0;
    padding: 5px 7px 6px;
    border-top: 1px solid var(--c-line);
    background: var(--mk-field);
    border-radius: 0 0 var(--r-1) var(--r-1);
  }
  .meta b {
    font: 600 var(--ts-xs) / 1.3 var(--font-serif);
    color: var(--c-tx);
  }
  .cell.sel .meta b {
    color: var(--pane-c);
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
    font: calc(9.5px * var(--ts-scale, 1)) / 1.3 var(--font-mono);
    color: var(--c-tx-faint);
    white-space: nowrap;
  }
  .designation {
    flex: 0 0 auto;
    color: var(--pane-c);
  }
  .pcount {
    flex: 0 0 auto;
  }
  .nm {
    min-width: 0;
  }
  .empty {
    padding: 22px 0;
  }
  .note {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: italic var(--ts-xs) var(--font-serif);
    color: var(--c-tx-faint);
  }
  @media (prefers-reduced-motion: reduce) {
    .cell {
      transition: none;
    }
    .thumb img:global([data-figure-state="ready"]) {
      animation: none;
    }
  }
</style>
