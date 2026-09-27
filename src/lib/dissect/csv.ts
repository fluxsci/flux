// Tolerant delimited-text reader for the Dissect viewer. Deliberately SEPARATE from the paper
// module's tableModel.parseCsv, which is strict by design (markdown-fidelity-pinned: rejects
// ragged rows, demands 2×2) — analysis output is messier than that, and a viewer's job is to
// show the file, not to validate it. RFC4180-shaped: quoted fields, "" escapes, quoted
// newlines, CRLF; ragged rows are kept and padded at render time. Pure (no DOM, no Svelte) —
// gated by verify-dissections.ts.

export interface ParsedTable {
  header: string[];
  rows: string[][];
  cols: number;
  /** Exact only when complete; otherwise the number of complete records scanned. */
  totalRows: number;
  truncated: boolean;
  complete: boolean;
  delimiter: "," | "\t";
  diagnostics: { columns: boolean; cells: number; characters: boolean; input: boolean };
}
export const DISSECT_TABLE_MAX_ROWS = 5000;
export const DISSECT_TABLE_MAX_COLUMNS = 128;
export const DISSECT_TABLE_MAX_CELL_CHARS = 4096;
export const DISSECT_TABLE_MAX_STORED_CHARS = 2 * 1024 * 1024;
export const DISSECT_TABLE_MAX_BYTES = 16 * 1024 * 1024;
export interface ParseOptions {
  delimiter?: "," | "\t"; name?: string; maxRows?: number;
  maxColumns?: number; maxCellChars?: number; maxStoredChars?: number;
  inputTruncated?: boolean;
}

/** Sniff only a bounded prefix; a malformed million-column header cannot allocate
 * a million-element regexp match or delay the first frame. */
export function sniffDelimiter(text: string, name = ""): "," | "\t" {
  if (/\.tsv$/i.test(name)) return "\t";
  let tabs = 0, commas = 0;
  for (let i = 0; i < Math.min(text.length, 65536) && text[i] !== "\n" && text[i] !== "\r"; i++) {
    if (text[i] === "\t") tabs++; else if (text[i] === ",") commas++;
  }
  return tabs > commas ? "\t" : ",";
}
const limit = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.max(0, Math.min(fallback, Math.floor(value!))) : fallback;

/** One scanner serves synchronous headless callers and the cooperative viewer.
 * Beyond the retained prefix it counts records without allocating fields/rows. */
