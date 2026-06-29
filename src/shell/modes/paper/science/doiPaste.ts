// Paste a bare DOI or doi.org URL and it becomes a citation: the metadata is
// fetched, written to library.bib, and a [@key] chip is inserted in place
// (Flux_Paper_Plan.md B5). Only fires when the whole paste is a DOI — pasting a
// paragraph that happens to contain one is left alone.

import { EditorView } from "@codemirror/view";

const DOI_ONLY =
  /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"<>]+)$/i;

export type DoiHandler = (
  doi: string,
  view: EditorView,
  from: number,
  to: number,
) => void;

export function doiPaste(onDoi: DoiHandler) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const text = (event.clipboardData?.getData("text/plain") ?? "").trim();
      const m = DOI_ONLY.exec(text);
      if (!m) return false;
      event.preventDefault();
      const sel = view.state.selection.main;
      onDoi(m[1].replace(/[.,;]$/, ""), view, sel.from, sel.to);
      return true;
    },
  });
}
