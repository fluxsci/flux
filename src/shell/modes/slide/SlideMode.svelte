<script lang="ts">
  // flux-slide — the Slide mode. Slides-are-figures (slide-migration): the
  // static editing surface IS the figure editor — the deck's slides load into
  // the app-global figure store (projected one slide = one Figure on the
  // synthetic "deck" canvas) and the shared Canvas/Inspector/X-ray/presets/
  // keyboard operate on them unchanged. This mode adds only the thin
  // presentation layer: a slide filmstrip for sequencing, the on-demand
  // Animator dock, present mode, and the offline HTML export. Persistence
  // mirrors FigureMode (debounced autosave on the shared dirty store, flush on
  // destroy, keyboard gated on `focused`) but writes ONE deck.json through the
  // slide bridge — tenancy-asserted so a wrong-folder write is structurally
  // impossible.
  import { onMount, onDestroy, tick, setContext, untrack } from "svelte";
  import { get } from "svelte/store";
  import { projectModel } from "../../shellStore";
  import { openSlideRequest } from "../../command/commandBus";
  import {
    deckOverlay,
    activeBeat,
    selTrackIds,
    commitDeckLive,
    currentDeck,
    composedSlide,
    selectSlide,
    overlayHistoryCompanion,
    sealHistory,
    endpointEdit,
    enterEndpointEdit,
    exitEndpointEdit,
    clearBeatDisplay,
    editDestination, setEditDestination, editAfterBeat, registerSlideEditAdapter, slideCanvasPresentation,
  } from "../../../lib/slide/store";
  import { familyOf } from "../../../lib/slide/family";
  import { suggestElementTrack, suggestTrack } from "../../../lib/slide/autobuild";
  import {
    dirty as figDirty,
    activeFigureId,
    selection,
    selectedFrameId,
    partSelection,
    viewport,
    project,
    commit,
    embeddedProjectRoot,
    registerHistoryCompanion,
    gestureCancelHook, importerOpen,
    cascadeState,
    undo, redo,
  } from "../../../lib/store";
  import {
    listProjectDecks,
    loadDeckInto,
    saveDeckFrom,
    deckDiskDiverged, refreshDeckSources,
    createDeckInProject,
    duplicateDeckInProject as duplicateDeckBridge,
    deleteDeckFromProject as deleteDeckBridge,
    exportDeck as exportDeckBridge,
    canExportDeck,
    type DeckListItem,
    type DeckDiag,
  } from "../../../lib/project/slideBridge";
  import * as slideOps from "../../../lib/slide/ops";
  import { slideDefaultBackground } from "../../../lib/slide/deckProject";
  import { inspectorHidden, leftRailHidden } from "../../../lib/settings";
  import { resolveTheme, BUILTIN_THEMES } from "../../../lib/slide/theme";
  import type { Deck, TransitionKind } from "../../../lib/slide/types";
  import { createPlayer, type Player } from "../../../lib/slide/player/player";
  import { plotManifests, plotGen } from "../../../lib/plot/store";
  import { getAssetData } from "../../../lib/assets";
  import { assetDisplaySize } from "../../../lib/ops";
  import { sendSlideToCanvas, listFigCanvases } from "../../../lib/project/convert";
  import { touchActivityLock } from "../../../lib/bridge/activityLock";
  import { createAutosave, ConflictError } from "../../../lib/autosave";
  import { registerFlushable } from "../../lifecycle";
  import { pointerDrag } from "../../../lib/ui/pointerDrag";
  import { initializeEditor } from "../../editorHandoff";
  import { deckRevision, figRevision, bumpFigRevision } from "../../scholar/revisions";
  import { handleKey, handleEditorPaste } from "../../../lib/keyboard";
  import Toolbar from "../../../lib/Toolbar.svelte";
  import Canvas from "../../../lib/Canvas.svelte";
  import Inspector from "../../../lib/Inspector.svelte";
  import ArrangeHud from "../../../lib/ArrangeHud.svelte";
  import CascadePopover from "../../../lib/CascadePopover.svelte";
  import { trackCascadeAdapter, openTrackCascade } from "./animator/cascadeTracks";
  import FluxFigMenu from "../../../lib/FluxFigMenu.svelte";
  import Xray from "../../../lib/Xray.svelte";
  import PlotImporter, { type PlotPick } from "../../../lib/PlotImporter.svelte";
  import { readIncomingPlot } from "../../../lib/io";
  import { compileSlide, semanticTargets, trackDuration } from "../../../lib/slide/compile";
  import { staggerSpan } from "../../../lib/slide/stagger";
  import PresetPicker from "../../../lib/PresetPicker.svelte";
  import AnimatePanel from "./AnimatePanel.svelte";
  import PropertiesPane from "./animator/PropertiesPane.svelte";
  import GhostCopyControls from "./animator/GhostCopyControls.svelte";
  import GhostTransformDialog from "./GhostTransformDialog.svelte";
  import { ghostBirth, objectLabel } from "./animator/ghostEditing";
  import { hoverTrackId } from "./animator/animatorState";
  import DeckPicker from "./DeckPicker.svelte";
  import SlidePresetMenu from "./SlidePresetMenu.svelte";
  import PresentOverlay from "./PresentOverlay.svelte";
  import SlideThumb from "./SlideThumb.svelte";
  import { slideLayout } from "./slideLayoutStore";
  import { pushToast, errMsg } from "../../../lib/toast";

  // Shared components (Inspector/Toolbar) read this to hide figure-only
  // affordances / accent the mode title. Context, so figure mode is untouched.
  setContext("flux-editor-mode", "slide");

  // `active` (W16): false when this pane is kept-alive but hidden — pause the
  // build preview so its animation loop doesn't run off-screen.
  let { focused = true, active = true, paneId = "" }: { focused?: boolean; active?: boolean; paneId?: string } = $props();

  const pm = get(projectModel);
  let ready = $state(false);
  let loadError = $state<string | null>(null);
  let decks = $state<DeckListItem[]>([]);
  let alive = true;
  let ownsEditor = false;
  let deckOpenEpoch = 0;
  let activeDeckId = $state<string | null>(null);
  let unsubDirty: (() => void) | undefined;
  let unsubFigRev: (() => void) | undefined;
  let unsubDeckRev: (() => void) | undefined;
  let unregCompanion: (() => void) | undefined;
  let unregEditAdapter: (() => void) | undefined;
  let inspectorTab = $state<"object"|"animation"|"slide"|"deck">("object");
  let ghostHidden = $state(true);
  let ghostDialog = $state<{sourceId: string; beatIndex: number; original: "stay" | "disappear" | "transform"} | null>(null);
  let openingRequest = $state(0);
  let consumingOpenRequest = $state(false);
  $effect(() => {
    const request = $openSlideRequest;
    if (!ready || !request || consumingOpenRequest || openingRequest === request.n) return;
    openingRequest = request.n; consumingOpenRequest = true;
    void (async () => {
      try {
      const loaded = activeDeckId === request.deckId || await openDeck(request.deckId);
      if (get(openSlideRequest)?.n !== request.n) return;
      if (loaded && request.slideId && get(deckOverlay)?.slides.some(s => s.id === request.slideId)) selectSlide(request.slideId);
      openSlideRequest.set(null);
      } finally { consumingOpenRequest = false; }
    })();
  });
  let deckDiverged = $state(false);

  const overlay = $derived($deckOverlay);
  const stage = $derived(overlay?.stage ?? slideOps.DEFAULT_STAGE);
  const theme = $derived(resolveTheme(overlay?.theme));
  const slideIds = $derived(overlay?.slides.map((s) => s.id) ?? []);
  const activeSlide = $derived.by(() => {
    void $project; // composedSlide reads the project non-reactively
    void overlay;
    const sid = $activeFigureId;
    return sid ? composedSlide(sid) : null;
  });
  const plotTags = $derived.by(() => {
    const plots = activeSlide?.elements.filter(e => e.type === "plot") ?? [];
    return new Map(plots.length > 1 ? plots.map((p,i) => [p.id, `Plot ${i+1}`]) : []);
  });
  const editLabel = $derived.by(() => {
    const destination = $editDestination;
    if (destination.kind === "design") return "Design · initial object properties";
    const index = activeSlide?.beats.findIndex(b => b.id === destination.beatId) ?? -1;
    return index > 0 ? `Editing after ${index} · ${activeSlide?.beats[index]?.label || "Step"}` : "Design";
  });
  const selectedUnbornGhosts = $derived.by(() => {
    const unborn = new Set($slideCanvasPresentation.unbornElementIds ?? []);
    return [...$selection].filter(id => unborn.has(id)).flatMap(id => {
      const birth = ghostBirth(activeSlide, id);
      return birth ? [{id, ...birth}] : [];
    });
  });
  function editGhostDestination(targetId: string) {
    const birth = ghostBirth(activeSlide, targetId);
    if (!birth?.track.id) return;
    stopPreview();
    if (birth.track.disabled) commitDeckLive(d => slideOps.setTrackEnabled(d, activeSlide!.id, birth.track.id!, true));
    activeBeat.set(birth.beatIndex);
    selTrackIds.set([birth.track.id]);
    enterEndpointEdit([birth.track.id], "t2");
    inspectorTab = "animation";
  }
  $effect(() => { if ($selTrackIds.length) { inspectorTab = "animation"; inspectorHidden.set(false); } });
  const canvasPresentation = $derived.by(() => {
    const id = $hoverTrackId ?? $selTrackIds[$selTrackIds.length - 1];
    const t = activeSlide?.beats.flatMap(b => b.tracks).find(t => t.id === id);
    const selected = $selection.size === 1 ? [...$selection][0] : undefined;
    const ghostDrag = selected && (ghostBirth(activeSlide, selected) || activeSlide?.beats[$activeBeat]?.tracks.some(track => track.ghostFrom === selected));
    return { ...$slideCanvasPresentation, stage, ...(ghostDrag ? {preferredDragTargetId: selected} : {}), ...(t && !t.target.startsWith("@") ? { highlight: { elementId:t.target, ...(activeSlide && (t.part || t.selector) ? {partIds:semanticTargets(t,activeSlide,{plotManifest:id=>$plotManifests[id]})} : {}) } } : {}), ghostHidden };
  });
  // What the Background swatch shows: the slide's own override, else the color
  // it actually rests at (deck default → theme) — never a hardcoded dark.
  const effectiveBg = $derived(
    activeSlide && overlay ? (activeSlide.background ?? slideDefaultBackground(overlay)) : "#100f0f",
  );

  // --- external edits: reload-or-banner (fig/'s W7 UX, mirrored) --------------
  async function onDeckRevision() {
    if (!pm || !ready) return;
    decks = await listProjectDecks(pm.root); // an agent may have added/removed a deck
    if (!activeDeckId) return;
    if (get(figDirty)) {
      if (await deckDiskDiverged(pm.root, activeDeckId)) deckDiverged = true;
      return;
    }
    if (await deckDiskDiverged(pm.root, activeDeckId)) {
      await openDeck(activeDeckId, { force: true, preserveView: true });
    }
  }
  async function reloadDeckTheirs() {
    if (!pm || !activeDeckId) return;
    // re-seeds baseline + clears dirty; preserveView keeps the user's slide/beat
    await openDeck(activeDeckId, { force: true, preserveView: true });
    deckDiverged = false;
  }
  async function overwriteDeckMine() {
    if (!pm) return;
    await saveDeckFrom(pm.root, { force: true }); // editor's version wins
    decks = await listProjectDecks(pm.root);
    deckDiverged = false;
  }

  // --- autosave (shared controller: stay-dirty, retry, sticky error toast) ----
  const autosave = createAutosave({
    name: "deck",
    delay: 700,
    isDirty: () => !!pm && ready && get(figDirty),
    save: async () => {
      if (!pm) return;
      try {
        await saveDeckFrom(pm.root); // clears the dirty flag only on success
      } catch (e) {
        if (e instanceof ConflictError) deckDiverged = true;
        throw e;
      }
      decks = await listProjectDecks(pm.root);
    },
  });
  const autosaveStatus = autosave.status;
  const autosaveError = autosave.error;
  const saveErr = autosave.error;

  function surfaceDiagnostics(diags: DeckDiag[]) {
    if (!diags.length) return;
    pushToast("error", `Deck assets: ${diags.length} problem${diags.length > 1 ? "s" : ""}`, {
      detail: diags.map((d) => d.reason).join("\n"),
    });
  }

  // --- deck switching / management --------------------------------------------
  const lastDeckKey = (root: string) => `flux.slide.lastDeck:${root}`;
  function rememberDeck(root: string, id: string | null) {
    try { if (id) localStorage.setItem(lastDeckKey(root), id); } catch { /* ignore */ }
  }
  function lastDeckId(root: string): string | null {
    try { return localStorage.getItem(lastDeckKey(root)); } catch { return null; }
  }

  // `preserveView` (external-change reloads — fig/'s W10 rule, mirrored): an
  // agent editing the deck on disk must not yank the user to slide 1 or re-fit
  // their zoom. Keep the current slide + beat where they still exist; the load
  // itself lands on slides[0], so restore through selectSlide (the sanctioned
  // switch — display reconciliation included).
  async function openDeck(
    id: string,
    opts: { force?: boolean; preserveView?: boolean } = {},
  ): Promise<boolean> {
    if (!pm || !alive) return false;
    const epoch=++deckOpenEpoch;
    const isCurrent=()=>alive && epoch===deckOpenEpoch;
    if (!opts.force && id === activeDeckId) return true;
    const keepSlide = opts.preserveView ? get(activeFigureId) : null;
    const keepBeat = opts.preserveView ? get(activeBeat) : 0;
    const keepDestination=opts.preserveView?get(editDestination):null;
    const keepViewport=opts.preserveView?{...get(viewport)}:null;
    const keepFit=opts.preserveView&&fitted;
    try {
      await autosave.flush();
      if(!isCurrent())return false;
      const loaded = await loadDeckInto(pm.root, id, {isCurrent});
      if(!isCurrent())return false;
      if (!loaded) {
        pushToast("error", "Couldn't open that deck — its file may be missing or corrupt.");
        return false;
      }
      surfaceDiagnostics(loaded.diagnostics);
      activeDeckId = loaded.deck.id;
      rememberDeck(pm.root, activeDeckId);
      const nextDecks = await listProjectDecks(pm.root);
      if(!isCurrent())return false;
      decks=nextDecks;
      animatorOpen = animatorRemembered();
      const kept = keepSlide ? loaded.deck.slides.find((s) => s.id === keepSlide) : null;
      if (kept) {
        selectSlide(kept.id); // restore document selection, then the explicit editing view
        const clamped = Math.max(0, Math.min(keepBeat, (kept.beats?.length ?? 1) - 1));
        if (clamped !== get(activeBeat)) activeBeat.set(clamped);
        if(keepDestination?.kind==="after"&&kept.beats.some(b=>b.id===keepDestination.beatId))setEditDestination(keepDestination);
        if(keepFit)fitViewport();else if(keepViewport){writingFit=true;viewport.set(keepViewport);writingFit=false;fitted=false;}
      } else {
        fitViewport(); // deck switch / kept slide gone — the old full re-fit
      }
      return true;
    } catch (e) {
      if(!isCurrent())return false;
      pushToast("error", "Couldn't open that deck", { detail: errMsg(e) });
      return false;
    }
  }

  let deckBusy = $state(false);
  async function newDeck() {
    if (!pm || deckBusy) return;
    deckBusy = true;
    try {
      await autosave.flush();
      const d = await createDeckInProject(pm.root, { title: `Deck ${decks.length + 1}`, theme: overlay?.theme });
      activeDeckId = d.id;
      rememberDeck(pm.root, d.id);
      decks = await listProjectDecks(pm.root);
      animatorOpen = animatorRemembered();
      fitViewport();
    } catch (e) {
      pushToast("error", "Couldn't create the deck", { detail: errMsg(e) });
    } finally {
      deckBusy = false;
    }
  }
  async function duplicateDeck(id: string) {
    if (!pm || deckBusy) return;
    deckBusy = true;
    try {
      await autosave.flush();
      const newId = await duplicateDeckBridge(pm.root, id);
      decks = await listProjectDecks(pm.root);
      if (newId) await openDeck(newId);
      else pushToast("error", "Couldn't duplicate that deck.");
    } catch (e) {
      pushToast("error", "Couldn't duplicate that deck", { detail: errMsg(e) });
    } finally {
      deckBusy = false;
    }
  }
  async function deleteDeck(id: string) {
    if (!pm || decks.length <= 1) return;
    if (typeof window !== "undefined" && !window.confirm("Remove this deck from the project? Its file stays on disk.")) return;
    const wasActive = id === activeDeckId;
    try {
      const ok = await deleteDeckBridge(pm.root, id);
      if (!ok) {
        pushToast("error", "Couldn't remove that deck.");
        return;
      }
      decks = await listProjectDecks(pm.root);
      if (wasActive && decks[0]) await openDeck(decks[0].id);
    } catch (e) {
      pushToast("error", "Couldn't remove that deck", { detail: errMsg(e) });
    }
  }

  // --- slide lifecycle (deck ops through the ONE pure core) --------------------
  function onAddSlide() {
    let newId = "";
    commitDeckLive((d) => {
      newId = slideOps.addSlide(d, { name: `Slide ${d.slides.length + 1}`, layout: "content-figure", starters: true }).id;
    });
    if (newId) selectSlide(newId);
  }
  function onDuplicateSlide(id: string) {
    let nid: string | null = null;
    commitDeckLive((d) => {
      nid = slideOps.duplicateSlide(d, id);
    });
    if (nid) selectSlide(nid);
  }
  function onDeleteSlide(id: string) {
    if ((overlay?.slides.length ?? 0) <= 1) return;
    let next: string | null = null;
    commitDeckLive((d) => {
      next = slideOps.deleteSlide(d, id).nextActiveId;
    });
    if (next) selectSlide(next);
  }

  // --- filmstrip drag-to-reorder ------------------------------------------------
  let dragIdx = $state<number | null>(null);
  let dropIdx = $state<number | null>(null);
  function moveSlide(from: number, to: number) {
    if (from == null || from === to || !overlay) return;
    const ids = overlay.slides.map((s) => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    commitDeckLive((dd) => slideOps.reorderSlides(dd, ids));
  }

  // --- deck / slide panels --------------------------------------------------------
  function onTitleInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    commitDeckLive((dd) => slideOps.setDeckMeta(dd, { title: v }), { coalesce: "deck-title" });
  }
  function onThemeChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    commitDeckLive((dd) => slideOps.setTheme(dd, v));
  }
  function onStageChange(e: Event) {
    const i = Number((e.target as HTMLSelectElement).value);
    const p = slideOps.STAGE_PRESETS[i];
    if (p) {
      commitDeckLive((dd) => slideOps.setStageSize(dd, { width: p.width, height: p.height }));
      fitViewport(); // stage change re-frames every slide
    }
  }
  function onSlideName(v: string) {
    const sid = $activeFigureId;
    if (!sid) return;
    commitDeckLive((dd) => slideOps.setSlide(dd, sid, { name: v }), { coalesce: `slide-name:${sid}` });
  }
  function onSlideNotes(v: string) {
    const sid = $activeFigureId;
    if (!sid) return;
    commitDeckLive((dd) => slideOps.setSlide(dd, sid, { notes: v }), { coalesce: `slide-notes:${sid}` });
  }
  function onSlideTransition(v: string) {
    const sid = $activeFigureId;
    if (!sid) return;
    commitDeckLive((dd) => slideOps.setSlide(dd, sid, { transition: v as TransitionKind }));
  }
  // Background edits write the PROJECTED Figure.background (the canvas paints
  // it live); the save fold-back turns it into slide.background (§3.4).
  function onSlideBackground(v: string) {
    const sid = $activeFigureId;
    if (!sid) return;
    commit((p) => {
      const f = p.figures.find((ff) => ff.id === sid);
      if (f) f.background = v;
    });
  }

  // --- slide presets (machine-global library, FluxConfig/presets/slides) --------
  let presetMenu = $state<null | { mode: "insert" } | { mode: "save"; slideId: string }>(null);

  // --- Send to canvas (slide → paper figure) ------------------------------------
  let sendOpen = $state(false);
  let sendCanvases = $state<{ id: string; name: string }[]>([]);
  async function openSendToCanvas() {
    if (!pm) return;
    sendCanvases = await listFigCanvases(pm.root);
    sendOpen = true;
  }
  async function doSendToCanvas(canvasId: string | null) {
    sendOpen = false;
    const sid = $activeFigureId;
    const s = sid ? composedSlide(sid) : null;
    if (!pm || !s || !overlay) return;
    try {
      const res = await sendSlideToCanvas(pm.root, s, overlay, canvasId);
      bumpFigRevision();
      pushToast("info", `Sent to canvas as "${res.name}"`, {
        detail: "It is now a paper figure (it will appear in @fig).",
      });
    } catch (e) {
      pushToast("error", "Couldn't send to canvas", { detail: errMsg(e) });
    }
  }

  // --- draggable filmstrip edge → left-rail width (the animator gutter, turned
  // vertical; persists via slideLayout like animatorH) ---------------------------
  let filmResize = $state(false);
  let cancelFilmResize: (() => void) | null = null;
  let cancelRailResize: (() => void) | null = null;
  let filmEl = $state<HTMLElement | null>(null);
  const FILM_DEFAULT_W = 172;
  const filmMaxW = () => Math.max(FILM_DEFAULT_W, Math.round(window.innerWidth * 0.5));
  function startFilmDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    cancelFilmResize?.();
    const original = get(slideLayout).filmstripW;
    filmResize = true;
    cancelFilmResize = pointerDrag(e, moveFilmDrag,
      () => slideLayout.update(s => ({ ...s, filmstripW: original })), endFilmDrag);
  }
  function moveFilmDrag(e: PointerEvent) {
    if (!filmResize || !filmEl) return;
    const w = Math.max(120, Math.min(filmMaxW(), e.clientX - filmEl.getBoundingClientRect().left));
    slideLayout.update((s) => ({ ...s, filmstripW: Math.round(w) }));
  }
  function endFilmDrag() {
    filmResize = false;
    cancelFilmResize = null;
  }
  function resetFilmW() {
    slideLayout.update((s) => ({ ...s, filmstripW: FILM_DEFAULT_W }));
  }

  // --- draggable rail edge → right-rail width (same pattern; the store's
  // inspectorW was persisted-but-dormant until this gutter landed) -------------
  let railResize = $state(false);
  let slideBodyEl = $state<HTMLElement | null>(null);
  const RAIL_DEFAULT_W = 248;
  const railMaxW = () => Math.max(RAIL_DEFAULT_W, Math.round(window.innerWidth * 0.4));
  function startRailDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    cancelRailResize?.();
    const original = get(slideLayout).inspectorW;
    railResize = true;
    cancelRailResize = pointerDrag(e, moveRailDrag,
      () => slideLayout.update(s => ({ ...s, inspectorW: original })), endRailDrag);
  }
  function moveRailDrag(e: PointerEvent) {
    if (!railResize || !slideBodyEl) return;
    const w = Math.max(200, Math.min(railMaxW(), slideBodyEl.getBoundingClientRect().right - e.clientX));
    slideLayout.update((s) => ({ ...s, inspectorW: Math.round(w) }));
  }
  function endRailDrag() {
    railResize = false;
    cancelRailResize = null;
  }
  function resetRailW() {
    slideLayout.update((s) => ({ ...s, inspectorW: RAIL_DEFAULT_W }));
  }

  // Fit remains live while the dock/rails resize. A deliberate zoom or pan
  // exits Fit; resizing then preserves the user's focal point and scale.
  let canvasWrapEl = $state<HTMLElement | null>(null);
  let fitted = $state(true);
  let writingFit = false;
  function fitViewport() {
    fitted = true;
    void tick().then(() => {
      const el = canvasWrapEl, st = get(deckOverlay)?.stage ?? slideOps.DEFAULT_STAGE;
      if (!el) return;
      const w=el.clientWidth,h=el.clientHeight;
      const z=Math.max(.05,Math.min(16,Math.min((w-48)/st.width,(h-48)/st.height)));
      writingFit = true;
      viewport.set({panX:(w-st.width*z)/2,panY:(h-st.height*z)/2,zoom:z});
      writingFit = false;
    });
  }
  $effect(() => {
    const el=canvasWrapEl; if(!el)return;
    let width=el.clientWidth,height=el.clientHeight;
    const ro=new ResizeObserver(() => {
      const w=el.clientWidth,h=el.clientHeight;
      if(!w||!h)return;
      if(untrack(()=>fitted)) fitViewport();
      else { writingFit=true;viewport.update(v=>({...v,panX:v.panX+(w-width)/2,panY:v.panY+(h-height)/2}));writingFit=false; }
      width=w;height=h;
    });
    ro.observe(el);
    let initial=true;
    const off=viewport.subscribe(()=>{if(initial){initial=false;return;}if(!writingFit)fitted=false;});
    return ()=>{ro.disconnect();off();};
  });

  // --- animator dock: on-demand, remembered per deck ----------------------------
  let animatorOpen = $state(false);
  const animKey = () => `flux.slide.animator:${pm?.root ?? ""}:${activeDeckId ?? ""}`;
  function animatorRemembered(): boolean {
    try { return localStorage.getItem(animKey()) === "1"; } catch { return false; }
  }
  function toggleAnimator() {
    animatorOpen = !animatorOpen;
    try { localStorage.setItem(animKey(), animatorOpen ? "1" : "0"); } catch { /* ignore */ }
    if (!animatorOpen) {
      stopPreview();
      exitEndpointEdit(); // closing the animator ends any endpoint checkout
    }
  }

  const animationIssues=$derived(activeSlide ? compileSlide(activeSlide,stage,{plotManifest:id=>$plotManifests[id]}).issues : []);
  function inspectIssue(trackId?:string){
    if(!activeSlide||!trackId)return;
    const bi=activeSlide.beats.findIndex(b=>b.tracks.some(t=>t.id===trackId));
    if(bi>=0){activeBeat.set(bi);selTrackIds.set([trackId]);animatorOpen=true;inspectorTab="animation";}
  }
  // --- inline build preview (present-in-place via the ONE player) ---------------
  let previewing = $state(false);
  let previewHost = $state<HTMLElement | undefined>();
  let pvW = $state(0);
  let pvH = $state(0);
  let player: Player | undefined;
  let pvStage = $state(slideOps.DEFAULT_STAGE);
  const pvScale = $derived(pvW > 0 && pvH > 0 ? Math.min(pvW / pvStage.width, pvH / pvStage.height) : 1);

  function playerOpts(d: Deck) {
    return {
      theme: resolveTheme(d.theme),
      assetUrl: (id: string) => getAssetData(id),
      assetSize: (id: string) => assetDisplaySize(get(project), id),
      plotGen: get(plotGen),
      deckBackground: d.background,
      mode: "present" as const,
      plotManifest: (id: string) => get(plotManifests)[id],
      // A talk previews with motion regardless of the OS setting — matches
      // Present and the exported runtime (which force it off too).
      reducedMotion: false,
    };
  }
  let previewTime = $state(0);
  let previewPlaying = $state(false);
  let previewLoop = $state(false);
  let previewGeneration = 0;
  let previewSlideIndex = 0;
  let previewAssetGenerations = $state<Record<string, number>>({});
  let unsubscribeFrame: (() => void) | undefined;
  async function ensurePreview(): Promise<Player | undefined> {
    if (player) return player;
    const generation=++previewGeneration;
    const deck=currentDeck(),sid=$activeFigureId;
    if(!deck||!sid)return;
    previewSlideIndex=deck.slides.findIndex(s=>s.id===sid);
    if(previewSlideIndex<0)return;
    const slide=deck.slides[previewSlideIndex],generations=get(plotGen),dependencies=new Set<string>();
    for(const element of slide.elements)if(element.type==="plot")dependencies.add(element.assetId);
    for(const beat of slide.beats)for(const track of beat.tracks)if(track.to?.assetId)dependencies.add(track.to.assetId);
    previewAssetGenerations=Object.fromEntries([...dependencies].map(id=>[id,generations[id]??0]));
    pvStage=deck.stage;previewing=true;
    await tick();
    if(generation!==previewGeneration||!previewHost)return;
    try {
      player=createPlayer(previewHost,deck,playerOpts(deck));
      unsubscribeFrame=player.on("frame",()=>{
        if(!player)return;
        const state=player.state();previewTime=state.time;previewPlaying=state.playing;
        if(state.beat!==get(activeBeat))activeBeat.set(state.beat);
      });
      return player;
    } catch(e) { stopPreview();pushToast("error",`Preview failed: ${errMsg(e)}`); }
  }
  let previewStartBeat=0;
  let previewRange: "step" | "from" | "slide" = "from";
  async function startPreview(startBeat = 0, range: "step" | "from" | "slide" = startBeat === 0 ? "slide" : "from") {
    const p=await ensurePreview();if(!p)return;
    const from=Math.max(1,startBeat); previewStartBeat=startBeat;previewRange=range;
    p.play({slide:previewSlideIndex,fromBeat:from,...(range === "step" ? {toBeat:from} : {}),loop:previewLoop});
    previewPlaying=p.state().playing;
  }
  async function seekPreview(beat:number,time:number) {
    const p=await ensurePreview();if(!p)return;
    p.pause();p.seek(previewSlideIndex,beat,time);previewTime=p.state().time;previewPlaying=false;
  }
  function pausePreview(){player?.pause();previewPlaying=false;}
  function resumePreview(){if(!player)return;const state=player.state();if(state.time>=state.duration){void startPreview(previewStartBeat,previewRange);return;}player.resume();previewPlaying=player.state().playing;}
  function stopPreview() {
    previewGeneration++;unsubscribeFrame?.();unsubscribeFrame=undefined;
    player?.destroy();player=undefined;previewing=false;previewPlaying=false;previewTime=0;
    previewAssetGenerations={};
  }
  $effect(()=>{
    const generations=$plotGen;
    if(previewing&&Object.entries(previewAssetGenerations).some(([id,atStart])=>(generations[id]??0)!==atStart))stopPreview();
  });
  function toggleLoop(){previewLoop=!previewLoop;if(previewPlaying)void startPreview(previewRange==="slide"?0:$activeBeat,previewRange);}
  $effect(()=>{if(!active&&previewing)stopPreview();});
  let lastPreviewSlide:string|null=null;
  $effect(()=>{const sid=$activeFigureId;if(sid!==lastPreviewSlide){lastPreviewSlide=sid;stopPreview();}});
  $effect(()=>{
    if(!previewHost)return;
    previewHost.style.transformOrigin="center center";
    previewHost.style.transform=`scale(${pvScale})`;
  });

  // A morph target is an asset dependency; choosing it never places a second
  // object on the stage. Import uses the shared plot/sidecar loader.
  let morphFor = $state<{deckId:string;slideId:string;targetId:string;trackId?:string;beatId?:string}|null>(null);
  function chooseMorph(targetId:string,trackId?:string) {
    if(!overlay||!activeSlide)return;
    stopPreview();
    morphFor={deckId:overlay.id,slideId:activeSlide.id,targetId,trackId,beatId:activeSlide.beats[$activeBeat]?.id};
    importerOpen.set(true);
  }
  async function acceptMorphTarget(picks:PlotPick[]) {
    const request=morphFor;
    if(!request||!picks.length)return;
    if(picks.length!==1)throw new Error("Choose one plot for the next data state.");
    const incoming=await readIncomingPlot(picks[0].abs);
    if(incoming.el.type!=="plot")throw new Error("Choose an SVG plot for a data morph.");
    if(!get(importerOpen) || morphFor !== request) return;
    if(get(deckOverlay)?.id!==request.deckId || get(activeFigureId)!==request.slideId) return;
    const source=incoming.el.source;let addedId:string|undefined;let selectedBeat=0;
    commitDeckLive(d=>{
      const s=slideOps.slideById(d,request.slideId);if(!s?.elements.some(e=>e.id===request.targetId))return;
      let beat=request.trackId?s.beats.find(b=>b.tracks.some(t=>t.id===request.trackId)):s.beats.find(b=>b.id===request.beatId);
      if(!beat || beat===s.beats[0])beat=slideOps.addBeat(d,s.id,{label:"Data change",advance:"click"})??undefined;
      if(!beat)return;
      if(!d.assets.some(a=>a.id===incoming.asset.id)) d.assets.push(incoming.asset);
      const t=slideOps.setTransform(d,s.id,beat.id,request.targetId,{toAssetId:incoming.asset.id,svgPath:source?.svgPath,manifestPath:source?.manifestPath});
      addedId=t?.id;selectedBeat=s.beats.indexOf(beat);
    });
    if(addedId){activeBeat.set(selectedBeat);selTrackIds.set([addedId]);editAfterBeat(selectedBeat);}
  }
  $effect(()=>{if(!$importerOpen)morphFor=null;});

  // --- present mode ---------------------------------------------------------------
  let presentOpen = $state(false);
  // $state.raw, NOT $state: a deep $state proxy would ride into the player,
  // where the transform engine structuredClones deck elements
  // (transformPreState) — structuredClone(proxy) throws DataCloneError and
  // createPlayer dies mid-construction, leaving Present frozen on the first
  // slide (keys/clicks all hit `if (!player) return`). The deck is composed
  // once per launch and never mutated in place — reassignment reactivity is
  // exactly right. (The same Svelte-5 trap as the ☆ Library payloads.)
  let presentDeck = $state.raw<Deck | null>(null);
  let presentStart = $state(0);
  function launchPresent(fromStart: boolean) {
    exitEndpointEdit();
    const d = currentDeck();
    if (!d?.slides.length) return;
    presentDeck = d;
    presentStart = fromStart ? 0 : Math.max(0, d.slides.findIndex((s) => s.id === $activeFigureId));
    presentOpen = true;
  }

  // --- export ----------------------------------------------------------------------
  let canExport = $state(false);
  let exporting = $state(false);
  let exportMsg = $state<{ ok: boolean; text: string } | null>(null);
  let exportMsgTimer: ReturnType<typeof setTimeout> | undefined;
  async function onExport() {
    const id = activeDeckId;
    if (!pm || !id || exporting) return;
    exitEndpointEdit(); // export the persisted deck, never a checkout view
    exporting = true;
    exportMsg = null;
    try {
      await autosave.flush(); // export the latest, not a stale file
      const path = await exportDeckBridge(pm.root, id);
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

  // --- the animation chords (animator-open only; rework §8) ----------------------
  // Selection sources are honored identically by construction: canvas click,
  // ctrl-click deep-select, and X-ray rows all write the same selection/
  // partSelection stores these read.
  function selectionTargets(): string[] {
    const ps = $partSelection;
    if ($selection.size) return [...$selection];
    return ps ? [ps.elementId] : [];
  }
  /** Ctrl+Shift+A / Ctrl+Shift+D: give every selected object/part an
   *  appearance (enter) or disappearance (exit) with the smart per-kind
   *  defaults, into the active beat (never beat 0 — beat 1 auto-creates). */
  function addAppearance(exit: boolean, emphasize = false) {
    const sid=$activeFigureId,s=activeSlide,ids=selectionTargets(),part=$partSelection;
    if(!sid||!s||!ids.length)return;
    let bi=$activeBeat,created:string[]=[];
    commitDeckLive(d=>{
      const sl=slideOps.slideById(d,sid);if(!sl)return;
      if(bi<1){if(sl.beats.length<2)slideOps.addBeat(d,sid,{label:"Step 1",advance:"click"});bi=Math.max(1,sl.beats.length-1);}
      const b=sl.beats[bi];if(!b)return;
      for(const id of ids){
        const el=s.elements.find(e=>e.id===id);if(!el)continue;
        const track=part&&!exit ? suggestTrack($plotManifests[el.type==="plot"?el.assetId:""],id,part.partId) : suggestElementTrack(el,{exit,...(part?{part:part.partId}:{})});
        if(emphasize){track.preset="highlight";track.duration=500;}
        // New effect follows this target's prior effects in the step, so
        // entrance → emphasis → exit is useful immediately and never replaces.
        const prior=b.tracks.filter(t=>t.target===id&&(t.part??"")===(track.part??"")&&familyOf(t)==="appearance");
        track.start=prior.reduce((end,t)=>Math.max(end,(t.start??0)+trackDuration(t)+staggerSpan(t,semanticTargets(t,sl,{plotManifest:id=>get(plotManifests)[id]}).length)),0);
        const added=slideOps.appendAnimation(d,sid,b.id,track);if(added?.id)created.push(added.id);
      }
    });
    activeBeat.set(bi);selTrackIds.set(created);inspectorTab="animation";
  }
  function animationAction(action:"appear"|"change"|"ghost"|"emphasize"|"disappear") {
    stopPreview();
    if(action==="ghost")openGhostDialog();
    else if(action==="change")addOrToggleTransform();
    else addAppearance(action==="disappear",action==="emphasize");
  }
  function openGhostDialog() {
    const ids = selectionTargets(), s = activeSlide;
    if (!s || ids.length !== 1) return;
    const sourceId = ids[0], beatIndex = Math.max(1, $activeBeat);
    const birth = ghostBirth(s, sourceId);
    if (birth && birth.beatIndex >= beatIndex) {
      pushToast("info", "Choose a later step to copy this ghost", { detail: "A ghost can become a source after its birth step." });
      return;
    }
    const tracks = s.beats[beatIndex]?.tracks.filter(t => t.target === sourceId && !t.part && !t.selector && !t.disabled) ?? [];
    const original = tracks.some(t => familyOf(t) === "transform") ? "transform" : tracks.some(t => ["fadeOut", "popOut", "drawOff", "wipeOut"].includes(t.preset ?? "")) ? "disappear" : "stay";
    ghostDialog = { sourceId, beatIndex, original };
  }
  function createGhosts(count: number, original: "stay" | "disappear" | "transform") {
    const request = ghostDialog, s = activeSlide;
    if (!request || !s) return;
    try {
      const sourceSnapshot = compileSlide(s, stage, {plotManifest: id => get(plotManifests)[id]}).copySourceState(request.sourceId, request.beatIndex);
      if (!sourceSnapshot) throw new Error("The source is unavailable before this step.");
      const result = commitDeckLive(d => {
        const sl = slideOps.slideById(d, s.id)!;
        if (!sl.beats[request.beatIndex]) slideOps.addBeat(d, s.id, {label: `Step ${request.beatIndex}`, advance: "click"});
        return slideOps.addGhostTransform(d, s.id, sl.beats[request.beatIndex].id, request.sourceId, {count, original, sourceSnapshot});
      });
      if (!result?.trackIds.length) return;
      ghostDialog = null;
      activeBeat.set(request.beatIndex);
      selTrackIds.set([result.trackIds[0]]);
      enterEndpointEdit([result.trackIds[0]], "t2");
      inspectorTab = "animation";
    } catch (error) { pushToast("error", "Could not create ghosts", {detail: errMsg(error)}); }
  }
  /** Ctrl+Shift+T: no transform on the selection → create one per selected
   *  element in the active beat (grouped when several) and check out t2
   *  immediately (the mockup's flow: add, then sculpt). A transform already
   *  selected → toggle the t1 ↔ t2 checkout. */
  function addOrToggleTransform() {
    const sid = $activeFigureId;
    const s = activeSlide;
    if (!sid || !s) return;
    const ids = selectionTargets();
    if (!ids.length) return;
    const targetBi = $activeBeat > 0 ? $activeBeat : Math.max(1, s.beats.length - 1);
    const existing = new Map<string, string>(); // target → trackId (active-beat transforms)
    const beat = s.beats[Math.min(targetBi, s.beats.length - 1)];
    for (const t of beat?.tracks ?? []) {
      if (t.id && ids.includes(t.target) && familyOf(t) === "transform") existing.set(t.target, t.id);
    }
    if (existing.size === ids.length) {
      // all selected already have transforms here → toggle the endpoint
      const trackIds = ids.map((id) => existing.get(id)!);
      const cur = $endpointEdit;
      const sameTracks =
        cur && cur.entries.length && cur.entries.some((en) => (en.trackId != null && trackIds.includes(en.trackId)) || ids.includes(en.target));
      const next: "t1" | "t2" = cur && sameTracks && cur.end === "t2" ? "t1" : "t2";
      // t1 with no upstream routes to the BASE (the canvas shows/edits the
      // document state while the t₁ handle is lit).
      enterEndpointEdit(trackIds, next);
      return;
    }
    let beatId = "";
    const created: string[] = [];
    commitDeckLive((d) => {
      const sl = slideOps.slideById(d, sid);
      if (!sl) return;
      let bi = targetBi;
      if (sl.beats.length <= 1) {
        slideOps.addBeat(d, sid, { label: "Beat 1", advance: "click" });
        bi = 1;
      }
      bi = Math.min(bi, sl.beats.length - 1);
      beatId = sl.beats[bi].id;
      for (const id of ids) {
        const t = slideOps.setTransform(d, sid, beatId, id, {});
        if (t?.id) created.push(t.id);
      }
      if (created.length > 1) slideOps.groupTracks(d, sid, beatId, created, "Transform");
      activeBeat.set(bi);
    });
    if (created.length) {
      selTrackIds.set(created);
      enterEndpointEdit(created, "t2");
    }
  }

  // --- keyboard: slide navigation first, then the FIGURE keymap wholesale --------
  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || presentOpen) return; // the presenter overlay owns the keyboard
    // The cascade popover owns the keyboard while open (its own window
    // listener registers later, so this handler must yield first).
    if (get(cascadeState)) return;
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable;
    const inAnimation = !!(e.target as HTMLElement)?.closest?.('[data-command-scope="animation"]');
    if (inAnimation) {
      const mod=e.metaKey||e.ctrlKey;
      if(mod&&e.shiftKey&&["a","d","t"].includes(e.key.toLowerCase())&&!typing) {
        e.preventDefault();animationAction(e.key.toLowerCase()==="a"?"appear":e.key.toLowerCase()==="d"?"disappear":"change");
      }
      return;
    }
    if (previewing && !typing) {
      if(e.key==="Escape"){e.preventDefault();stopPreview();return;}
      if(e.code==="Space"){e.preventDefault();previewPlaying?pausePreview():resumePreview();return;}
      // History remains available while inspecting a frame. Its companion
      // invalidates the captured player before restoring document state.
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&["z","y"].includes(e.key.toLowerCase()))handleKey(e);
      return;
    }
    if (!typing) {
      // F5 presents from the first slide; Shift+F5 from the current one.
      if (e.key === "F5") {
        e.preventDefault();
        launchPresent(!e.shiftKey);
        return;
      }
      // The three animation chords act ONLY while the animator is open
      // (rework §8); elsewhere they do nothing — and never fall through to
      // select-all/duplicate (those branches carry !shiftKey guards now).
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && !e.altKey && animatorOpen) {
        const k = e.key.toLowerCase();
        if (k === "a") { e.preventDefault(); addAppearance(false); return; }
        if (k === "d") { e.preventDefault(); addAppearance(true); return; }
        if (k === "t") { e.preventDefault(); addOrToggleTransform(); return; }
        // ⌃⇧C with ≥2 tracks selected = TRACK cascade; with fewer it falls
        // through to the figure keymap, which opens the ELEMENT cascade.
        if (k === "c" && get(selTrackIds).length >= 2) { e.preventDefault(); openTrackCascade(); return; }
      }
      // Esc: an in-flight canvas gesture aborts first (FIG-12); then an
      // active endpoint checkout exits (restoring the base state); then the
      // figure keymap's normal Esc ladder.
      if (e.key === "Escape" && $endpointEdit) {
        if (gestureCancelHook.fn?.()) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        exitEndpointEdit();
        return;
      }
      // Slide nav with arrows — only when nothing is selected (else the
      // figure keymap nudges the selection).
      if ($selection.size === 0 && !$selectedFrameId && !$partSelection && (overlay?.slides.length ?? 0) > 0) {
        const i = slideIds.indexOf($activeFigureId ?? "");
        if (e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          const n = slideIds[Math.min(slideIds.length - 1, i + 1)];
          if (n) selectSlide(n);
          return;
        }
        if (e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          const n = slideIds[Math.max(0, i - 1)];
          if (n) selectSlide(n);
          return;
        }
      }
    }
    // Everything else: the ONE figure keymap (tools, undo/redo, align,
    // group/ungroup, copy/paste, X-ray, importer, presets, nudges, Esc…).
    handleKey(e);
  }
  $effect(() => {
    if (!focused || !ready) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Paste onto the active slide — the shared figure/slide arbitration
  // (internal elements vs OS-clipboard image; images ride the figure drop
  // pipeline into the deck asset sink).
  function onPaste(e: ClipboardEvent) {
    if (!focused || !ready || presentOpen) return;
    handleEditorPaste(e, $activeFigureId);
  }

  // --- lifecycle ---------------------------------------------------------------------
  onMount(() => {
    void initializeEditor("slide", paneId, () => alive, async () => {
    ownsEditor = true;
    const history = overlayHistoryCompanion();
    unregCompanion = registerHistoryCompanion({
      capture: history.capture,
      restore(snapshot) {
        // Covers every history route, including the shared toolbar and keymap.
        // A player owns a deck snapshot and must never survive its replacement.
        stopPreview();
        history.restore(snapshot);
      },
    });
    unregEditAdapter = registerSlideEditAdapter(stopPreview);
    try {
      if (pm) {
        embeddedProjectRoot.set(pm.root);
        decks = await listProjectDecks(pm.root);
        if (decks.length) {
          const want = lastDeckId(pm.root);
          const ok = await openDeck(want && decks.some((d) => d.id === want) ? want : decks[0].id, { force: true });
          if (!ok && decks[0]) await openDeck(decks[0].id, { force: true });
        } else {
          await createDeckInProject(pm.root, { title: pm.manifest.title });
          decks = await listProjectDecks(pm.root);
          activeDeckId = decks[0]?.id ?? get(deckOverlay)?.id ?? null;
          if (activeDeckId) rememberDeck(pm.root, activeDeckId);
          fitViewport();
        }
      } else {
        loadError = "Slide mode needs an open Flux project.";
      }
    } catch (e) {
      loadError = errMsg(e);
    }
    if(!alive)return;
    ready = true;
    canExport = canExportDeck();
    animatorOpen = animatorRemembered();
    unsubDirty = figDirty.subscribe((d) => {
      if (!ready || !pm || !d) return;
      touchActivityLock("slides"); // defer concurrent agent deck writes while mid-edit
      autosave.schedule();
    });
    let firstFigureRevision=true;
    unsubFigRev=figRevision.subscribe(()=>{
      if(firstFigureRevision){firstFigureRevision=false;return;}
      if(pm)void refreshDeckSources(pm.root).catch(e=>pushToast("error","Could not refresh slide sources",{detail:errMsg(e)}));
    });
    // Live-reload on external slides/ edits (skip the immediate on-subscribe call).
    let firstDeck = true;
    unsubDeckRev = deckRevision.subscribe(() => {
      if (firstDeck) { firstDeck = false; return; }
      void onDeckRevision();
    });
    }).catch(e => { if (alive) loadError = errMsg(e); });
  });

  const unregFlush = registerFlushable({
    id: "slide",
    isDirty: () => !!pm && ready && get(figDirty),
    flush: () => autosave.flush(),
  });

  onDestroy(() => {
    alive=false;deckOpenEpoch++;
    cancelFilmResize?.();endRailDrag();
    unsubDirty?.();
    unsubDeckRev?.();
    unsubFigRev?.();
    stopPreview();
    if (ownsEditor) clearBeatDisplay();
    if (ready) void autosave.flush();
    autosave.dispose();
    unregFlush();
    unregCompanion?.();
    unregEditAdapter?.();
  });
</script>

<svelte:window onpaste={onPaste} />

<div class="slide-mode">
  {#if !ready || loadError}
    <div class="editor-loading" role="status">{loadError ?? "Opening slides…"}</div>
  {:else}
  <header class="deckbar">
    <div class="left">
      {#if overlay}
        <input class="title" value={overlay.title} oninput={onTitleInput} onblur={sealHistory} spellcheck="false" aria-label="Deck title" />
      {/if}
    </div>
    <div class="right">
      <button class="btn" class:active={animatorOpen} onclick={toggleAnimator} disabled={!overlay}
        title="Toggle the animation dock (beats, tracks, preview)">Animate ⏱</button>
      <button class="btn" onclick={() => launchPresent(false)} disabled={!overlay?.slides.length}
        title="Present from the current slide · F5 from the start, ⇧F5 from here">Present ▶</button>
      <button class="btn ghost" onclick={onExport} disabled={!overlay || !canExport || exporting}
        title={canExport ? "Export a self-contained offline .html" : "Export is available in the desktop app"}>
        {exporting ? "Exporting…" : "Export"}
      </button>
      {#if $saveErr}
        <button class="saveerr" title={`Autosave failed — ${$saveErr}. Your edits are still in memory; it will retry on the next change.`} onclick={() => void autosave.flush()}>⚠ unsaved</button>
      {:else}
        <span class="dirty" class:on={$figDirty} title="Unsaved changes">●</span>
      {/if}
    </div>
  </header>

  <!-- the SHARED figure toolbar: tools, undo/redo, rulers, zoom -->
  <Toolbar saveStatus={$autosaveStatus} saveError={$autosaveError} retrySave={() => void autosave.flush()} />

  <div class="body" bind:this={slideBodyEl} style={`--film-w:${$slideLayout.filmstripW}px; --insp-w:${$slideLayout.inspectorW}px;`}>
    {#if $leftRailHidden}
      <button class="edgetab left" title="Show slides (Ctrl+B)" onclick={() => leftRailHidden.set(false)}>›</button>
    {:else}
    <!-- filmstrip -->
    <aside class="filmstrip" bind:this={filmEl}>
      {#if pm}
        <DeckPicker {decks} activeId={activeDeckId} onSelect={(id) => void openDeck(id)} onNew={newDeck} onDuplicate={duplicateDeck} onDelete={deleteDeck} busy={deckBusy} />
      {/if}
      {#if overlay}
        {#each overlay.slides as s, i (s.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="thumb" class:active={s.id === $activeFigureId}
            class:dragging={dragIdx === i} class:dropbefore={dropIdx === i && dragIdx !== null && dragIdx > i} class:dropafter={dropIdx === i && dragIdx !== null && dragIdx < i}
            draggable="true"
            ondragstart={(e) => { dragIdx = i; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
            ondragover={(e) => { e.preventDefault(); dropIdx = i; if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; }}
            ondrop={(e) => { e.preventDefault(); if (dragIdx !== null) moveSlide(dragIdx, i); dragIdx = null; dropIdx = null; }}
            ondragend={() => { dragIdx = null; dropIdx = null; }}
            onclick={() => selectSlide(s.id)}>
            <span class="n">{i + 1}</span>
            <div class="mini"><SlideThumb slideId={s.id} {stage} /></div>
            <span class="nm">{s.name ?? `Slide ${i + 1}`}</span>
            <div class="thumbacts">
              <button class="ta" title="Duplicate" aria-label="Duplicate slide" onclick={(e) => { e.stopPropagation(); onDuplicateSlide(s.id); }}>⧉</button>
              {#if overlay.slides.length > 1}
                <button class="ta" title="Delete" aria-label="Delete slide" onclick={(e) => { e.stopPropagation(); onDeleteSlide(s.id); }}>×</button>
              {/if}
            </div>
          </div>
        {/each}
        <button class="addslide" onclick={onAddSlide}>+ Add slide</button>
        <button class="addslide" onclick={() => (presetMenu = { mode: "insert" })}
          title="Insert a slide from your machine-global preset library (FluxConfig/presets/slides)">+ Preset</button>
      {/if}
    </aside>
    <!-- the drag gutter sits OUTSIDE the (vertically scrolling) filmstrip so it
         never scrolls away; a flex sibling with negative margins overlays the seam -->
    <div class="film-gutter" class:active={filmResize} role="separator" aria-orientation="vertical"
      aria-label="Resize slide list" onpointerdown={startFilmDrag} ondblclick={resetFilmW}><span class="grip"></span></div>
    {/if}

    <!-- stage: the SHARED figure canvas in frame mode -->
    <main class="stage-col">
      <div class="edit-statebar">
        <div class="edit-switch" aria-label="Canvas edit destination">
          <button class:chosen={$editDestination.kind === "design"} onclick={()=>{stopPreview();setEditDestination({kind:"design"});}} title="Edit original object properties, before animation">Design</button>
          <button class:chosen={$editDestination.kind === "after" && $editDestination.beatId===activeSlide?.beats[$activeBeat]?.id} disabled={$activeBeat===0} onclick={()=>{stopPreview();editAfterBeat();}} title="Create or update changes only at the selected step">Edit after step {$activeBeat || "…"}</button>
        </div>
        <span class="edit-label">{previewing ? `Inspecting step ${$activeBeat} · ${(previewTime/1000).toFixed(2)}s` : editLabel}</span>
        <button class="fit-button" class:chosen={fitted} onclick={fitViewport}>Fit</button>
        <label class="ghost-toggle"><input type="checkbox" bind:checked={ghostHidden}/> Show hidden</label>
      </div>
      {#if animationIssues.length}<details class="animation-issues"><summary>⚠ {animationIssues.length} animation {animationIssues.length===1?"issue":"issues"}</summary>{#each animationIssues as issue}<button onclick={()=>inspectIssue(issue.trackId)}>{issue.reason}</button>{/each}</details>{/if}
      <div class="canvas-wrap" bind:this={canvasWrapEl}>
        {#if ready && overlay}
          <Canvas frame paneActive={active} presentation={canvasPresentation} />
          <ArrangeHud />
          <CascadePopover tracks={trackCascadeAdapter} />
          {#if previewing}
            <div class="preview-overlay">
              <div class="preview-viewport" bind:clientWidth={pvW} bind:clientHeight={pvH}>
                <div class="preview-host" bind:this={previewHost}></div>
              </div>
              <button class="preview-stop" onclick={stopPreview} title="Stop preview">■ Stop</button>
            </div>
          {/if}
        {:else if ready}
          <div class="empty">{loadError ?? "No deck loaded."}</div>
        {:else}
          <div class="empty">Loading deck…</div>
        {/if}
      </div>
      {#if animatorOpen && overlay}
        <AnimatePanel slide={activeSlide} onPreview={startPreview} onAction={animationAction}
          onSeek={seekPreview} onPause={pausePreview} onStop={stopPreview} onResume={resumePreview}
          onUndo={undo} onRedo={redo} onSave={()=>void autosave.flush()} onChooseMorph={chooseMorph}
          time={previewTime} playing={previewPlaying} {previewing} loop={previewLoop} onLoop={toggleLoop} />
      {/if}
    </main>

    <!-- right rail: the SHARED inspector + the slide/deck panels.
         Ctrl+Shift+B (shared keyboard.ts chord) hides the whole rail. -->
    {#if !$inspectorHidden}
    <div class="film-gutter" class:active={railResize} role="separator" aria-orientation="vertical"
      aria-label="Resize right rail" onpointerdown={startRailDrag} ondblclick={resetRailW}><span class="grip"></span></div>
    <aside class="rail">
      <nav class="inspector-tabs" aria-label="Slide inspector">
        {#each ["object","animation","slide","deck"] as tab}
          <button class:chosen={inspectorTab===tab} onclick={()=>inspectorTab=tab as typeof inspectorTab}>{tab[0].toUpperCase()+tab.slice(1)}</button>
        {/each}
      </nav>
      {#if activeSlide && (inspectorTab === "object" || inspectorTab === "animation")}<GhostCopyControls slide={activeSlide} onEditGhost={editGhostDestination}/>{/if}
      {#if selectedUnbornGhosts.length && (inspectorTab === "object" || inspectorTab === "animation")}
        <section class="ghost-unborn" aria-label="Ghost destination">
          {#each selectedUnbornGhosts as ghost (ghost.id)}
            <strong>{activeSlide ? objectLabel(activeSlide, ghost.id) : "Ghost"}</strong>
            <p>Starts at step {ghost.beatIndex} · {activeSlide?.beats[ghost.beatIndex]?.label || "Step"}. Its destination is editable after that step.</p>
            <button onclick={() => editGhostDestination(ghost.id)}>{ghost.track.disabled ? "Enable and edit destination" : "Edit destination"}</button>
          {/each}
        </section>
      {/if}
      {#if inspectorTab==="object" && !selectedUnbornGhosts.length}<Inspector />{/if}
      {#if inspectorTab==="animation" && activeSlide}<PropertiesPane slide={activeSlide} {plotTags} onChooseMorph={chooseMorph}/>{/if}
      {#if overlay && activeSlide}
        <section class="panel" hidden={inspectorTab!=="slide"}>
          <h4>Slide</h4>
          <label class="full">Name
            <input value={activeSlide.name ?? ""} onchange={(e) => onSlideName(e.currentTarget.value)} />
          </label>
          <label class="full">Background
            <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(effectiveBg) ? effectiveBg : "#100f0f"}
              onchange={(e) => onSlideBackground(e.currentTarget.value)} />
          </label>
          <label class="full">Transition
            <select value={activeSlide.transition ?? overlay.defaults.transition} onchange={(e) => onSlideTransition(e.currentTarget.value)}>
              <option value="none">none</option><option value="fade">fade</option>
              <option value="slide">slide</option><option value="push">push</option>
            </select>
          </label>
          <label class="full">Speaker notes
            <textarea rows="3" value={activeSlide.notes ?? ""} oninput={(e) => onSlideNotes(e.currentTarget.value)} onblur={sealHistory}></textarea>
          </label>
          <div class="convertrow">
            <button class="act" onclick={openSendToCanvas} title="Copy this slide's content to a paper-figure canvas (it becomes a real figure and WILL appear in @fig)">Send to canvas…</button>
          </div>
          <div class="convertrow">
            <button class="act" onclick={() => (presetMenu = { mode: "save", slideId: activeSlide.id })}
              title="Save this slide (content, animation, background, media) to your machine-global preset library">Save as preset…</button>
          </div>
          {#if sendOpen}
            <div class="sendmenu">
              {#each sendCanvases as c (c.id)}
                <button onclick={() => void doSendToCanvas(c.id)}>{c.name}</button>
              {/each}
              <button onclick={() => void doSendToCanvas(null)}>+ New canvas</button>
              <button class="ghosty" onclick={() => (sendOpen = false)}>Cancel</button>
            </div>
          {/if}
        </section>
        <section class="panel" hidden={inspectorTab!=="deck"}>
          <h4>Deck</h4>
          <label class="full">Stage
            <select onchange={onStageChange} title="All slides share one stage frame (figure ruler: 96 px/inch)">
              {#each slideOps.STAGE_PRESETS as p, i (p.label)}
                <option value={i} selected={stage.width === p.width && stage.height === p.height}>{p.label}</option>
              {/each}
            </select>
          </label>
          <label class="full">Theme
            <select value={overlay.theme} onchange={onThemeChange}>
              {#each Object.values(BUILTIN_THEMES) as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
            </select>
          </label>
        </section>
      {/if}
    </aside>
    {:else}
      <button class="edgetab right" title="Show right rail (Ctrl+Shift+B)" onclick={() => inspectorHidden.set(false)}>‹</button>
    {/if}
  </div>

  {#if presetMenu}
    <SlidePresetMenu
      mode={presetMenu.mode}
      slideId={presetMenu.mode === "save" ? presetMenu.slideId : $activeFigureId}
      suggestedName={presetMenu.mode === "save" ? (activeSlide?.name ?? "") : ""}
      onClose={() => (presetMenu = null)} />
  {/if}

  {#if exportMsg}
    <div class="export-toast" class:err={!exportMsg.ok} role="status">
      {exportMsg.ok ? "✓" : "⚠"}
      {exportMsg.text}
    </div>
  {/if}

  {#if deckDiverged}
    <div class="disk-toast">
      <span>This deck changed on disk (an agent or another tool edited it).</span>
      <button onclick={reloadDeckTheirs}>Reload theirs</button>
      <button class="ghost" onclick={overwriteDeckMine}>Overwrite with mine</button>
    </div>
  {/if}
  {/if}
</div>

{#if ready && !loadError}
{#if presentOpen && presentDeck}
  <PresentOverlay
    deck={presentDeck}
    theme={resolveTheme(presentDeck.theme)}
    start={{ slide: presentStart, beat: 0 }}
    onClose={() => (presentOpen = false)} />
{/if}

<!-- shared figure surfaces: X-ray, property cockpit, plots/ browser, presets -->
<FluxFigMenu />
<Xray />
<PlotImporter {active} rootOverride={pm?.root ?? ""} title={morphFor ? "Choose next plot data state" : "Plot gallery"} onPick={morphFor ? acceptMorphTarget : undefined} />
<PresetPicker />

{#if ghostDialog && activeSlide}
  <GhostTransformDialog source={objectLabel(activeSlide, ghostDialog.sourceId)} step={`step ${ghostDialog.beatIndex} · ${activeSlide.beats[ghostDialog.beatIndex]?.label || "New step"}`} initialOriginal={ghostDialog.original} onCreate={createGhosts} onClose={() => ghostDialog = null}/>
{/if}
{/if}

<style>
  .editor-loading { margin: auto; padding: 24px; color: var(--c-tx-2); }
  .ghost-unborn{margin:12px;padding:12px;border:1px solid var(--c-line-strong);border-radius:7px;background:var(--c-bg-2);font-size:12px}
  .ghost-unborn p{color:var(--c-tx-2);line-height:1.5;margin:5px 0 10px}.ghost-unborn button{font:inherit;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line-strong);border-radius:5px;padding:6px 8px;cursor:pointer}
  .animation-issues {flex:0 0 auto;color:var(--c-warning,#da702c);padding:5px 12px;font-size:11px;max-height:110px;overflow:auto;border-bottom:1px solid var(--c-line);}
  .animation-issues summary{cursor:pointer;}
  .animation-issues button{display:block;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:5px 0;}
  .edit-statebar { display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--c-line);font-size:11px; }
  .edit-statebar button,.inspector-tabs button { background:var(--c-bg-2);color:var(--c-tx-2);border:1px solid var(--c-line);border-radius:4px;padding:5px 8px;font:inherit;cursor:pointer; }
  .edit-switch { display:flex;gap:3px; }
  .edit-statebar .chosen,.inspector-tabs .chosen { border-color:var(--c-accent);color:var(--c-tx);background:color-mix(in oklab,var(--c-accent) 13%,var(--c-bg)); }
  .edit-statebar button:disabled { opacity:.4;cursor:default; }
  .edit-label { color:var(--c-tx-2);font-size:10px;flex:1; }
  .ghost-toggle { display:flex;align-items:center;gap:4px;white-space:nowrap;color:var(--c-tx-2); }
  .inspector-tabs { display:flex;gap:3px;padding:8px 6px;position:sticky;top:0;background:var(--c-bg);z-index:5;font-size:11px; }
  .inspector-tabs button { flex:1;padding:5px 4px; }
  .panel[hidden] { display:none; }

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
    padding: 5px 14px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-bg-raised);
    flex: 0 0 auto;
  }
  .deckbar .left, .deckbar .right { display: flex; align-items: center; gap: var(--sp-2); }
  .title {
    border: 1px solid transparent; border-radius: var(--r-1); background: transparent;
    color: var(--c-tx); font: inherit; font-size: var(--ts-md); padding: 3px 8px; min-width: 220px;
  }
  .title:hover { border-color: var(--c-line); }
  .title:focus { outline: none; border-color: var(--c-accent); background: var(--c-bg); }
  .btn {
    border: 1px solid var(--c-line-strong); border-radius: var(--r-1); background: var(--c-surface);
    color: var(--c-tx-2); cursor: pointer; font-size: var(--ts-sm); padding: 4px 10px;
  }
  .btn:hover:not(:disabled) { border-color: var(--c-accent); color: var(--c-tx-hi); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn.ghost { background: transparent; }
  .btn.active { border-color: var(--c-accent); background: var(--c-accent); color: var(--c-on-accent); }
  .dirty { color: var(--c-tx-faint); opacity: 0; transition: opacity 0.15s; font-size: 12px; }
  .dirty.on { opacity: 1; color: var(--c-accent); }
  .saveerr {
    font-size: 11px; font-weight: 600; color: var(--c-on-accent, #100f0f);
    background: var(--c-danger, #d14d41); border: none; border-radius: var(--r-1); padding: 2px 8px; cursor: pointer;
  }
  .saveerr:hover { filter: brightness(1.08); }
  .export-toast {
    position: absolute; top: 54px; left: 50%; transform: translateX(-50%); z-index: 40;
    max-width: 70%; padding: 8px 14px; border-radius: var(--r-2);
    background: var(--c-bg-raised); border: 1px solid var(--c-accent);
    color: var(--c-tx-hi); font-size: var(--ts-sm); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .export-toast.err { border-color: var(--c-danger, #d14); }
  .disk-toast {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 50;
    display: flex; gap: 10px; align-items: center; padding: 10px 14px;
    background: var(--c-bg-raised); border: 1px solid var(--c-line);
    color: var(--c-tx); border-radius: var(--r-2); font-size: var(--ts-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .disk-toast button {
    border: 1px solid var(--c-line); background: var(--c-bg-2, transparent);
    color: var(--c-tx-hi); border-radius: var(--r-1); padding: 4px 10px;
    cursor: pointer; font-size: var(--ts-xs, 12px);
  }
  .disk-toast button:hover { background: var(--c-line); }
  .disk-toast button.ghost { background: transparent; }
  .body { display: flex; flex: 1; min-height: 0; position: relative; }
  .filmstrip {
    flex: 0 0 var(--film-w, 172px); overflow-y: auto; border-right: 1px solid var(--c-line);
    background: var(--c-bg-raised); padding: 10px; display: flex; flex-direction: column; gap: 10px;
  }
  .thumb {
    position: relative; display: grid; grid-template-columns: 16px 1fr; grid-template-rows: auto auto;
    gap: 2px 6px; cursor: pointer; padding: 4px; border: 1px solid transparent; border-radius: var(--r-2);
  }
  .thumb:hover { background: var(--c-accent-tint-2); }
  .thumb.active { border-color: var(--c-accent); background: var(--c-accent-tint-2); }
  .thumb.dragging { opacity: 0.4; }
  .thumb.dropbefore { box-shadow: inset 0 2px 0 0 var(--c-accent); }
  .thumb.dropafter { box-shadow: inset 0 -2px 0 0 var(--c-accent); }
  .thumb .n { grid-row: 1 / span 2; font-size: 11px; color: var(--c-tx-muted); text-align: right; font-variant-numeric: tabular-nums; }
  /* the SlideThumb wrap paints the slide's own background — a hardcoded black
     here bled through as dark placeholder/letterbox slivers in light themes */
  .mini { border: 1px solid var(--c-line); border-radius: 3px; overflow: hidden; position: relative; }
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
  .film-gutter {
    flex: 0 0 7px; margin: 0 -3px; cursor: col-resize; z-index: 6;
    display: flex; align-items: stretch; justify-content: center;
  }
  .film-gutter .grip { width: 1px; background: transparent; transition: background 0.12s; }
  .film-gutter:hover .grip, .film-gutter.active .grip { background: var(--c-accent, #4385be); width: 2px; }
  /* Slim hover-revealed reopen affordance for a hidden rail (FigureMode twin). */
  .edgetab {
    position: absolute; top: 0; bottom: 0; width: 12px; border: none; padding: 0;
    background: transparent; color: var(--c-tx-muted, #878580); font-size: 14px;
    cursor: pointer; opacity: 0.25; z-index: 7;
  }
  .edgetab:hover { opacity: 1; background: color-mix(in srgb, var(--c-accent, #4385be) 18%, transparent); }
  .edgetab.left { left: 0; }
  .edgetab.right { right: 0; }
  .stage-col { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .canvas-wrap { flex: 1; min-height: 0; position: relative; }
  .preview-overlay {
    position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
    background: var(--c-canvas-slide, #17181b);
  }
  .preview-viewport { position: relative; flex: 1; align-self: stretch; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .preview-host { flex: 0 0 auto; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5); }
  .preview-stop {
    position: absolute; top: 12px; right: 12px; z-index: 31;
    font-size: 12px; color: var(--c-tx-hi, #fff); background: color-mix(in oklab, var(--c-bg, #100f0f) 70%, transparent);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 6px; padding: 5px 12px; cursor: pointer;
  }
  .preview-stop:hover { border-color: var(--c-accent, #4385be); }
  .rail {
    flex: 0 0 var(--insp-w, 248px); border-left: 1px solid var(--c-line);
    background: var(--c-surface); overflow-y: auto; display: flex; flex-direction: column;
  }
  /* the shared Inspector carries its own width/border — neutralize inside the rail */
  .rail :global(.inspector) { width: 100%; border-left: none; flex: 0 0 auto; }
  .panel {
    padding: 10px; border-top: 1px solid var(--c-line);
    font-size: 12px; display: flex; flex-direction: column; gap: 6px;
  }
  .panel h4 { margin: 0 0 2px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6; }
  .panel label.full { display: flex; flex-direction: column; gap: 3px; opacity: 0.85; }
  .panel input, .panel select, .panel textarea {
    background: var(--c-bg-raised); border: 1px solid var(--c-line-strong); color: var(--c-tx);
    border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 100%;
  }
  .panel textarea { resize: vertical; font-family: inherit; }
  .convertrow { display: flex; }
  .act {
    flex: 1; background: var(--c-ui); color: var(--c-tx); border: 1px solid var(--c-line-strong);
    border-radius: 5px; padding: 5px 8px; font-size: 12px; cursor: pointer;
  }
  .act:hover { background: var(--c-ui-hover); }
  .sendmenu { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--c-line-strong); border-radius: 6px; padding: 4px; background: var(--c-bg-raised); }
  .sendmenu button {
    text-align: left; border: none; background: transparent; color: var(--c-tx-2);
    border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px;
  }
  .sendmenu button:hover { background: var(--c-accent-tint, rgba(67, 133, 190, 0.15)); color: var(--c-tx-hi); }
  .sendmenu .ghosty { color: var(--c-tx-muted); }
  .empty { margin: auto; color: var(--c-tx-faint); font-style: italic; display: flex; gap: 10px; align-items: center; justify-content: center; height: 100%; }
</style>
