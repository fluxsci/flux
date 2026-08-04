// Pure text helpers for figure references — no imports, so the logic is unit-
// testable outside the browser (scripts/verify-figfamily.ts).
//
// (The old designationFromName name-parser lived here until figure families
// landed — display identity is structured now: src/lib/figfamily.ts.)

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
