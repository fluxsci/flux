// Dissect viewer state + the hotkey's selection→plot resolution. The open/closed state is a
// plain writable (the importerOpen layering rule: keyboard.ts, Inspector and the overlay all
// need it). The selection→plot ladder is NOT here: it is plotsRail/focusPlot's
// resolvePlotElement, shared with the Plots rail's Dissections pane (one ladder — the
// verify-plots-rail-focus gate pins that this file keeps no private copy). Dissections are keyed
// by the plot's plots/-relative path (see dissect/rules); sourceless pasted/snip images fall
// back to their asset NAME.

import { get, writable } from "svelte/store";
import { project, selection, partSelection, embeddedProjectRoot, projectDir } from "../store";
import { pushToast } from "../toast";
import { plotKeyFor } from "./rules";
import { resolvePlotElement, focusTargetFor } from "../plotsRail/focusPlot";

export interface DissectTarget {
  /** The plot's dissection key (plots/-relative path sans extension). */
  key: string;
  /** What the overlay header calls the plot (the key's basename). */
  displayName: string;
  /** Open straight to this file's detail view (the Plots rail's Enter / ⤢ on a file). */
  initial?: { group: string; name: string };
}

/** Non-null = the Dissect overlay is open on this plot. */
export const dissectTarget = writable<DissectTarget | null>(null);

export function closeDissect(): void {
  dissectTarget.set(null);
}

/** The project root the viewer reads under (figure mode pins embeddedProjectRoot). */
export function dissectRoot(): string {
  return get(embeddedProjectRoot) || get(projectDir) || "";
}

/** Resolve an element to its dissection key ("" when nothing usable). Exported for the
 *  Inspector's badge, which resolves the same way the hotkey does. */
export function dissectKeyForElement(el: { type: string; assetId?: string; source?: { svgPath?: string } }): string {
  const root = dissectRoot();
  const assetName = el.assetId ? (get(project).assets.find((a) => a.id === el.assetId)?.name ?? "") : "";
  // A plot's source.svgPath is authoritative; pasted/snip images (and legacy plots with no
  // source) fall back to the asset's original basename — predictable, documented.
  const src = (el.type === "plot" && el.source?.svgPath) || assetName;
  return src ? plotKeyFor(src, root) : "";
}

/**
 * The `d` hotkey: open the Dissect overlay for the selection. The selection→plot ladder is the
 * Plots rail's (plotsRail/focusPlot resolvePlotElement — ONE ladder): a drilled part → its
 * owning plot; a single selected element; with several selected, the last plot-like one. A
 * placed dissection FILE opens its owner plot's dissections at that file.
 */
export function openDissectForSelection(): void {
  const el = resolvePlotElement(get(project), get(selection), get(partSelection));
  if (!el || !el.assetId) {
    pushToast("info", "Select a plot to view its dissections");
    return;
  }
  const root = dissectRoot();
  const assetName = get(project).assets.find((a) => a.id === el.assetId)?.name ?? "";
  void focusTargetFor(el, root, assetName).then((t) => {
    if (t.kind === "external") {
      pushToast("info", "Library plots have no dissections", {
        detail: "Dissections live in a project's plots/_dissections folder.",
      });
      return;
    }
    if (!t.key) {
      pushToast("info", "Can't locate this plot's source under plots/", {
        detail: "Dissections are keyed by the plot's file under the project's plots/ folder.",
      });
      return;
    }
    dissectTarget.set({ key: t.key, displayName: t.key.split("/").pop() ?? t.key, ...(t.file ? { initial: t.file } : {}) });
  });
}
