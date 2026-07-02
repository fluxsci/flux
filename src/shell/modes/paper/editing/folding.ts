// Section folding at the caret. lang-markdown ships the heading foldService,
// but it only answers when the queried line IS the heading — these commands
// add "fold the section I'm IN": walk up to the nearest heading, fold its
// range, and park the caret on the heading so unfold works from the same
// spot. No gutter by design (gutters are display:none in this editor) — the
// themed "⋯" placeholder is the indicator, foldKeymap + the palette the
// controls.

import type { EditorView } from "@codemirror/view";
import { foldable, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import type { Line } from "@codemirror/state";

function nearestHeading(view: EditorView): Line | null {
  const { state } = view;
  for (let n = state.doc.lineAt(state.selection.main.head).number; n >= 1; n--) {
    const line = state.doc.line(n);
    if (/^#{1,6}\s/.test(line.text)) return line;
  }
  return null;
}

export function foldSection(view: EditorView): boolean {
  const line = nearestHeading(view);
  if (!line) return false;
  const range = foldable(view.state, line.from, line.to);
  if (!range) return false;
  view.dispatch({
    effects: foldEffect.of(range),
    selection: { anchor: line.from },
  });
  return true;
}

export function unfoldSection(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = nearestHeading(view);
  const effects: ReturnType<typeof unfoldEffect.of>[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    const atHeading = line && from >= line.from && from <= line.to + 1;
    const atCaret = head >= from - 1 && head <= to + 1;
    if (atHeading || atCaret) effects.push(unfoldEffect.of({ from, to }));
  });
  if (!effects.length) return false;
  view.dispatch({ effects });
  return true;
}
