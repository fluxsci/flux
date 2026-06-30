<script lang="ts">
  // flux-slide: the Slide mode (the 4th pillar). P1 = the editor: a WYSIWYG stage
  // (the ONE renderer + selection/drag/resize/snap), a tools toolbar, a filmstrip,
  // the inspector, and theme/stage controls. Persistence mirrors FigureMode
  // (debounced autosave on a dirty store, flush on destroy, keyboard gated on
  // `focused`). The stage + thumbnails both render through src/lib/slide/player.
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { projectModel } from "../../shellStore";
  import {
    deck as deckStore,
    deckDirty,
    activeSlideId,
    activeBeat,
    selection,
    loadDeckModel,
    commitDeck,
    loadedProjectRoot,
  } from "../../../lib/slide/store";
  import {
    listProjectDecks,
    loadDeckInto,
    saveDeckFrom,
    createDeckInProject,
    loadDeckAssets,
    listInsertables,
    type DeckListItem,
    type DeckAssetResolvers,
    type Insertables,
  } from "../../../lib/project/slideBridge";
  import * as slideOps from "../../../lib/slide/ops";
  import { createDeck as createDeckModel } from "../../../lib/slide/ops";
  import { resolveTheme, BUILTIN_THEMES } from "../../../lib/slide/theme";
  import { createPlayer, type Player } from "../../../lib/slide/player/player";
  import { plotManifests, plotGen } from "../../../lib/plot/store";
  import SlideStage from "./SlideStage.svelte";
  import Inspector from "./Inspector.svelte";
  import AnimatePanel from "./AnimatePanel.svelte";
  import PresentOverlay from "./PresentOverlay.svelte";
  import PlotImporter from "../../../lib/PlotImporter.svelte";
  import { importerOpen } from "../../../lib/store";
  import { slideLayout } from "./slideLayoutStore";
  import { stageView, resetStageView, ZOOM_MIN, ZOOM_MAX } from "./stageView";
  import "katex/dist/katex.min.css";

  let { focused = true }: { focused?: boolean } = $props();

  const pm = get(projectModel);
  let ready = $state(false);
  let decks = $state<DeckListItem[]>([]);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubDirty: (() => void) | undefined;
  let resolvers = $state<DeckAssetResolvers>({ assetUrl: () => undefined, figureSvg: () => undefined });
  let insertables = $state<Insertables>({ figures: [], plots: [], images: [] });
  let insertOpen = $state(false);
  let presentOpen = $state(false);

  async function refreshAssets() {
    const d = get(deckStore);
    if (pm && d) resolvers = await loadDeckAssets(pm.root, d);
  }
  // Plots get their own always-on `Plot…` browser button; Insert ▾ is for the
  // (typically short) figure + image lists.
  const hasInsertables = $derived(insertables.figures.length + insertables.images.length > 0);

  const deck = $derived($deckStore);
  const activeSlide = $derived(
    deck && $activeSlideId ? slideOps.slideById(deck, $activeSlideId) : deck?.slides[0] ?? null,
  );
  const theme = $derived(resolveTheme(deck?.theme));

  // --- inline build preview (play the current slide's animations on the stage) --
  let previewing = $state(false);
  let previewHost = $state<HTMLElement>();
  let pvW = $state(0);
  let pvH = $state(0);
  let player: Player | undefined;
  const pvScale = $derived(deck && pvW > 0 && pvH > 0 ? Math.min(pvW / deck.stage.width, pvH / deck.stage.height) : 1);

  function startPreview() {
    const d = deck;
    const s = activeSlide;
    if (!d || !s || previewing) return;
    const si = d.slides.findIndex((x) => x.id === s.id);
    if (si < 0) return;
    previewing = true;
    queueMicrotask(() => {
      if (!previewHost) { previewing = false; return; }
      const opts = {
        theme, assetUrl: resolvers.assetUrl, figureSvg: resolvers.figureSvg,
        plotGen: get(plotGen), mode: "present" as const, plotManifest: (id: string) => get(plotManifests)[id],
      };
      player = createPlayer(previewHost, d, opts);
      previewHost.style.transformOrigin = "center center";
      previewHost.style.transform = `scale(${pvScale})`;
      player.goTo(si, 0);
      const nBeats = s.beats.length;
      player.on("beatEnd", () => {
        if (!player) return;
        if (player.state().beat >= nBeats - 1) setTimeout(stopPreview, 1100);
        else setTimeout(() => player?.next(), 480);
      });
      if (nBeats <= 1) setTimeout(stopPreview, 900);
      else setTimeout(() => player?.next(), 420);
    });
  }
  function stopPreview() {
    player?.destroy();
    player = undefined;
    previewing = false;
  }

  const STAGE_PRESETS = [
    { label: "16:9 · 1280×720", w: 1280, h: 720 },
    { label: "16:9 · 1920×1080", w: 1920, h: 1080 },
    { label: "4:3 · 1024×768", w: 1024, h: 768 },
  ];

  onMount(async () => {
    try {
      if (pm) {
        decks = await listProjectDecks(pm.root);
        // Reuse the live in-memory deck across a mode round-trip (slide→figure→
        // slide, same project) — the deck store is module-level and survives
        // unmount, so don't reload from disk (which raced the un-awaited
        // destroy-time save and dropped edits). Reload only on first entry or a
        // genuine project change (root mismatch).
        const live = get(deckStore) && get(loadedProjectRoot) === pm.root;
        if (!live) {
          if (decks.length) await loadDeckInto(pm.root, decks[0].id);
          else await createDeckInProject(pm.root, { title: pm.manifest.title });
          decks = await listProjectDecks(pm.root);
          if (!get(deckStore)) loadDeckModel(createDeckModel({ title: pm.manifest.title }));
          loadedProjectRoot.set(pm.root);
        }
      } else if (!get(deckStore)) {
        loadDeckModel(createDeckModel({ title: "Demo Deck" }));
      }
      await refreshAssets();
      if (pm) insertables = await listInsertables(pm.root);
      const d0 = get(deckStore);
      if (d0?.slides.length) {
        if (!get(activeSlideId)) activeSlideId.set(d0.slides[0].id);
        const cur = slideOps.slideById(d0, get(activeSlideId) ?? d0.slides[0].id) ?? d0.slides[0];
        activeBeat.set(Math.max(0, cur.beats.length - 1)); // open fully-built
      }
    } catch (e) {
      console.error("SlideMode: deck load failed, using in-memory deck", e);
      loadDeckModel(createDeckModel({ title: pm?.manifest.title ?? "Demo Deck" }));
    }
    ready = true;
    if (typeof window !== "undefined") window.addEventListener("beforeunload", flushOnExit);
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
    player?.destroy();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", flushOnExit);
    // Flush pending edits to disk, but DO NOT clearDeck() — the live deck is kept
    // in the module-level store so a quick round-trip to another mode reuses it
    // (see onMount's `live` guard). clearDeck() is reserved for true project close.
    if (pm && get(deckDirty)) void saveDeckFrom(pm.root);
  });

  // Belt-and-suspenders: flush on window close while in slide mode.
  function flushOnExit() {
    if (pm && get(deckDirty)) void saveDeckFrom(pm.root);
  }

  function selectSlide(id: string) {
    activeSlideId.set(id);
    const s = deck && slideOps.slideById(deck, id);
    activeBeat.set(s ? Math.max(0, s.beats.length - 1) : 0); // show fully-built for editing
    selection.set([]);
  }

  // --- tools: add an element to the active slide, then select it ---------------
  function add(make: (d: import("../../../lib/slide/types").Deck, sid: string) => string | null) {
    const sid = $activeSlideId ?? activeSlide?.id;
    if (!sid) return;
    let id: string | null = null;
    commitDeck((d) => {
      id = make(d, sid);
    });
    if (id) selection.set([id]);
  }
  const addText = () => add((d, sid) => slideOps.addTextBox(d, sid, { text: "Text", x: 120, y: 120, width: 600, height: 90, fontSize: 36 }));
  const addTitle = () => add((d, sid) => slideOps.addTextBox(d, sid, { text: "Title", x: 120, y: 90, width: 1040, height: 130, fontSize: 72, fontWeight: 700, align: "left" }));
  const addBullets = () =>
    add((d, sid) =>
      slideOps.addTextBox(d, sid, {
        x: 140, y: 220, width: 900, height: 320, fontSize: 34,
        blocks: [
          slideOps.makeBlock("First point", { marker: "bullet" }),
          slideOps.makeBlock("Second point", { marker: "bullet" }),
          slideOps.makeBlock("…and a sub-point", { marker: "bullet", level: 1, emphasis: "accent" }),
        ],
      }),
    );
  const addMath = () => add((d, sid) => slideOps.addMath(d, sid, { tex: "E = mc^2", x: 420, y: 300, width: 440, height: 120, display: true }));
  const addRect = () => add((d, sid) => slideOps.addRect(d, sid, { x: 300, y: 250, width: 320, height: 200 }));
  const addEllipse = () => add((d, sid) => slideOps.addEllipse(d, sid, { x: 360, y: 260, width: 220, height: 220 }));
  const addLine = () => add((d, sid) => slideOps.addLine(d, sid, { x: 300, y: 360, width: 360, arrowEnd: true }));

  // --- insert reusable project content (figures / plots / images) -------------
  // These reference real project assets, so after inserting we must reload the
  // asset resolvers (figure SVG / plot cache / image data URL) before they paint.
  async function insertAndSelect(make: (d: import("../../../lib/slide/types").Deck, sid: string) => string | null) {
    const sid = $activeSlideId ?? activeSlide?.id;
    if (!sid) return;
    let id: string | null = null;
    commitDeck((d) => { id = make(d, sid); });
    await refreshAssets();
    if (id) selection.set([id]);
    insertOpen = false;
  }
  const insertFigure = (figureId: string) =>
    insertAndSelect((d, sid) => slideOps.addEmbedFigure(d, sid, { figureId, x: 360, y: 150, width: 600, height: 420, fit: "contain" }));
  const insertImage = (img: Insertables["images"][number]) =>
    insertAndSelect((d, sid) => slideOps.addImageToSlide(d, sid, { assetId: img.id, x: 360, y: 150, width: 600, height: 420 }));

  // Reuse Figure mode's Plot Importer (the searchable plots/ browser) to drop a
  // plot onto the active slide. `rel` is the path under plots/ (e.g.
  // "example_set/01_bars.svg"); strip .svg for the stable id + source paths.
  const openPlotBrowser = () => importerOpen.set(true);
  async function onPickPlot({ rel, semantic }: { abs: string; rel: string; semantic: boolean }) {
    const base = rel.replace(/\.svg$/i, "");
    await insertAndSelect((d, sid) =>
      slideOps.addPlotToSlide(d, sid, {
        assetId: base, x: 360, y: 150, width: 600, height: 420,
        source: { svgPath: `plots/${base}.svg`, manifestPath: semantic ? `plots/${base}.fluxplot.json` : undefined },
      }),
    );
  }

  function onAddSlide() {
    const d = get(deckStore);
    if (!d) return;
    let newId = "";
    commitDeck((dd) => {
      newId = slideOps.addSlide(dd, { name: `Slide ${dd.slides.length + 1}`, layout: "content-figure" }).id;
    });
    if (newId) selectSlide(newId);
  }
  function onDuplicateSlide(id: string) {
    let nid: string | null = null;
    commitDeck((dd) => { nid = slideOps.duplicateSlide(dd, id); });
    if (nid) selectSlide(nid);
  }
  function onDeleteSlide(id: string) {
    const d = get(deckStore);
    if (!d || d.slides.length <= 1) return;
    let next: string | null = null;
    commitDeck((dd) => { next = slideOps.deleteSlide(dd, id).nextActiveId; });
    if (next) selectSlide(next);
  }

  function onTitleInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    commitDeck((dd) => { dd.title = v; });
  }
  function onThemeChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    commitDeck((dd) => slideOps.setTheme(dd, v));
  }
  function onStageChange(e: Event) {
    const i = Number((e.target as HTMLSelectElement).value);
    const p = STAGE_PRESETS[i];
    if (p) commitDeck((dd) => slideOps.setStageSize(dd, { width: p.w, height: p.h }));
  }

  // Deckbar zoom buttons step centered (pan reset); fine zoom-to-cursor is the
  // canvas's Ctrl+wheel. The % chip resets to fit.
  function stepZoom(factor: number) {
    stageView.update((v) => ({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom * factor)), panX: 0, panY: 0 }));
  }

  // --- draggable pane edges (filmstrip / inspector widths) — mirrors Paper's
  // pointer-drag gutter; sizes persist in slideLayout (localStorage). The Animator
  // dock height is dragged inside AnimatePanel via the same store.
  let bodyEl = $state<HTMLDivElement | null>(null);
  let dragPane = $state<"film" | "insp" | null>(null);
  function startPaneDrag(which: "film" | "insp", e: PointerEvent) {
    e.preventDefault();
    dragPane = which;
    window.addEventListener("pointermove", movePaneDrag);
    window.addEventListener("pointerup", endPaneDrag);
  }
  function movePaneDrag(e: PointerEvent) {
    if (!dragPane || !bodyEl) return;
    const r = bodyEl.getBoundingClientRect();
    if (dragPane === "film") {
      const w = Math.max(120, Math.min(420, e.clientX - r.left));
      slideLayout.update((s) => ({ ...s, filmstripW: Math.round(w) }));
    } else {
      const w = Math.max(190, Math.min(480, r.right - e.clientX));
      slideLayout.update((s) => ({ ...s, inspectorW: Math.round(w) }));
    }
  }
  function endPaneDrag() {
    dragPane = null;
    window.removeEventListener("pointermove", movePaneDrag);
    window.removeEventListener("pointerup", endPaneDrag);
  }

  // Slide nav with arrows — only when no element is selected (else the stage nudges).
  function onKey(e: KeyboardEvent) {
    if (!focused || !deck) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    // Alt+I opens the plot importer (mirrors Figure mode's keyboard.ts:461) — works
    // regardless of selection, so handle it before the slide-nav selection guard.
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyI") {
      e.preventDefault();
      if (!$importerOpen) openPlotBrowser();
      return;
    }
    if ($selection.length > 0) return;
    const i = deck.slides.findIndex((s) => s.id === $activeSlideId);
    if (e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      const n = deck.slides[Math.min(deck.slides.length - 1, i + 1)];
      if (n) selectSlide(n.id);
    } else if (e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      const n = deck.slides[Math.max(0, i - 1)];
      if (n) selectSlide(n.id);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="slide-mode">
  <header class="deckbar">
    <div class="left">
      <span class="pillar">Slide</span>
      {#if deck}
        <input class="title" value={deck.title} oninput={onTitleInput} spellcheck="false" aria-label="Deck title" />
      {/if}
    </div>
    <div class="right">
      {#if deck}
        <select class="sel" value={deck.theme} onchange={onThemeChange} title="Theme" aria-label="Theme">
          {#each Object.values(BUILTIN_THEMES) as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
        <select class="sel" onchange={onStageChange} title="Stage size" aria-label="Stage size">
          {#each STAGE_PRESETS as p, i (p.label)}
            <option value={i} selected={deck.stage.width === p.w && deck.stage.height === p.h}>{p.label}</option>
          {/each}
        </select>
        <div class="zoomctl" title="Zoom — Ctrl+wheel to zoom to cursor · + / − / 0 (fit) · middle-drag to pan">
          <button class="zb" onclick={() => stepZoom(1 / 1.2)} disabled={$stageView.zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
          <button class="zb pct" onclick={resetStageView} title="Reset to fit">{Math.round($stageView.zoom * 100)}%</button>
          <button class="zb" onclick={() => stepZoom(1.2)} disabled={$stageView.zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
        </div>
      {/if}
      <button class="btn" onclick={() => (presentOpen = true)} disabled={!deck} title="Present (from current slide)">Present ▶</button>
      <button class="btn ghost" disabled title="Export .html (P4)">Export</button>
      <span class="dirty" class:on={$deckDirty} title="Unsaved changes">●</span>
    </div>
  </header>

  <!-- tools -->
  <div class="tools">
    <button class="tool" onclick={addTitle} disabled={!activeSlide}>Title</button>
    <button class="tool" onclick={addText} disabled={!activeSlide}>Text</button>
    <button class="tool" onclick={addBullets} disabled={!activeSlide}>Bullets</button>
    <button class="tool" onclick={addMath} disabled={!activeSlide}>Math</button>
    <button class="tool" class:active={$importerOpen} onclick={openPlotBrowser} disabled={!activeSlide} title="Browse + insert a project plot (semantic — animatable & morphable) · Alt+I">Plot…</button>
    <span class="div"></span>
    <button class="tool" onclick={addRect} disabled={!activeSlide}>Rect</button>
    <button class="tool" onclick={addEllipse} disabled={!activeSlide}>Ellipse</button>
    <button class="tool" onclick={addLine} disabled={!activeSlide}>Line</button>
    {#if hasInsertables}
      <span class="div"></span>
      <div class="insert-wrap">
        <button class="tool" onclick={() => (insertOpen = !insertOpen)} disabled={!activeSlide} aria-haspopup="menu" aria-expanded={insertOpen}>Insert ▾</button>
        {#if insertOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="insert-menu" role="menu">
            {#if insertables.figures.length}
              <div class="grp">Figures</div>
              {#each insertables.figures as f (f.id)}
                <button class="item" role="menuitem" onclick={() => insertFigure(f.id)}>{f.title}</button>
              {/each}
            {/if}
            {#if insertables.images.length}
              <div class="grp">Images</div>
              {#each insertables.images as img (img.id)}
                <button class="item" role="menuitem" onclick={() => insertImage(img)}>{img.id}</button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="body" bind:this={bodyEl} style={`--film-w:${$slideLayout.filmstripW}px; --insp-w:${$slideLayout.inspectorW}px;`}>
    <!-- filmstrip -->
    <aside class="filmstrip">
      {#if deck}
        {#each deck.slides as s, i (s.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="thumb" class:active={s.id === ($activeSlideId ?? activeSlide?.id)} onclick={() => selectSlide(s.id)}>
            <span class="n">{i + 1}</span>
            <div class="mini">
              <SlideStage slide={s} {theme} stage={deck.stage} interactive={false} assetUrl={resolvers.assetUrl} figureSvg={resolvers.figureSvg} />
            </div>
            <span class="nm">{s.name ?? `Slide ${i + 1}`}</span>
            <div class="thumbacts">
              <button class="ta" title="Duplicate" aria-label="Duplicate slide" onclick={(e) => { e.stopPropagation(); onDuplicateSlide(s.id); }}>⧉</button>
              {#if deck.slides.length > 1}
                <button class="ta" title="Delete" aria-label="Delete slide" onclick={(e) => { e.stopPropagation(); onDeleteSlide(s.id); }}>×</button>
              {/if}
            </div>
          </div>
        {/each}
        <button class="addslide" onclick={onAddSlide}>+ Add slide</button>
      {/if}
    </aside>

    <!-- filmstrip ↔ stage resize handle -->
    <div class="pane-gutter" class:active={dragPane === "film"} role="separator" aria-orientation="vertical"
      aria-label="Resize filmstrip" onpointerdown={(e) => startPaneDrag("film", e)}><span class="grip"></span></div>

    <!-- stage -->
    <main class="stage-wrap">
      {#if ready && deck && activeSlide}
        <div class="stage-viewport" bind:clientWidth={pvW} bind:clientHeight={pvH}>
          <SlideStage slide={activeSlide} {theme} stage={deck.stage} interactive={true} {focused} beat={Math.min($activeBeat, activeSlide.beats.length - 1)} assetUrl={resolvers.assetUrl} figureSvg={resolvers.figureSvg} />
          {#if previewing}
            <div class="preview-overlay">
              <div class="preview-host" bind:this={previewHost}></div>
              <button class="preview-stop" onclick={stopPreview} title="Stop preview">■ Stop</button>
            </div>
          {/if}
        </div>
        <AnimatePanel onPreview={startPreview} />
      {:else if ready && deck}
        <div class="empty">This deck has no slides. <button class="btn" onclick={onAddSlide}>Add one</button></div>
      {:else}
        <div class="empty">Loading deck…</div>
      {/if}
    </main>

    <!-- stage ↔ inspector resize handle -->
    <div class="pane-gutter" class:active={dragPane === "insp"} role="separator" aria-orientation="vertical"
      aria-label="Resize inspector" onpointerdown={(e) => startPaneDrag("insp", e)}><span class="grip"></span></div>

    <!-- inspector -->
    <aside class="inspector-host">
      <Inspector {focused} />
    </aside>
  </div>
</div>

{#if presentOpen && deck && activeSlide}
  <PresentOverlay
    {deck}
    {theme}
    assetUrl={resolvers.assetUrl}
    figureSvg={resolvers.figureSvg}
    start={{ slide: deck.slides.findIndex((s) => s.id === activeSlide.id), beat: 0 }}
    onClose={() => (presentOpen = false)} />
{/if}

<!-- the shared plots/ browser (Figure mode's Alt+I importer), reused to drop a
     plot onto the active slide instead of importing into a figure -->
<PlotImporter rootOverride={pm?.root ?? ""} onPick={onPickPlot} title="Insert plot onto slide" />

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
    padding: 7px 14px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-bg-raised);
    flex: 0 0 auto;
  }
  /* zoom control (C2) */
  .zoomctl { display: inline-flex; align-items: center; border: 1px solid var(--c-line); border-radius: var(--r-1); overflow: hidden; }
  .zb {
    border: none; background: var(--c-surface); color: var(--c-tx); cursor: pointer;
    font-size: var(--ts-sm); padding: 4px 8px; line-height: 1;
  }
  .zb:hover:not(:disabled) { background: var(--c-accent-tint); color: var(--c-tx-hi); }
  .zb:disabled { opacity: 0.4; cursor: default; }
  .zb.pct { min-width: 46px; font-variant-numeric: tabular-nums; border-left: 1px solid var(--c-line); border-right: 1px solid var(--c-line); }
  .deckbar .left, .deckbar .right { display: flex; align-items: center; gap: var(--sp-2); }
  .pillar { font-family: var(--font-serif); font-style: italic; font-size: var(--ts-lg, 20px); color: var(--c-tx-hi); }
  .title {
    border: 1px solid transparent; border-radius: var(--r-1); background: transparent;
    color: var(--c-tx); font: inherit; font-size: var(--ts-md); padding: 3px 8px; min-width: 220px;
  }
  .title:hover { border-color: var(--c-line); }
  .title:focus { outline: none; border-color: var(--c-accent); background: var(--c-bg); }
  .sel {
    border: 1px solid var(--c-line-strong); border-radius: var(--r-1); background: var(--c-surface);
    color: var(--c-tx-2); font-size: var(--ts-xs); padding: 3px 6px;
  }
  .btn {
    border: 1px solid var(--c-line-strong); border-radius: var(--r-1); background: var(--c-surface);
    color: var(--c-tx-2); cursor: pointer; font-size: var(--ts-sm); padding: 4px 10px;
  }
  .btn:hover:not(:disabled) { border-color: var(--c-accent); color: var(--c-tx-hi); }
  .btn:disabled, .tool:disabled { opacity: 0.4; cursor: default; }
  .btn.ghost { background: transparent; }
  .dirty { color: var(--c-tx-faint); opacity: 0; transition: opacity 0.15s; font-size: 12px; }
  .dirty.on { opacity: 1; color: var(--c-accent); }
  .tools {
    display: flex; align-items: center; gap: 5px; padding: 6px 12px;
    border-bottom: 1px solid var(--c-line); background: var(--c-bg-raised); flex: 0 0 auto;
  }
  .tool {
    border: 1px solid var(--c-line); border-radius: var(--r-1); background: var(--c-surface);
    color: var(--c-tx-2); cursor: pointer; font-size: var(--ts-sm); padding: 3px 11px;
  }
  .tool:hover:not(:disabled) { border-color: var(--c-accent); color: var(--c-tx-hi); }
  /* lit only while the plot importer is open (was a permanent .accent → looked stuck) */
  .tool.active { border-color: var(--c-accent); background: var(--c-accent); color: var(--c-on-accent); }
  .div { width: 1px; height: 18px; background: var(--c-line); margin: 0 4px; }
  .insert-wrap { position: relative; }
  .insert-menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; min-width: 180px;
    background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-2);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); padding: 4px; display: flex; flex-direction: column; gap: 1px;
  }
  .insert-menu .grp { font-size: var(--ts-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--c-tx-muted); padding: 5px 8px 2px; }
  .insert-menu .item {
    text-align: left; border: none; background: transparent; color: var(--c-tx-2);
    border-radius: var(--r-1); padding: 5px 8px; cursor: pointer; font-size: var(--ts-sm);
  }
  .insert-menu .item:hover { background: var(--c-accent-tint); color: var(--c-tx-hi); }
  .body { display: flex; flex: 1; min-height: 0; }
  .filmstrip {
    flex: 0 0 var(--film-w, 172px); overflow-y: auto; border-right: 1px solid var(--c-line);
    background: var(--c-bg-raised); padding: 10px; display: flex; flex-direction: column; gap: 10px;
  }
  /* draggable pane edges (C1): a thin hit-strip with a centered grip on hover/drag */
  .pane-gutter {
    flex: 0 0 5px; align-self: stretch; cursor: col-resize; position: relative;
    margin: 0 -2px; z-index: 5; display: flex; align-items: center; justify-content: center;
  }
  .pane-gutter .grip { width: 1px; height: 100%; background: transparent; transition: background 0.12s; }
  .pane-gutter:hover .grip, .pane-gutter.active .grip { background: var(--c-accent, #4385be); width: 2px; }
  .thumb {
    position: relative; display: grid; grid-template-columns: 16px 1fr; grid-template-rows: auto auto;
    gap: 2px 6px; cursor: pointer; padding: 4px; border: 1px solid transparent; border-radius: var(--r-2);
  }
  .thumb:hover { background: var(--c-accent-tint-2); }
  .thumb.active { border-color: var(--c-accent); background: var(--c-accent-tint-2); }
  .thumb .n { grid-row: 1 / span 2; font-size: 11px; color: var(--c-tx-muted); text-align: right; font-variant-numeric: tabular-nums; }
  .mini { aspect-ratio: 16 / 9; border: 1px solid var(--c-line); border-radius: 3px; overflow: hidden; position: relative; background: #000; }
  .nm { font-size: 11px; color: var(--c-tx-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thumbacts { position: absolute; top: 2px; right: 2px; display: flex; gap: 2px; opacity: 0; }
  .thumb:hover .thumbacts { opacity: 1; }
  .ta {
    width: 16px; height: 16px; line-height: 14px; border: none; border-radius: 3px;
    background: var(--c-surface); color: var(--c-tx-muted); cursor: pointer; font-size: 11px;
  }
  .ta:hover { color: var(--c-tx-hi); }
  .addslide {
    border: 1px dashed var(--c-line-strong); border-radius: var(--r-2); background: transparent;
    color: var(--c-tx-muted); cursor: pointer; font-size: var(--ts-sm); padding: 8px;
  }
  .addslide:hover { border-color: var(--c-accent); color: var(--c-tx-hi); }
  .stage-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--c-bg); padding: 18px; gap: 12px; }
  .stage-viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .preview-overlay {
    position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
    background: var(--c-bg, #100f0f);
  }
  .preview-host { flex: 0 0 auto; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5); }
  .preview-stop {
    position: absolute; top: 12px; right: 12px; z-index: 31;
    font-size: 12px; color: var(--c-tx-hi, #fff); background: color-mix(in oklab, var(--c-bg, #100f0f) 70%, transparent);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 6px; padding: 5px 12px; cursor: pointer;
  }
  .preview-stop:hover { border-color: var(--c-accent, #4385be); }
  .inspector-host { flex: 0 0 var(--insp-w, 248px); border-left: 1px solid var(--c-line); background: var(--c-bg-raised); overflow-y: auto; position: relative; }
  .empty { margin: auto; color: var(--c-tx-faint); font-style: italic; display: flex; gap: 10px; align-items: center; }
</style>
