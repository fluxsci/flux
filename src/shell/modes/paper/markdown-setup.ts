// Assembles the CodeMirror 6 extensions for Flux Paper. This is THE single
// assembly point — the live-preview engine, science chips, comment marks,
// slash/citation autocomplete and the view-mode compartment all compose here
// (Flux_Paper_Plan.md Part 2). Keep precedence intentional: our formatting
// keymap is prepended ahead of the default keymap so it wins.

import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { fluxTheme, fluxHighlight } from "./flux-theme";
import { livePreview } from "./live-preview/livePreview";

export interface EditorExtensionOpts {
  /** Live-preview rendering (headings/emphasis/chips render in place). Default on. */
  livePreview?: boolean;
  /** Extra extensions appended by the caller (chips, comments, view-mode, keymaps). */
  extra?: Extension[];
}

export function createEditorExtensions(
  opts: EditorExtensionOpts = {},
): Extension[] {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    markdown({ extensions: [GFM] }),
    syntaxHighlighting(fluxHighlight),
    fluxTheme,
    opts.livePreview === false ? [] : livePreview,
    opts.extra ?? [],
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  ];
}
