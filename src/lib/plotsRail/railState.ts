// Small cross-component signals for the Plots rail (kept out of the components so keyboard.ts
// and FigureMode can reach them without importing Svelte files).
import { writable } from "svelte/store";
import { leftRailHidden } from "../settings";

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

/** A mode whose left rail can show the Plots view (Figure: [Layers | Plots]; Slide:
 *  [Slides | Plots]). Registered per store tenant, so keyboard.ts's Alt+G stays mode-agnostic. */
export interface RailHost {
  /** The rail shows the Plots view (it may still be hidden — leftRailHidden). */
  isPlots(): boolean;
  /** Show the Plots view (true) or the mode's other view (false). */
  setPlots(on: boolean): void;
}
const hosts = new Map<string, RailHost>();
/** Register `host` for a store tenant; returns the unregister function. */
export function registerRailHost(tenant: string, host: RailHost): () => void {
  hosts.set(tenant, host);
  return () => { if (hosts.get(tenant) === host) hosts.delete(tenant); };
}
export function railHostFor(tenant: string): RailHost | null {
  return hosts.get(tenant) ?? null;
}

/** Show the Plots rail of `tenant`'s mode (unhide the rail, switch to Plots) and focus its
 *  search — Alt+G's outcome, for buttons (Slide's Become bar: Add ▾ → Plot…). */
export function openPlotsRail(tenant: string): boolean {
  const host = railHostFor(tenant);
  if (!host) return false;
  leftRailHidden.set(false);
  if (!host.isPlots()) host.setPlots(true);
  requestRailFocus();
  return true;
}
