// A Canvas's hit-testing surface for things dragged in from outside it (the Plots rail's
// drag-to-place). ONE holder per FigureMode instance — created there and handed to that
// instance's Canvas (which fills it on mount, clears it on destroy) and its left rail — never a
// module singleton: a split workspace mounts several FigureModes, and a stale singleton would
// point a drop at a destroyed or neighbouring canvas.

import type { Figure } from "../types";

export interface CanvasHits {
  /** The canvas host's screen box (read once per drag by the caller — no layout per move). */
  hostRect(): DOMRect | null;
  /** The figure under a client point, given the host box captured at drag start. */
  figureAt(clientX: number, clientY: number, host: DOMRect): Figure | null;
  /** A client point in a figure's local coordinates (px at 96/in, unzoomed). */
  toFigure(fig: Figure, clientX: number, clientY: number, host: DOMRect): { x: number; y: number };
  zoom(): number;
  /** Light the frame that would receive the drop (the OS-file drop's highlight). */
  setDropHighlight(figId: string | null): void;
}

export interface HitBridgeHolder {
  get(): CanvasHits | null;
  set(hits: CanvasHits | null): void;
}

export function createHitBridge(): HitBridgeHolder {
  let current: CanvasHits | null = null;
  return {
    get: () => current,
    set: (hits) => { current = hits; },
  };
}
