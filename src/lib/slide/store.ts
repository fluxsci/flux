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
import type { Asset, Id } from "../types";
import type { Deck, Slide } from "./types";
import {
  project,
  activeFigureId,
  activeCanvasId,
  loadProject,
  commit,
  mutate,
  editGen,
  clearSelection,
  type HistoryCompanion,
} from "../store";
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
  externalAssets = external;
  const proj = deckToProject(deck, resolvedAssets);
  loadProject(proj, null);
  deckOverlay.set(stripDeckToOverlay(deck));
  activeCanvasId.set(DECK_CANVAS_ID);
  activeFigureId.set(deck.slides[0]?.id ?? null);
  activeBeat.set(0);
  selTrackIds.set([]);
}

/** Compose the full live Deck from the two halves (figure store + overlay). */
export function currentDeck(): Deck | null {
  const o = get(deckOverlay);
  if (!o) return null;
  return projectIntoDeck(get(project), o, { externalAssetIds: externalAssets });
}

/** The composed live Slide for one slide id (elements from the figure store,
 *  presentation from the overlay) — what the player/renderer consume. */
export function composedSlide(slideId: Id): Slide | null {
  const o = get(deckOverlay);
  const p = get(project);
  if (!o) return null;
  const os = o.slides.find((s) => s.id === slideId);
  const fig = p.figures.find((f) => f.id === slideId);
  if (!os || !fig) return null;
  const s: Slide = {
    ...os,
    elements: fig.elements,
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
    const deck = projectIntoDeck(proj, o, { externalAssetIds: externalAssets });
    out = fn(deck);
    // Decompose: figures ← deck slides (order + content), overlay ← the rest.
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
      elements: s.elements,
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
  deckOverlay.set(o); // notify overlay subscribers (same object, fresh signal)
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
 *  both halves together. */
export function overlayHistoryCompanion(): HistoryCompanion {
  return {
    capture: () => ({
      overlay: structuredClone(get(deckOverlay)),
      beat: get(activeBeat),
    }),
    restore: (s) => {
      const snap = s as { overlay: Deck | null; beat: number } | undefined;
      if (!snap) return;
      deckOverlay.set(snap.overlay);
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

/** Select a slide: an in-memory `activeFigureId` swap (instant — the ≤100ms
 *  slide-switch budget rides on this being a store write, never a reload). */
export function selectSlide(slideId: Id): void {
  activeFigureId.set(slideId);
  const o = get(deckOverlay);
  const s = o?.slides.find((x) => x.id === slideId);
  activeBeat.set(Math.max(0, (s?.beats.length ?? 1) - 1)); // edit fully-built
  selTrackIds.set([]);
  clearSelection();
}

/** Clear the slide stores (true project close / tenancy handoff). */
export function clearDeck(): void {
  deckOverlay.set(null);
  activeBeat.set(0);
  selTrackIds.set([]);
  externalAssets = new Set();
  coalesceState.key = null;
}
