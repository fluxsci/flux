// Vim mode for the Paper editor (@replit/codemirror-vim — the same engine
// Obsidian's vim mode uses). Loaded through a Compartment so the palette
// toggle swaps it live without rebuilding the view (caret/scroll/history all
// survive, same pattern as the page-view compartment). The compartment content
// must sit BEFORE every other keymap in the extension tree — vim handles keys
// at the DOM-event level and expects first claim.

import { Compartment, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { completionStatus, closeCompletion } from "@codemirror/autocomplete";
import { vim, Vim } from "@replit/codemirror-vim";
import type { VimFlavor } from "./vimStore";

export const vimCompartment = new Compartment();

// flux-ViM — Flux's own flavor: plain vim plus a small set of opt-in tweaks.
// Every flavor tweak lives HERE, in one place. The mappings are engine-global
// state (Vim.map mutates the shared vim instance), so they are applied or
// removed on every flavor (re)configure — plain "vim" must always get stock
// behavior back.
function applyFluxFlavor(on: boolean) {
  try {
    if (on) {
      // Tweak 1: `jj` in rapid succession leaves insert mode (no reach for Esc).
      Vim.map("jj", "<Esc>", "insert");
    } else {
      Vim.unmap("jj", "insert");
    }
  } catch {
    /* unmapping a never-mapped key is a harmless no-op */
  }
}

// VSCode/Obsidian Esc ordering: while the @/slash completion tooltip is open,
// the FIRST Esc closes the tooltip and stays in insert mode; the SECOND Esc
// reaches vim and leaves insert mode. Vim consumes keys via a DOM keydown
// handler (above the keymap facet), so a plain keymap binding could never win
// — this shim is a Prec.highest DOM handler registered before vim() so it
// deterministically runs first.
const escClosesCompletionFirst = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.key !== "Escape" || completionStatus(view.state) !== "active") return false;
      closeCompletion(view);
      return true;
    },
  }),
);

// Dress vim's fat cursor + bottom status panel (mode / pending keys / ex line)
// in the paper surface's tokens.
const vimTheme = EditorView.theme({
  ".cm-fat-cursor": {
    background: "var(--c-accent) !important",
    color: "var(--c-on-accent) !important",
  },
  "&:not(.cm-focused) .cm-fat-cursor": {
    background: "none !important",
    outline: "1px solid var(--c-accent)",
  },
  ".cm-vim-panel": {
    background: "var(--c-surface)",
    color: "var(--c-tx-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    padding: "2px 8px",
    borderTop: "1px solid var(--c-line)",
  },
  ".cm-vim-panel input": {
    color: "var(--c-tx)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
  },
});

export function vimExtensions(flavor: VimFlavor): Extension {
  applyFluxFlavor(flavor === "flux");
  return flavor === "off" ? [] : [escClosesCompletionFirst, vim({ status: true }), vimTheme];
}
