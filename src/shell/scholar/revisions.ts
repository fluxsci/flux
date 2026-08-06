// Cross-pane "something changed" counters. The figure editor bumps figRevision
// after it autosaves fig/; the paper module's scholar stores resubscribe and
// re-read, so embedded @fig refs/embeds re-render live. Same idea for the
// bibliography (bibRevision) after a DOI is fetched into library.bib.

import { writable } from "svelte/store";

export const figRevision = writable(0);
export const bibRevision = writable(0);
// W10: external (agent/CLI) edits to slides/ bump this so an open SlideMode
// live-reloads the deck (clean-only), matching the figure/manuscript story.
export const deckRevision = writable(0);
// Dissect: external writes under plots/_dissections/ bump this so an open Dissect
// viewer (and the Inspector's count badge) re-list live — a script dropping panels
// while the overlay is open "pops in" without a reopen.
export const dissectionsRevision = writable(0);

export function bumpFigRevision() {
  figRevision.update((n) => n + 1);
}
export function bumpBibRevision() {
  bibRevision.update((n) => n + 1);
}
export function bumpDeckRevision() {
  deckRevision.update((n) => n + 1);
}
export function bumpDissections() {
  dissectionsRevision.update((n) => n + 1);
}
