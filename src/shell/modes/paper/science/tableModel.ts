// ONE escape-aware pipe-table grammar for the paper module: the editor widget
// (tables.ts), the editing ops (editing/tableOps.ts), paste conversion
// (tablePaste.ts) and the pure gates all consume THIS parse/serialize pair.
//
// The fidelity target is markdown-it's GFM table rule: the export renderer
// (render/renderManuscript.ts) feeds the same text to markdown-it, so any
// grammar drift here IS an editor↔export divergence. The pre-2026-08 widget
// had four: naive split("|") broke on \| escapes, header/delimiter column-count
// mismatches still rendered as a table (markdown-it rejects them), fenced code
// blocks grew table widgets (refNumbers skips fences, the widget scan didn't),
// and pipe-less lines directly under a table were prose in the editor but
// absorbed as rows by the export. All four are pinned by verify-table-model.
//
// Model cells hold TRUE content (escapedSplit consumes the backslash of \|,
// exactly like markdown-it); the serializer re-escapes on emit. Pure module —
// no DOM, no Svelte; @codemirror/state's Text is data-only, so this runs in
// the pure tier.

import type { Text } from "@codemirror/state";
import { TBL_CAPTION_RE } from "./refNumbers";

export type Align = "left" | "center" | "right";

/** One caption grammar with the numbering twin (science/refNumbers.ts). */
export const CAPTION = TBL_CAPTION_RE;

// ---------------------------------------------------------------------------
// Row splitting (markdown-it's escapedSplit, ported verbatim: an unescaped `|`
// separates cells; `\|` contributes a literal `|` and the backslash is gone).
// Rows are TRIMMED before splitting (markdown-it does getLine().trim()), and
// an empty-string edge cell from a leading/trailing pipe is dropped.
// ---------------------------------------------------------------------------

export function escapedSplit(str: string): string[] {
  const result: string[] = [];
  const max = str.length;
  let pos = 0;
  let ch = str.charCodeAt(pos);
  let isEscaped = false;
  let lastPos = 0;
  let current = "";
  while (pos < max) {
    if (ch === 0x7c /* | */) {
      if (!isEscaped) {
        result.push(current + str.substring(lastPos, pos));
        current = "";
        lastPos = pos + 1;
      } else {
        current += str.substring(lastPos, pos - 1);
        lastPos = pos;
      }
    }
    isEscaped = ch === 0x5c; /* \ */
    pos++;
    ch = str.charCodeAt(pos);
  }
  result.push(current + str.substring(lastPos));
  return result;
}

/** Trimmed TRUE-content cells of a row line (escapes consumed, edge empties dropped). */
export function rowCells(line: string): string[] {
  const cols = escapedSplit(line.trim());
  if (cols.length && cols[0] === "") cols.shift();
  if (cols.length && cols[cols.length - 1] === "") cols.pop();
  return cols.map((c) => c.trim());
}

/** Caret geometry for one row line. Offsets are RAW positions within `line`
 *  (escapes still present — trimming is whitespace-only, so content bounds are
 *  exact). `contentFrom === contentTo` marks an empty cell (caret lands one
 *  space into the slot). */
export interface CellSpan {
  slotFrom: number;
  slotTo: number;
  contentFrom: number;
  contentTo: number;
}

export function rowCellSpans(line: string): CellSpan[] {
  let start = 0;
  let end = line.length;
  while (start < end && /\s/.test(line[start])) start++;
  while (end > start && /\s/.test(line[end - 1])) end--;
  // Unescaped-pipe boundaries within the trimmed window.
  const bounds: number[] = [];
  let esc = false;
  for (let i = start; i < end; i++) {
    const c = line[i];
    if (c === "|" && !esc) bounds.push(i);
    esc = c === "\\";
  }
  const slots: [number, number][] = [];
  let prev = start;
  for (const b of bounds) {
    slots.push([prev, b]);
    prev = b + 1;
  }
  slots.push([prev, end]);
  // Drop empty EDGE cells produced by a leading/trailing pipe (the escapedSplit
  // shift/pop rule — interior empties stay).
  if (slots.length && bounds.length && bounds[0] === start && slots[0][0] === slots[0][1]) slots.shift();
  if (
    slots.length &&
    bounds.length &&
    bounds[bounds.length - 1] === end - 1 &&
    slots[slots.length - 1][0] === slots[slots.length - 1][1]
  )
    slots.pop();
  return slots.map(([sf, st]) => {
    let cf = sf;
    let ct = st;
    while (cf < ct && /\s/.test(line[cf])) cf++;
    while (ct > cf && /\s/.test(line[ct - 1])) ct--;
    if (cf === ct) {
      const at = Math.min(sf + 1, st);
      return { slotFrom: sf, slotTo: st, contentFrom: at, contentTo: at };
    }
    return { slotFrom: sf, slotTo: st, contentFrom: cf, contentTo: ct };
  });
}

