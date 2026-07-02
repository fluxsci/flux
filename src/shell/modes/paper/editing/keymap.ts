// Formatting keyboard shortcuts. Prepended ahead of the default keymap so it
// wins; markdown()'s own continue-markup keymap (Enter/Backspace) is untouched.

import { keymap } from "@codemirror/view";
import {
  insertLink,
  setHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleQuote,
  toggleWrap,
} from "./commands";
import { stepEmbedWidth } from "./figureSize";

export const formattingKeymap = keymap.of([
  // Figure width stepping (zoom mnemonic). Only fires with the caret on an
  // embed line — returns false elsewhere so the keys fall through.
  { key: "Mod-Alt--", run: stepEmbedWidth(-1) },
  { key: "Mod-Alt-=", run: stepEmbedWidth(1) },
  { key: "Mod-b", run: toggleWrap("**"), preventDefault: true },
  { key: "Mod-i", run: toggleWrap("*"), preventDefault: true },
  { key: "Mod-e", run: toggleWrap("`"), preventDefault: true },
  // Link insert moved off Mod-k so the ⌘K command palette can own it (Redesign v2).
  { key: "Mod-Shift-k", run: insertLink, preventDefault: true },
  { key: "Mod-Shift-1", run: setHeading(1), preventDefault: true },
  { key: "Mod-Shift-2", run: setHeading(2), preventDefault: true },
  { key: "Mod-Shift-3", run: setHeading(3), preventDefault: true },
  { key: "Mod-Shift-4", run: setHeading(4), preventDefault: true },
  { key: "Mod-Shift-0", run: setHeading(0), preventDefault: true },
  { key: "Mod-Shift-.", run: toggleQuote, preventDefault: true },
  { key: "Mod-Shift-8", run: toggleBulletList, preventDefault: true },
  { key: "Mod-Shift-7", run: toggleOrderedList, preventDefault: true },
]);
