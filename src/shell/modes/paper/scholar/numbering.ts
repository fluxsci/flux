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
