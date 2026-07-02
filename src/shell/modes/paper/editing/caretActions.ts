// Follow-the-item-under-the-cursor (Mod-Enter — Obsidian's follow-link muscle
// memory). Resolution order at the caret: a figure embed line → open that
// figure; a @fig/@tbl chip at/adjacent (chips are atomic, the caret rests at
// their edges) → open the figure; a citation → the group editor. Returns
// false on plain prose so the key falls through.

import type { EditorView } from "@codemirror/view";
import { crossrefRe } from "../science/grammar";
import { embedLineAt } from "../science/figureAttrs";
import { resolveFigure } from "../scholar/figures";
import { citationGroupAt } from "../scholar/citeOps";

export function followAtCaret(deps: {
  openFigure: (id: string) => void;
  editCitation: () => void;
}): (view: EditorView) => boolean {
  return (view) => {
    const head = view.state.selection.main.head;

    const embed = embedLineAt(view.state, head);
    if (embed) {
      const r = resolveFigure(embed.id);
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
        const r = resolveFigure(m[0].slice(1));
        if (r) {
          deps.openFigure(r.ref.id);
          return true;
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
