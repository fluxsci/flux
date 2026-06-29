// Tracks the editor caret so the outliner can highlight the section the cursor
// is in (Redesign v2). A cheap updateListener publishes the caret offset; the
// active heading is derived by a binary search over the cached flat outline in
// PaperMode — O(log n), no tree re-walk on every cursor move.

import { writable } from "svelte/store";
import { EditorView } from "@codemirror/view";

export const cursorPos = writable(0);

export const cursorWatcher = EditorView.updateListener.of((u) => {
  if (u.selectionSet || u.docChanged) cursorPos.set(u.state.selection.main.head);
});
