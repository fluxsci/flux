// Double-click activation for SOURCE-LINE chips (the figure-embed name chip,
// the slide-embed "Deck 3 · Slide 4" chip).
//
// Those chips reveal their raw source the moment a selection touches their
// line, so the FIRST click of a double-click places the caret, the chip's DOM
// is replaced by the raw text, and the browser dispatches the second
// mousedown and the `dblclick` to that raw text — never to the chip. A plain
// `dblclick` listener on the chip therefore never fires for a real user
// (measured 2026-10-02: Figure never opened from the figure chip).
//
// The fix: the chip ARMS its action on the first mousedown (it is still in the
// DOM then), and one editor-level mousedown handler fires it when the second
// press of the same OS double-click (detail 2) lands on the same line of the
// same document. Returning true there also stops CodeMirror's word selection
// in the just-revealed source. The chip keeps a direct `dblclick` listener
// for the case where it is still present (synthetic events, a reveal that did
// not happen); a just-fired action suppresses that duplicate.

import { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";

interface Armed {
  doc: Text;
  line: number;
  at: number;
  run: () => void;
}

const armed = new WeakMap<EditorView, Armed>();
const firedAt = new WeakMap<EditorView, number>();
/** Generous sanity bound; the OS double-click interval itself is enforced by
 *  the browser through `MouseEvent.detail`. */
const ARM_MS = 1500;

/** Wire a chip element so a double-click on it runs `run`, even though the
 *  first click reveals the source and removes the element. */
export function armChipActivation(view: EditorView, el: HTMLElement, run: () => void): void {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      return;
    }
    armed.set(view, { doc: view.state.doc, line: view.state.doc.lineAt(pos).number, at: e.timeStamp, run });
  });
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const fired = firedAt.get(view);
    if (fired != null && e.timeStamp - fired < ARM_MS) return; // the mousedown path already ran it
    armed.delete(view);
    run();
  });
}

/** The editor-level half: install once per editor (CodeMirror dedupes the
 *  shared instance when several modules include it). */
export const chipActivation = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || e.detail !== 2) return false;
    const a = armed.get(view);
    armed.delete(view);
    if (!a || a.doc !== view.state.doc || e.timeStamp - a.at > ARM_MS) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null || view.state.doc.lineAt(pos).number !== a.line) return false;
    e.preventDefault();
    firedAt.set(view, e.timeStamp);
    a.run();
    return true;
  },
});