// ---------------------------------------------------------------------------
// Delimiter row (markdown-it's exact rule: chars restricted to | - : and
// spaces; first char | - or :; "-" then space is a list, not a table; each
// interior cell /^:?-+:?$/, empties allowed only at the edges).
// ---------------------------------------------------------------------------

const DELIM_CHARS = /^[|\-:\s]+$/;

export function parseDelim(line: string): Align[] | null {
  const t = line.trim();
  if (!t) return null;
  const first = t[0];
  if (first !== "|" && first !== "-" && first !== ":") return null;
  if (t.length > 1 && first === "-" && /\s/.test(t[1])) return null;
  if (!DELIM_CHARS.test(t)) return null;
  const cols = t.split("|");
  const aligns: Align[] = [];
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i].trim();
    if (!c) {
      if (i === 0 || i === cols.length - 1) continue;
      return null;
    }
    if (!/^:?-+:?$/.test(c)) return null;
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    aligns.push(l && r ? "center" : r ? "right" : "left");
  }
  return aligns.length ? aligns : null;
}

// ---------------------------------------------------------------------------
// Block-level scanning: what ends a table body. markdown-it continues the body
// over ANY non-blank line that no "blockquote-class" terminator rule claims —
// a pipe-less prose line directly under a table IS a row (GFM: "broken at the
// first empty line or beginning of another block-level structural element").
// Terminators, matching our markdown-it config (html:false, deflist loaded):
// fence, blockquote, hr, list, heading, and the deflist `: ` marker (which is
// also our caption line — the caption check runs first and wins).
// ---------------------------------------------------------------------------

const TERMINATOR = new RegExp(
  "^ {0,3}(?:" +
    "(?:```|~~~)" + // fence
    "|>" + // blockquote
    "|(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$" + // hr
    "|(?:[-+*]|\\d{1,9}[.)])(?:[ \\t]|$)" + // list item
    "|#{1,6}(?:[ \\t]|$)" + // ATX heading
    "|:[ \\t]" + // deflist marker (also the Quarto caption line)
    ")",
);

export const isTerminator = (line: string): boolean => TERMINATOR.test(line);

/** ≥4 columns of leading whitespace = an indented code block, never a table
 *  row (any tab in the indent run counts as reaching 4). */
export function codeIndented(line: string): boolean {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "\t") n += 4;
    else break;
    if (n >= 4) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface TableRow {
  /** 1-based doc line number. */
  line: number;
  /** TRUE-content cells (rowCells of the line). */
  cells: string[];
  /** False for a pipe-less absorbed line — the serializer must leave those
   *  verbatim (auto-reflow may align pipes the author typed, never invent
   *  structure around prose). */
  piped: boolean;
}

export interface ParsedTable {
  from: number;
  to: number; // end of the caption line when attached, else of the last row
  headerLine: number;
  delimLine: number;
  lastRowLine: number; // last body row (== delimLine when the body is empty)
  captionLine: number | null;
  head: string[];
  aligns: Align[];
  rows: TableRow[];
  caption: string | null;
  label: string | null;
}

/** Parse a table whose HEADER sits at `startLine`. Column-count equality
 *  between header and delimiter is required — markdown-it rejects the whole
 *  construct otherwise, so we must too. */
export function parseAt(doc: Text, startLine: number): ParsedTable | null {
  if (startLine + 1 > doc.lines) return null;
  const header = doc.line(startLine);
  if (header.text.indexOf("|") < 0 || !header.text.trim()) return null;
  if (codeIndented(header.text)) return null;
  const delim = doc.line(startLine + 1);
  if (codeIndented(delim.text)) return null;
  const aligns = parseDelim(delim.text);
  if (!aligns) return null;
  const head = rowCells(header.text);
  if (head.length === 0 || head.length !== aligns.length) return null;

  const rows: TableRow[] = [];
  let last = startLine + 1;
  let caption: string | null = null;
  let label: string | null = null;
  let captionLine: number | null = null;

  for (let n = startLine + 2; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (!text.trim()) break;
    // The caption wins over both absorption and termination — the renderer
    // intercepts `: Caption {#tbl-id}` lines before markdown-it ever runs.
    const cm = CAPTION.exec(text);
    if (cm) {
      // Attached only when the last body row is a PIPE row (the refNumbers
      // adjacency rule — the numbering twins must agree byte-for-byte).
      if (rows.length === 0 || rows[rows.length - 1].piped) {
        caption = cm[1];
        label = cm[2];
        captionLine = n;
      }
      break;
    }
    if (isTerminator(text) || codeIndented(text)) break;
    // A display-math opener ends the body: the renderer extracts `$$` blocks
    // BEFORE markdown-it runs, so those lines are never table rows in the
    // export (and refNumbers suspends the caption grammar inside them).
    if (text.trim().startsWith("$$")) break;
    rows.push({ line: n, cells: rowCells(text), piped: text.includes("|") });
    last = n;
  }
  // Caption after exactly one blank line (parseAt's historical adjacency rule).
  if (captionLine == null && last + 2 <= doc.lines && doc.line(last + 1).text.trim() === "") {
    const cm = CAPTION.exec(doc.line(last + 2).text);
    if (cm && (rows.length === 0 || rows[rows.length - 1].piped)) {
      caption = cm[1];
      label = cm[2];
      captionLine = last + 2;
    }
  }

  return {
    from: header.from,
    to: doc.line(captionLine ?? last).to,
    headerLine: startLine,
    delimLine: startLine + 1,
    lastRowLine: last,
    captionLine,
    head,
    aligns,
    rows,
    caption,
    label,
  };
}

