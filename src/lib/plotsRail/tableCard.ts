// A dissection CSV/TSV as a card in the Dissections pane: the head of the file, parsed by the
// tolerant reader (dissect/csv.ts), and the card's height for the grid (pure; gate:
// scripts/verify-plots-rail-focus.ts).
import { parseDelimited } from "../dissect/csv";

export interface TablePreview {
  header: string[];
  rows: string[][];
  /** Lower bound unless `complete` (a bounded read cannot know the true count). */
  rowCount: number;
  complete: boolean;
  cols: number;
  /** One wide row (> 5 columns) shown as key/value lines — typical `_stats` output. */
  transposed: boolean;
  error?: string;
}

export const CARD_ROWS = 6;
const LINE = 15, TITLE = 20, PAD = 6;

/** Parse the head of a CSV/TSV for a card (or, with `maxRows`, for Peek's longer look). */
export function tablePreview(text: string, name: string, truncatedInput: boolean, maxRows = CARD_ROWS): TablePreview {
  const t = parseDelimited(text, { name, maxRows: maxRows + 1, inputTruncated: truncatedInput });
  const transposed = t.rows.length === 1 && t.cols > 5;
  return { header: t.header, rows: t.rows.slice(0, maxRows), rowCount: t.totalRows, complete: t.complete && !truncatedInput, cols: t.cols, transposed };
}

/** The card's height (the grid lays it out as a block of this height). */
export function tableCardHeight(p: TablePreview | null): number {
  if (!p || p.error) return TITLE + LINE + PAD;
  const lines = p.transposed ? Math.min(p.cols, 8) : 1 + Math.min(p.rows.length, CARD_ROWS);
  return TITLE + lines * LINE + PAD;
}
