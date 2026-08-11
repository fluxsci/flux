// The CM side of the paper feedback stamp: an updateListener publishing the
// live selection into the CM-free paperSelectionStore (which eager shell code
// reads). Cost discipline (§4/§6): fires only on selectionSet/docChanged, a
// primitive compare gates the store write, and the quote slice is capped.
//
// Per-pane (dual-paper 2026-08-11): a FACTORY — the publish target is one
// app-global store (the feedback stamp quotes "the" selection), so only the
// FOCUSED pane publishes; `isFocused` is that gate, and the dedupe pair lives
// in the closure. A focus flip republishes via PaperMode's focus effect.

import { EditorView } from "@codemirror/view";
import { publishPaperSelection } from "../../../lib/project/paperSelectionStore";

const QUOTE_CAP = 400;

export function makePaperSelectionWatcher(isFocused: () => boolean) {
  let lastFrom = -1;
  let lastTo = -1;
  return EditorView.updateListener.of((u) => {
    if (!isFocused()) return;
    if (!u.selectionSet && !u.docChanged) return;
    const sel = u.state.selection.main;
    if (sel.from === lastFrom && sel.to === lastTo && !u.docChanged) return;
    lastFrom = sel.from;
    lastTo = sel.to;
    const quote = sel.empty ? "" : u.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + QUOTE_CAP));
    publishPaperSelection(sel.from, sel.to, quote);
  });
}
