// Bridges CodeMirror selection geometry → a Svelte store that positions the
// floating formatting bubble (Flux_Paper_Plan.md A2). Coordinates are in the
// viewport, so the bubble is rendered position:fixed (no host-offset maths).
//
// Per-pane (dual-paper 2026-08-11): PaperMode creates ONE bubble per instance
// and installs the watcher into its own extension tree — the old module-global
// store meant selecting in pane B moved the bubble pane A was rendering (the
// "selection-bubble singleton" the pane gate named).

import { EditorView } from "@codemirror/view";
import { writable, type Writable } from "svelte/store";

export interface BubbleState {
  visible: boolean;
  /** viewport x of the selection centre */
  cx: number;
  /** viewport y of the selection's top */
  top: number;
}

export interface SelectionBubble {
  bubble: Writable<BubbleState>;
  /** A CM update listener that publishes the bubble position on selection change. */
  watcher: ReturnType<typeof EditorView.updateListener.of>;
}

export function createSelectionBubble(): SelectionBubble {
  const bubble = writable<BubbleState>({ visible: false, cx: 0, top: 0 });
  const hide = () => bubble.update((b) => (b.visible ? { ...b, visible: false } : b));
  const watcher = EditorView.updateListener.of((u) => {
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
  return { bubble, watcher };
}
