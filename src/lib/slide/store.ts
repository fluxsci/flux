// ---------------------------------------------------------------------------
// Flux Slide — the GUI presentation-overlay store (slides-are-figures).
//
// The deck's STATIC content (elements/groups/guides/backgrounds) lives in the
// app-global figure store (src/lib/store.ts `project`), projected one slide =
// one Figure on the synthetic "deck" canvas — the figure editor edits it
// directly (tools, inspector, X-ray, presets, clipboard, history). This module
// owns ONLY the presentation overlay the projection strips out:
//
//   • `deckOverlay` — a Deck whose slides carry EMPTY elements (order, beats,
//     transition/notes/camera, stage, theme, defaults, deck background).
//     Elements are never stored here (single source of truth).
//   • the animator cursor (activeBeat, selTrackIds).
//
// Undo is UNIFIED: overlay edits ride the figure store's history through the
// registered history companion (store.registerHistoryCompanion) — a commit
// whose project delta is empty but whose companion changed is still one undo
// step, and Cmd+Z restores both halves together.
//
// Deck-level structural ops (add/delete/duplicate/reorder slide, beats,
// tracks, theme, stage) run through `commitDeckLive`, which composes the live
// Deck (projectIntoDeck), applies ONE pure slide/ops mutation — the exact
// functions flux-core runs headlessly — and decomposes the result back into
// project figures + overlay. One core, two engines, no drift.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import type { Asset, Element, Id } from "../types";
import type { Deck, Slide, Track } from "./types";
import {
  project,
  activeFigureId,
  activeCanvasId,
  loadProject,
  commit,
  mutate,
  editGen,
  clearSelection,
  selection,
  partSelection,
  type HistoryCompanion,
} from "../store";
import { familyOf } from "./family";
import { diffState, foldPreState, earlierTransformStates, applyState } from "./tween";
import { applyTextLayout } from "../text";
import { deckToProject, projectIntoDeck, DECK_CANVAS_ID, slideDefaultBackground } from "./deckProject";

/** The live presentation overlay (null before a deck is loaded). Slides in
 *  here always have `elements: []` and no groups/guides/background — those
 *  live in the projected figure store. */
export const deckOverlay = writable<Deck | null>(null);

/** The animator cursor: which beat of the active slide is current. */
export const activeBeat = writable<number>(0);
/** The animator's track selection (stable Track.ids). The LAST entry is the
 *  "primary". Reconciled against surviving tracks after undo/redo. */
export const selTrackIds = writable<string[]>([]);

// Asset ids resolved FROM the project (plots, fig/-owned media) rather than
// owned by the deck — the save fold never writes them into deck.assets and
// never copies their bytes into slides/<id>/assets/.
let externalAssets = new Set<string>();
export function externalAssetIds(): ReadonlySet<string> {
  return externalAssets;
}

/** Strip a deck to its overlay half: slides keep id/name/layout/presentation,
 *  drop elements/groups/guides/background (those live in the projection). */
export function stripDeckToOverlay(deck: Deck): Deck {
  const d = structuredClone(deck);
  d.slides = d.slides.map((s) => {
    const o: Slide = { id: s.id, elements: [], beats: s.beats };
    if (s.name !== undefined) o.name = s.name;
    if (s.layout !== undefined) o.layout = s.layout;
    if (s.transition !== undefined) o.transition = s.transition;
    if (s.notes !== undefined) o.notes = s.notes;
    if (s.camera !== undefined) o.camera = s.camera;
    return o;
  });
  // Design tokens + assets live in the projected project while loaded; the
  // fold (projectIntoDeck) re-reads them from there. Keeping them here too
  // would be double storage.
  d.palette = [];
  delete d.colorGroups;
  delete d.textStyles;
  d.assets = [];
  return d;
}

/** Load a deck into the LIVE editing stores: static content → the figure
 *  store (deckToProject → loadProject: history reset, dirty cleared), overlay
 *  → this store. `resolvedAssets` = deck.assets + project-resolved assets;
 *  `external` marks the project-resolved ids. */
