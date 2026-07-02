// Assembles the CodeMirror 6 extensions for Flux Paper. This is THE single
// assembly point — the live-preview engine, science chips, comment marks,
// slash/citation autocomplete and the view-mode compartment all compose here
// (Flux_Paper_Plan.md Part 2). Keep precedence intentional: our formatting
// keymap is prepended ahead of the default keymap so it wins.

import {
  EditorView,
  keymap,
  drawSelection,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { fluxTheme, fluxHighlight } from "./flux-theme";
import { livePreview } from "./live-preview/livePreview";

// PAP-10: a themed find/replace panel (Cmd/Ctrl-F). CodeMirror ships the behavior; this just
// dresses the panel in the manuscript surface's tokens so it doesn't look like a raw browser box.
const searchPanelTheme = EditorView.theme({
  ".cm-panels": { background: "var(--c-surface)", color: "var(--c-tx)", borderColor: "var(--c-line-strong)" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "system-ui, sans-serif", fontSize: "var(--ts-sm)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { fontSize: "var(--ts-sm)" },
  ".cm-panel.cm-search input": {
    background: "var(--c-bg)", color: "var(--c-tx)",
    border: "1px solid var(--c-line-strong)", borderRadius: "var(--r-1)", padding: "2px 6px",
  },
  ".cm-panel.cm-search button": {
    background: "var(--c-surface)", color: "var(--c-tx-2)",
    border: "1px solid var(--c-line-strong)", borderRadius: "var(--r-1)", cursor: "pointer",
  },
  ".cm-panel.cm-search button[name=close]": { color: "var(--c-tx-muted)" },
  ".cm-searchMatch": { background: "var(--c-accent-tint, rgba(67,133,190,0.25))" },
  ".cm-searchMatch-selected": { background: "var(--c-accent-glow, rgba(67,133,190,0.5))" },
});

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
    // PAP-23: no highlightActiveLine() — the theme intentionally paints .cm-activeLine
    // transparent, so the extension only cost a per-keystroke line decoration for nothing.
    EditorView.lineWrapping,
    markdown({ extensions: [GFM] }),
    syntaxHighlighting(fluxHighlight),
    fluxTheme,
    search({ top: true }), // PAP-10: find/replace (Cmd/Ctrl-F, Cmd/Ctrl-Alt-F)
    searchPanelTheme,
    // PAP-11: native spellcheck on the editable content (off by default in CodeMirror). Grammar-
    // aware red squiggles + the OS/Electron suggestion menu, without correcting mid-word.
    EditorView.contentAttributes.of({ spellcheck: "true", autocapitalize: "off", autocorrect: "off" }),
    opts.livePreview === false ? [] : livePreview,
    opts.extra ?? [],
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
  ];
}
