import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { OutlineItem } from "./outline/outline";
import { boundsOf, registerTargetResolver } from "../../../lib/bridge/targetResolvers";
import { describeTarget, type TargetRef } from "../../../lib/project/targets";

export function nearestHeading(list: OutlineItem[], pos: number): string | undefined {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].from <= pos) lo = mid + 1; else hi = mid; }
  return list[lo - 1]?.text;
}

export function registerPaperTargets(view: EditorView, path: () => string, outline: () => OutlineItem[], focused: () => boolean) {
  function target(from: number, to: number): TargetRef {
    return { kind: "doc", path: path(), from, to, quote: view.state.sliceDoc(from, Math.min(to, from + 400)), heading: nearestHeading(outline(), from) };
  }
  return registerTargetResolver({ surface: "paper", root: () => view.dom,
    revision: () => [view.state.doc, view.state.selection, view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft],
    current: () => { const s = view.state.selection.main; return focused() ? [target(s.from, s.to)] : []; },
    within(rect) {
      const a = view.posAtCoords({ x: rect.x, y: rect.y }, false), b = view.posAtCoords({ x: rect.x + rect.w, y: rect.y + rect.h }, false);
      if (a == null || b == null) return [];
      const ref = target(Math.min(a, b), Math.max(a, b));
      return [{ ref, bounds: rect, label: describeTarget(ref) }];
    },
    at(x, y, node) {
      const pos = view.posAtCoords({ x, y }); if (pos == null) return [];
      let syntax = syntaxTree(view.state).resolveInner(pos, 1);
      while (syntax.parent && !/^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|Blockquote)$/.test(syntax.name)) syntax = syntax.parent;
      const line = view.state.doc.lineAt(pos);
      const ref = syntax.parent ? target(syntax.from, syntax.to) : target(line.from, line.to);
      const bounds = boundsOf(node?.closest('.cm-line') ?? view.contentDOM);
      if (ref.kind === "doc") {
        const a = view.coordsAtPos(ref.from), b = view.coordsAtPos(Math.max(ref.from, ref.to - 1));
        const top = Math.min(bounds.y, a?.top ?? bounds.y), bottom = Math.max(bounds.y + bounds.h, b?.bottom ?? bounds.y);
        bounds.y = top; bounds.h = bottom - top;
      }
      return [{ ref, bounds, label: describeTarget(ref) }];
    },
  });
}
