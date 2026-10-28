import { get } from "svelte/store";
import { activeCanvasId, activeTool, embeddedProjectRoot, projectDir, project, selection, partSelection, nodeEditId } from "../store";
import { storeTenant } from "../tenancy";
import { joinPath } from "../project/types";
import { pushToast, errMsg } from "../toast";
import { figurePlacement } from "./placement";
import { plotSourceCandidates } from "../plot/source";

export function requestFigurePlacement(): void {
  const canvasId = get(activeCanvasId);
  if (!canvasId || storeTenant() !== "figure") return;
  nodeEditId.set(null);
  activeTool.set("select");
  figurePlacement.set({ canvasId, root: get(embeddedProjectRoot) || get(projectDir) });
}

/** Preserve explicit source paths. Imported-only plots copy their stored SVG path. */
export async function selectedPlotPath(): Promise<string | null> {
  const p = get(project), picked = get(partSelection)?.elementId;
  const ids = picked ? [picked] : [...get(selection)].reverse();
  for (const id of ids) {
    const e = p.figures.flatMap(f => f.elements).find(e => e.id === id);
    if (e?.type !== "plot") continue;
    const source = e.source?.svgPath;
    const path = source || p.assets.find(a => a.id === e.assetId)?.path;
    if (!path) return null;
    const root = get(embeddedProjectRoot) || get(projectDir);
    if (source) return plotSourceCandidates(root, source, e.source)[0] ?? null;
    if (/^(?:[a-z]:)?[\\/]/i.test(path)) return path;
    if (!root) return null;
    let base = get(embeddedProjectRoot) ? "fig" : "";
    if (storeTenant() === "slide") {
      const { currentDeck, externalAssetIds } = await import("../slide/store");
      if (get(project) !== p || storeTenant() !== "slide" || root !== (get(embeddedProjectRoot) || get(projectDir))) return null;
      const deck = currentDeck();
      if (!deck) return null;
      base = externalAssetIds().has(e.assetId) ? "" : `slides/${deck.id}`;
    }
    return joinPath(root, base, path);
  }
  return null;
}

export async function copySelectedPlotPath(): Promise<void> {
  const path = await selectedPlotPath();
  if (!path) { pushToast("info", "Select a saved plot to copy its path"); return; }
  try {
    await navigator.clipboard.writeText(path);
    pushToast("success", "Plot path copied");
  } catch (error) { pushToast("error", "Could not copy the plot path", { detail: errMsg(error) }); }
}
