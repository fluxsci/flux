// Placing plots from the Plots rail — through the ONE insert pipeline (io.importPlotsFromPaths:
// true physical size, fluxplot sidecars, the destination re-checked after the async reads).
// Every placement is visible: the destination chip flashes and a toast names the figure, with a
// Show action — the active figure may be scrolled off-screen.

import { get, writable } from "svelte/store";
import { importPlotsFromPaths } from "../io";
import { project, activeFigureId, embeddedProjectRoot, projectDir } from "../store";
import { pushToast, errMsg } from "../toast";
import { centerOnFigure } from "../viewportNav";

/** Bumps after every successful placement (the destination chip flashes). */
export const insertFlash = writable(0);

const currentRoot = () => get(embeddedProjectRoot) || get(projectDir) || "";

/** Place `paths` in the active figure, or — for a drop — in `at.figId` at the drop point. */
export async function insertPlots(paths: string[], at?: { figId: string; x: number; y: number; fx: number; fy: number }): Promise<number> {
  if (!paths.length) return 0;
  const figId = at?.figId ?? get(activeFigureId);
  const fig = get(project).figures.find((f) => f.id === figId);
  if (!fig) { pushToast("info", "Select a figure to place plots in"); return 0; }
  // A drop onto another figure makes it the destination (and the active figure) first: the
  // pipeline re-checks that the destination did not change while it read the files.
  if (get(activeFigureId) !== fig.id) activeFigureId.set(fig.id);
  const root = currentRoot();
  const canPlace = () => get(activeFigureId) === fig.id && currentRoot() === root;
  try {
    const n = await importPlotsFromPaths(paths, canPlace, undefined, at ? { at: { x: at.x, y: at.y, fx: at.fx, fy: at.fy } } : {});
    if (n > 0) {
      insertFlash.update((k) => k + 1);
      const name = fig.nickname || fig.name || "the figure";
      pushToast("success", `Placed ${n === 1 ? "1 plot" : `${n} plots`} in ${name}`, { action: { label: "Show", run: () => { centerOnFigure(fig.id); } } });
    }
    return n;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return 0;
    pushToast("error", "Could not place the plot", { detail: errMsg(e) });
    return 0;
  }
}
