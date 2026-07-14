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
//   paper:  the NUMBERING singletons are gone (WS-4.2 landed: per-editor
//           numberingFacet + margin-host threading) — the remaining reasons
//           are the cursor/selection-bubble singletons; the block stays until
//           those are per-pane too.
//   figure: the figure stores (project/selection/viewport in lib/store.ts)
//           are fully app-global — both panes would render every commit and
//           fight over selection. Real fix = per-pane figure stores (F5.3,
//           deferred — do not build here).
//   slide:  slides-are-figures — slide mode loads the deck INTO those same
//           app-global figure stores, so it is a singleton for the same reason.
const SINGLETON_MODES: readonly ModeId[] = ["paper", "figure", "slide"];
const MODE_LABEL: Partial<Record<ModeId, string>> = { paper: "manuscript", figure: "figure", slide: "slide" };
function wouldDuplicateSingleton(kept: Pane[], incoming: ModeId): boolean {
  if (!SINGLETON_MODES.includes(incoming)) return false;
  const existing = kept.find((p) => p.mode === incoming);
  if (!existing) return false;
  focusedPaneId.set(existing.id);
  pushToast("info", `Two ${MODE_LABEL[incoming] ?? incoming} panes aren’t supported yet`, {
    detail:
      incoming === "paper"
        ? "Keep one pane on Paper; open the other as Figure, Slide, Library, or Reader."
        : `Focused the existing ${incoming === "slide" ? "Slide" : "Figure"} pane instead.`,
  });
  return true;
}

// Slide-migration §3.2.1: figure and slide mode SHARE the app-global figure
// store (a deck loads into it, projected as figures), so they may never be
// simultaneously visible — deny the request with a toast (predictable beats
// clever). Mutual keep-alive eviction (below) handles the hidden-mode case.
const EXCLUSIVE_PAIRS: readonly [ModeId, ModeId][] = [["figure", "slide"]];
function wouldViolateExclusivity(kept: Pane[], incoming: ModeId): boolean {
  for (const [a, b] of EXCLUSIVE_PAIRS) {
    const other = incoming === a ? b : incoming === b ? a : null;
    if (other && kept.some((p) => p.mode === other)) {
      pushToast("info", "Figure and Slide share the editing engine and can’t be open side-by-side", {
        detail: "Close or switch the other pane first.",
      });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Keep-alive eviction (slide-migration §3.2.1): an explicit trigger for
// ModeContent's MRU — entering figure mode force-evicts a kept-alive slide
// mode (and vice versa) so the two store tenants are never resident together.
// The payload is a counter so repeated evictions of the same mode re-notify.
// ---------------------------------------------------------------------------
export const evictRequest = writable<{ n: number; mode: ModeId | null }>({ n: 0, mode: null });
export function evictMode(mode: ModeId): void {
  evictRequest.update((r) => ({ n: r.n + 1, mode }));
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
  const others = get(panes).filter((p) => p.id !== fid);
  if (wouldDuplicateSingleton(others, mode)) return;
  if (wouldViolateExclusivity(others, mode)) return;
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
    if (wouldViolateExclusivity(focused, mode)) return;
    panes.update((list) => list.map((p) => (p.id !== fid ? { ...p, mode } : p)));
    return;
  }
  if (wouldDuplicateSingleton(ps, mode)) return;
  if (wouldViolateExclusivity(ps, mode)) return;
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
