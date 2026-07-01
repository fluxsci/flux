// ---------------------------------------------------------------------------
// Flux Slide — the GUI editor stores (the in-memory live deck + editor state).
//
// Mirrors the figure editor's store.ts split: the deck model is a plain object
// mutated only through the pure ops core (src/lib/slide/ops.ts) via `commitDeck`,
// so the GUI, flux-core, and the live bridge all drive the same mutations. The
// editor-only selection/active-slide/active-beat state lives here too (never
// persisted). Persistence is the slideBridge's job.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import type { Deck } from "./types";
import { ensureTrackIds } from "./ops";

/** The live deck being edited (null on the web/demo fallback or before load). */
export const deck = writable<Deck | null>(null);
/** Dirty flag → drives the debounced autosave (SlideMode). */
export const deckDirty = writable<boolean>(false);

/** Editor cursor: which slide + which beat is shown, and the element selection. */
export const activeSlideId = writable<string | null>(null);
export const activeBeat = writable<number>(0);
export const selection = writable<string[]>([]);
/** Direct manipulation: the plot part last clicked on the stage (elId + semantic
 *  id), so the Animator can focus its X-ray row / track. Null clears the focus. */
export const focusedPart = writable<{ elId: string; part: string } | null>(null);

/** The project root the live deck was loaded from. Lets SlideMode REUSE the
 *  in-memory deck across a mode round-trip (slide→figure→slide, same project)
 *  instead of reloading from disk — which previously raced an un-awaited
 *  destroy-time save and dropped edits. It still reloads when the project
 *  actually changes (root mismatch). Null = no deck loaded for any project. */
export const loadedProjectRoot = writable<string | null>(null);

/** Replace the live deck (on load) and reset editor cursor + dirty. */
export function loadDeckModel(d: Deck): void {
  ensureTrackIds(d); // backfill stable track ids for decks predating Track.id
  deck.set(d);
  activeSlideId.set(d.slides[0]?.id ?? null);
  activeBeat.set(0);
  selection.set([]);
  deckDirty.set(false);
}

// ---------------------------------------------------------------------------
// Undo / redo — snapshot history (mirrors the figure editor's store.ts). Every
// discrete `commitDeck` snapshots the pre-state; a `coalesce` key folds a burst
// of same-key commits (a typing run, a slider drag) into ONE undo step.
// ---------------------------------------------------------------------------
const past: Deck[] = [];
const future: Deck[] = [];
const MAX_HISTORY = 200;
let coalesceKey: string | null = null;

/** Reactive flags for the toolbar undo/redo buttons. */
export const canUndo = writable<boolean>(false);
export const canRedo = writable<boolean>(false);
function publishHistory(): void {
  canUndo.set(past.length > 0);
  canRedo.set(future.length > 0);
}

/** Apply a pure mutation to the live deck, then publish a FRESH reference + mark
 *  dirty. The GUI's single write path (the figure editor's `commit` analog).
 *
 *  We `structuredClone` the result so every nested reference (slides, elements,
 *  beats) is new — guaranteeing Svelte 5's `$derived`/`{#each}` propagate the
 *  change (referential dedup would otherwise drop a nested in-place mutation).
 *
 *  `opts.coalesce` groups a rapid run of same-key commits (text typing, a slider
 *  drag) into one undo entry: the pre-state is captured on the first commit of the
 *  run only. A discrete edit (no key, or a new key) starts a fresh undo step. */
export function commitDeck(mutate: (d: Deck) => void, opts?: { coalesce?: string }): void {
  const d = get(deck);
  if (!d) return;
  const key = opts?.coalesce ?? null;
  if (!key || key !== coalesceKey) {
    past.push(structuredClone(d));
    if (past.length > MAX_HISTORY) past.shift();
    future.length = 0;
  }
  coalesceKey = key;
  mutate(d);
  deck.set(structuredClone(d));
  deckDirty.set(true);
  publishHistory();
}

/** End the current coalesced run (e.g. on text-edit blur or pointer-up) so the
 *  next commit begins a fresh undo step. */
export function sealHistory(): void {
  coalesceKey = null;
}

/** Restore the previous deck snapshot. */
export function undoDeck(): void {
  const d = get(deck);
  if (!past.length || !d) return;
  future.push(structuredClone(d));
  deck.set(past.pop()!);
  coalesceKey = null;
  deckDirty.set(true);
  reconcileCursor();
  publishHistory();
}

/** Re-apply the last undone deck snapshot. */
export function redoDeck(): void {
  const d = get(deck);
  if (!future.length || !d) return;
  past.push(structuredClone(d));
  deck.set(future.pop()!);
  coalesceKey = null;
  deckDirty.set(true);
  reconcileCursor();
  publishHistory();
}

/** After an undo/redo, keep the editor cursor valid: a live active slide, a
 *  selection of only still-existing elements, and an in-range beat. */
function reconcileCursor(): void {
  const d = get(deck);
  if (!d) return;
  if (!d.slides.some((s) => s.id === get(activeSlideId))) activeSlideId.set(d.slides[0]?.id ?? null);
  const slide = d.slides.find((s) => s.id === get(activeSlideId));
  const live = new Set(slide?.elements.map((e) => e.id) ?? []);
  selection.update((ids) => ids.filter((id) => live.has(id)));
  if (get(activeBeat) >= (slide?.beats.length ?? 1)) activeBeat.set(0);
}

/** Clear the deck (on true project close — NOT on a mode switch; the live deck is
 *  intentionally kept across mode round-trips, see `loadedProjectRoot`). */
export function clearDeck(): void {
  deck.set(null);
  activeSlideId.set(null);
  activeBeat.set(0);
  selection.set([]);
  deckDirty.set(false);
  loadedProjectRoot.set(null);
  past.length = 0;
  future.length = 0;
  coalesceKey = null;
  publishHistory();
}
