import { get } from "svelte/store";
import { activeCanvasId, activeTool, embeddedProjectRoot, projectDir, project, selection, partSelection, nodeEditId } from "../store";
import { storeTenant } from "../tenancy";
import { fileBridge, joinPath } from "../project/types";
import { pushToast, errMsg } from "../toast";
import { figurePlacement } from "./placement";
import { plotSourceCandidates } from "../plot/source";
import type { SemanticPlotElement } from "../types";

export function requestFigurePlacement(): void {
  const canvasId = get(activeCanvasId);
  if (!canvasId || storeTenant() !== "figure") return;
  nodeEditId.set(null);
  activeTool.set("select");
  figurePlacement.set({ canvasId, root: get(embeddedProjectRoot) || get(projectDir) });
}

/** The selected plots' files, in selection order: a linked source where it
 *  resolves on disk, else an imported-only plot's accepted SVG in the directory
 *  that owns it (Figure: the project's fig/; Slide: the deck, or the project for
 *  a project-resolved asset). */
export async function selectedPlotPaths(): Promise<string[]> {
  const p = get(project), picked = get(partSelection)?.elementId;
  const byId = new Map(p.figures.flatMap(f => f.elements).map(e => [e.id, e]));
  const plots = (picked ? [picked] : [...get(selection)])
    .map(id => byId.get(id))
    .filter((e): e is SemanticPlotElement => e?.type === "plot");
  const root = get(embeddedProjectRoot) || get(projectDir);
  if (!plots.length) return [];
  let base = get(embeddedProjectRoot) ? "fig" : "";
  let external: ReadonlySet<string> = new Set();
  if (storeTenant() === "slide") {
    const slide = await import("../slide/store");
    // The deck may have been switched while the module loaded.
    const deck = get(slide.deckOverlay);
    if (!deck || get(project) !== p) return [];
    base = `slides/${deck.id}`;
    external = slide.externalAssetIds();
  }
  const fb = fileBridge(), out: string[] = [];
  for (const e of plots) {
    let path: string | null = null;
    if (e.source?.svgPath) {
      const candidates = plotSourceCandidates(root, e.source.svgPath, e.source);
      path = candidates[0] ?? null;
      for (const c of candidates) if (await fb?.exists(c)) { path = c; break; }
    } else {
      const stored = p.assets.find(a => a.id === e.assetId)?.path;
      if (stored && /^(?:[a-z]:)?[\\/]/i.test(stored)) path = stored;
      else if (stored && root) path = joinPath(root, external.has(e.assetId) ? "" : base, stored);
    }
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export async function copySelectedPlotPath(): Promise<void> {
  const paths = await selectedPlotPaths();
  if (!paths.length) { pushToast("info", "Select a saved plot to copy its path"); return; }
  try {
    await navigator.clipboard.writeText(paths.join("\n"));
    pushToast("success", paths.length === 1 ? "Plot path copied" : `${paths.length} plot paths copied`, { detail: paths.length === 1 ? paths[0] : undefined });
  } catch (error) { pushToast("error", "Could not copy the plot path", { detail: errMsg(error) }); }
}
