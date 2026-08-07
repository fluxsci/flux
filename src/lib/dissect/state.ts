// Dissect viewer state + the hotkey's selection→plot resolution. The open/closed state is a
// plain writable (the importerOpen layering rule: keyboard.ts, Inspector and the overlay all
// need it), and openDissectForSelection mirrors openXray's resolution ladder — a drilled part
// resolves to its OWNING plot, else the single selected element. Dissections are keyed by the
// plot's plots/-relative path (see dissect/rules), so the last step maps the element's source
// (or, for sourceless pasted/snip images, its asset NAME) to that key.

import { get, writable } from "svelte/store";
import { project, selection, partSelection, embeddedProjectRoot, projectDir } from "../store";
import { pushToast } from "../toast";
import { plotKeyFor } from "./rules";

export interface DissectTarget {
  /** The plot's dissection key (plots/-relative path sans extension). */
  key: string;
  /** What the overlay header calls the plot (the key's basename). */
  displayName: string;
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
 * The `d` hotkey: open the Dissect overlay for the selection. Resolution ladder:
 *   1. a drilled plot part → its owning plot element;
 *   2. a single selected plot or image element → that element.
 * Anything else (empty/multi selection, non-asset elements) gets an informational toast —
 * dissections are a per-plot affordance.
 */
type AssetEl = { type: string; assetId?: string; source?: { svgPath?: string } };

export function openDissectForSelection(): void {
  const p = get(project);
  let el: AssetEl | null = null;
  const ps = get(partSelection);
  if (ps) {
    for (const f of p.figures) {
      const hit = f.elements.find((e) => e.id === ps.elementId);
      if (hit && hit.type === "plot") {
        el = hit;
        break;
      }
    }
  }
  if (!el) {
    const sel = get(selection);
    if (sel.size === 1) {
      const id = [...sel][0];
      for (const f of p.figures) {
        const hit = f.elements.find((e) => e.id === id);
        if (hit) {
          el = hit as AssetEl;
          break;
        }
      }
    }
  }
  if (!el || !("assetId" in el && el.assetId)) {
    pushToast("info", "Select a plot to view its dissections");
    return;
  }
  const key = dissectKeyForElement(el);
  if (!key) {
    pushToast("info", "Can't locate this plot's source under plots/", {
      detail: "Dissections are keyed by the plot's file under the project's plots/ folder.",
    });
    return;
  }
  dissectTarget.set({ key, displayName: key.split("/").pop() ?? key });
}
