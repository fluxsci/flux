// Pipe tables render as clean journal tables (Flux_Paper_Plan.md B3). The
// grammar lives in tableModel.ts (ONE escape-aware parse/serialize pair shared
// with editing/tableOps.ts and the gates — fidelity target is markdown-it, the
// export renderer). This field scans the doc (front-matter- and fence-aware,
// matching science/refNumbers), records appearance-order numbers for LABELED
// tables (so @tbl chips resolve), and places a styled <table> block widget
// AFTER the source block. The source lines stay present and navigable (compact
// mono via cm-flux-tablesrc), so every pipe row costs exactly one vertical
// keypress and caret movement never reflows the document — the decoration set
// is a pure function of the document (docChanged/refreshChips only, never
// selection). You edit the markdown source directly (Tab/Enter cell
// navigation + row/column ops in editing/tableOps.ts); the .qmd stays Quarto.
//
// Cells and captions render their INLINE CONTENT the way the export prints it:
// bold/italic/code, `$…$` math (lazy KaTeX — the math.ts kick pattern), and
// resolved cross-refs/citations ("Fig. 2", "(Smith et al., 2021)") via
// mdInline's resolver hooks. The widget is native-selectable (copy a rendered
// cell) and horizontally scrollable when wider than the column.
//
// Never rebuild on selection, never add block atomicRanges — selection-driven
// decoration rebuilds and block atomics are what caused the old multi-line
// caret jumps.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { numberingFacet, type PaperNumbering } from "../scholar/numberingFacet";
import { resolveFigure } from "../scholar/figures";
import { resolveCite } from "../scholar/bib";
import { formatNumericLabel } from "../scholar/citeNumbering";
import { frontMatterEndLine } from "../frontmatter";
import { refreshChips } from "./chips";
import { touchesMe, paperPerf } from "./changeGate";
import { mdInlineFragment, inlineSig, type InlineResolvers } from "./mdInline";
import { katexReady } from "./katexLoader";
import { kickKatex } from "./math";
import { numberTables, scanTablesCached, type ParsedTable, type Align } from "./tableModel";
import { anyPaperHandlers, handlersForEl, type TableAction } from "./chipContext";

/** Cell content renders like the export: inline markdown + math + resolved
 *  refs/cites against THIS editor's numbering instance. */
function cellResolvers(reg: PaperNumbering): InlineResolvers {
  return {
    math: true,
    resolveRef: (label) => resolveFigure(label, reg)?.display ?? null,
    resolveCite: (keys) => {
      if (reg.style === "numeric") {
        const n = formatNumericLabel(keys, (k) => reg.ordinals.get(k));
        return n.anyResolved ? n.text : null;
      }
      return resolveCite(keys);
    },
  };
}

// WS-2 Fix 2: previous render state per wrap element — lets updateDOM patch
// only the changed <td>/<th> content while typing inside a table, instead of
// rebuilding the whole <table> DOM per keystroke (embeds.ts domState
// precedent). Diffs run on RENDER SIGNATURES (inlineSig), not raw text, so a
// figure renumbering or KaTeX load re-renders exactly the affected cells.
interface TableDomState {
  head: string[];
  body: string[][];
  aligns: Align[];
  caption: string | null;
  number: number;
}
const tableDomState = new WeakMap<HTMLElement, TableDomState>();

// Native mouse interaction inside the widget (text selection for copy, the
// action bar, horizontal scroll) — CodeMirror must not claim these. Keyboard
// stays with the editor.
const NATIVE_EVENTS = new Set([
  "mousedown",
  "mouseup",
  "mousemove",
  "click",
  "dblclick",
  "pointerdown",
  "pointerup",
  "pointermove",
  "contextmenu",
  "selectstart",
  "dragstart",
]);

