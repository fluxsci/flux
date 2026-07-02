// Pipe tables render as clean journal tables in place (Flux_Paper_Plan.md B3,
// basic tier). The renderer scans the doc for GFM pipe tables + an optional
// Quarto `: Caption {#tbl-id}` line, records appearance-order numbers (so @tbl
// chips resolve), and replaces each table block with a styled <table>. Cursor
// entering the block reveals the raw markdown. Full in-cell editing is Phase 4;
// today you edit the markdown source (reveal-on-cursor). The .qmd stays Quarto.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { setTableNumbers } from "../scholar/numbering";
import { refreshChips } from "./chips";

const DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const CAPTION = /^\s*:\s+(.*?)\s*\{#(tbl-[A-Za-z0-9_-]+)\}\s*$/;
type Align = "left" | "center" | "right";

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
function alignsFrom(delim: string): Align[] {
  return splitRow(delim).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
}
function isRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "" && !DELIM.test(line);
}

interface ParsedTable {
  from: number;
  to: number;
  head: string[];
  body: string[][];
  aligns: Align[];
  caption: string | null;
  label: string | null;
}

function parseAt(state: EditorState, startLine: number): ParsedTable | null {
  const doc = state.doc;
  if (startLine + 1 > doc.lines) return null;
  const header = doc.line(startLine);
  const delim = doc.line(startLine + 1);
  if (!isRow(header.text) || !DELIM.test(delim.text)) return null;

  const aligns = alignsFrom(delim.text);
  const head = splitRow(header.text);
  const body: string[][] = [];
  let last = startLine + 1;
  for (let n = startLine + 2; n <= doc.lines; n++) {
    const ln = doc.line(n);
    if (!isRow(ln.text)) break;
    body.push(splitRow(ln.text));
    last = n;
  }
  // Optional caption directly below, or after one blank line.
  let caption: string | null = null;
  let label: string | null = null;
  let endLine = last;
  const checkCaption = (n: number): boolean => {
    if (n > doc.lines) return false;
    const m = CAPTION.exec(doc.line(n).text);
    if (m) {
      caption = m[1];
      label = m[2];
      endLine = n;
      return true;
    }
    return false;
  };
  if (!checkCaption(last + 1) && last + 1 <= doc.lines && doc.line(last + 1).text.trim() === "")
    checkCaption(last + 2);

  return {
    from: header.from,
    to: doc.line(endLine).to,
    head,
    body,
    aligns,
    caption,
    label,
  };
}

class TableWidget extends WidgetType {
  readonly key: string;
  constructor(readonly t: ParsedTable, readonly number: number) {
    super();
    this.key = JSON.stringify([t.head, t.body, t.aligns, t.caption, number]);
  }
  eq(o: TableWidget) {
    return o.key === this.key;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "flux-tablewrap";
    wrap.setAttribute("contenteditable", "false");

    const table = document.createElement("table");
    table.className = "flux-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    this.t.head.forEach((c, i) => {
      const th = document.createElement("th");
      th.textContent = c;
      th.style.textAlign = this.t.aligns[i] ?? "left";
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.t.body) {
      const tr = document.createElement("tr");
      this.t.head.forEach((_, i) => {
        const td = document.createElement("td");
        td.textContent = row[i] ?? "";
        td.style.textAlign = this.t.aligns[i] ?? "left";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (this.t.caption) {
      const cap = document.createElement("div");
      cap.className = "flux-table-cap";
      const b = document.createElement("b");
      b.textContent = `Table ${this.number}.`;
      cap.appendChild(b);
      cap.appendChild(document.createTextNode(" " + this.t.caption));
      wrap.appendChild(cap);
    }
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

function build(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const deco: Range<Decoration>[] = [];
  const numbered: { label: string; number: number }[] = [];
  let count = 0;
  let n = 1;
  while (n <= state.doc.lines) {
    const parsed = parseAt(state, n);
    if (!parsed) {
      n++;
      continue;
    }
    count++;
    if (parsed.label) numbered.push({ label: parsed.label, number: count });
    const fromLine = state.doc.lineAt(parsed.from).number;
    const toLine = state.doc.lineAt(parsed.to).number;
    let overlapsActive = false;
    for (let i = fromLine; i <= toLine; i++) if (active.has(i)) overlapsActive = true;
    if (!overlapsActive) {
      deco.push(
        Decoration.replace({ widget: new TableWidget(parsed, count), block: true }).range(
          parsed.from,
          parsed.to,
        ),
      );
    }
    n = toLine + 1;
  }
  setTableNumbers(numbered);
  return Decoration.set(deco, true);
}

// PAP-7: on a selection-only change the table decorations change ONLY if the caret moved onto
// or off a table block. Test just the lines the old/new selections touch for table membership
// — a pipe row, a `---` delimiter, a `{#tbl-}` caption, or the single blank line a caption may
// sit below — instead of re-parsing every line of the document on each cursor move. This
// over-approximates block membership (a stray `|` in prose triggers a harmless rebuild) but
// never misses a line that could belong to a table, so the rendering stays correct.
function tableInActive(state: EditorState): boolean {
  for (const n of activeLines(state)) {
    const t = state.doc.line(n).text;
    if (t.includes("|") || CAPTION.test(t) || DELIM.test(t)) return true;
    if (t.trim() === "" && n + 1 <= state.doc.lines && CAPTION.test(state.doc.line(n + 1).text))
      return true;
  }
  return false;
}

export const scienceTables = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(refreshChips))) return build(tr.state);
    if (tr.selection && (tableInActive(tr.startState) || tableInActive(tr.state)))
      return build(tr.state);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
});
