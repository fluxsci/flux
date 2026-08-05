// Follow-the-item-under-the-cursor (Mod-Enter — Obsidian's follow-link muscle
// memory). Resolution order at the caret: a figure embed line → open that
// figure; a @fig chip at/adjacent (chips are atomic, the caret rests at their
// edges) → open the figure; a @tbl/@eq chip → scroll THIS editor to the
// table/equation source (they live in the document, not the figure project);
// a citation → the group editor. Returns false on plain prose so the key
// falls through.

import { EditorView } from "@codemirror/view";
import { crossrefRe } from "../science/grammar";
import { embedLineAt } from "../science/figureAttrs";
import { resolveFigure } from "../scholar/figures";
import { numberingFacet, type PaperNumbering } from "../scholar/numberingFacet";
import { citationGroupAt } from "../scholar/citeOps";

/** Scroll the editor to an in-document construct (@tbl-…/@eq-…). Shared by
 *  Mod-Enter, chip double-click and the editor-level dblclick fallback. */
export function jumpToInlineLabel(view: EditorView, nums: PaperNumbering, label: string): boolean {
  const pos = label.startsWith("tbl-")
    ? nums.tblMeta.get(label)?.pos
    : label.startsWith("eq-")
      ? nums.eqPos.get(label)
      : undefined;
  if (pos == null) return false;
  view.dispatch({
    selection: { anchor: Math.min(pos, view.state.doc.length) },
    effects: EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: "center" }),
    userEvent: "select",
  });
  view.focus();
  return true;
}

/** True for the cross-ref families that resolve INSIDE the document. */
export const isInlineFamily = (family: string): boolean => family === "tbl" || family === "eq";

export function followAtCaret(deps: {
  openFigure: (id: string) => void;
  editCitation: () => void;
}): (view: EditorView) => boolean {
  return (view) => {
    const head = view.state.selection.main.head;
    const nums = view.state.facet(numberingFacet); // WS-4.2

    const embed = embedLineAt(view.state, head);
    if (embed) {
      const r = resolveFigure(embed.id, nums);
      if (r) {
        deps.openFigure(r.ref.id);
        return true;
      }
    }

    const line = view.state.doc.lineAt(head);
    const re = crossrefRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (head >= from - 1 && head <= to + 1) {
        const label = m[0].slice(1);
        const r = resolveFigure(label, nums);
        if (r) {
          if (isInlineFamily(r.ref.family)) {
            if (jumpToInlineLabel(view, nums, label)) return true;
          } else {
            deps.openFigure(r.ref.id);
            return true;
          }
        }
      }
    }

    if (citationGroupAt(view.state, head)) {
      deps.editCitation();
      return true;
    }
    return false;
  };
}
