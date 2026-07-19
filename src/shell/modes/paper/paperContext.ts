// The CM side of the paper feedback stamp: an updateListener publishing the
// live selection into the CM-free paperSelectionStore (which eager shell code
// reads). Cost discipline (§4/§6): fires only on selectionSet/docChanged, a
// primitive compare gates the store write, and the quote slice is capped.

import { EditorView } from "@codemirror/view";
import { publishPaperSelection } from "../../../lib/project/paperSelectionStore";

const QUOTE_CAP = 400;

let lastFrom = -1;
let lastTo = -1;

export const paperSelectionWatcher = EditorView.updateListener.of((u) => {
  if (!u.selectionSet && !u.docChanged) return;
  const sel = u.state.selection.main;
  if (sel.from === lastFrom && sel.to === lastTo && !u.docChanged) return;
  lastFrom = sel.from;
  lastTo = sel.to;
  const quote = sel.empty ? "" : u.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + QUOTE_CAP));
  publishPaperSelection(sel.from, sel.to, quote);
});
