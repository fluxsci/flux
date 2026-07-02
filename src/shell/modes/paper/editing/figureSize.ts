// Keyboard-first figure resizing (the primary affordance — the drag grip and
// hover buttons in science/embeds.ts are the pointer equivalents). Commands
// return false when the caret isn't on an embed line, so the bindings cost
// nothing elsewhere and fall through to the defaults.

import type { EditorView } from "@codemirror/view";
import { embedLineAt, setEmbedWidth, widthFraction } from "../science/figureAttrs";

export const WIDTH_PRESETS = [25, 33, 50, 66, 75, 100];

/** Current width as a preset-comparable percent (unset ⇒ 100, fit-to-column). */
function currentPct(view: EditorView): { pct: number; explicit: boolean } | null {
  const info = embedLineAt(view.state, view.state.selection.main.head);
  if (!info) return null;
  const f = widthFraction(info.attrs.width);
  return f ? { pct: Math.round(f * 100), explicit: true } : { pct: 100, explicit: false };
}

/** Snap to the next/previous preset. Bound to Mod-Alt-= / Mod-Alt-- . */
export const stepEmbedWidth =
  (dir: 1 | -1) =>
  (view: EditorView): boolean => {
    const cur = currentPct(view);
    if (!cur) return false;
    const next =
      dir > 0
        ? (WIDTH_PRESETS.find((p) => p > cur.pct) ?? 100)
        : ([...WIDTH_PRESETS].reverse().find((p) => p < cur.pct) ?? WIDTH_PRESETS[0]);
    if (next === cur.pct) return true; // at the bound — consume, no edit
    return setEmbedWidth(view, view.state.selection.main.head, `${next}%`);
  };

/** Palette presets; pct=null resets to auto (removes the attr). */
export function setEmbedWidthPreset(view: EditorView, pct: number | null): boolean {
  return setEmbedWidth(view, view.state.selection.main.head, pct === null ? null : `${pct}%`);
}
