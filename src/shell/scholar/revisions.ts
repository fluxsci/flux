// Cross-pane "something changed" counters. The figure editor bumps figRevision
// after it autosaves fig/; the paper module's scholar stores resubscribe and
// re-read, so embedded @fig refs/embeds re-render live. Same idea for the
// bibliography (bibRevision) after a DOI is fetched into library.bib.

import { writable } from "svelte/store";

export const figRevision = writable(0);
export const bibRevision = writable(0);

export function bumpFigRevision() {
  figRevision.update((n) => n + 1);
}
export function bumpBibRevision() {
  bibRevision.update((n) => n + 1);
}
