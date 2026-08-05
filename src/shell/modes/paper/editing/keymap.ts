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
import { foldSection, unfoldSection } from "./folding";

// WS-4.3: the CM-owned chords the window dispatcher must NEVER claim (the
// pure gate intersects this against the command table), plus the single-source
// palette hint strings for CM-owned actions.
export const CM_CHORD_STRINGS = [
  "Mod-Alt--",
  "Mod-Alt-=",
  "Ctrl-Shift-[",
  "Ctrl-Shift-]",
  "Mod-b",
  "Mod-i",
  "Mod-e",
  "Mod-Shift-k",
  "Mod-Shift-1",
  "Mod-Shift-2",
  "Mod-Shift-3",
  "Mod-Shift-4",
  "Mod-Shift-0",
  "Mod-Shift-.",
  "Mod-Shift-8",
  "Mod-Shift-7",
  // Owned by other CM layers (not this keymap, still CM territory):
  "Mod-Enter", // follow-at-caret
  "Mod-Alt-m", // comment on selection
  "Mod-f", // search
  // Table editing (editing/tableOps.ts tableKeymap; all fall through off-table):
  "Mod-Alt-r", // insert row below
  "Mod-Alt-Shift-r", // delete row
  "Mod-Alt-c", // insert column right
  "Mod-Alt-Shift-c", // delete column
  "Mod-Alt-a", // cycle column alignment
] as const;

export const CM_HINTS = {
  commentSelection: "⌘⌥M",
  figWidth: "⌘⌥− / ⌘⌥=",
  foldSection: "⌃⇧[",
  unfoldSection: "⌃⇧]",
  tableRowBelow: "⌘⌥R",
  tableDeleteRow: "⌘⌥⇧R",
  tableColRight: "⌘⌥C",
  tableDeleteCol: "⌘⌥⇧C",
  tableAlign: "⌘⌥A",
} as const;

export const formattingKeymap = keymap.of([
  // Figure width stepping (zoom mnemonic). Only fires with the caret on an
  // embed line — returns false elsewhere so the keys fall through.
  { key: "Mod-Alt--", run: stepEmbedWidth(-1) },
  { key: "Mod-Alt-=", run: stepEmbedWidth(1) },
  // Fold the section the caret is IN (supersedes foldCode on the same chord —
  // foldKeymap's other bindings, incl. fold/unfold-all, still apply).
  { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: foldSection },
  { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: unfoldSection },
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
