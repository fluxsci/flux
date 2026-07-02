// Live "citation group under the caret" tracking — the store that makes the
// Citation Group editor and the BibliographyView card follow the cursor. A
// sibling of outline/activeHeading's cursorWatcher (NOT an extension of it:
// cursorPos is a hot plain-number store; this one carries group identity and
// only wakes subscribers when the group actually changes). citationGroupAt is
// line-local (O(line)) so running it per caret move is cheap. Positions stay
// current across edits because the watcher also fires on docChanged.

import { EditorView } from "@codemirror/view";
import { writable } from "svelte/store";
import type { CitationGroup } from "../margin/types";
import { citationGroupAt } from "./citeOps";

export const activeCitationGroup = writable<CitationGroup | null>(null);

let lastKey = "";

export const activeCitationWatcher = EditorView.updateListener.of((u) => {
  if (!u.selectionSet && !u.docChanged) return;
  const g = citationGroupAt(u.state, u.state.selection.main.head);
  const key = g ? `${g.from}:${g.to}:${g.keys.join(";")}` : "";
  if (key === lastKey) return;
  lastKey = key;
  activeCitationGroup.set(g);
});

/** PaperMode calls this on destroy so a stale group never outlives its editor. */
export function resetActiveCitation(): void {
  lastKey = "";
  activeCitationGroup.set(null);
}
