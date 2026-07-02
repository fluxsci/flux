// Workspace pane layout. Starts as a single pane; can split into two
// side-by-side panes, each hosting a mode. Architected to grow into a nested
// tree later (Flux_Integration_Plan.md §2D).

import { writable, derived, get } from "svelte/store";
import type { ModeId } from "./shellStore";
import { pushToast } from "../lib/toast";

export interface Pane {
  id: string;
  mode: ModeId;
}

// PAP-16: two Paper panes side-by-side would share the manuscript's module-global singletons
// (table numbering, cursor position, the selection bubble), so `@tbl` numbers and the comment
// bubble collide across panes. Rather than ship that broken, gate the split for V1: refuse to
// leave two manuscript panes open and say why. (Removing this = keying those stores per-pane.)
function wouldDuplicatePaper(kept: Pane[], incoming: ModeId): boolean {
  if (incoming !== "paper" || !kept.some((p) => p.mode === "paper")) return false;
  pushToast("info", "Two manuscript panes aren’t supported yet", {
    detail: "Keep one pane on Paper; open the other as Figure, Slide, Library, or Reader.",
  });
  return true;
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
  if (wouldDuplicatePaper(get(panes).filter((p) => p.id !== fid), mode)) return;
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
    const focused = ps.filter((p) => p.id === fid);
    if (wouldDuplicatePaper(focused, mode)) return;
    panes.update((list) => list.map((p) => (p.id !== fid ? { ...p, mode } : p)));
    return;
  }
  if (wouldDuplicatePaper(ps, mode)) return;
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