export function loadDeckModel(deck: Deck, resolvedAssets: Asset[] = deck.assets, external: Set<string> = new Set()): void {
  disarmCheckoutSync();
  checkoutBaselines.clear();
  endpointEdit.set(null);
  externalAssets = external;
  const proj = deckToProject(deck, resolvedAssets);
  loadProject(proj, null);
  deckOverlay.set(stripDeckToOverlay(deck));
  activeCanvasId.set(DECK_CANVAS_ID);
  activeFigureId.set(deck.slides[0]?.id ?? null);
  activeBeat.set(0);
  selTrackIds.set([]);
}

/** Compose the full live Deck from the two halves (figure store + overlay).
 *  Checked-out endpoint elements fold as their BASE state (the guard). */
export function currentDeck(): Deck | null {
  const o = get(deckOverlay);
  if (!o) return null;
  return projectIntoDeck(get(project), o, { externalAssetIds: externalAssets, baselines: checkoutBaselines });
}

/** The composed live Slide for one slide id (elements from the figure store,
 *  presentation from the overlay) — what the player/renderer consume.
 *  Checked-out elements substitute their BASE state, so thumbnails/preview/
 *  present always see document truth (the canvas alone shows the endpoint). */
export function composedSlide(slideId: Id): Slide | null {
  const o = get(deckOverlay);
  const p = get(project);
  if (!o) return null;
  const os = o.slides.find((s) => s.id === slideId);
  const fig = p.figures.find((f) => f.id === slideId);
  if (!os || !fig) return null;
  const elements = checkoutBaselines.size
    ? fig.elements.map((e) => (checkoutBaselines.has(e.id) ? structuredClone(checkoutBaselines.get(e.id)!) : e))
    : fig.elements;
  const s: Slide = {
    ...os,
    elements,
    ...(fig.groups ? { groups: fig.groups } : {}),
    ...(fig.guides ? { guides: fig.guides } : {}),
  };
  if (fig.background !== slideDefaultBackground(o)) s.background = fig.background;
  return s;
}

// ---------------------------------------------------------------------------
// The GUI deck-op write path — compose → pure op → decompose, in ONE history
// entry (with the presentation overlay riding the history companion).
// ---------------------------------------------------------------------------

// Coalescing (a typing run, a slider drag, an S/A/M paint sweep) folds a burst
// of same-key commits into ONE undo step: the first commit of the run captures
// the pre-state; followers mutate in place. The editGen guard makes reuse
// safe — if ANY other edit/undo landed since, a fresh entry opens.
const coalesceState = { key: null as string | null, gen: -1 };

/** Apply a pure deck op to the LIVE deck: composes the current Deck, runs
 *  `fn`, then writes the result back into the figure store (figures) and the
 *  overlay. One undo step (or part of a coalesced run). Returns fn's result. */
export function commitDeckLive<T>(fn: (deck: Deck) => T, opts?: { coalesce?: string }): T {
  const o = get(deckOverlay);
  if (!o) throw new Error("no deck loaded");
  let out!: T;
  const key = opts?.coalesce ?? null;
  const continueRun = key !== null && key === coalesceState.key && editGen.n === coalesceState.gen;
  const write = continueRun ? mutate : commit;
  write((proj) => {
    const deck = projectIntoDeck(proj, o, { externalAssetIds: externalAssets, baselines: checkoutBaselines });
    out = fn(deck);
    // Decompose: figures ← deck slides (order + content), overlay ← the rest.
    // Checked-out elements keep the STORE's display state (the fold guard
    // substituted their base into `deck`; folding that base back would snap
    // the canvas out of the endpoint mid-checkout).
    const keepDisplay = (slideId: Id, els: Element[]): Element[] => {
      if (!checkoutBaselines.size) return els;
      const live = proj.figures.find((f) => f.id === slideId);
      if (!live) return els;
      return els.map((e) => {
        if (!checkoutBaselines.has(e.id)) return e;
        return live.elements.find((x) => x.id === e.id) ?? e;
      });
    };
    const defaultBg = slideDefaultBackground(deck);
    proj.name = deck.title;
    proj.figures = deck.slides.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      canvasId: DECK_CANVAS_ID,
      x: 0,
      y: 0,
      width: deck.stage.width,
      height: deck.stage.height,
      background: s.background ?? defaultBg,
      elements: keepDisplay(s.id, s.elements),
      ...(s.groups ? { groups: s.groups } : {}),
      ...(s.guides ? { guides: s.guides } : {}),
    }));
    proj.assets = [
      ...deck.assets,
      ...proj.assets.filter((a) => externalAssets.has(a.id) && !deck.assets.some((d) => d.id === a.id)),
    ];
    // The overlay store object is REPLACED after the write (below); mutate the
    // captured `o` here so the companion snapshot (taken by beginGesture before
    // this callback) holds the true pre-state.
    Object.assign(o, stripDeckToOverlay(deck));
  });
  // Publish a FRESH identity: Svelte 5's store→rune bridge dedupes on
  // referential equality, so re-setting the same object would not re-render
  // `$deckOverlay` consumers (the filmstrip's {#each} would go stale).
  deckOverlay.set({ ...o });
  coalesceState.key = key;
  coalesceState.gen = editGen.n;
  reconcileCursor();
  return out;
}