export function createDelimitedParser(text: string, opts: ParseOptions = {}) {
  const src = String(text ?? "");
  const delimiter = opts.delimiter ?? sniffDelimiter(src, opts.name);
  const maxRows = limit(opts.maxRows, DISSECT_TABLE_MAX_ROWS);
  const maxColumns = Math.max(1, limit(opts.maxColumns, DISSECT_TABLE_MAX_COLUMNS));
  const maxCellChars = limit(opts.maxCellChars, DISSECT_TABLE_MAX_CELL_CHARS);
  const maxStoredChars = limit(opts.maxStoredChars, DISSECT_TABLE_MAX_STORED_CHARS);
  const retained: string[][] = [];
  const diagnostics = { columns: false, cells: 0, characters: false, input: !!opts.inputTruncated };
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row: string[] = [], field = "", inQuotes = false, fieldChars = 0, col = 0;
  let record = 0, lastNonempty = -1, rowNonempty = false, chars = 0, cellCut = false, done = false;
  const keep = () => record <= maxRows && col < maxColumns;
  const append = (c: string) => {
    fieldChars++; rowNonempty = true;
    if (!keep()) return;
    if (field.length < maxCellChars && chars < maxStoredChars) { field += c; chars++; }
    else { cellCut = true; if (chars >= maxStoredChars) diagnostics.characters = true; }
  };
  const endField = () => {
    if (record <= maxRows) {
      if (col < maxColumns) { row.push(field); if (cellCut) diagnostics.cells++; }
      else diagnostics.columns = true;
    }
    col++; field = ""; fieldChars = 0; cellCut = false;
  };
  const endRow = () => {
    endField();
    if (record <= maxRows) retained.push(row);
    if (rowNonempty) lastNonempty = record;
    record++; row = []; col = 0; rowNonempty = false;
  };
  const snapshot = (): ParsedTable => {
    const visible = retained.slice(0, done ? lastNonempty + 1 : retained.length);
    const header = visible[0] ?? [], rows = visible.slice(1);
    const totalRows = Math.max(0, (done ? lastNonempty + 1 : record) - 1);
    return { header, rows, cols: Math.max(1, ...visible.map(r => r.length)), totalRows,
      truncated: totalRows > rows.length || diagnostics.columns || !!diagnostics.cells || diagnostics.input,
      complete: done && !diagnostics.input, delimiter, diagnostics: { ...diagnostics } };
  };
  return {
    get done() { return done; }, snapshot,
    step(charBudget = 32768) {
      const stop = Math.min(src.length, i + Math.max(1, charBudget));
      for (; i < stop; i++) {
        const c = src[i];
        if (inQuotes) {
          if (c === '"') { if (src[i + 1] === '"') { append('"'); i++; } else inQuotes = false; }
          else append(c);
        } else if (c === '"' && fieldChars === 0) inQuotes = true;
        else if (c === delimiter) endField();
        else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; endRow(); }
        else append(c);
      }
      if (i >= src.length && !done) {
        // A byte-bounded prefix may end in a partial record. Never present it as
        // a complete scientific observation, even when its quote is unclosed.
        if (!opts.inputTruncated && (fieldChars || col)) endRow();
        done = true;
      }
      return done;
    },
  };
}
export function parseDelimited(text: string, opts: ParseOptions = {}): ParsedTable {
  const parser = createDelimitedParser(text, opts);
  while (!parser.step()) { /* synchronous engine for bounded/headless use */ }
  return parser.snapshot();
}
export async function parseDelimitedAsync(text: string, opts: ParseOptions & { signal?: AbortSignal; onProgress?: (table: ParsedTable) => void } = {}): Promise<ParsedTable> {
  const parser = createDelimitedParser(text, opts);
  let published = false;
  while (!parser.done) {
    if (opts.signal?.aborted) throw new DOMException("Table loading cancelled", "AbortError");
    parser.step();
    if (!published) { const prefix = parser.snapshot(); if (prefix.rows.length || parser.done) { opts.onProgress?.(prefix); published = true; } }
    if (!parser.done) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (opts.signal?.aborted) throw new DOMException("Table loading cancelled", "AbortError");
  return parser.snapshot();
}

export const dissectCollator = new Intl.Collator(undefined, { numeric: true });
export function tableOrder(table: ParsedTable, column: number, direction: 1 | -1, numeric = numericColumns(table)): number[] {
  const indices = table.rows.map((_, i) => i);
  if (column < 0) return indices;
  return indices.sort((a, b) => {
    const va = table.rows[a][column] ?? "", vb = table.rows[b][column] ?? "";
    if (va === "" && vb === "") return a - b;
    if (va === "") return 1;
    if (vb === "") return -1;
    const d = numeric[column] && isNumericCell(va) && isNumericCell(vb) ? numericValue(va) - numericValue(vb) : dissectCollator.compare(va, vb);
    return d ? d * direction : a - b;
  });
}

const NUM_RE = /^[+-]?(?:\d[\d,_]*)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Is this cell numeric for alignment/sorting? ("", the padding value, is neutral.) */
export function isNumericCell(v: string): boolean {
  const s = v.trim();
  return s !== "" && s !== "-" && s !== "+" && NUM_RE.test(s);
}

export function numericValue(v: string): number {
  return Number(v.trim().replace(/[,_]/g, ""));
}

/** Column alignment: right-align a column when ≥90% of its non-empty cells are numeric.
 *  Sampled over the first 200 rows — enough signal, O(1) in file size. */
export function numericColumns(t: ParsedTable): boolean[] {
  const out: boolean[] = [];
  const sample = t.rows.slice(0, 200);
  for (let c = 0; c < t.cols; c++) {
    let seen = 0;
    let num = 0;
    for (const r of sample) {
      const v = (r[c] ?? "").trim();
      if (v === "") continue;
      seen++;
      if (isNumericCell(v)) num++;
    }
    out.push(seen > 0 && num / seen >= 0.9);
  }
  return out;
}
