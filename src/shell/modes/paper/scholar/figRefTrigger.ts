// The `@@` figure-reference trigger. `@` is the literature path (citation
// autocomplete, as always); typing a SECOND `@` right after it means "figure
// reference" — the keystroke is swallowed, the first `@` is removed from the
// document (no `@@` ever lands in the .qmd), and the FigRefPicker opens at the
// caret (figure → panels → inserts `@fig-x[-panels]`). A pure input-level
// trick: the on-disk grammar is unchanged.

import { EditorView } from "@codemirror/view";
import { closeCompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

export function figRefTrigger(open: () => void): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "@" || from !== to) return false;
    if (view.state.sliceDoc(from - 1, from) !== "@") return false;
    // The first `@` must itself start a token — `name@@`, `a@@b` (emails,
    // code) and a third `@` in a row stay literal text.
    const before = from >= 2 ? view.state.sliceDoc(from - 2, from - 1) : "";
    if (/[\w@]/.test(before)) return false;
    view.dispatch({ changes: { from: from - 1, to: from }, userEvent: "delete" });
    closeCompletion(view); // the first @ opened the citation list — retract it
    open();
    return true;
  });
}
