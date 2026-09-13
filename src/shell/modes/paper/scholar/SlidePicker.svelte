<script lang="ts">
  import { onMount } from "svelte";
  import type { SlideRepository, EmbedDeckRow } from "../../../../lib/slide/embedRepository";
  import type { Deck } from "../../../../lib/slide/types";
  import SlideEmbedThumb from "./SlideEmbedThumb.svelte";
  let { repository, onSelect, onClose }: { repository: SlideRepository; onSelect: (deck: string, slide: string) => Promise<void>; onClose: () => void } = $props();
  let decks = $state<EmbedDeckRow[]>([]), deck = $state<Deck | null>(null), query = $state(""), selected = $state(0), scroll = $state(0), busy = $state(false), error = $state("");
  let input: HTMLInputElement, grid: HTMLDivElement;
  let width = $state(600), height = $state(400), alive = true, ticket = 0;
  const columns = $derived(deck ? Math.max(1, Math.floor(width / 185)) : 1);
  const rowH = $derived(deck ? 176 : 48);
  const rows = $derived(deck ? deck.slides.map((s, i) => ({ id: s.id, title: s.name || `Slide ${i + 1}`, detail: `Slide ${i + 1} · ${Math.max(0, s.beats.length - 1)} steps`, steps: Math.max(0, s.beats.length - 1) })) : decks.map(d => ({ id: d.id, title: d.title, detail: d.error || (d.count == null ? "Deck" : `${d.count} slides`), steps: 0 })));
  const filtered = $derived(rows.filter(r => `${r.title} ${r.detail}`.toLowerCase().includes(query.toLowerCase())));
  const first = $derived(Math.max(0, Math.floor(scroll / rowH) - 1) * columns);
  const last = $derived(Math.min(filtered.length, first + (Math.ceil(height / rowH) + 3) * columns));
  $effect(() => { void query; void deck; selected = 0; scroll = 0; if (grid) grid.scrollTop = 0; });
  onMount(() => {
    input?.focus();
    void repository.list().then(async list => {
      if (!alive) return; decks = list;
      // Metadata streams in; the picker opens before reading every deck.
      let at = 0;
      const worker = async () => { while (alive && at < list.length) { const d = list[at++]; try { const model = await repository.deck(d.id); if (alive) decks = decks.map(r => r.id === d.id ? { ...r, title: model.title, count: model.slides.length } : r); } catch (e) { if (alive) decks = decks.map(r => r.id === d.id ? { ...r, error: String((e as Error).message) } : r); } } };
      await Promise.all([worker(), worker()]);
    }).catch(e => error = String(e.message || e));
    return () => { alive = false; ticket++; };
  });
  async function choose(index: number) {
    const row = filtered[index]; if (!row || busy) return;
    const generation = ++ticket; error = ""; busy = true;
    try {
      if (deck) await onSelect(deck.id, row.id);
      else { const d = await repository.deck(row.id); if (alive && generation === ticket) { deck = d; query = ""; input.focus(); } }
    } catch (e) { if (alive && generation === ticket) error = String((e as Error).message || e); }
    finally { if (alive && generation === ticket) busy = false; }
  }
  function key(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === "Tab") {
      const dialog = (e.currentTarget as HTMLElement).querySelector(".slide-picker")!;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),input")];
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      return;
    }
    if (e.key === "Enter" && e.target instanceof HTMLButtonElement) { e.stopPropagation(); return; }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void choose(selected); return; }
    const delta = e.key === "ArrowDown" ? columns : e.key === "ArrowUp" ? -columns : !query && e.key === "ArrowRight" ? 1 : !query && e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return; e.preventDefault(); e.stopPropagation(); selected = Math.max(0, Math.min(filtered.length - 1, selected + delta));
    const y = Math.floor(selected / columns) * rowH;
    if (y < grid.scrollTop) grid.scrollTop = y;
    else if (y + rowH > grid.scrollTop + height) grid.scrollTop = y + rowH - height;
  }
</script>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="slide-picker-scrim" onkeydown={key}>
  <div tabindex="-1" class="slide-picker" role="dialog" aria-modal="true" aria-label="Insert slide">
    <header>
      {#if deck}<button onclick={() => { ticket++; busy = false; deck = null; query = ""; input.focus(); }} aria-label="Back to decks">‹ Decks</button>{/if}
      <b>{deck ? deck.title : "Insert slide · Choose a deck"}</b>
      <button onclick={onClose} aria-label="Close slide picker">×</button>
    </header>
    <input bind:this={input} bind:value={query} placeholder={deck ? "Search slides…" : "Search decks…"} aria-label={deck ? "Search slides" : "Search decks"} />
    <p>{deck ? "Choose a slide. It will start at step 0 in your document." : "Select the deck containing your slide."}</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="grid" bind:this={grid} bind:clientWidth={width} bind:clientHeight={height} onscroll={() => scroll = grid.scrollTop} aria-busy={busy}>
      <div style={`height:${Math.ceil(filtered.length / columns) * rowH}px;position:relative`}>
        {#each filtered.slice(first, last) as row, offset (row.id)}
          {@const index = first + offset}
          <button class="card" class:selected={selected === index} style={`position:absolute;left:${index % columns * 100 / columns}%;top:${Math.floor(index / columns) * rowH}px;width:calc(${100 / columns}% - 6px);height:${rowH - 8}px`} disabled={busy} onclick={() => { selected = index; void choose(index); }} aria-label={row.title}>
            {#if deck}<SlideEmbedThumb {repository} deckId={deck.id} slideId={row.id} steps={row.steps} />{/if}
            <b>{row.title}</b><small>{row.detail}</small>
          </button>
        {/each}
      </div>
      {#if !filtered.length}<p>{query ? "No matches." : deck ? "This deck has no slides." : "This project has no decks yet."}</p>{/if}
    </div>
  </div>
</div>
<style>
  .slide-picker-scrim{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--c-bg) 65%,transparent);z-index:85}
  .slide-picker{width:min(680px,90%);height:min(620px,85%);display:flex;flex-direction:column;background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:12px;padding:14px;box-shadow:var(--elev-3);gap:10px;color:var(--c-tx)}
  header{display:flex;align-items:center;gap:10px}header b{flex:1}header button{background:transparent;border:1px solid var(--c-line);border-radius:5px;padding:4px 8px;cursor:pointer}button,input{font:inherit;color:inherit}input{background:var(--c-bg);padding:8px;border:1px solid var(--c-line);border-radius:4px}p{margin:0;font-size:var(--ts-sm);color:var(--c-tx-2)}.error{color:var(--c-danger)}
  .grid{flex:1;min-height:0;overflow:auto}.card{display:flex;flex-direction:column;padding:3px 7px;text-align:left;background:var(--c-bg);border:1px solid var(--c-line);border-radius:5px;overflow:hidden;cursor:pointer}.card.selected,.card:hover{border-color:var(--c-accent)}.card b,.card small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-size:var(--ts-sm)}.card small{font-size:var(--ts-xs);color:var(--c-tx-2)}.card :global(.slide-thumb){width:100%;flex-shrink:0}
</style>
