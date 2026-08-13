<script lang="ts">
  import { onMount } from "svelte";
  import { popIn, fadeRise } from "../../../../lib/motion/actions";
  import { renderFigureSvg, type FigureRef } from "./figures";

  let {
    figures,
    canvases = [],
    onSelect,
    onClose,
  }: {
    figures: FigureRef[];
    /** Project canvas list (id + display name, canonical order) for the
     *  scope dropdown; with 0–1 canvases the dropdown is not shown. */
    canvases?: { id: string; name: string }[];
    onSelect: (ref: FigureRef) => void;
    onClose: () => void;
  } = $props();

  let query = $state("");
  let canvasSel = $state(""); // "" = all canvases
  let sel = $state(0);
  let gridEl = $state<HTMLElement | undefined>(undefined);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  // The `autofocus` attribute is unreliable on dynamically-mounted content —
  // without a real focus() the editor keeps the keyboard and eats Enter/arrows.
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

  // Focus stays in the search input; `sel` roves the grid (first cell pre-
  // selected so plain Enter inserts immediately). Up/Down move by the LIVE
  // column count; Left/Right join in when there's no query to edit.
  $effect(() => {
    void filtered;
    sel = 0;
  });
  $effect(() => {
    gridEl?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  });
  function cols(): number {
    if (!gridEl) return 1;
    return getComputedStyle(gridEl).gridTemplateColumns.split(" ").length || 1;
  }
  function move(d: number) {
    sel = Math.max(0, Math.min(filtered.length - 1, sel + d));
  }
  function onkeydown(e: KeyboardEvent) {
    // The keydown that OPENED the picker (e.g. Enter accepting the /figure
    // completion) is still bubbling when this window listener mounts — anything
    // already claimed upstream must not double-fire here.
    if (e.defaultPrevented) return;
    // The canvas dropdown owns its own keyboard when focused (native arrow/
    // Enter behavior) — only Escape still closes the picker from there.
    if (e.target instanceof HTMLSelectElement && e.key !== "Escape") return;
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
      if (filtered[sel]) onSelect(filtered[sel]);
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose} transition:fadeRise={{ y: 0 }}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="picker" onclick={(e) => e.stopPropagation()} transition:popIn>
    <header>
      <span class="ttl">Insert figure</span>
      <input
        class="search"
        placeholder="Search figures…"
        bind:this={inputEl}
        bind:value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="figpicker-grid"
        aria-activedescendant="figopt-{sel}" />
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
      <div class="grid" id="figpicker-grid" bind:this={gridEl} role="listbox" aria-label="Figures">
        {#each filtered as f, i (f.id)}
          {@const svg = renderFigureSvg(f.id)}
          <!-- Focus stays in the search input (aria-activedescendant pattern):
               options are highlighted, not focused. -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            class="cell"
            class:sel={i === sel}
            data-i={i}
            id="figopt-{i}"
            role="option"
            aria-selected={i === sel}
            onclick={() => onSelect(f)}>
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
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="empty">
        {figures.length ? "No figures match." : "This project has no figures yet."}
      </p>
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
    /* Row floor (issue #10): .cell{overflow:hidden} zeroes each item's
       automatic minimum size, so with many figures the height-constrained
       grid COMPRESSED every row to fit (30px slivers, meta clipped, no
       scrollbar ever). max-content keeps rows at full cell height so the
       content genuinely overflows and `overflow: auto` scrolls. */
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
  .empty {
    padding: var(--sp-6);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
  }
</style>
