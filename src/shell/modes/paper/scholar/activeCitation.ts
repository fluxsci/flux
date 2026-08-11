// Live "citation group under the caret" tracking — the store that makes the
// Citation Group editor and the BibliographyView card follow the cursor. A
// sibling of outline/activeHeading's cursor tracker (NOT an extension of it:
// cursorPos is a hot plain-number store; this one carries group identity and
// only wakes subscribers when the group actually changes). citationGroupAt is
// line-local (O(line)) so running it per caret move is cheap. Positions stay
// current across edits because the watcher also fires on docChanged.
//
// Per-pane (dual-paper 2026-08-11): one instance per PaperMode; margin views
// reach it through the MarginHost (the WS-4.2 numbering-threading pattern),
// never a module import. The dedupe key lives in the closure.

import { EditorView } from "@codemirror/view";
import { writable, type Writable } from "svelte/store";
import type { CitationGroup } from "../margin/types";
import { citationGroupAt } from "./citeOps";

export interface ActiveCitation {
  activeCitationGroup: Writable<CitationGroup | null>;
  watcher: ReturnType<typeof EditorView.updateListener.of>;
  /** PaperMode calls this on destroy so a stale group never outlives its editor. */
  reset(): void;
}

export function createActiveCitation(): ActiveCitation {
  const activeCitationGroup = writable<CitationGroup | null>(null);
  let lastKey = "";
  const watcher = EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    const g = citationGroupAt(u.state, u.state.selection.main.head);
    const key = g ? `${g.from}:${g.to}:${g.keys.join(";")}` : "";
    if (key === lastKey) return;
    lastKey = key;
    activeCitationGroup.set(g);
  });
  return {
    activeCitationGroup,
    watcher,
    reset() {
      lastKey = "";
      activeCitationGroup.set(null);
    },
  };
}
