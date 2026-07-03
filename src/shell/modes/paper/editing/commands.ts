// Formatting commands. Each edits the Quarto-markdown *source* through a single
// transaction (so live-preview re-renders it for free) and is annotated with one
// userEvent so undo treats it as one step (Flux_Paper_Plan.md A2).

import type { EditorView } from "@codemirror/view";
import { EditorSelection, type ChangeSpec } from "@codemirror/state";

export type Command = (view: EditorView) => boolean;

/** Toggle an inline wrap (`**`, `*`, `` ` ``, `~~`) around each selection range. */
export function toggleWrap(mark: string): Command {
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - mark.length, range.from);
      const after = state.sliceDoc(range.to, range.to + mark.length);
      // Marks sit just outside the selection → strip them.
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: range.from - mark.length, to: range.from },
            { from: range.to, to: range.to + mark.length },
          ],
          range: EditorSelection.range(
            range.from - mark.length,
            range.to - mark.length,
          ),
        };
      }
      const sel = state.sliceDoc(range.from, range.to);
      // Marks are inside the selection → strip them.
      if (
        sel.length >= mark.length * 2 &&
        sel.startsWith(mark) &&
        sel.endsWith(mark)
      ) {
        return {
          changes: {
            from: range.from,
            to: range.to,
            insert: sel.slice(mark.length, sel.length - mark.length),
          },
          range: EditorSelection.range(range.from, range.to - mark.length * 2),
        };
      }
      // Otherwise wrap (empty selection → caret lands between the marks).
      return {
        changes: { from: range.from, to: range.to, insert: mark + sel + mark },
        range: sel
          ? EditorSelection.range(
              range.from + mark.length,
              range.to + mark.length,
            )
          : EditorSelection.cursor(range.from + mark.length),
      };
    });
    view.dispatch({ ...tr, scrollIntoView: true, userEvent: "input.format" });
    view.focus();
    return true;
  };
}

// Text color uses the Pandoc/Quarto span `[text]{style="color: #hex"}` — the
// same shape the live-preview colorizes in place and the renderer emits as a
// real <span>, so editor, Preview and exports all agree on one markup.
const COLOR_TAIL_RE = /^\]\{style="color:\s*([^"}]*?)\s*"\}/;
const COLOR_SPAN_RE = /^\[([\s\S]+)\]\{style="color:\s*([^"}]*?)\s*"\}$/;
const colorTail = (color: string) => `]{style="color: ${color}"}`;

/** Set (or, with `null` / the span's current color, clear) the selection's
 *  text color. Retints in place when the selection is an existing span's inner
 *  text or covers a whole span; otherwise wraps the selection. */
export function setTextColor(color: string | null): Command {
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((range) => {
      const sel = state.sliceDoc(range.from, range.to);

      // Selection is the inner text of an existing span → retint / unwrap.
      const before = state.sliceDoc(range.from - 1, range.from);
      const tail = COLOR_TAIL_RE.exec(state.sliceDoc(range.to, range.to + 48));
      if (before === "[" && tail) {
        if (color === null || color === tail[1]) {
          return {
            changes: [
              { from: range.from - 1, to: range.from },
              { from: range.to, to: range.to + tail[0].length },
            ],
            range: EditorSelection.range(range.from - 1, range.to - 1),
          };
        }
        return {
          changes: { from: range.to, to: range.to + tail[0].length, insert: colorTail(color) },
          range: EditorSelection.range(range.from, range.to),
        };
      }

      // Selection covers a whole span → retint / unwrap.
      const cover = COLOR_SPAN_RE.exec(sel);
      if (cover) {
        const inner = cover[1];
        const insert = color === null || color === cover[2] ? inner : `[${inner}${colorTail(color)}`;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.range(range.from, range.from + insert.length),
        };
      }

      // Plain text → wrap (selecting the inner text so a follow-up click retints).
      if (color === null || !sel) return { range };
      return {
        changes: { from: range.from, to: range.to, insert: `[${sel}${colorTail(color)}` },
        range: EditorSelection.range(range.from + 1, range.from + 1 + sel.length),
      };
    });
    if (!tr.changes.empty) view.dispatch({ ...tr, scrollIntoView: true, userEvent: "input.format" });
    view.focus();
    return true;
  };
}

/** Apply a per-line prefix toggle (headings, quote, lists) across the selection. */
function eachSelectedLine(
  view: EditorView,
  fn: (lineText: string, lineFrom: number) => ChangeSpec | null,
): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const c = fn(line.text, line.from);
        if (c) changes.push(c);
      }
      if (line.to + 1 > range.to) break;
      pos = line.to + 1;
    }
  }
  if (changes.length)
    view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

export function setHeading(level: number): Command {
  return (view) =>
    eachSelectedLine(view, (text, from) => {
      const m = /^(#{1,6})\s+/.exec(text);
      if (level === 0) return m ? { from, to: from + m[0].length } : null; // → paragraph
      const want = "#".repeat(level) + " ";
      if (m && m[1].length === level) return { from, to: from + m[0].length }; // toggle off
      if (m) return { from, to: from + m[0].length, insert: want };
      return { from, insert: want };
    });
}

export const toggleQuote: Command = (view) =>
  eachSelectedLine(view, (text, from) => {
    const m = /^>\s?/.exec(text);
    if (m) return { from, to: from + m[0].length };
    return { from, insert: "> " };
  });

export const toggleBulletList: Command = (view) =>
  eachSelectedLine(view, (text, from) => {
    const m = /^(\s*)([-*+])\s+/.exec(text);
    if (m) return { from, to: from + m[0].length, insert: m[1] };
    return { from, insert: "- " };
  });

export const toggleOrderedList: Command = (view) =>
  eachSelectedLine(view, (text, from) => {
    const m = /^(\s*)\d+\.\s+/.exec(text);
    if (m) return { from, to: from + m[0].length, insert: m[1] };
    return { from, insert: "1. " };
  });

/** Wrap selection as a link; place the caret in the `url` placeholder. */
export const insertLink: Command = (view) => {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const sel = state.sliceDoc(range.from, range.to);
    if (sel) {
      const insert = `[${sel}](url)`;
      const urlAt = range.from + 1 + sel.length + 2; // after "[sel]("
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlAt, urlAt + 3),
      };
    }
    const insert = `[](url)`;
    return {
      changes: { from: range.from, insert },
      range: EditorSelection.cursor(range.from + 1),
    };
  });
  view.dispatch({ ...tr, scrollIntoView: true, userEvent: "input.link" });
  view.focus();
  return true;
};

/** Insert text at the caret (used by slash-menu / insert actions). */
export function insertAtCursor(view: EditorView, text: string, selectInner?: [number, number]) {
  const { state } = view;
  const pos = state.selection.main.from;
  const sel = selectInner
    ? EditorSelection.range(pos + selectInner[0], pos + selectInner[1])
    : EditorSelection.cursor(pos + text.length);
  view.dispatch({
    changes: { from: pos, to: state.selection.main.to, insert: text },
    selection: sel,
    userEvent: "input.insert",
    scrollIntoView: true,
  });
  view.focus();
}
