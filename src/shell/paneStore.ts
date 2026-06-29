// Workspace pane layout. Starts as a single pane; can split into two
// side-by-side panes, each hosting a mode. Architected to grow into a nested
// tree later (Flux_Integration_Plan.md §2D).

import { writable, derived, get } from "svelte/store";
import type { ModeId } from "./shellStore";

export interface Pane {
  id: string;
  mode: ModeId;
}

let counter = 0;
const newId = () => `pane-${++counter}`;

const firstId = newId();
export const panes = writable<Pane[]>([{ id: firstId, mode: "paper" }]);
export const focusedPaneId = writable<string>(firstId);

/** The mode of the currently-focused pane (drives the activity rail). */
export const focusedMode = derived(
  [panes, focusedPaneId],
  ([$panes, $focused]) =>
    $panes.find((p) => p.id === $focused)?.mode ?? $panes[0]?.mode ?? "paper",
);

export function resetPanes(mode: ModeId = "paper") {
  const id = newId();
  panes.set([{ id, mode }]);
  focusedPaneId.set(id);
}

export function focusPane(id: string) {
  focusedPaneId.set(id);
}

/** Set the focused pane's mode. */
export function setFocusedMode(mode: ModeId) {
  const fid = get(focusedPaneId);
  panes.update((ps) => ps.map((p) => (p.id === fid ? { ...p, mode } : p)));
}

/**
 * Open `mode` in a split. If single-pane: add a second pane and focus it. If
 * already split: set the *other* (non-focused) pane's mode.
 */
export function splitWith(mode: ModeId) {
  const ps = get(panes);
  if (ps.length >= 2) {
    const fid = get(focusedPaneId);
    panes.update((list) => list.map((p) => (p.id !== fid ? { ...p, mode } : p)));
    return;
  }
  const id = newId();
  panes.set([...ps, { id, mode }]);
  focusedPaneId.set(id);
}

export function closePane(id: string) {
  const ps = get(panes);
  if (ps.length <= 1) return;
  const remaining = ps.filter((p) => p.id !== id);
  panes.set(remaining);
  if (get(focusedPaneId) === id) focusedPaneId.set(remaining[0].id);
}
