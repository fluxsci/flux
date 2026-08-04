// Paper-module layout preferences — persisted to localStorage exactly like
// paperViewStore.ts. Holds the outliner/dynamic-margin open state, the two
// reader-adjustable editor gutters (as fractions of the editor-column width,
// null = centered 72ch default), the dynamic-margin width, and the outliner's
// collapsed node paths. A single global store (shared across paper panes) for
// MVP — see the redesign plan's per-pane note.

import { writable } from "svelte/store";

export interface PaperLayout {
  outlinerOpen: boolean;
  /** Outliner (left rail) width in px. */
  outlinerW: number;
  /** Left gutter as a fraction [0,1] of the editor-column width; null = centered default. */
  gutterL: number | null;
  /** Right gutter as a fraction [0,1] of the editor-column width; null = centered default. */
  gutterR: number | null;
  dynMarginOpen: boolean;
  /** Dynamic-margin width in px. */
  dynMarginW: number;
  /** Outliner collapsed node paths (stable tree paths, not doc offsets). */
  collapsed: string[];
  /** F4: active document's project-relative path (validated on load; null = main). */
  activeDocPath?: string | null;
}

const KEY = "flux.paper.layout";

// First-run shows the full three-column workspace (mockup intent); the choice
// then persists, so returning users keep whatever they last set.
const DEFAULTS: PaperLayout = {
  outlinerOpen: true,
  outlinerW: 224,
  gutterL: null,
  gutterR: null,
  dynMarginOpen: true,
  dynMarginW: 340,
  collapsed: [],
};

function load(): PaperLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PaperLayout>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export const paperLayout = writable<PaperLayout>(load());

paperLayout.subscribe((v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
});
