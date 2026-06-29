// Bridges CodeMirror selection geometry → a Svelte store that positions the
// floating formatting bubble (Flux_Paper_Plan.md A2). Coordinates are in the
// viewport, so the bubble is rendered position:fixed (no host-offset maths).

import { EditorView } from "@codemirror/view";
import { writable } from "svelte/store";

export interface BubbleState {
  visible: boolean;
  /** viewport x of the selection centre */
  cx: number;
  /** viewport y of the selection's top */
  top: number;
}

export const bubble = writable<BubbleState>({ visible: false, cx: 0, top: 0 });

function hide() {
  bubble.update((b) => (b.visible ? { ...b, visible: false } : b));
}

/** A CM update listener that publishes the bubble position on selection change. */
export const selectionWatcher = EditorView.updateListener.of((u) => {
  const view = u.view;
  if (!view.hasFocus) {
    hide();
    return;
  }
  const sel = view.state.selection.main;
  if (sel.empty) {
    hide();
    return;
  }
  const a = view.coordsAtPos(sel.from);
  const b = view.coordsAtPos(sel.to);
  if (!a || !b) {
    hide();
    return;
  }
  bubble.set({
    visible: true,
    cx: (a.left + b.right) / 2,
    top: Math.min(a.top, b.top),
  });
});
