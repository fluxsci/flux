// Tracks the editor caret so the outliner can highlight the section the cursor
// is in (Redesign v2). A cheap updateListener publishes the caret offset; the
// active heading is derived by a binary search over the cached flat outline in
// PaperMode — O(log n), no tree re-walk on every cursor move.
//
// Per-pane (dual-paper 2026-08-11): one tracker per PaperMode instance — the
// old module-global store made every outline highlight follow whichever editor
// moved its caret last (the "cursor singleton" the pane gate named).

import { writable, type Writable } from "svelte/store";
import { EditorView } from "@codemirror/view";

export interface CursorTracking {
  cursorPos: Writable<number>;
  watcher: ReturnType<typeof EditorView.updateListener.of>;
}

export function createCursorTracking(): CursorTracking {
  const cursorPos = writable(0);
  const watcher = EditorView.updateListener.of((u) => {
    if (u.selectionSet || u.docChanged) cursorPos.set(u.state.selection.main.head);
  });
  return { cursorPos, watcher };
}
