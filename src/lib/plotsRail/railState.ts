// Small cross-component signals for the Plots rail (kept out of the components so keyboard.ts
// and FigureMode can reach them without importing Svelte files).
import { writable } from "svelte/store";

/** Bumped to ask the mounted rail to focus its gallery search (Alt+G). */
export const plotsRailFocusRequest = writable(0);
// The request is ONE-SHOT: Alt+G can arrive before the rail mounts (a hidden rail), so a
// component must act on a pending request at mount — but a later remount (Layers → Plots by
// tab) must not replay an old Alt+G (re-focusing the search, un-collapsing the gallery).
let pending = false;
/** Ask the rail to focus its search (keyboard.ts, Alt+G). */
export function requestRailFocus(): void { pending = true; plotsRailFocusRequest.update((n) => n + 1); }
/** Whether a request is waiting (without taking it). */
export function railFocusPending(): boolean { return pending; }
/** Take the waiting request (true once per Alt+G). */
export function takeRailFocus(): boolean { const p = pending; pending = false; return p; }
/** The rail's Quick Look is open: it owns the keyboard (the editor keymap yields). */
export const railQuickLook = writable(false);
