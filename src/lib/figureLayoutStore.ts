// Figure-module layout preferences — persisted to localStorage exactly like
// slide's slideLayoutStore.ts / paper's view-mode/paperLayoutStore.ts. Holds
// the two drag-adjustable rail widths in px. A single global store shared
// across panes (MVP).

import { writable } from "svelte/store";

export interface FigureLayout {
  /** Left sidebar (canvases/figures/layers) width in px. */
  sidebarW: number;
  /** Inspector (right rail) width in px. */
  inspectorW: number;
}

const KEY = "flux.figure.layout";

// Defaults match the values the panes shipped with as fixed widths.
export const FIGURE_LAYOUT_DEFAULTS: FigureLayout = { sidebarW: 200, inspectorW: 248 };

function load(): FigureLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...FIGURE_LAYOUT_DEFAULTS, ...(JSON.parse(raw) as Partial<FigureLayout>) };
  } catch {
    /* ignore */
  }
  return { ...FIGURE_LAYOUT_DEFAULTS };
}

export const figureLayout = writable<FigureLayout>(load());

figureLayout.subscribe((v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
});
