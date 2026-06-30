// Transient view state for the INTERACTIVE slide canvas: user zoom (1 = fit) and
// pan offset in screen px. Not persisted — pan resets per slide, zoom is a live
// session affordance (like PowerPoint's zoom). Shared so the deckbar zoom control
// (SlideMode) and the canvas (SlideStage) drive the same value. Non-interactive
// thumbnails ignore it and always fit.

import { writable } from "svelte/store";

export interface StageView {
  /** User zoom multiplier on top of the fit-scale. 1 = fit-to-viewport. */
  zoom: number;
  /** Pan offset of the scaled slide within the viewport, in screen px. */
  panX: number;
  panY: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

export const stageView = writable<StageView>({ zoom: 1, panX: 0, panY: 0 });

/** Back to fit (zoom 1, centered). */
export function resetStageView(): void {
  stageView.set({ zoom: 1, panX: 0, panY: 0 });
}
