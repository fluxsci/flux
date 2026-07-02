// Pure text helpers for figure references — no imports, so the logic is unit-
// testable outside the browser (scripts/verify-figname.ts).

/** Flux-figure is the source of truth for a figure's DESIGNATION. When its
 *  name is itself a designation — "Figure 3", "Fig S2", "figure 7" — the
 *  token after the word IS the display number, so renaming in flux-figure
 *  ("Figure 6" → "Figure 7") propagates to every chip, embed caption, hover
 *  card and export. Descriptive names ("Growth curves") return null and the
 *  caller falls back to the order-based ordinal. */
export function designationFromName(name: string): string | null {
  const m = /^fig(?:ure)?\.?\s+(\S.*)$/i.exec(name.trim());
  return m ? m[1].trim() : null;
}

/** True when the name already carries the designation — UI that shows
 *  "Fig {number}" next to the name should then drop the redundant name. */
export const nameIsDesignation = (name: string): boolean => designationFromName(name) !== null;

/** Serialize a set of panel letters into the `@fig` suffix grammar. Selection
 *  order is irrelevant — output follows the figure's own panel order. Runs of
 *  ≥3 consecutive panels collapse to a range ("a-c"); pairs and singles join
 *  with commas ("a,b"). Returns "" when nothing is selected (whole figure). */
export function panelSpec(
  ref: { panels: string[] },
  selected: Iterable<string>,
): string {
  const want = new Set(selected);
  const idxs = ref.panels
    .map((p, i) => (want.has(p) ? i : -1))
    .filter((i) => i >= 0);
  const parts: string[] = [];
  for (let s = 0; s < idxs.length; ) {
    let e = s;
    while (e + 1 < idxs.length && idxs[e + 1] === idxs[e] + 1) e++;
    if (e - s >= 2) {
      parts.push(`${ref.panels[idxs[s]]}-${ref.panels[idxs[e]]}`);
    } else {
      for (let k = s; k <= e; k++) parts.push(ref.panels[idxs[k]]);
    }
    s = e + 1;
  }
  return parts.join(",");
}

/** The full reference text to insert: `@fig-x`, `@fig-x-a`, `@fig-x-a-c,e`… */
export function figRefText(
  ref: { label: string; panels: string[] },
  selected: Iterable<string>,
): string {
  const spec = panelSpec(ref, selected);
  return "@" + ref.label + (spec ? "-" + spec : "");
}
