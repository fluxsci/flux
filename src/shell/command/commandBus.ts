// The shell-level command bus. The shell owns the
// global Ctrl+K: when Paper is the focused mode the request routes to
// PaperMode's own (richer) palette via `paperPaletteRequest`; every other mode
// gets the shell GlobalPalette. Cross-mode actions (open a document in Paper,
// capture feedback) ride these stores so any surface
// can trigger them without importing mode internals.

import { writable } from "svelte/store";

/** Bumped when the shell routes Ctrl+K to the Paper palette. */
export const paperPaletteRequest = writable(0);
export function requestPaperPalette(): void {
  paperPaletteRequest.update((n) => n + 1);
}

/** "Open this project-relative document in Paper mode" (project context/notebook/rules…). */
export const openDocRequest = writable<{ path: string; from?: number; to?: number; quote?: string; n: number } | null>(null);
let dn = 0;
export function requestOpenDoc(path: string, range: { from?: number; to?: number; quote?: string } = {}): void {
  openDocRequest.set({ path, ...range, n: ++dn });
}

/** A project usage points at one independently editable slide. */
export const openSlideRequest = writable<{ deckId: string; slideId?: string; slideIndex?: number; beat?: number; trackId?: string; n: number } | null>(null);
let sn = 0;
export function requestOpenSlide(deckId: string, slideId?: string, at: { slideIndex?: number; beat?: number; trackId?: string } = {}): void {
  openSlideRequest.set({ deckId, slideId, ...at, n: ++sn });
}

export const openFigureRequest = writable<{ figureId: string; elements: string[]; parts: { elementId: string; partId: string }[] } | null>(null);
export const openLibraryRequest = writable<{ query?: string; selectedKeys?: string[] } | null>(null);