/** End the current coalesced run (text blur, pointer-up) so the next commit
 *  begins a fresh undo step. */
export function sealHistory(): void {
  coalesceState.key = null;
}

/** The history companion provider (registered by SlideMode while mounted):
 *  snapshots the overlay next to every project snapshot so undo/redo restore
 *  both halves together. The endpoint-checkout state (which endpoint is
 *  checked out + the captured base elements) rides the SAME snapshot, so
 *  undo across the checkout boundary is exact: entries from before the
 *  checkout restore endpointEdit = null (auto-exit), entries from within
 *  restore the checkout AND re-derive the display element from the restored
 *  track state (invariant: store element ≡ pre ⊕ activeState, always). */
export function overlayHistoryCompanion(): HistoryCompanion {
  return {
    capture: () => ({
      overlay: structuredClone(get(deckOverlay)),
      beat: get(activeBeat),
      checkout: structuredClone(get(endpointEdit)),
      baselines: [...checkoutBaselines.entries()].map(([id, el]) => [id, structuredClone(el)] as const),
    }),
    restore: (s) => {
      const snap = s as
        | { overlay: Deck | null; beat: number; checkout?: EndpointEdit | null; baselines?: (readonly [Id, Element])[] }
        | undefined;
      if (!snap) return;
      deckOverlay.set(snap.overlay);
      disarmCheckoutSync();
      checkoutBaselines.clear();
      for (const [id, el] of snap.baselines ?? []) checkoutBaselines.set(id, structuredClone(el));
      endpointEdit.set(snap.checkout ?? null);
      if (snap.checkout) {
        // the undo restored the PROJECT (display at snapshot time) and the
        // overlay (state at snapshot time) — re-derive the display from the
        // restored state so the two can never disagree, then re-arm.
        reprojectCheckoutDisplay();
        armCheckoutSync();
      }
      reconcileCursor();
    },
  };
}

/** After an undo/redo/op, keep the animator cursor valid: an in-range beat and
 *  a track selection of only still-existing tracks on the active slide. */
export function reconcileCursor(): void {
  const o = get(deckOverlay);
  if (!o) return;
  const sid = get(activeFigureId);
  const slide = o.slides.find((s) => s.id === sid) ?? o.slides[0] ?? null;
  if (get(activeBeat) >= (slide?.beats.length ?? 1)) activeBeat.set(Math.max(0, (slide?.beats.length ?? 1) - 1));
  const liveTracks = new Set(slide?.beats.flatMap((b) => b.tracks.map((t) => t.id)) ?? []);
  selTrackIds.update((ids) => ids.filter((id) => liveTracks.has(id)));
}

// ---------------------------------------------------------------------------
// ENDPOINT CHECKOUT (animation rework §4.4) — "model checkout": to edit a
// transform's t2 (or a chained t1), the checked-out element's DISPLAY state
// is swapped into the figure store so every editor tool (drag, resize, node
// edit, inspector, colors) works on it verbatim. The captured BASE element
// lives here; every fold substitutes it back (deck.json never sees a
// composed state), and an armed subscription mirrors the user's edits into
// the edited track's sparse `to.state` — overlay-only writes that ride the
// SAME undo entry as the canvas edit (one Cmd+Z restores both halves).
// ---------------------------------------------------------------------------

