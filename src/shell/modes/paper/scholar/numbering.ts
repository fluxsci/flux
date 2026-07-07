// Table numbering by appearance order. Figures number from the project manifest
// (see figures.ts); tables are defined inline, so the table renderer scans the
// document for `{#tbl-…}` captions and records their order here, and the @tbl
// cross-ref chips read it back (Flux_Paper_Plan.md B3). Kept in its own module
// so figures.ts and tables.ts can both use it without a cycle.

export const tableNums = new Map<string, number>();

/** Record labelled tables and their (appearance-order) numbers. */
export function setTableNumbers(pairs: { label: string; number: number }[]): void {
  tableNums.clear();
  for (const p of pairs) tableNums.set(p.label, p.number);
}

export function tableNumber(label: string): number | undefined {
  return tableNums.get(label);
}

// Equation numbering (2.1) — same appearance-order registry pattern: the display-
// math field (science/math.ts) records labeled equations as it scans, @eq chips
// read the numbers back. One shared rule with the export (science/refNumbers.ts).
export const eqNums = new Map<string, number>();

export function setEqNumbers(pairs: { label: string; number: number }[]): void {
  eqNums.clear();
  for (const p of pairs) eqNums.set(p.label, p.number);
}

export function eqNumber(label: string): number | undefined {
  return eqNums.get(label);
}
