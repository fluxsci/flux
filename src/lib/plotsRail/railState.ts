// Small cross-component signals for the Plots rail (kept out of the components so keyboard.ts
// and FigureMode can reach them without importing Svelte files).
import { writable } from "svelte/store";

/** Bumped to ask the mounted rail to focus its gallery search (Alt+G). */
export const plotsRailFocusRequest = writable(0);
/** The rail's Quick Look is open: it owns the keyboard (the editor keymap yields). */
export const railQuickLook = writable(false);
