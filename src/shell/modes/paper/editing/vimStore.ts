// The vim-flavor preference — persisted to localStorage exactly like
// view-mode/paperViewStore.ts. Three states, off by default:
//   "off"  — no vim
//   "vim"  — plain vim (Obsidian/VSCode-vim behavior, untouched defaults)
//   "flux" — flux-ViM: plain vim plus Flux's own opt-in tweaks (see
//            editing/vim.ts `applyFluxFlavor` — first tweak: `jj` leaves
//            insert mode).

import { writable } from "svelte/store";

export type VimFlavor = "off" | "vim" | "flux";

const KEY = "flux.paper.vimFlavor";
// Pre-flavor boolean key ("1"/"0") — migrated on first load, never written.
const LEGACY_KEY = "flux.paper.vimMode";

function load(): VimFlavor {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "off" || v === "vim" || v === "flux") return v;
    return localStorage.getItem(LEGACY_KEY) === "1" ? "vim" : "off";
  } catch {
    return "off";
  }
}

export const paperVimFlavor = writable<VimFlavor>(load());
paperVimFlavor.subscribe((v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
});
