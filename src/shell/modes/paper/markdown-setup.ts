// Assembles the CodeMirror 6 extensions for Flux Paper. This is THE single
// assembly point — the live-preview engine, science chips, comment marks,
// slash/citation autocomplete and the view-mode compartment all compose here
// (Flux_Paper_Plan.md Part 2). Keep precedence intentional: our formatting
// keymap is prepended ahead of the default keymap so it wins.
//
// The `first` slot (vim) must stay first — vim claims keys at the DOM level
// and its status panel host crashes if anything initializes before it. The
// scrollMargins values keep the caret off the viewport edges.

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
import { syntaxHighlighting, codeFolding, foldKeymap } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { fluxTheme, fluxHighlight } from "./flux-theme";
import { livePreview } from "./live-preview/livePreview";
import { caretFeel } from "./editing/caretFeel";

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
  /**
   * Extensions that must precede EVERYTHING else in the tree. Vim lives here:
   * it claims keys at the DOM level ahead of all keymaps, and its ViewPlugin
   * must initialize before the shared panel host (which `search()` below pulls
   * in) or the vim status panel crashes reading `view.cm` before it exists.
   */
  first?: Extension[];
}

export function createEditorExtensions(
  opts: EditorExtensionOpts = {},
): Extension[] {
  return [
    opts.first ?? [],
    history(),
    drawSelection(),
    // PAP-23: no highlightActiveLine() — the theme intentionally paints .cm-activeLine
    // transparent, so the extension only cost a per-keystroke line decoration for nothing.
    EditorView.lineWrapping,
    markdown({ extensions: [GFM] }),
    syntaxHighlighting(fluxHighlight),
    fluxTheme,
    // Caret-feel lab (EXPERIMENTAL, caret-feel branch): overlay caret motion
    // models + blink/scroll polish. Must sit AFTER drawSelection so its
    // measure pass runs after the cursor layer's (it mirrors that geometry).
    caretFeel(),
    search({ top: true }), // PAP-10: find/replace (Cmd/Ctrl-F, Cmd/Ctrl-Alt-F)
    searchPanelTheme,
    // PAP-11: native spellcheck on the editable content (off by default in CodeMirror). Grammar-
    // aware red squiggles + the OS/Electron suggestion menu, without correcting mid-word.
    EditorView.contentAttributes.of({ spellcheck: "true", autocapitalize: "off", autocorrect: "off" }),
    // Section folding (lang-markdown ships the heading foldService; commands
    // in editing/folding.ts). No gutter — the themed "⋯" pill is the marker.
    codeFolding({
      placeholderDOM(_view, onclick) {
        const el = document.createElement("span");
        el.className = "cm-foldPlaceholder";
        el.textContent = "⋯";
        el.title = "Folded section — click to unfold";
        el.onclick = onclick;
        return el;
      },
    }),
    // Keep the caret clear of the viewport edges while arrowing (top clears
    // the overlaying title pill).
    EditorView.scrollMargins.of(() => ({ top: 84, bottom: 96 })),
    opts.livePreview === false ? [] : livePreview,
    opts.extra ?? [],
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
  ];
}
