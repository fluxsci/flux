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

// PAP-16 + WS-1 Fix 7b: SINGLETON modes — two side-by-side panes of these
// would share module-global state, so the split is gated for V1 and the
// request deterministically FOCUSES the pane that already shows the mode.
//   paper:  manuscript numbering/cursor/bubble singletons (WS-4.2 removes the
//           numbering ones, but the block stays until ALL are per-pane).
//   figure: the figure stores (project/selection/viewport in lib/store.ts)
//           are fully app-global — both panes would render every commit and
//           fight over selection. Real fix = per-pane figure stores (F5.3,
//           deferred — do not build here).
const SINGLETON_MODES: readonly ModeId[] = ["paper", "figure"];
function wouldDuplicateSingleton(kept: Pane[], incoming: ModeId): boolean {
  if (!SINGLETON_MODES.includes(incoming)) return false;
  const existing = kept.find((p) => p.mode === incoming);
  if (!existing) return false;
  focusedPaneId.set(existing.id);
  pushToast("info", `Two ${incoming === "paper" ? "manuscript" : "figure"} panes aren’t supported yet`, {
    detail:
      incoming === "paper"
        ? "Keep one pane on Paper; open the other as Figure, Slide, Library, or Reader."
        : "Focused the existing Figure pane instead.",
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
  if (wouldDuplicateSingleton(get(panes).filter((p) => p.id !== fid), mode)) return;
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
    if (wouldDuplicateSingleton(focused, mode)) return;
    panes.update((list) => list.map((p) => (p.id !== fid ? { ...p, mode } : p)));
    return;
  }
  if (wouldDuplicateSingleton(ps, mode)) return;
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
