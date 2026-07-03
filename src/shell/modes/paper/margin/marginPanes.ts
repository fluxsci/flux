// The dynamic margin's pane stack — module-scope stores (house style, like
// refReveal.ts) so any feature flow can summon a pane without prop plumbing.
// Semantics per the owner's spec: summon opens the pane (ensuring the margin
// is visible) or focuses it if already open; panes stack in one column and
// split the height equally; opening past the max (a setting) evicts the
// oldest. Focus-return-to-editor on close stays at the CALL SITES (the frame's
// ✕ / Escape via MarginApi, the hotkeys in PaperMode) per feel invariant #7.

import { writable, get } from "svelte/store";
import { settings } from "../../../../lib/settings";
import { paperLayout } from "../view-mode/paperLayoutStore";

export interface OpenPane {
  id: string;
  /** Stable keyed-each identity so siblings never remount on stack changes. */
  key: number;
  initialQuery?: string;
}

export const openPanes = writable<OpenPane[]>([]);
/** The pane that owns focus (or last did) — Alt+P's target, brighter outline. */
export const activePaneId = writable<string | null>(null);
/** Bumped to route focus into a pane (freshly opened or re-summoned). */
export const paneFocusReq = writable<{ id: string; n: number }>({ id: "", n: 0 });

let nextKey = 1;

export function summonPane(id: string, opts?: { initialQuery?: string }): void {
  paperLayout.update((s) => (s.dynMarginOpen ? s : { ...s, dynMarginOpen: true }));
  const panes = get(openPanes);
  if (!panes.some((p) => p.id === id)) {
    const max = Math.max(1, Math.floor(get(settings).paperMaxMarginPanes) || 4);
    const next = [...panes, { id, key: nextKey++, initialQuery: opts?.initialQuery }];
    openPanes.set(next.slice(-max)); // over the max → evict the oldest
  }
  activePaneId.set(id);
  paneFocusReq.update((r) => ({ id, n: r.n + 1 }));
}

export function closePane(id: string): void {
  openPanes.update((panes) => panes.filter((p) => p.id !== id));
  activePaneId.update((a) => (a === id ? null : a));
}

/** Close the active (else most recently opened) pane. True if one closed. */
export function closeActivePane(): boolean {
  const panes = get(openPanes);
  if (!panes.length) return false;
  const id = get(activePaneId) ?? panes[panes.length - 1].id;
  closePane(panes.some((p) => p.id === id) ? id : panes[panes.length - 1].id);
  return true;
}

export function closeAllPanes(): boolean {
  if (!get(openPanes).length) return false;
  openPanes.set([]);
  activePaneId.set(null);
  return true;
}
