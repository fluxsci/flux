// Click-a-@fig-ref → jump to that figure in Figure mode (Flux_Paper_Plan.md B1).
// If a figure pane is already open it's focused; otherwise we split one in. The
// figure store only populates once FigureMode mounts + loads, so a pending id is
// left for FigureMode to consume after its load (handshake).

import { get, writable } from "svelte/store";
import { panes, focusPane, splitWith } from "../paneStore";
import { activeFigureId, activeCanvasId, project, viewport } from "../../lib/store";
import { readerKey } from "../modes/reader/readerStore";

export const pendingRevealFigureId = writable<string | null>(null);

/** Center the figure editor on a figure by id. Returns false if not loaded yet. */
export function focusFigure(figId: string): boolean {
  const p = get(project);
  const fig = p.figures.find((f) => f.id === figId);
  if (!fig) return false;
  activeCanvasId.set(fig.canvasId);
  activeFigureId.set(figId);
  const zoom = 0.55;
  viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
  pendingRevealFigureId.set(null);
  return true;
}

export function revealFigure(figId: string) {
  const ps = get(panes);
  const existing = ps.find((p) => p.mode === "figure");
  if (existing) focusPane(existing.id);
  else splitWith("figure");
  pendingRevealFigureId.set(figId);
  // If the figure store is already loaded, jump immediately too.
  focusFigure(figId);
}

/** Open a paper's PDF in FluxReader without losing the current pane — same
 *  split-or-focus behavior as revealFigure (ReaderMode reads readerKey
 *  reactively, so setting it works whether the pane exists yet or not). */
export function revealReader(citekey: string) {
  const ps = get(panes);
  const existing = ps.find((p) => p.mode === "reader");
  if (existing) focusPane(existing.id);
  else splitWith("reader");
  readerKey.set(citekey);
}