export interface EndpointEdit {
  /** Which handle the user is sculpting ("t1" of a chained track edits the
   *  UPSTREAM track — resolved at enter; `entries` always hold the track
   *  whose `to.state` receives the diffs). */
  end: "t1" | "t2";
  entries: { trackId: Id; target: Id }[];
}

/** The active endpoint checkout (null = plain document editing). */
export const endpointEdit = writable<EndpointEdit | null>(null);

// elementId → its BASE (document beat-0) element, captured at enter.
// Module-level and non-reactive by design (read by every fold).
const checkoutBaselines = new Map<Id, Element>();

/** Read-only view for gates/debug. */
export function checkoutBaselineIds(): ReadonlySet<Id> {
  return new Set(checkoutBaselines.keys());
}

let unsubCheckoutSync: (() => void) | null = null;
// last synced display JSON per element — the change detector.
const lastDisplay = new Map<Id, string>();

/** Locate a track by id in the OVERLAY (beats live there). */
function overlayTrack(trackId: Id): { slide: Slide; beatIndex: number; track: Track } | null {
  const o = get(deckOverlay);
  if (!o) return null;
  for (const s of o.slides) {
    for (let bi = 0; bi < s.beats.length; bi++) {
      const track = s.beats[bi].tracks.find((t) => t.id === trackId);
      if (track) return { slide: s, beatIndex: bi, track };
    }
  }
  return null;
}

/** The endpoint DISPLAY state for one checkout entry: pre(track) ⊕ state. */
function displayFor(entry: { trackId: Id; target: Id }): Element | null {
  const found = overlayTrack(entry.trackId);
  const base = checkoutBaselines.get(entry.target);
  if (!found || !base) return null;
  const pre = foldPreState(base, earlierTransformStates(found.slide.beats, entry.target, found.beatIndex));
  const disp = applyState(pre, found.track.to?.state as Record<string, unknown> | undefined);
  if (disp.type === "text") applyTextLayout(disp); // GUI re-wrap; headless-safe
  return disp;
}

/** Force the store elements to the checkout display (enter + undo restore). */
function reprojectCheckoutDisplay(): void {
  const ee = get(endpointEdit);
  if (!ee) return;
  const sid = get(activeFigureId);
  mutate((p) => {
    const fig = p.figures.find((f) => f.id === sid);
    if (!fig) return;
    for (const entry of ee.entries) {
      const disp = displayFor(entry);
      if (!disp) continue;
      const i = fig.elements.findIndex((e) => e.id === entry.target);
      if (i >= 0) fig.elements[i] = disp;
      lastDisplay.set(entry.target, JSON.stringify(disp));
    }
  });
}

/** Mirror user edits on checked-out elements into their tracks' `to.state`.
 *  Armed only while a checkout is active (zero ambient cost). Overlay-only
 *  writes: the SAME pure fold the player uses computes pre; diffState
 *  captures the sparse patch; the canvas commit that triggered us already
 *  opened the undo entry (its companion snapshot holds the overlay
 *  pre-state), so this write rides that entry — one undo step, both halves. */
function armCheckoutSync(): void {
  disarmCheckoutSync();
  unsubCheckoutSync = project.subscribe((p) => {
    const ee = get(endpointEdit);
    if (!ee) return;
    const sid = get(activeFigureId);
    const fig = p.figures.find((f) => f.id === sid);
    if (!fig) return;
    let touched = false;
    const o = get(deckOverlay);
    if (!o) return;
    for (const entry of ee.entries) {
      const el = fig.elements.find((e) => e.id === entry.target);
      if (!el) continue; // deleted mid-checkout — reconcile handles exits
      const j = JSON.stringify(el);
      if (j === lastDisplay.get(entry.target)) continue;
      lastDisplay.set(entry.target, j);
      const found = overlayTrack(entry.trackId);
      const base = checkoutBaselines.get(entry.target);
      if (!found || !base) continue;
      const pre = foldPreState(base, earlierTransformStates(found.slide.beats, entry.target, found.beatIndex));
      const state = diffState(pre, el) ?? {};
      found.track.to = { ...(found.track.to ?? {}), state };
      touched = true;
    }
    if (touched) deckOverlay.set({ ...o }); // fresh identity (runes dedupe)
  });
}
function disarmCheckoutSync(): void {
  unsubCheckoutSync?.();
  unsubCheckoutSync = null;
  lastDisplay.clear();
}

