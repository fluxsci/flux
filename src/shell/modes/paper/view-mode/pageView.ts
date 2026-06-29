// Continuous ↔ paginated editing surface (Flux_Paper_Plan.md A3). A Compartment
// swaps a theme variant in place — no editor rebuild, caret/scroll preserved.
// "Paginated" is a page *feel* (a centred sheet on a darker desk); true page
// breaks live in the rendered Preview/export (Principle 7).

import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PaperViewMode } from "./paperViewStore";

export const pageCompartment = new Compartment();

/** Continuous: the base 72ch column (fluxTheme already provides it). */
export const continuousTheme = EditorView.theme({});

/** Paginated: a bright cream sheet, centred on a slightly darker cream desk. */
export const paginatedTheme = EditorView.theme({
  "&": { backgroundColor: "var(--c-surface-2)" },
  ".cm-scroller": { padding: "30px 0 80px" },
  ".cm-content": {
    maxWidth: "780px",
    margin: "0 auto",
    padding: "92px 104px",
    minHeight: "1000px",
    background: "var(--flx-paper)",
    border: "1px solid var(--c-line-strong)",
    borderRadius: "3px",
    boxShadow: "var(--elev-2)",
    // faint page-break guide, ~letter content height
    backgroundImage:
      "repeating-linear-gradient(var(--flx-paper), var(--flx-paper) 1003px, var(--c-line) 1003px, var(--c-line) 1004px, var(--flx-paper) 1004px)",
  },
});

export function themeFor(mode: PaperViewMode) {
  return mode === "paginated" ? paginatedTheme : continuousTheme;
}
