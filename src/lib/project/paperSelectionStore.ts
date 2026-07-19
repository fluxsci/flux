// The paper editor's live doc/selection, published for the feedback stamp.
// Deliberately CM-free (a plain store + setters) so eager shell modules can
// read it without dragging CodeMirror/the paper chunk into the startup bundle —
// the CM updateListener that FEEDS it lives in modes/paper/paperContext.ts.

import { writable } from "svelte/store";

export interface PaperSelectionInfo {
  /** Project-relative docRel of the active document. */
  doc: string;
  from: number;
  to: number;
  /** Selected text (capped), "" when the selection is a bare caret. */
  quote: string;
}

export const paperSelection = writable<PaperSelectionInfo | null>(null);

let currentDoc = "";

export function setPaperContextDoc(rel: string): void {
  currentDoc = rel;
  paperSelection.set(rel ? { doc: rel, from: 0, to: 0, quote: "" } : null);
}

export function publishPaperSelection(from: number, to: number, quote: string): void {
  if (!currentDoc) return;
  paperSelection.set({ doc: currentDoc, from, to, quote });
}