/** Enter an endpoint checkout for one or more transform tracks. `end: "t1"`
 *  resolves each track to the PREVIOUS transform on its target (whose t2 IS
 *  this track's t1); a track with no upstream is plain document editing — it
 *  contributes no checkout entry (its base state IS t1). Returns the entries
 *  actually checked out (empty = pure t1-on-base: nothing swapped). */
export function enterEndpointEdit(trackIds: Id[], end: "t1" | "t2"): EndpointEdit["entries"] {
  exitEndpointEdit();
  const sid = get(activeFigureId);
  const p = get(project);
  const fig = p.figures.find((f) => f.id === sid);
  if (!fig) return [];
  const entries: EndpointEdit["entries"] = [];
  const targets: Id[] = [];
  for (const trackId of trackIds) {
    const found = overlayTrack(trackId);
    if (!found || familyOf(found.track) !== "transform") continue;
    const target = found.track.target;
    targets.push(target);
    let edited: { trackId: Id; target: Id } | null = null;
    if (end === "t2") {
      edited = { trackId, target };
    } else {
      // t1 → the previous transform on the same target (else base editing)
      let prev: Track | null = null;
      for (let bi = 0; bi < found.beatIndex; bi++) {
        for (const t of found.slide.beats[bi].tracks) {
          if (!t.disabled && t.target === target && familyOf(t) === "transform") prev = t;
        }
      }
      if (prev?.id) edited = { trackId: prev.id, target };
    }
    if (!edited) continue;
    const docEl = fig.elements.find((e) => e.id === edited.target);
    if (!docEl) continue;
    checkoutBaselines.set(edited.target, structuredClone(docEl));
    entries.push(edited);
  }
  // select the objects either way (t1-on-base = "you're already looking at it")
  if (targets.length) {
    selection.set(new Set(targets));
    partSelection.set(null);
  }
  if (!entries.length) {
    endpointEdit.set(null);
    return [];
  }
  endpointEdit.set({ end, entries });
  reprojectCheckoutDisplay();
  armCheckoutSync();
  return entries;
}

/** Re-derive the checkout display after a PROPERTIES-side edit to the
 *  checked-out track's state (dropping a Δ prop, Clear t₂): the sync mirror
 *  is one-way (canvas → track), so track-side edits push back explicitly. */
export function refreshEndpointDisplay(): void {
  if (get(endpointEdit)) reprojectCheckoutDisplay();
}

/** Exit the checkout (the ONE central exit — Esc, animator close, slide
 *  switch, preview/present/export start, mode unmount, project close):
 *  restores every baseline into the store (history-invisible) and clears. */
export function exitEndpointEdit(): void {
  const ee = get(endpointEdit);
  disarmCheckoutSync();
  if (!ee && !checkoutBaselines.size) return;
  const sid = get(activeFigureId);
  if (checkoutBaselines.size) {
    mutate((p) => {
      const fig = p.figures.find((f) => f.id === sid);
      if (!fig) return;
      for (const [id, base] of checkoutBaselines) {
        const i = fig.elements.findIndex((e) => e.id === id);
        if (i >= 0) fig.elements[i] = structuredClone(base);
      }
    });
  }
  checkoutBaselines.clear();
  endpointEdit.set(null);
}

/** Select a slide: an in-memory `activeFigureId` swap (instant — the ≤100ms
 *  slide-switch budget rides on this being a store write, never a reload). */
export function selectSlide(slideId: Id): void {
  exitEndpointEdit(); // scope change ends the checkout (restores the base)
  activeFigureId.set(slideId);
  const o = get(deckOverlay);
  const s = o?.slides.find((x) => x.id === slideId);
  activeBeat.set(Math.max(0, (s?.beats.length ?? 1) - 1)); // edit fully-built
  selTrackIds.set([]);
  clearSelection();
}

/** Clear the slide stores (true project close / tenancy handoff). */
export function clearDeck(): void {
  disarmCheckoutSync();
  checkoutBaselines.clear();
  endpointEdit.set(null);
  deckOverlay.set(null);
  activeBeat.set(0);
  selTrackIds.set([]);
  externalAssets = new Set();
  coalesceState.key = null;
}
