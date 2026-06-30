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
  deck.set(d);
  activeSlideId.set(d.slides[0]?.id ?? null);
  activeBeat.set(0);
  selection.set([]);
  deckDirty.set(false);
}

/** Apply a pure mutation to the live deck, then publish a FRESH reference + mark
 *  dirty. The GUI's single write path (the figure editor's `commit` analog).
 *
 *  We `structuredClone` the result so every nested reference (slides, elements,
 *  beats) is new — guaranteeing Svelte 5's `$derived`/`{#each}` propagate the
 *  change (referential dedup would otherwise drop a nested in-place mutation).
 *  Decks are small plain JSON, so the clone is cheap; live-typing paths can move
 *  to gesture-batched commits later if profiling ever shows it matters. */
export function commitDeck(mutate: (d: Deck) => void): void {
  const d = get(deck);
  if (!d) return;
  mutate(d);
  deck.set(structuredClone(d));
  deckDirty.set(true);
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
}