const FENCE = /^\s*(```|~~~)/;
const MATH_CLOSE = /\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/;

/** Front-matter-aware, fence-aware, display-math-aware full-document scan
 *  (the widget build). The fence/math suspension rules mirror
 *  science/refNumbers.ts scanRefNumbers byte-for-byte — the numbering twins
 *  must agree on which pipe blocks exist. `fmEndLine` is frontmatter.ts's
 *  closing-fence line (0 when absent). */
export function scanTables(doc: Text, fmEndLine = 0): ParsedTable[] {
  const out: ParsedTable[] = [];
  let inFence = false;
  let inMath = false;
  let n = fmEndLine + 1;
  while (n <= doc.lines) {
    const text = doc.line(n).text;
    const t = text.trim();
    if (!inMath && FENCE.test(text)) {
      inFence = !inFence;
      n++;
      continue;
    }
    if (inFence) {
      n++;
      continue;
    }
    if (inMath) {
      if (MATH_CLOSE.test(t)) inMath = false;
      n++;
      continue;
    }
    if (t.startsWith("$$")) {
      const rest = t.slice(2);
      if (!(MATH_CLOSE.test(rest) && rest.includes("$$"))) inMath = true; // multi-line block opens
      n++;
      continue;
    }
    const parsed = parseAt(doc, n);
    if (!parsed) {
      n++;
      continue;
    }
    out.push(parsed);
    n = doc.lineAt(parsed.to).number + 1;
  }
  return out;
}

// The scan is memoized on the DOCUMENT, which is immutable: two decoration
// fields read the same tables in the same update (science/tables.ts for the
// rendered widget, science/tableFold.ts for the collapsed source), and the fold
// re-derives on selection changes, where the document has not moved at all.
const scanCache = new WeakMap<Text, { fmEndLine: number; tables: ParsedTable[] }>();

/** `scanTables`, memoized per document. `fmEndLine` is derived from the same
 *  doc by every caller, so it is checked rather than keyed on. */
export function scanTablesCached(doc: Text, fmEndLine = 0): ParsedTable[] {
  const hit = scanCache.get(doc);
  if (hit && hit.fmEndLine === fmEndLine) return hit.tables;
  const tables = scanTables(doc, fmEndLine);
  scanCache.set(doc, { fmEndLine, tables });
  return tables;
}

/** Appearance-order table numbers — Quarto semantics (science/refNumbers.ts):
 *  only LABELED tables participate, so the editor and the export can never
 *  disagree. ONE rule, read by the widget caption AND the collapsed pill. */
export function numberTables(tables: readonly ParsedTable[]): Map<ParsedTable, number> {
  const out = new Map<ParsedTable, number>();
  let n = 0;
  for (const t of tables) if (t.label) out.set(t, ++n);
  return out;
}

/** The table whose SOURCE BLOCK (header … last row, caption included) contains
 *  `pos`. Bounded upward walk to the nearest plausible header, then parseAt —
 *  callers on the typing path verify fence-truth against the live decoration
 *  set (see editing/tableOps.ts); this function itself is fence-blind. */
export function tableAt(doc: Text, pos: number): ParsedTable | null {
  let here = doc.lineAt(pos).number;
  // A caption line belongs to the table ABOVE it — possibly across the one
  // allowed blank line (the widget's posAtDOM resolves to the caption end, so
  // the hover-bar/cell-click path enters exactly here).
  if (CAPTION.test(doc.line(here).text)) {
    let up = here - 1;
    if (up >= 1 && doc.line(up).text.trim() === "") up--;
    if (up < 1) return null;
    here = up;
  }
  // Walk up over plausible table lines (rows / delimiter) to each candidate
  // header and try a parse that reaches back down to `pos`.
  const lowest = Math.max(1, here - 400); // structural bound, not a scan cap
  for (let h = here; h >= lowest; h--) {
    const text = doc.line(h).text;
    if (!text.trim()) return null; // blank line above pos before any header
    if (h < here && isTerminator(text) && !CAPTION.test(text)) return null;
    if (text.indexOf("|") >= 0) {
      const parsed = parseAt(doc, h);
      if (parsed && parsed.from <= pos && pos <= parsed.to) return parsed;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serialization: aligned padded pipes. Widths are measured on the ESCAPED
// source text (what the mono source column actually shows); every piped row is
// rewritten canonically, verbatim (pipe-less) rows are the author's prose and
// pass through untouched.
// ---------------------------------------------------------------------------

export const escapePipes = (content: string): string => content.replace(/\|/g, "\\|");

const delimCell = (a: Align, w: number): string =>
  a === "center"
    ? ":" + "-".repeat(Math.max(1, w - 2)) + ":"
    : a === "right"
      ? "-".repeat(Math.max(1, w - 1)) + ":"
      : "-".repeat(w);

export interface TableShape {
  head: string[];
  aligns: Align[];
  rows: TableRow[];
}

/** Render header + delimiter + body as canonical padded lines. Row order and
 *  count mirror `rows`; a verbatim row contributes `null` (caller keeps the
 *  original line text). */
export function formatTableLines(t: TableShape): { header: string; delim: string; rows: (string | null)[] } {
  const cols = t.head.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 3;
    w = Math.max(w, escapePipes(t.head[c] ?? "").length);
    for (const r of t.rows) {
      if (!r.piped) continue;
      w = Math.max(w, escapePipes(r.cells[c] ?? "").length);
    }
    widths.push(w);
  }
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const rowLine = (cells: string[]): string =>
    "| " + widths.map((w, c) => pad(escapePipes(cells[c] ?? ""), w)).join(" | ") + " |";
  return {
    header: rowLine(t.head),
    delim: "| " + widths.map((w, c) => delimCell(t.aligns[c] ?? "left", w)).join(" | ") + " |",
    rows: t.rows.map((r) => (r.piped ? rowLine(r.cells) : null)),
  };
}

/** Full canonical source text for header…lastRow of a parsed table against the
 *  CURRENT doc (verbatim rows keep their live line text). */
export function formatTableBlock(doc: Text, t: ParsedTable): string {
  const f = formatTableLines(t);
  const lines: string[] = [f.header, f.delim];
  for (let i = 0; i < t.rows.length; i++) {
    lines.push(f.rows[i] ?? doc.line(t.rows[i].line).text);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pasted-data conversion
// ---------------------------------------------------------------------------

const normNewlines = (text: string): string[] => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
};

/** TSV (an Excel/Sheets/pandas copy) → cell grid. Deliberately strict: every
 *  line must carry the SAME tab count (≥1) — prose with a stray tab must never
 *  auto-convert. */
export function parseTsv(text: string): string[][] | null {
  const lines = normNewlines(text);
  if (!lines.length) return null;
  const tabs = (lines[0].match(/\t/g) ?? []).length;
  if (tabs < 1) return null;
  for (const l of lines) if ((l.match(/\t/g) ?? []).length !== tabs) return null;
  return lines.map((l) => l.split("\t").map((c) => c.trim()));
}

/** Quote-aware CSV → cell grid (explicit "Paste as table" only — commas are
 *  far too common in prose for an automatic path). Requires ≥2 columns and a
 *  consistent column count. */
export function parseCsv(text: string): string[][] | null {
  const lines = normNewlines(text);
  if (lines.length < 2) return null;
  const rows: string[][] = [];
  for (const l of lines) {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inQ) {
        if (c === '"') {
          if (l[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQ = false;
        } else cur += c;
      } else if (c === '"' && cur === "") inQ = true;
      else if (c === ",") {
        cells.push(cur.trim());
        cur = "";
      } else cur += c;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  const cols = rows[0].length;
  if (cols < 2) return null;
  for (const r of rows) if (r.length !== cols) return null;
  return rows;
}

/** Cell grid → canonical markdown table text (first row = header). */
export function gridToTable(grid: string[][]): string {
  const head = grid[0] ?? [];
  const rows: TableRow[] = grid.slice(1).map((cells, i) => ({ line: i, cells, piped: true }));
  const f = formatTableLines({ head, aligns: head.map(() => "left" as Align), rows });
  return [f.header, f.delim, ...f.rows.map((r) => r ?? "")].join("\n");
}
