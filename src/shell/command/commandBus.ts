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

/** The principal Agent drawer (PrincipalDrawer.svelte, mounted in Workspace). */
export const principalDrawerOpen = writable(false);
export function togglePrincipalDrawer(): void {
  principalDrawerOpen.update((v) => !v);
}

/** Prefill queue for the principal terminal. The session module (xterm) is
 *  dynamically imported on first drawer open (startup-budget discipline), so
 *  asks buffer here until it registers its sink. */
const askQueue: string[] = [];
let askSink: ((text: string) => void) | null = null;
export function askPrincipal(text: string): void {
  if (askSink) askSink(text);
  else askQueue.push(text);
}
export function registerPrincipalAskSink(fn: (text: string) => void): void {
  askSink = fn;
  for (const t of askQueue.splice(0)) fn(t);
}

/** The feedback capture popover (FeedbackCapture.svelte, mounted in Workspace). */
export const feedbackCaptureOpen = writable(false);
