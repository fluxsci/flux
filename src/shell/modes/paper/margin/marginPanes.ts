// The dynamic margin's pane stack. Semantics per the owner's spec: summon
// opens the pane (ensuring the margin is visible) or focuses it if already
// open; panes stack in one column and split the height equally; opening past
// the max (a setting) evicts the oldest. Focus-return-to-editor on close stays
// at the CALL SITES (the frame's ✕ / Escape via MarginApi, the hotkeys in
// PaperMode) per feel invariant #7.
//
// Per-pane (dual-paper 2026-08-11): the stack used to be module-scope "house
// style… so any feature flow can summon a pane without prop plumbing" — which
// meant pane A's margin showed panes summoned from pane B. Each PaperMode now
// creates ONE stack and hands it to its own DynamicMargin; every in-pane flow
// summons through that instance. (The margin's open/width flags stay in the
// shared paperLayout — a genuine preference.)

import { writable, get, type Writable } from "svelte/store";
import { settings } from "../../../../lib/settings";
import { paperLayout } from "../view-mode/paperLayoutStore";

export interface OpenPane {
  id: string;
  /** Stable keyed-each identity so siblings never remount on stack changes. */
  key: number;
  initialQuery?: string;
}

export interface MarginPaneStack {
  openPanes: Writable<OpenPane[]>;
  /** The pane that owns focus (or last did) — Alt+P's target, brighter outline. */
  activePaneId: Writable<string | null>;
  /** Bumped to route focus into a pane (freshly opened or re-summoned). */
  paneFocusReq: Writable<{ id: string; n: number }>;
  summonPane(id: string, opts?: { initialQuery?: string }): void;
  closePane(id: string): void;
  /** Close the active (else most recently opened) pane. True if one closed. */
  closeActivePane(): boolean;
  closeAllPanes(): boolean;
}

export function createMarginPanes(): MarginPaneStack {
  const openPanes = writable<OpenPane[]>([]);
  const activePaneId = writable<string | null>(null);
  const paneFocusReq = writable<{ id: string; n: number }>({ id: "", n: 0 });
  let nextKey = 1;

  function summonPane(id: string, opts?: { initialQuery?: string }): void {
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

  function closePane(id: string): void {
    openPanes.update((panes) => panes.filter((p) => p.id !== id));
    activePaneId.update((a) => (a === id ? null : a));
  }

  function closeActivePane(): boolean {
    const panes = get(openPanes);
    if (!panes.length) return false;
    const id = get(activePaneId) ?? panes[panes.length - 1].id;
    closePane(panes.some((p) => p.id === id) ? id : panes[panes.length - 1].id);
    return true;
  }

  function closeAllPanes(): boolean {
    if (!get(openPanes).length) return false;
    openPanes.set([]);
    activePaneId.set(null);
    return true;
  }

  return { openPanes, activePaneId, paneFocusReq, summonPane, closePane, closeActivePane, closeAllPanes };
}
