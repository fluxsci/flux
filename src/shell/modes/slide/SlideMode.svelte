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
    undoDeck,
    redoDeck,
    canUndo,
    canRedo,
  } from "../../../lib/slide/store";
  import {
    listProjectDecks,
    loadDeckInto,
    saveDeckFrom,
    createDeckInProject,
    duplicateDeckInProject as duplicateDeckBridge,
    deleteDeckFromProject as deleteDeckBridge,
    loadDeckAssets,
    writeDeckAsset,
    listInsertables,
    exportDeck as exportDeckBridge,
    canExportDeck,
    type DeckListItem,
    type DeckAssetResolvers,
    type Insertables,
  } from "../../../lib/project/slideBridge";
  import * as slideOps from "../../../lib/slide/ops";
  import { createDeck as createDeckModel } from "../../../lib/slide/ops";
  import { resolveTheme, BUILTIN_THEMES } from "../../../lib/slide/theme";
  import { createPlayer, type Player } from "../../../lib/slide/player/player";
  import { plotManifests, plotGen } from "../../../lib/plot/store";
  import { touchActivityLock } from "../../../lib/bridge/activityLock";
  import { createAutosave } from "../../../lib/autosave";
  import SlideStage from "./SlideStage.svelte";
  import Inspector from "./Inspector.svelte";
  import AnimatePanel from "./AnimatePanel.svelte";
  import DeckPicker from "./DeckPicker.svelte";
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
  let activeDeckId = $state<string | null>(null);
  let unsubDirty: (() => void) | undefined;

  // W4: the shared autosave controller (stay-dirty + silent retry + sticky
  // error toast) replaces the hand-rolled saveTimer/saveError pattern here.
  const autosave = createAutosave({
    name: "deck",
    delay: 700,
    isDirty: () => !!pm && get(deckDirty),
    save: async () => {
      if (!pm) return;
      await saveDeckFrom(pm.root); // clears deckDirty only on success
      decks = await listProjectDecks(pm.root);
    },
  });
  const saveErr = autosave.error;
  let resolvers = $state<DeckAssetResolvers>({ assetUrl: () => undefined, figureSvg: () => undefined });
  let insertables = $state<Insertables>({ figures: [], plots: [], images: [] });
  let insertOpen = $state(false);
  let presentOpen = $state(false);
  let presentFromStart = $state(false);
  let dragOver = $state(false);
  function launchPresent(fromStart: boolean) {
    if (!deck) return;
    presentFromStart = fromStart;
    presentOpen = true;
  }

  async function refreshAssets() {
    const d = get(deckStore);
    if (pm && d) resolvers = await loadDeckAssets(pm.root, d);
  }

  // --- multiple decks (D) ------------------------------------------------------
  // Remember the last-open deck per project (mirrors paperLayout's activeDocPath).
  const lastDeckKey = (root: string) => `flux.slide.lastDeck:${root}`;
  function rememberDeck(root: string, id: string | null) {
    try { if (id) localStorage.setItem(lastDeckKey(root), id); } catch { /* ignore */ }
  }
  function lastDeckId(root: string): string | null {
    try { return localStorage.getItem(lastDeckKey(root)); } catch { return null; }
  }
  // After a deck swaps in, point the cursor at its first slide (fully built) and
  // reset the canvas view + selection.
  function resetCursorAndView() {
    const d = get(deckStore);
    if (d?.slides.length) {
      activeSlideId.set(d.slides[0].id);
      activeBeat.set(Math.max(0, d.slides[0].beats.length - 1));
    } else {
      activeSlideId.set(null);
      activeBeat.set(0);
    }
    selection.set([]);
    resetStageView();
  }
  /** Switch to another deck — saves the current one FIRST (await, mirrors Paper's
   *  loadDocument), so no edits race the swap. */
  async function switchDeck(id: string) {
    if (!pm || id === activeDeckId) return;
    await autosave.flush();
    await loadDeckInto(pm.root, id);
    activeDeckId = get(deckStore)?.id ?? id;
    rememberDeck(pm.root, activeDeckId);
    loadedProjectRoot.set(pm.root);
    await refreshAssets();
    resetCursorAndView();
    decks = await listProjectDecks(pm.root);
  }
  /** Create a fresh deck in the project, then switch to it. */
  async function newDeck() {
    if (!pm) return;
    await autosave.flush();
    const d = await createDeckInProject(pm.root, { title: `Deck ${decks.length + 1}`, theme: get(deckStore)?.theme });
    activeDeckId = d.id;
    rememberDeck(pm.root, d.id);
    loadedProjectRoot.set(pm.root);
    decks = await listProjectDecks(pm.root);
    await refreshAssets();
    resetCursorAndView();
  }
  async function duplicateDeck(id: string) {
    if (!pm) return;
    await autosave.flush(); // flush the source first if it's live
    const newId = await duplicateDeckBridge(pm.root, id);
    decks = await listProjectDecks(pm.root);
    if (newId) await switchDeck(newId);
  }
  async function deleteDeck(id: string) {
    if (!pm || decks.length <= 1) return;
    if (typeof window !== "undefined" && !window.confirm("Remove this deck from the project? Its file stays on disk.")) return;
    const wasActive = id === activeDeckId;
    const ok = await deleteDeckBridge(pm.root, id);
    if (!ok) return;
    decks = await listProjectDecks(pm.root);
    if (wasActive && decks[0]) await switchDeck(decks[0].id);
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
          if (decks.length) {
            // open the deck the user last had here, else the first
            const want = lastDeckId(pm.root);
            await loadDeckInto(pm.root, want && decks.some((d) => d.id === want) ? want : decks[0].id);
          } else await createDeckInProject(pm.root, { title: pm.manifest.title });
          decks = await listProjectDecks(pm.root);
          if (!get(deckStore)) loadDeckModel(createDeckModel({ title: pm.manifest.title }));
          loadedProjectRoot.set(pm.root);
        }
        activeDeckId = get(deckStore)?.id ?? null;
        if (activeDeckId) rememberDeck(pm.root, activeDeckId);
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
    canExport = canExportDeck();
    if (typeof window !== "undefined") window.addEventListener("beforeunload", flushOnExit);
    unsubDirty = deckDirty.subscribe((d) => {
      if (!ready || !pm || !d) return;
      touchActivityLock("slides"); // W3: defer concurrent agent deck writes while mid-edit
      autosave.schedule();
    });
  });

  onDestroy(() => {
    unsubDirty?.();
    player?.destroy();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", flushOnExit);
    // Flush pending edits to disk, but DO NOT clearDeck() — the live deck is kept
    // in the module-level store so a quick round-trip to another mode reuses it
    // (see onMount's `live` guard). clearDeck() is reserved for true project close.
    void autosave.flush();
    autosave.dispose();
  });

  // Belt-and-suspenders: flush on window close while in slide mode.
  function flushOnExit() {
    void autosave.flush();
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

  // --- import a NEW image by drag-drop / paste (writes a deck asset) -----------
  const MIME_KIND: Record<string, import("../../../lib/slide/types").DeckAsset["kind"]> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/svg+xml": "svg",
  };
  /** Natural pixel size of an image file (falls back for SVG without a size). */
  function naturalSize(file: File): Promise<{ w: number; h: number }> {
    return new Promise((res) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { res({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 }); URL.revokeObjectURL(url); };
      img.onerror = () => { res({ w: 800, h: 600 }); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }
  let importBusy = $state(false);
  /** Import one dropped/pasted image: write it into the deck's assets/, register
   *  the asset + a centered, aspect-fit image element, then refresh resolvers. */
  async function importImageFile(file: File) {
    const kind = MIME_KIND[file.type];
    const d = get(deckStore);
    if (!kind || !pm || !d) return;
    importBusy = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const nat = await naturalSize(file);
      const rel = await writeDeckAsset(pm.root, d.id, file.name || `image.${kind}`, bytes);
      // fit within 80% of the stage, preserving aspect ratio; center it.
      const s = Math.min((d.stage.width * 0.8) / nat.w, (d.stage.height * 0.8) / nat.h, 1);
      const w = Math.round(nat.w * s), h = Math.round(nat.h * s);
      await insertAndSelect((dd, sid) => {
        const assetId = slideOps.addAsset(dd, { kind, path: rel, naturalWidth: nat.w, naturalHeight: nat.h });
        return slideOps.addImageToSlide(dd, sid, {
          assetId, x: Math.round((d.stage.width - w) / 2), y: Math.round((d.stage.height - h) / 2), width: w, height: h,
        });
      });
    } finally {
      importBusy = false;
    }
  }
  function onStageDrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => MIME_KIND[f.type]);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void importImageFile(f);
  }
  function onStagePaste(e: ClipboardEvent) {
    const t = (e.target as HTMLElement)?.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    const item = [...(e.clipboardData?.items ?? [])].find((it) => MIME_KIND[it.type]);
    const file = item?.getAsFile();
    if (file) { e.preventDefault(); void importImageFile(file); }
  }

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
      newId = slideOps.addSlide(dd, { name: `Slide ${dd.slides.length + 1}`, layout: "content-figure", starters: true }).id;
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

  // --- filmstrip drag-to-reorder ----------------------------------------------
  let dragIdx = $state<number | null>(null);
  let dropIdx = $state<number | null>(null);
  function moveSlide(from: number, to: number) {
    if (from == null || from === to || !deck) return;
    const ids = deck.slides.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    commitDeck((dd) => slideOps.reorderSlides(dd, ids));
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

  // --- export (E) --------------------------------------------------------------
  let canExport = $state(false); // desktop-only (the engine needs Node/esbuild)
  let exporting = $state(false);
  let exportMsg = $state<{ ok: boolean; text: string } | null>(null);
  let exportMsgTimer: ReturnType<typeof setTimeout> | undefined;
  async function onExport() {
    const d = get(deckStore);
    if (!pm || !d || exporting) return;
    exporting = true;
    exportMsg = null;
    try {
      if (get(deckDirty)) await saveDeckFrom(pm.root); // export the latest, not a stale file
      const path = await exportDeckBridge(pm.root, d.id);
      flashExport(true, `Exported → ${path.split("/").slice(-2).join("/")}`);
    } catch (e) {
      flashExport(false, e instanceof Error ? e.message : "Export failed");
    } finally {
      exporting = false;
    }
  }
  function flashExport(ok: boolean, text: string) {
    exportMsg = { ok, text };
    clearTimeout(exportMsgTimer);
    exportMsgTimer = setTimeout(() => (exportMsg = null), ok ? 6000 : 9000);
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
    // F5 presents from the first slide; Shift+F5 from the current one (B22).
    if (e.key === "F5") {
      e.preventDefault();
      launchPresent(!e.shiftKey);
      return;
    }
    // Undo / redo (deck-level history). After the input guard so a focused text
    // field keeps its native undo; Cmd/Ctrl+Z everywhere else on the stage.
    if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redoDeck();
      else undoDeck();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redoDeck();
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

<svelte:window onkeydown={onKey} onpaste={onStagePaste} />

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
      <button class="btn" onclick={() => launchPresent(false)} disabled={!deck} title="Present from the current slide · F5 from the start, ⇧F5 from here">Present ▶</button>
      <button class="btn ghost" onclick={onExport} disabled={!deck || !canExport || exporting}
        title={canExport ? "Export a self-contained offline .html" : "Export is available in the desktop app"}>
        {exporting ? "Exporting…" : "Export"}
      </button>
      {#if $saveErr}
        <button class="saveerr" title={`Autosave failed — ${$saveErr}. Your edits are still in memory; it will retry on the next change.`} onclick={() => void autosave.flush()}>⚠ unsaved</button>
      {:else}
        <span class="dirty" class:on={$deckDirty} title="Unsaved changes">●</span>
      {/if}
    </div>
  </header>

  <!-- tools -->
  <div class="tools">
    <button class="tool ic" onclick={undoDeck} disabled={!$canUndo} title="Undo (⌘/Ctrl+Z)" aria-label="Undo">↶</button>
    <button class="tool ic" onclick={redoDeck} disabled={!$canRedo} title="Redo (⇧⌘/Ctrl+Z)" aria-label="Redo">↷</button>
    <span class="div"></span>
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
      {#if pm}
        <DeckPicker {decks} activeId={activeDeckId} onSelect={switchDeck} onNew={newDeck} onDuplicate={duplicateDeck} onDelete={deleteDeck} />
      {/if}
      {#if deck}
        {#each deck.slides as s, i (s.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="thumb" class:active={s.id === ($activeSlideId ?? activeSlide?.id)}
            class:dragging={dragIdx === i} class:dropbefore={dropIdx === i && dragIdx !== null && dragIdx > i} class:dropafter={dropIdx === i && dragIdx !== null && dragIdx < i}
            draggable="true"
            ondragstart={(e) => { dragIdx = i; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
            ondragover={(e) => { e.preventDefault(); dropIdx = i; if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; }}
            ondrop={(e) => { e.preventDefault(); if (dragIdx !== null) moveSlide(dragIdx, i); dragIdx = null; dropIdx = null; }}
            ondragend={() => { dragIdx = null; dropIdx = null; }}
            onclick={() => selectSlide(s.id)}>
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
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <main class="stage-wrap" class:dropping={dragOver}
      ondragover={(e) => { if ([...(e.dataTransfer?.items ?? [])].some((it) => it.kind === "file")) { e.preventDefault(); dragOver = true; } }}
      ondragleave={(e) => { if (e.currentTarget === e.target) dragOver = false; }}
      ondrop={(e) => { dragOver = false; onStageDrop(e); }}>
      {#if importBusy}<div class="import-toast">Importing image…</div>{/if}
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

  {#if exportMsg}
    <div class="export-toast" class:err={!exportMsg.ok} role="status">
      {exportMsg.ok ? "✓" : "⚠"}
      {exportMsg.text}
    </div>
  {/if}
</div>

{#if presentOpen && deck && activeSlide}
  <PresentOverlay
    {deck}
    {theme}
    assetUrl={resolvers.assetUrl}
    figureSvg={resolvers.figureSvg}
    start={{ slide: presentFromStart ? 0 : deck.slides.findIndex((s) => s.id === activeSlide.id), beat: 0 }}
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
  /* export toast (E) */
  .export-toast {
    position: absolute; top: 54px; left: 50%; transform: translateX(-50%); z-index: 40;
    max-width: 70%; padding: 8px 14px; border-radius: var(--r-2);
    background: var(--c-bg-raised); border: 1px solid var(--c-accent);
    color: var(--c-tx-hi); font-size: var(--ts-sm); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .export-toast.err { border-color: var(--c-danger, #d14); }
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
  .saveerr {
    font-size: 11px; font-weight: 600; color: var(--c-on-accent, #100f0f);
    background: var(--c-de, #d14d41); border: none; border-radius: var(--r-1); padding: 2px 8px; cursor: pointer;
  }
  .saveerr:hover { filter: brightness(1.08); }
  .tools {
    display: flex; align-items: center; gap: 5px; padding: 6px 12px;
    border-bottom: 1px solid var(--c-line); background: var(--c-bg-raised); flex: 0 0 auto;
  }
  .tool {
    border: 1px solid var(--c-line); border-radius: var(--r-1); background: var(--c-surface);
    color: var(--c-tx-2); cursor: pointer; font-size: var(--ts-sm); padding: 3px 11px;
  }
  .tool:hover:not(:disabled) { border-color: var(--c-accent); color: var(--c-tx-hi); }
  .tool.ic { padding: 3px 8px; font-size: 15px; line-height: 1; }
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
  /* drag-to-reorder affordances */
  .thumb.dragging { opacity: 0.4; }
  .thumb.dropbefore { box-shadow: inset 0 2px 0 0 var(--c-accent); }
  .thumb.dropafter { box-shadow: inset 0 -2px 0 0 var(--c-accent); }
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
  .stage-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--c-bg); padding: 18px; gap: 12px; position: relative; }
  .stage-wrap.dropping { outline: 2px dashed var(--c-accent); outline-offset: -6px; }
  .stage-wrap.dropping::after {
    content: "Drop image to add"; position: absolute; inset: 0; z-index: 40;
    display: flex; align-items: center; justify-content: center; pointer-events: none;
    font-size: var(--ts-lg); color: var(--c-tx-hi);
    background: color-mix(in oklab, var(--c-accent) 12%, transparent);
  }
  .import-toast {
    position: absolute; top: 24px; left: 50%; transform: translateX(-50%); z-index: 41;
    background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-2);
    padding: 6px 14px; color: var(--c-tx-hi); font-size: var(--ts-sm); box-shadow: var(--shadow-2, 0 4px 16px rgba(0,0,0,0.4));
  }
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