class TableWidget extends WidgetType {
  readonly key: string;
  readonly headSigs: string[];
  readonly bodySigs: string[][];
  readonly captionSig: string | null;
  constructor(
    readonly t: ParsedTable,
    readonly number: number,
    readonly resolvers: InlineResolvers,
  ) {
    super();
    const cols = t.head.length;
    this.headSigs = t.head.map((c) => inlineSig(c, resolvers));
    this.bodySigs = t.rows.map((r) => {
      const out: string[] = [];
      for (let i = 0; i < cols; i++) out.push(inlineSig(r.cells[i] ?? "", resolvers));
      return out;
    });
    this.captionSig = t.caption == null ? null : inlineSig(t.caption, resolvers);
    this.key = JSON.stringify([this.headSigs, this.bodySigs, this.captionSig, t.aligns, number]);
  }
  eq(o: TableWidget) {
    return o.key === this.key;
  }
  private fillCell(el: HTMLElement, raw: string): void {
    el.replaceChildren(mdInlineFragment(raw, this.resolvers));
  }
  // Patch in place for same-shape edits (cell content, alignment, caption,
  // number). Any structural change (column/row count, caption presence) →
  // false = full redraw. estimatedHeight semantics untouched (accurate
  // estimates are what prevent scroll jumps).
  updateDOM(dom: HTMLElement): boolean {
    const prev = tableDomState.get(dom);
    if (!prev) return false;
    const b = this.t;
    if (prev.head.length !== b.head.length || prev.body.length !== this.bodySigs.length) return false;
    if ((prev.caption == null) !== (this.captionSig == null)) return false;
    const ths = dom.querySelectorAll<HTMLElement>("thead th");
    if (ths.length !== b.head.length) return false;
    const trs = dom.querySelectorAll<HTMLTableRowElement>("tbody tr");
    if (trs.length !== this.bodySigs.length) return false;
    for (let i = 0; i < b.head.length; i++) {
      if (prev.head[i] !== this.headSigs[i]) this.fillCell(ths[i], b.head[i]);
      const align = b.aligns[i] ?? "left";
      if ((prev.aligns[i] ?? "left") !== align)
        for (const cell of [ths[i], ...Array.from(trs, (tr) => tr.children[i] as HTMLElement | undefined)])
          if (cell) cell.style.textAlign = align;
    }
    for (let r = 0; r < this.bodySigs.length; r++) {
      const tds = trs[r].children;
      if (tds.length !== b.head.length) return false;
      for (let c = 0; c < b.head.length; c++) {
        if ((prev.body[r]?.[c] ?? "") !== this.bodySigs[r][c])
          this.fillCell(tds[c] as HTMLElement, b.rows[r].cells[c] ?? "");
      }
    }
    if (this.captionSig != null) {
      const cap = dom.querySelector<HTMLElement>(".flux-table-cap");
      if (!cap) return false;
      const bEl = cap.querySelector("b");
      if (!bEl) return false;
      if (prev.number !== this.number) bEl.textContent = `Table ${this.number}.`;
      if (prev.caption !== this.captionSig) {
        while (bEl.nextSibling) cap.removeChild(bEl.nextSibling);
        cap.appendChild(document.createTextNode(" "));
        cap.appendChild(mdInlineFragment(this.t.caption ?? "", this.resolvers));
      }
    }
    tableDomState.set(dom, {
      head: this.headSigs,
      body: this.bodySigs,
      aligns: this.t.aligns,
      caption: this.captionSig,
      number: this.number,
    });
    return true;
  }
  // Row height ≈ 2×6px padding + 0.95em×1.5 line ≈ 36px; caption ≈ 32px; wrap
  // vertical padding 2×1.4em ≈ 48px. Only an estimate for unrendered widgets —
  // CodeMirror swaps in the measured height once visible.
  get estimatedHeight() {
    return 36 * (1 + this.t.rows.length) + (this.t.caption ? 32 : 0) + 48;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "flux-tablewrap";
    wrap.setAttribute("contenteditable", "false");
    // A native selection inside the widget must copy NATIVELY: CodeMirror's
    // contentDOM copy handler would replace the clipboard with the editor
    // selection (the caret line, when empty). Stop it from ever seeing the
    // event — default clipboard behavior handles the rest.
    wrap.addEventListener("copy", (e) => e.stopPropagation());
    wrap.addEventListener("cut", (e) => e.stopPropagation());

    const scroll = document.createElement("div");
    scroll.className = "flux-tablescroll";
    // The rendered table is a VIEW of the source rows: click a cell and the
    // caret lands in that cell's source text (Chromium cannot text-select
    // inside a contenteditable=false island anyway — the click is unambiguous).
    if (anyPaperHandlers()) {
      scroll.addEventListener("click", (e) => {
        const cell = (e.target as HTMLElement).closest("td, th");
        if (!cell) return;
        const tr = cell.parentElement as HTMLTableRowElement;
        const col = [...tr.children].indexOf(cell);
        const row = cell.tagName === "TH" ? -1 : [...(tr.parentElement?.children ?? [])].indexOf(tr);
        if (col >= 0) handlersForEl(wrap)?.table?.onTableAction?.(wrap, { kind: "cell", row, col });
      });
    }
    const table = document.createElement("table");
    table.className = "flux-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    this.t.head.forEach((c, i) => {
      const th = document.createElement("th");
      this.fillCell(th, c);
      th.style.textAlign = this.t.aligns[i] ?? "left";
      if (anyPaperHandlers()) {
        th.title = "Alt-click to cycle column alignment";
        th.addEventListener("mousedown", (e) => {
          if (!e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          handlersForEl(wrap)?.table?.onTableAction?.(wrap, { kind: "align", col: i });
        });
      }
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.t.rows) {
      const tr = document.createElement("tr");
      this.t.head.forEach((_, i) => {
        const td = document.createElement("td");
        this.fillCell(td, row.cells[i] ?? "");
        td.style.textAlign = this.t.aligns[i] ?? "left";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    if (this.t.caption) {
      const cap = document.createElement("div");
      cap.className = "flux-table-cap";
      // Same route as a cell click: the caption's source line lives inside the
      // collapsed block (tableFold.ts), so clicking the rendered caption puts
      // the caret in it.
      if (anyPaperHandlers()) {
        cap.title = "Click to edit the caption source";
        cap.addEventListener("click", () => handlersForEl(wrap)?.table?.onTableAction?.(wrap, { kind: "caption" }));
      }
      const b = document.createElement("b");
      b.textContent = `Table ${this.number}.`;
      cap.appendChild(b);
      cap.appendChild(document.createTextNode(" "));
      cap.appendChild(mdInlineFragment(this.t.caption, this.resolvers));
      wrap.appendChild(cap);
    }

    // Hover action bar (the embeds.ts .flux-embed-bar pattern) — rendered only
    // when PaperMode has registered the handler (headless single-field tests
    // and read-only hosts get the plain widget).
    if (anyPaperHandlers()) {
      const bar = document.createElement("div");
      bar.className = "flux-table-bar";
      const btn = (label: string, title: string, action: TableAction) => {
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = label;
        el.title = title;
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          handlersForEl(wrap)?.table?.onTableAction?.(wrap, action);
        });
        return el;
      };
      bar.appendChild(btn("+ Row", "Add a row at the end", { kind: "add-row" }));
      bar.appendChild(btn("+ Col", "Add a column at the right", { kind: "add-col" }));
      bar.appendChild(btn("Format", "Align the source pipes", { kind: "format" }));
      bar.appendChild(btn("Copy", "Copy the table (tab-separated — pastes into Excel/Sheets)", { kind: "copy" }));
      wrap.appendChild(bar);
    }

    tableDomState.set(wrap, {
      head: this.headSigs,
      body: this.bodySigs,
      aligns: this.t.aligns,
      caption: this.captionSig,
      number: this.number,
    });
    return wrap;
  }
  ignoreEvent(e: Event) {
    // Native mouse interaction inside the rendered table: select/copy cell
    // text, press the bar buttons, drag the horizontal scrollbar. The caret
    // lives in the SOURCE lines — a click here deliberately doesn't move it.
    return NATIVE_EVENTS.has(e.type);
  }
}

function build(state: EditorState): DecorationSet {
  paperPerf.tables++;
  const deco: Range<Decoration>[] = [];
  const reg = state.facet(numberingFacet);
  // Memoized on the doc — science/tableFold.ts reads the same scan in the same
  // update (and again, free, on every selection change).
  const tables = scanTablesCached(state.doc, frontMatterEndLine(state.doc));

  // Numbering pass FIRST (WS-4.2: per-editor instance, replace-contents), so
  // widget cells that reference tables — @tbl-x inside a cell, forward refs
  // included — resolve in the same update. The rule itself lives in
  // tableModel.numberTables (Quarto semantics, shared with the collapsed-source
  // pill and byte-aligned with science/refNumbers.ts): only LABELED tables
  // participate, so a doc mixing plain layout tables with formal
  // `: Caption {#tbl-…}` tables can never show one number in the editor and
  // another in the exported caption.
  reg.tbl.clear();
  reg.tblMeta.clear();
  const numbers = numberTables(tables);
  let count = 0;
  for (const t of tables) {
    const n = numbers.get(t);
    if (n == null || !t.label) continue;
    count = n;
    reg.tbl.set(t.label, n);
    reg.tblMeta.set(t.label, { pos: t.from, caption: t.caption });
  }

  const resolvers = cellResolvers(reg);
  let sawMath = false;
  for (const t of tables) {
    const fromLine = t.headerLine;
    const toLine = state.doc.lineAt(t.to).number;
    for (let i = fromLine; i <= toLine; i++) {
      deco.push(Decoration.line({ class: "cm-flux-tablesrc" }).range(state.doc.line(i).from));
    }
    if (!sawMath) {
      const hasDollar = (s: string) => s.includes("$");
      sawMath =
        t.head.some(hasDollar) ||
        t.rows.some((r) => r.cells.some(hasDollar)) ||
        (t.caption != null && hasDollar(t.caption));
    }
    deco.push(
      Decoration.widget({
        widget: new TableWidget(t, numbers.get(t) ?? count, resolvers),
        block: true,
        side: 1, // a block AFTER the source block — the pipe rows stay navigable
      }).range(t.to),
    );
  }
  // Cells may hold `$…$` — arm the lazy KaTeX load; its resolution dispatches
  // refreshChips, which rebuilds this field (the math.ts pattern).
  if (sawMath && !katexReady()) kickKatex();
  return Decoration.set(deco, true);
}

// WS-2 Fix 1: rebuild only when the change could plausibly touch a table — a
// pipe or ":-" (aligned-delim) on a touched line, a fence marker (``` or ~~~
// flip whether a pipe block is code), a newline, or an edit within TWO lines
// of an existing table decoration (the caption may sit one blank line below
// the block; caption edits ride this guard, and so do the pipe-less prose
// lines a table absorbs). Prose keystrokes map the set instead of the
// ~2×doc-lines walk. Known conservative gap (accepted): a bare pipe-less
// "---" delim typed under a pipe header registers at the next newline/pipe
// keystroke, not mid-"---" — hyphen is too common in prose to be a trigger
// token. setTableNumbers republishes exactly when a construct can change —
// behavior identical (changeGate.ts).
const TABLE_GATE = { tokens: ["|", ":-", "```", "~~~"], guardLines: 2 } as const;

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
