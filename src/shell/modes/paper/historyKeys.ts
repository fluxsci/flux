// Paper's undo/redo keys — one list, honoured on every platform.
//
// CodeMirror's stock `historyKeymap` binds redo as `Mod-y` with a `mac: "Mod-Shift-z"`
// alternative and a SEPARATE `linux: "Ctrl-Shift-z"` entry. On Windows that leaves only
// Ctrl+Y: Ctrl+Shift+Z reaches the editor, matches nothing, and does nothing. Flux documents
// Ctrl+Shift+Z as redo "in every editor" (docs/reference/shortcuts.qmd) and the Figure/Slide
// editor accepts both chords everywhere (keyboard.ts), so Paper on Windows was the one place
// the documented key was dead — the redo step of verify-paper-slide-embeds passed on Linux CI
// and failed on a Windows checkout (2026-09-22 Windows report), and it was the product.
//
// The shifted chord is bound here with NO platform qualifier, ahead of the stock list, so every
// platform accepts Ctrl/Cmd+Shift+Z and keeps its native alternative (Ctrl+Y on Windows/Linux).
// Gate: scripts/verify-paper-history-keys.ts resolves the chord through CodeMirror's own keymap
// builder using only the entries a Windows platform can see.
import { historyKeymap, redo } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

export const paperHistoryKeymap: readonly KeyBinding[] = [
  { key: "Mod-Shift-z", run: redo, preventDefault: true },
  ...historyKeymap,
];
