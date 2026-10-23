// Placing plots from the Plots rail — through the ONE insert pipeline (io.importPlotsFromPaths:
// true physical size, fluxplot sidecars, the destination re-checked after the async reads).
// Every placement is visible: the destination chip flashes and a toast names the figure, with a
// Show action — the active figure may be scrolled off-screen.
//
// A mode may hand the rail its own PlaceAdapter (Slide: deck/slide guards, video clips, the
// Become pick's Add mode); it still ends in importPlotsFromPaths.

import { get, writable } from "svelte/store";
import { importPlotsFromPaths, type PlaceAt } from "../io";
import { project, activeFigureId, embeddedProjectRoot, projectDir } from "../store";
import { storeTenant } from "../tenancy";
import { pushToast, errMsg } from "../toast";
import { centerOnFigure } from "../viewportNav";
import type { Figure } from "../types";

/** Bumps after every successful placement (the destination chip flashes). */
export const insertFlash = writable(0);

/** A mode's placement route: place `paths` in the active figure/slide (at `at` for a drop). */
export type PlaceAdapter = (paths: string[], canPlace: () => boolean, opts: { at?: PlaceAt }) => Promise<number>;

const currentRoot = () => get(embeddedProjectRoot) || get(projectDir) || "";

/** What the rail calls a destination: "Fig 3"-style names in Figure, "Slide 4" / its name in Slide. */
export function destinationName(fig: Pick<Figure, "id" | "name"> & { nickname?: string } | null | undefined, figures: readonly { id: string }[] = get(project).figures): string {
  if (!fig) return "";
  if (storeTenant() === "slide") return fig.name || `Slide ${figures.findIndex((f) => f.id === fig.id) + 1}`;
  return fig.nickname || fig.name || "the figure";
}

/** Place `paths` in the active figure, or — for a drop — in `at.figId` at the drop point. */
export async function insertPlots(paths: string[], at?: { figId: string; x: number; y: number; fx: number; fy: number }, adapter?: PlaceAdapter | null): Promise<number> {
  if (!paths.length) return 0;
  const slide = storeTenant() === "slide";
  const figId = at?.figId ?? get(activeFigureId);
  const fig = get(project).figures.find((f) => f.id === figId);
  if (!fig) { pushToast("info", slide ? "Select a slide to place plots on" : "Select a figure to place plots in"); return 0; }
  // A drop onto another figure makes it the destination (and the active figure) first: the
  // pipeline re-checks that the destination did not change while it read the files.
  if (get(activeFigureId) !== fig.id) activeFigureId.set(fig.id);
  const root = currentRoot();
  const canPlace = () => get(activeFigureId) === fig.id && currentRoot() === root;
  const opts = at ? { at: { x: at.x, y: at.y, fx: at.fx, fy: at.fy } } : {};
  try {
    const n = adapter ? await adapter(paths, canPlace, opts) : await importPlotsFromPaths(paths, canPlace, undefined, opts);
    if (n > 0) {
      insertFlash.update((k) => k + 1);
      const name = destinationName(fig);
      const what = paths.every((p) => /\.(mp4|mov)$/i.test(p)) ? (n === 1 ? "1 clip" : `${n} clips`) : n === 1 ? "1 plot" : `${n} plots`;
      // A slide is always the one on stage; a figure may be scrolled off-screen (Show).
      pushToast("success", `Placed ${what} ${slide ? "on" : "in"} ${name}`, slide ? undefined : { action: { label: "Show", run: () => { centerOnFigure(fig.id); } } });
    }
    return n;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return 0;
    if (e instanceof DOMException && e.name === "AbortError") return 0;
    pushToast("error", "Could not place the plot", { detail: errMsg(e) });
    return 0;
  }
}
