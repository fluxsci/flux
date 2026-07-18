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
  import { onMount, onDestroy, tick, setContext } from "svelte";
  import { get } from "svelte/store";
  import { projectModel } from "../../shellStore";
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
  } from "../../../lib/slide/store";
  import { familyOf } from "../../../lib/slide/family";
  import { animateElement, animatePart, suggestElementTrack } from "../../../lib/slide/autobuild";
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
    gestureCancelHook,
  } from "../../../lib/store";
  import {
    listProjectDecks,
    loadDeckInto,
    saveDeckFrom,
    deckDiskDiverged,
    createDeckInProject,
    duplicateDeckInProject as duplicateDeckBridge,
    deleteDeckFromProject as deleteDeckBridge,
    exportDeck as exportDeckBridge,
    canExportDeck,
    type DeckListItem,
    type DeckDiag,
  } from "../../../lib/project/slideBridge";
  import * as slideOps from "../../../lib/slide/ops";
  import { resolveTheme, BUILTIN_THEMES } from "../../../lib/slide/theme";
  import type { Deck, TransitionKind } from "../../../lib/slide/types";
  import { createPlayer, type Player } from "../../../lib/slide/player/player";
  import { plotManifests, plotGen } from "../../../lib/plot/store";
  import { getAssetData } from "../../../lib/assets";
  import { assetDisplaySize } from "../../../lib/ops";
  import { sendSlideToCanvas, listFigCanvases } from "../../../lib/project/convert";
  import { touchActivityLock } from "../../../lib/bridge/activityLock";
  import { createAutosave, ConflictError } from "../../../lib/autosave";
  import { registerFlushable, flushById, isDirtyById } from "../../lifecycle";
  import { evictMode } from "../../paneStore";
  import { setStoreTenant } from "../../../lib/tenancy";
  import { deckRevision, bumpFigRevision } from "../../scholar/revisions";
  import { handleKey } from "../../../lib/keyboard";
  import { importDroppedFiles } from "../../../lib/io";
  import Toolbar from "../../../lib/Toolbar.svelte";
  import Canvas from "../../../lib/Canvas.svelte";
  import Inspector from "../../../lib/Inspector.svelte";
  import ArrangeHud from "../../../lib/ArrangeHud.svelte";
  import FluxFigMenu from "../../../lib/FluxFigMenu.svelte";
  import Xray from "../../../lib/Xray.svelte";
  import PlotImporter from "../../../lib/PlotImporter.svelte";
  import PresetPicker from "../../../lib/PresetPicker.svelte";
  import AnimatePanel from "./AnimatePanel.svelte";
  import DeckPicker from "./DeckPicker.svelte";
  import PresentOverlay from "./PresentOverlay.svelte";
  import SlideThumb from "./SlideThumb.svelte";
  import { slideLayout } from "./slideLayoutStore";
  import { pushToast, errMsg } from "../../../lib/toast";

  // Shared components (Inspector/Toolbar) read this to hide figure-only
  // affordances / accent the mode title. Context, so figure mode is untouched.
  setContext("flux-editor-mode", "slide");

  // `active` (W16): false when this pane is kept-alive but hidden — pause the
  // build preview so its animation loop doesn't run off-screen.
  let { focused = true, active = true }: { focused?: boolean; active?: boolean } = $props();

  const pm = get(projectModel);
  let ready = $state(false);
  let loadError = $state<string | null>(null);
  let decks = $state<DeckListItem[]>([]);
  let activeDeckId = $state<string | null>(null);
  let unsubDirty: (() => void) | undefined;
  let unsubDeckRev: (() => void) | undefined;
  let unregCompanion: (() => void) | undefined;
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
      await openDeck(activeDeckId, { force: true });
    }
  }
  async function reloadDeckTheirs() {
    if (!pm || !activeDeckId) return;
    await openDeck(activeDeckId, { force: true }); // re-seeds baseline + clears dirty
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

  async function openDeck(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
    if (!pm) return false;
    if (!opts.force && id === activeDeckId) return true;
    try {
      await autosave.flush();
      const loaded = await loadDeckInto(pm.root, id);
      if (!loaded) {
        pushToast("error", "Couldn't open that deck — its file may be missing or corrupt.");
        return false;
      }
      surfaceDiagnostics(loaded.diagnostics);
      activeDeckId = loaded.deck.id;
      rememberDeck(pm.root, activeDeckId);
      decks = await listProjectDecks(pm.root);
      animatorOpen = animatorRemembered();
      fitViewport();
      return true;
    } catch (e) {
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

  // --- viewport: fit the stage frame into the canvas pane -----------------------
  let canvasWrapEl = $state<HTMLElement | null>(null);
  function fitViewport() {
    queueMicrotask(() => {
      const el = canvasWrapEl;
      const st = get(deckOverlay)?.stage ?? slideOps.DEFAULT_STAGE;
      if (!el) return;
      const w = el.clientWidth || 800;
      const h = el.clientHeight || 500;
      const z = Math.max(0.05, Math.min(16, Math.min((w - 90) / st.width, (h - 90) / st.height)));
      viewport.set({ panX: (w - st.width * z) / 2, panY: (h - st.height * z) / 2, zoom: z });
    });
  }

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
  function startPreview(startBeat = 0) {
    exitEndpointEdit(); // preview plays the PERSISTED state, never a checkout
    const d = currentDeck();
    const sid = $activeFigureId;
    if (!d || !sid || previewing) return;
    const si = d.slides.findIndex((x) => x.id === sid);
    if (si < 0) return;
    pvStage = d.stage;
    previewing = true;
    queueMicrotask(() => {
      if (!previewHost) { previewing = false; return; }
      player = createPlayer(previewHost, d, playerOpts(d));
      previewHost.style.transformOrigin = "center center";
      previewHost.style.transform = `scale(${pvScale})`;
      const nBeats = d.slides[si].beats.length;
      // play-from-here: rest at the beat BEFORE the requested one, then advance.
      const from = Math.max(0, Math.min(nBeats - 1, startBeat) - 1);
      player.goTo(si, from);
      player.on("beatEnd", () => {
        if (!player) return;
        if (player.state().beat >= nBeats - 1) setTimeout(stopPreview, 1100);
        else setTimeout(() => player?.next(), 480);
      });
      if (nBeats <= 1 || from >= nBeats - 1) setTimeout(stopPreview, 900);
      else setTimeout(() => player?.next(), 420);
    });
  }
  function stopPreview() {
    // The player (and its WAAPI/rAF work) is fully torn down — static editing
    // never runs a continuous loop (the E43 lesson, gated).
    player?.destroy();
    player = undefined;
    previewing = false;
  }
  $effect(() => {
    if (!active && previewing) stopPreview();
  });

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
  function addAppearance(exit: boolean) {
    const sid = $activeFigureId;
    const s = activeSlide;
    if (!sid || !s) return;
    const ps = $partSelection;
    const ids = selectionTargets();
    if (!ids.length) return;
    const beatIndex = $activeBeat > 0 ? $activeBeat : undefined;
    let landed = -1;
    const newIds: string[] = [];
    commitDeckLive((d) => {
      if (ps) {
        const el = s.elements.find((x) => x.id === ps.elementId);
        if (!el) return;
        if (exit) {
          const sl = slideOps.slideById(d, sid);
          if (!sl) return;
          let bi = beatIndex != null && beatIndex < sl.beats.length ? beatIndex : -1;
          if (bi < 0) {
            if (sl.beats.length <= 1) slideOps.addBeat(d, sid, { label: "Beat 1", advance: "click" });
            bi = sl.beats.length - 1;
          }
          const track = suggestElementTrack(el, { exit: true, part: ps.partId });
          slideOps.setAnimation(d, sid, sl.beats[bi].id, track);
          landed = bi;
          if (track.id) newIds.push(track.id);
        } else {
          landed = animatePart(d, sid, ps.elementId, ps.partId, $plotManifests[(el as { assetId?: string }).assetId ?? ""], beatIndex);
        }
        return;
      }
      for (const id of ids) {
        const r = animateElement(d, sid, id, { beatIndex, exit });
        if (r) {
          landed = r.beatIndex;
          newIds.push(r.trackId);
        }
      }
    });
    if (landed > 0) activeBeat.set(landed);
    if (newIds.length) selTrackIds.set(newIds);
    else if (landed > 0) {
      // animatePart may have re-enabled an existing track — select it
      const b = activeSlide?.beats[landed];
      const t = b?.tracks.find((tk) => tk.target === (ps?.elementId ?? ids[0]) && (!ps || tk.part === ps.partId));
      if (t?.id) selTrackIds.set([t.id]);
    }
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
      const sameTracks = cur && cur.entries.length && trackIds.includes(cur.entries[0].trackId);
      const next: "t1" | "t2" = cur && sameTracks && cur.end === "t2" ? "t1" : "t2";
      // t2→t1 with no upstream = plain document editing: enter returns [] and
      // the checkout simply ends (base state IS t1).
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
    if (presentOpen) return; // the presenter overlay owns the keyboard
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
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
    if (!focused) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Paste an image onto the active slide (figure drop pipeline, deck asset sink).
  function onPaste(e: ClipboardEvent) {
    if (!focused || presentOpen) return;
    const t = (e.target as HTMLElement)?.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    const item = [...(e.clipboardData?.items ?? [])].find((it) => /^image\/(png|svg)/.test(it.type));
    const file = item?.getAsFile();
    const sid = $activeFigureId;
    if (file && sid) {
      e.preventDefault();
      void importDroppedFiles([file], sid);
    }
  }

  // --- lifecycle ---------------------------------------------------------------------
  onMount(async () => {
    // Tenancy handoff (§3.2.1): flush + evict a resident FigureMode, claim the
    // store, register the overlay's history companion, THEN load the deck.
    await flushById("figure");
    if (isDirtyById("figure")) {
      pushToast("error", "Unsaved figure changes could not be written", {
        detail: "fig/ changed on disk. Resolve the conflict in Figure mode if those edits matter — opening Slide replaces the shared editing store.",
      });
    }
    evictMode("figure");
    await tick(); // let the evicted FigureMode unmount (its onDestroy no-ops)
    setStoreTenant("slide");
    unregCompanion = registerHistoryCompanion(overlayHistoryCompanion());
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
    ready = true;
    canExport = canExportDeck();
    animatorOpen = animatorRemembered();
    unsubDirty = figDirty.subscribe((d) => {
      if (!ready || !pm || !d) return;
      touchActivityLock("slides"); // defer concurrent agent deck writes while mid-edit
      autosave.schedule();
    });
    // Live-reload on external slides/ edits (skip the immediate on-subscribe call).
    let firstDeck = true;
    unsubDeckRev = deckRevision.subscribe(() => {
      if (firstDeck) { firstDeck = false; return; }
      void onDeckRevision();
    });
  });

  const unregFlush = registerFlushable({
    id: "slide",
    isDirty: () => !!pm && ready && get(figDirty),
    flush: () => autosave.flush(),
  });

  onDestroy(() => {
    unsubDirty?.();
    unsubDeckRev?.();
    stopPreview();
    exitEndpointEdit(); // unmount restores the base state before the flush
    void autosave.flush();
    autosave.dispose();
    unregFlush();
    unregCompanion?.();
  });
</script>

<svelte:window onpaste={onPaste} />

<div class="slide-mode">
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
  <Toolbar />

  <div class="body" style={`--film-w:${$slideLayout.filmstripW}px; --insp-w:${$slideLayout.inspectorW}px;`}>
    <!-- filmstrip -->
    <aside class="filmstrip">
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
      {/if}
    </aside>

    <!-- stage: the SHARED figure canvas in frame mode -->
    <main class="stage-col">
      <div class="canvas-wrap" bind:this={canvasWrapEl}>
        {#if ready && overlay}
          <Canvas frame paneActive={active} />
          <ArrangeHud />
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
        <AnimatePanel slide={activeSlide} onPreview={startPreview} />
      {/if}
    </main>

    <!-- right rail: the SHARED inspector + the slide/deck panels -->
    <aside class="rail">
      <Inspector />
      {#if overlay && activeSlide}
        <section class="panel">
          <h4>Slide</h4>
          <label class="full">Name
            <input value={activeSlide.name ?? ""} onchange={(e) => onSlideName(e.currentTarget.value)} />
          </label>
          <label class="full">Background
            <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(activeSlide.background ?? "") ? activeSlide.background : "#100f0f"}
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
        <section class="panel">
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
  </div>

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
</div>

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
<PlotImporter rootOverride={pm?.root ?? ""} title="Insert plot onto slide" />
<PresetPicker />

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
  .body { display: flex; flex: 1; min-height: 0; }
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
  .mini { border: 1px solid var(--c-line); border-radius: 3px; overflow: hidden; position: relative; background: #000; }
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
