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
/** The Plots view's narrowest width. */
export const PLOTS_RAIL_MIN = 220;
/** The left rail has NO fixed widest width (owner, 2026-10-22): it may grow until the canvas keeps
 *  CANVAS_MIN_W px beside the right rail (`leftRailMax`). A stored width beyond the current window
 *  is kept and shown clamped, so widening the window brings it back. */
export const CANVAS_MIN_W = 240;
/** A sanity bound for the persisted value only (no screen is this wide). */
export const LEFT_RAIL_STORED_MAX = 8000;
export function leftRailMax(bodyWidth: number, rightRailW: number): number {
  return Math.max(0, Math.round(bodyWidth - rightRailW - CANVAS_MIN_W));
}
/** The width to SHOW: the stored one, within [min, leftRailMax] (min wins on a tiny window). */
export function shownLeftRailW(stored: number, min: number, bodyWidth: number, rightRailW: number): number {
  return bodyWidth > 0 ? Math.max(min, Math.min(stored, leftRailMax(bodyWidth, rightRailW))) : stored;
}

function load(): FigureLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = decodePreferences(JSON.parse(raw), FIGURE_LAYOUT_DEFAULTS, {
        sidebarW: { min: 140, max: LEFT_RAIL_STORED_MAX }, inspectorW: { min: 200, max: 480 },
        leftView: { enum: ["layers", "plots"] }, plotsRailW: { min: PLOTS_RAIL_MIN, max: LEFT_RAIL_STORED_MAX },
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
