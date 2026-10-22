import { decodePreferences } from "./preferences";
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
  /** Which view the left rail shows: Layers (canvases/figures/layers) or Plots (gallery + dissections). */
  leftView: "layers" | "plots";
  /** The Plots view's own width (a gallery wants more room than a layer list). */
  plotsRailW: number;
  /** Gallery's share of the Plots view's height (the rest is Dissections). */
  plotsSplit: number;
  galleryCollapsed: boolean;
  dissectCollapsed: boolean;
}

const KEY = "flux.figure.layout";

// Defaults match the values the panes shipped with as fixed widths.
export const FIGURE_LAYOUT_DEFAULTS: FigureLayout = { sidebarW: 200, inspectorW: 248, leftView: "layers", plotsRailW: 320, plotsSplit: 0.62, galleryCollapsed: false, dissectCollapsed: false };
/** Bounds for the Plots view width (the upper one also yields to half the window at drag time). */
export const PLOTS_RAIL_MIN = 220;
export const PLOTS_RAIL_MAX = 720;

function load(): FigureLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = decodePreferences(JSON.parse(raw), FIGURE_LAYOUT_DEFAULTS, {
        sidebarW: { min: 140, max: 420 }, inspectorW: { min: 200, max: 480 },
        leftView: { enum: ["layers", "plots"] }, plotsRailW: { min: PLOTS_RAIL_MIN, max: PLOTS_RAIL_MAX },
        plotsSplit: { min: 0.05, max: 0.95 },
      });
      // Both panes collapsed is not a state the rail offers.
      if (v.galleryCollapsed && v.dissectCollapsed) v.dissectCollapsed = false;
      return v;
    }
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
