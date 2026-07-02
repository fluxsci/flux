// The vim-mode preference — a user preference, persisted to localStorage
// exactly like view-mode/paperViewStore.ts. Off by default.

import { writable } from "svelte/store";

const KEY = "flux.paper.vimMode";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export const paperVimMode = writable<boolean>(load());
paperVimMode.subscribe((v) => {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
});
