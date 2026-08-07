// Tolerant delimited-text reader for the Dissect viewer. Deliberately SEPARATE from the paper
// module's tableModel.parseCsv, which is strict by design (markdown-fidelity-pinned: rejects
// ragged rows, demands 2×2) — analysis output is messier than that, and a viewer's job is to
// show the file, not to validate it. RFC4180-shaped: quoted fields, "" escapes, quoted
// newlines, CRLF; ragged rows are kept and padded at render time. Pure (no DOM, no Svelte) —
// gated by verify-dissections.ts.

export interface ParsedTable {
  /** First row of the file (shown as the sticky header). */
  header: string[];
  /** Body rows, capped at maxRows (see truncated/totalRows). */
  rows: string[][];
  /** Widest row (header included) — render pads shorter rows to this. */
  cols: number;
  /** Body row count BEFORE the cap. */
  totalRows: number;
  truncated: boolean;
  delimiter: "," | "\t";
}

export const DISSECT_TABLE_MAX_ROWS = 5000;

/** Delimiter for a file: .tsv → tab; otherwise sniff the first line (a tab-dominant "csv"
 *  is a TSV someone misnamed — show it as a table, not one comma-less column). */
export function sniffDelimiter(text: string, name = ""): "," | "\t" {
  if (/\.tsv$/i.test(name)) return "\t";
  const firstLine = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

export function parseDelimited(
  text: string,
  opts: { delimiter?: "," | "\t"; name?: string; maxRows?: number } = {},
): ParsedTable {
  const src = String(text ?? "").replace(/^﻿/, ""); // BOM
  const delim = opts.delimiter ?? sniffDelimiter(src, opts.name ?? "");
  const maxRows = opts.maxRows ?? DISSECT_TABLE_MAX_ROWS;

  const all: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    all.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      inQuotes = true; // opening quote only at field start; a mid-field " is literal
    } else if (c === delim) {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  // A trailing newline produces one phantom empty row — drop empty tail rows.
  while (all.length && all[all.length - 1].every((c) => c === "")) all.pop();

  const header = all[0] ?? [];
  const body = all.slice(1);
  const rows = body.slice(0, maxRows);
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1);
  return { header, rows, cols, totalRows: body.length, truncated: body.length > maxRows, delimiter: delim };
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
