// Pipe tables render as clean journal tables (Flux_Paper_Plan.md B3, basic
// tier). The renderer scans the doc for GFM pipe tables + an optional Quarto
// `: Caption {#tbl-id}` line, records appearance-order numbers (so @tbl chips
// resolve), and places a styled <table> block widget AFTER the source block.
// The source lines stay present and navigable (compact mono via
// cm-flux-tablesrc), so every pipe row costs exactly one vertical keypress and
// caret movement never reflows the document — the decoration set is a pure
// function of the document (docChanged/refreshChips only, never selection).
// You edit the markdown source directly; the .qmd stays Quarto.
//
// Part of the LOCKED editing-feel contract — see ../EDITING-FEEL.md. In
// particular: never rebuild on selection, never add block atomicRanges.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { numberingFacet } from "../scholar/numberingFacet";
import { refreshChips } from "./chips";
import { touchesMe, paperPerf } from "./changeGate";

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

// WS-2 Fix 2: previous render state per wrap element — lets updateDOM patch
// only the changed <td>/<th> text + alignment while typing inside a table,
// instead of rebuilding the whole <table> DOM per keystroke (embeds.ts
// domState precedent).
interface TableDomState {
  t: ParsedTable;
  number: number;
}
const tableDomState = new WeakMap<HTMLElement, TableDomState>();

class TableWidget extends WidgetType {
  readonly key: string;
  constructor(readonly t: ParsedTable, readonly number: number) {
    super();
    this.key = JSON.stringify([t.head, t.body, t.aligns, t.caption, number]);
  }
  eq(o: TableWidget) {
    return o.key === this.key;
  }
  // Patch in place for same-shape edits (cell text, alignment, caption text,
  // number). Any structural change (column/row count, caption presence) →
  // false = full redraw. estimatedHeight semantics untouched (EDITING-FEEL 4).
  updateDOM(dom: HTMLElement): boolean {
    const prev = tableDomState.get(dom);
    if (!prev) return false;
    const a = prev.t;
    const b = this.t;
    if (a.head.length !== b.head.length || a.body.length !== b.body.length) return false;
    if ((a.caption == null) !== (b.caption == null)) return false;
    const ths = dom.querySelectorAll<HTMLElement>("thead th");
    if (ths.length !== b.head.length) return false;
    const trs = dom.querySelectorAll<HTMLTableRowElement>("tbody tr");
    if (trs.length !== b.body.length) return false;
    for (let i = 0; i < b.head.length; i++) {
      if (a.head[i] !== b.head[i]) ths[i].textContent = b.head[i];
      const align = b.aligns[i] ?? "left";
      if ((a.aligns[i] ?? "left") !== align)
        for (const cell of [ths[i], ...Array.from(trs, (tr) => tr.children[i] as HTMLElement | undefined)])
          if (cell) cell.style.textAlign = align;
    }
    for (let r = 0; r < b.body.length; r++) {
      const tds = trs[r].children;
      if (tds.length !== b.head.length) return false;
      for (let c = 0; c < b.head.length; c++) {
        const want = b.body[r][c] ?? "";
        if ((a.body[r]?.[c] ?? "") !== want) (tds[c] as HTMLElement).textContent = want;
      }
    }
    if (b.caption != null) {
      const cap = dom.querySelector<HTMLElement>(".flux-table-cap");
      if (!cap) return false;
      const bEl = cap.querySelector("b");
      if (!bEl) return false;
      if (prev.number !== this.number) bEl.textContent = `Table ${this.number}.`;
      if (a.caption !== b.caption) {
        // the caption text node follows the <b>
        while (bEl.nextSibling) cap.removeChild(bEl.nextSibling);
        cap.appendChild(document.createTextNode(" " + b.caption));
      }
    }
    tableDomState.set(dom, { t: b, number: this.number });
    return true;
  }
  // Row height ≈ 2×6px padding + 0.95em×1.5 line ≈ 36px; caption ≈ 32px; wrap
  // vertical padding 2×1.4em ≈ 48px. Only an estimate for unrendered widgets —
  // CodeMirror swaps in the measured height once visible.
  get estimatedHeight() {
    return 36 * (1 + this.t.body.length) + (this.t.caption ? 32 : 0) + 48;
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
    tableDomState.set(wrap, { t: this.t, number: this.number });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState): DecorationSet {
  paperPerf.tables++;
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
    // Quarto semantics (shared rule — science/refNumbers.ts): only LABELED tables
    // participate in numbering. The export counts the same way, so a doc mixing
    // plain layout tables with formal `: Caption {#tbl-…}` tables can no longer
    // show one number in the editor and another in the exported caption.
    if (parsed.label) {
      count++;
      numbered.push({ label: parsed.label, number: count });
    }
    const fromLine = state.doc.lineAt(parsed.from).number;
    const toLine = state.doc.lineAt(parsed.to).number;
    for (let i = fromLine; i <= toLine; i++) {
      deco.push(Decoration.line({ class: "cm-flux-tablesrc" }).range(state.doc.line(i).from));
    }
    deco.push(
      Decoration.widget({
        widget: new TableWidget(parsed, count),
        block: true,
        side: 1, // a block AFTER the source block — the pipe rows stay navigable
      }).range(parsed.to),
    );
    n = toLine + 1;
  }
  {
    // WS-4.2: per-editor numbering instance (facet), replace-contents.
    const reg = state.facet(numberingFacet);
    reg.tbl.clear();
    for (const p of numbered) reg.tbl.set(p.label, p.number);
  }
  return Decoration.set(deco, true);
}

// WS-2 Fix 1: rebuild only when the change could plausibly touch a table — a
// pipe or ":-" (aligned-delim) on a touched line, a newline, or an edit within
// TWO lines of an existing table decoration (the caption may sit one blank
// line below the block; caption edits ride this guard). Prose keystrokes map
// the set instead of the ~2×doc-lines walk. Known conservative gap (accepted):
// a bare pipe-less "---" delim typed under a pipe header registers at the next
// newline/pipe keystroke, not mid-"---" — hyphen is too common in prose to be
// a trigger token. setTableNumbers republishes exactly when a construct can
// change — behavior identical (changeGate.ts).
const TABLE_GATE = { tokens: ["|", ":-"], guardLines: 2 } as const;

export const scienceTables = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.effects.some((e) => e.is(refreshChips))) return build(tr.state);
    if (!tr.docChanged) return value;
    // Selection changes NEVER touch table decorations (see header comment) —
    // and setTableNumbers stops firing on every caret move as a bonus.
    if (touchesMe(tr, value, TABLE_GATE)) return build(tr.state);
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
