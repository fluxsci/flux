// The shell-level command bus (principal-agent scheme). The shell owns the
// global Ctrl+K: when Paper is the focused mode the request routes to
// PaperMode's own (richer) palette via `paperPaletteRequest`; every other mode
// gets the shell GlobalPalette. Cross-mode actions (open a document in Paper,
// toggle the agent drawer, capture feedback) ride these stores so any surface
// can trigger them without importing mode internals.

import { writable } from "svelte/store";

/** Bumped when the shell routes Ctrl+K to the Paper palette. */
export const paperPaletteRequest = writable(0);
export function requestPaperPalette(): void {
  paperPaletteRequest.update((n) => n + 1);
}

/** "Open this project-relative document in Paper mode" (mission/notebook/rules…). */
export const openDocRequest = writable<{ path: string; n: number } | null>(null);
let dn = 0;
export function requestOpenDoc(path: string): void {
  openDocRequest.set({ path, n: ++dn });
}

/** The feedback capture popover (FeedbackCapture.svelte, mounted in Workspace). */
export const feedbackCaptureOpen = writable(false);
