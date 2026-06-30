<script lang="ts">
  // flux-slide: the Slide mode (the 4th pillar). P0 = the spine: load/round-trip
  // a deck, a filmstrip + a faithfully-scaled themed stage preview, and the
  // ops-driven add-slide / add-text affordances. The real WYSIWYG stage editor
  // (selection/drag/resize) + the player land in P1/P2; this preview is the
  // precursor that proves the deck model end-to-end. Persistence mirrors
  // FigureMode (debounced autosave on a dirty store, flush on destroy, keyboard
  // gated on `focused`).
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { projectModel } from "../../shellStore";
  import {
    deck as deckStore,
    deckDirty,
    activeSlideId,
    activeBeat,
    loadDeckModel,
    commitDeck,
    clearDeck,
  } from "../../../lib/slide/store";
  import {
    listProjectDecks,
    loadDeckInto,
    saveDeckFrom,
    createDeckInProject,
    type DeckListItem,
  } from "../../../lib/project/slideBridge";
  import {
    createDeck as createDeckModel,
    addSlide,
    addTextBox,
    deleteSlide as opDeleteSlide,
    slideById,
  } from "../../../lib/slide/ops";
  import { resolveTheme, themeCssVars } from "../../../lib/slide/theme";
  import SlideStagePreview from "./SlideStagePreview.svelte";

  let { focused = true }: { focused?: boolean } = $props();

  const pm = get(projectModel); // the loaded Flux project (or null on web/demo)
  let ready = $state(false);
  let decks = $state<DeckListItem[]>([]);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubDirty: (() => void) | undefined;

  // Reactive views of the live deck + cursor.
  const deck = $derived($deckStore);
  const activeSlide = $derived(
    deck && $activeSlideId ? slideById(deck, $activeSlideId) : deck?.slides[0] ?? null,
  );
  const theme = $derived(resolveTheme(deck?.theme));

  onMount(async () => {
    try {
      if (pm) {
        decks = await listProjectDecks(pm.root);
        if (decks.length) await loadDeckInto(pm.root, decks[0].id);
        else await createDeckInProject(pm.root, { title: pm.manifest.title });
        decks = await listProjectDecks(pm.root);
        // Resilience: if the bridge hiccupped, still render an in-memory deck.
        if (!get(deckStore)) loadDeckModel(createDeckModel({ title: pm.manifest.title }));
      } else {
        // Web/demo fallback: an in-memory deck so the mode is demoable.
        loadDeckModel(createDeckModel({ title: "Demo Deck" }));
      }
    } catch (e) {
      console.error("SlideMode: deck load failed, using in-memory deck", e);
      loadDeckModel(createDeckModel({ title: pm?.manifest.title ?? "Demo Deck" }));
    }
    ready = true;

    // Autosave to slides/<id>/deck.json whenever the deck is marked dirty (debounced).
    unsubDirty = deckDirty.subscribe((d) => {
      if (!ready || !pm || !d) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await saveDeckFrom(pm.root);
        decks = await listProjectDecks(pm.root);
      }, 700);
    });
  });

  onDestroy(() => {
    unsubDirty?.();
    clearTimeout(saveTimer);
    if (pm && get(deckDirty)) void saveDeckFrom(pm.root); // flush
    clearDeck();
  });

  function selectSlide(id: string) {
    activeSlideId.set(id);
    activeBeat.set(0);
  }

  function onAddSlide() {
    const d = get(deckStore);
    if (!d) return;
    let newId = "";
    commitDeck((dd) => {
      const s = addSlide(dd, { name: `Slide ${dd.slides.length + 1}`, layout: "content-figure" });
      newId = s.id;
    });
    if (newId) selectSlide(newId);
  }

  function onAddText() {
    const sid = $activeSlideId ?? activeSlide?.id;
    if (!sid) return;
    commitDeck((dd) =>
      addTextBox(dd, sid, {
        text: "New text",
        x: 120,
        y: 120,
        width: 600,
        height: 120,
        fontSize: 40,
      }),
    );
  }

  function onDeleteSlide(id: string) {
    const d = get(deckStore);
    if (!d || d.slides.length <= 1) return;
    let next: string | null = null;
    commitDeck((dd) => {
      next = opDeleteSlide(dd, id).nextActiveId;
    });
    if (next) selectSlide(next);
  }

  function onTitleInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    commitDeck((dd) => {
      dd.title = v;
    });
  }

  // Slide nav with arrows (gated on focus so it doesn't fire from other panes).
  function onKey(e: KeyboardEvent) {
    if (!focused || !deck) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const i = deck.slides.findIndex((s) => s.id === $activeSlideId);
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const n = deck.slides[Math.min(deck.slides.length - 1, i + 1)];
      if (n) selectSlide(n.id);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = deck.slides[Math.max(0, i - 1)];
      if (n) selectSlide(n.id);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="slide-mode">
  <!-- Deck bar -->
  <header class="deckbar">
    <div class="left">
      <span class="pillar">Slide</span>
      {#if deck}
        <input
          class="title"
          value={deck.title}
          oninput={onTitleInput}
          spellcheck="false"
          aria-label="Deck title" />
      {/if}
    </div>
    <div class="right">
      <button class="btn" onclick={onAddText} disabled={!activeSlide}>+ Text</button>
      <button class="btn" onclick={onAddSlide} disabled={!deck}>+ Slide</button>
      <span class="dirty" class:on={$deckDirty} title="Unsaved changes">●</span>
    </div>
  </header>

  <div class="body">
    <!-- Filmstrip -->
    <aside class="filmstrip">
      {#if deck}
        {#each deck.slides as s, i (s.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="thumb"
            class:active={s.id === ($activeSlideId ?? activeSlide?.id)}
            onclick={() => selectSlide(s.id)}>
            <span class="n">{i + 1}</span>
            <div class="mini">
              <SlideStagePreview slide={s} {theme} stage={deck.stage} interactive={false} />
            </div>
            <span class="nm">{s.name ?? `Slide ${i + 1}`}</span>
            {#if deck.slides.length > 1}
              <button class="del" title="Delete slide" aria-label="Delete slide"
                onclick={(e) => { e.stopPropagation(); onDeleteSlide(s.id); }}>×</button>
            {/if}
          </div>
        {/each}
        <button class="addslide" onclick={onAddSlide}>+ Add slide</button>
      {/if}
    </aside>

    <!-- Stage -->
    <main class="stage-wrap">
      {#if ready && deck && activeSlide}
        <div class="stage-viewport">
          <SlideStagePreview
            slide={activeSlide}
            {theme}
            stage={deck.stage}
            interactive={true} />
        </div>
        <div class="beatbar">
          <span class="bl">Beats</span>
          {#each activeSlide.beats as b, bi (b.id)}
            <span class="beat" class:cur={bi === $activeBeat} title={b.label ?? `beat ${bi}`}>{bi}</span>
          {/each}
        </div>
      {:else if ready && deck}
        <div class="empty">This deck has no slides. <button class="btn" onclick={onAddSlide}>Add one</button></div>
      {:else}
        <div class="empty">Loading deck…</div>
      {/if}
    </main>
  </div>
</div>

<style>
  .slide-mode {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--c-bg);
    color: var(--c-tx);
    overflow: hidden;
  }
  .deckbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--sp-3);
    padding: 8px 14px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-bg-raised);
    flex: 0 0 auto;
  }
  .deckbar .left,
  .deckbar .right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .pillar {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-lg, 20px);
    color: var(--c-tx-hi);
  }
  .title {
    border: 1px solid transparent;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-md);
    padding: 3px 8px;
    min-width: 220px;
  }
  .title:hover {
    border-color: var(--c-line);
  }
  .title:focus {
    outline: none;
    border-color: var(--c-accent);
    background: var(--c-bg);
  }
  .btn {
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 4px 10px;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .dirty {
    color: var(--c-tx-faint);
    opacity: 0;
    transition: opacity 0.15s;
    font-size: 12px;
  }
  .dirty.on {
    opacity: 1;
    color: var(--c-accent);
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .filmstrip {
    flex: 0 0 168px;
    overflow-y: auto;
    border-right: 1px solid var(--c-line);
    background: var(--c-bg-raised);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .thumb {
    position: relative;
    display: grid;
    grid-template-columns: 16px 1fr;
    grid-template-rows: auto auto;
    gap: 2px 6px;
    cursor: pointer;
    padding: 4px;
    border: 1px solid transparent;
    border-radius: var(--r-2);
  }
  .thumb:hover {
    background: var(--c-accent-tint-2);
  }
  .thumb.active {
    border-color: var(--c-accent);
    background: var(--c-accent-tint-2);
  }
  .thumb .n {
    grid-row: 1 / span 2;
    font-size: 11px;
    color: var(--c-tx-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .mini {
    aspect-ratio: 16 / 9;
    border: 1px solid var(--c-line);
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .nm {
    font-size: 11px;
    color: var(--c-tx-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 16px;
    height: 16px;
    line-height: 14px;
    border: none;
    border-radius: 50%;
    background: var(--c-surface);
    color: var(--c-tx-muted);
    cursor: pointer;
    opacity: 0;
    font-size: 12px;
  }
  .thumb:hover .del {
    opacity: 1;
  }
  .del:hover {
    color: var(--c-danger);
  }
  .addslide {
    border: 1px dashed var(--c-line-strong);
    border-radius: var(--r-2);
    background: transparent;
    color: var(--c-tx-muted);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 8px;
  }
  .addslide:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .stage-wrap {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    background: var(--c-bg);
    padding: 18px;
    gap: 12px;
  }
  .stage-viewport {
    position: relative; /* containing block for the absolutely-positioned preview */
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .beatbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bl {
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-tx-muted);
    margin-right: 4px;
  }
  .beat {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid var(--c-line-strong);
    font-size: 11px;
    color: var(--c-tx-muted);
    font-variant-numeric: tabular-nums;
  }
  .beat.cur {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
    background: var(--c-accent-tint);
  }
  .empty {
    margin: auto;
    color: var(--c-tx-faint);
    font-style: italic;
    display: flex;
    gap: 10px;
    align-items: center;
  }
</style>
