// Caption panels: a figure's captions are one-per-panel, where panels are the
// text elements the user has explicitly marked as panel labels (Alt+L / the
// inspector toggle — TextElement.panelLabel). Caption text is stored on
// Figure.captions keyed by the label element's id (see CaptionEditor).

import type { Figure, Id } from "./types";

export interface Panel {
  /** The label element's id, or "__figure__" for the whole-figure fallback. */
  id: Id;
  /** The displayed label ("" for the fallback). */
  label: string;
}

/** Normalised key for sorting labels (strip wrappers, lowercase). */
function sortKey(label: string): string {
  return label.replace(/[().]/g, "").trim().toLowerCase();
}

/**
 * Derive the caption panels for a figure: one per text element marked as a
 * panel label, sorted by label (a, b, c, …). If nothing is marked, fall back
 * to a single whole-figure caption.
 */
export function figurePanels(fig: Figure): Panel[] {
  const panels: Panel[] = [];
  for (const e of fig.elements) {
    if (e.type === "text" && e.panelLabel) {
      panels.push({ id: e.id, label: e.text.trim() });
    }
  }
  panels.sort(
    (a, b) => sortKey(a.label).localeCompare(sortKey(b.label)) || a.label.localeCompare(b.label),
  );
  if (panels.length === 0) return [{ id: "__figure__", label: "" }];
  return panels;
}
