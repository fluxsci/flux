// A table's pipe source collapses to one "Table N" pill unless the selection is
// inside it (owner request, 2026-08-10). Reading a manuscript, you see the
// RENDERED table (tables.ts' block widget, untouched by this field) and a chip
// where its markdown was; the moment the caret enters the block — arrowing onto
// it, clicking a rendered cell, following a @tbl chip — the full source is back,
// exactly as it always was, and every editing affordance works unchanged.
//
// This is the embed-chip rule (chips.ts + widgets.ts EmbedSrcWidget) applied to
// a MULTI-LINE construct, and that difference is the whole design:
//
//   • A replacing decoration that spans line breaks changes the vertical layout,
//     so CodeMirror only accepts one from a StateField — never a ViewPlugin.
//     This field is therefore the one place in the paper editor where a
//     decoration set depends on the SELECTION as well as the document. It is
//     safe where the old reveal-on-cursor embed was not, because the swap is
//     source lines ⇄ pill only: the block widget below never moves and is never
//     rebuilt, and the caret's landing position is resolved from the geometry
//     that was on screen when the key was pressed — the reveal rides the same
//     transaction, after that position is computed.
//   • The caret can never sit inside hidden text: the reveal predicate is
//     "a selection range touches the block", boundaries included, so entering
//     the range IS what opens it. No atomicRanges — reaching a table from the
//     keyboard alone has to keep working.
//   • Identity is preserved when nothing opened or closed (same value object →
//     CodeMirror's decoration diff finds every chunk shared and does no height
//     work), and the document-side rebuild rides the same changeGate the widget
//     field uses.
//
// Cost per caret move is one pass over the (already scanned, memoized) table
// list comparing ranges; the sets are rebuilt only when a table opens or closes.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type ChangeDesc, type EditorState, type Range } from "@codemirror/state";
import { frontMatterEndLine } from "../frontmatter";
import { refreshChips } from "./chips";
import { paperPerf, touchesMe } from "./changeGate";
import { numberTables, scanTablesCached, type ParsedTable } from "./tableModel";

/** The collapsed source block: a compact accent pill naming the table. The
 *  rendered table and its caption sit right below it, so the pill only has to
 *  say WHICH construct is folded here and how much of it there is. */
export class TableSrcWidget extends WidgetType {
  constructor(
    readonly number: number | null,
    readonly rows: number,
    readonly cols: number,
    readonly hasCaption: boolean,
  ) {
    super();
  }
  eq(o: TableSrcWidget) {
    return (
      o.number === this.number &&
      o.rows === this.rows &&
      o.cols === this.cols &&
      o.hasCaption === this.hasCaption
    );
  }
  toDOM() {
    const el = document.createElement("span");
    // Unnumbered is not an error (an unlabeled layout table is legitimate) —
    // it just has no "Table N" to show, so the pill says what it is.
    el.className = "flux-tablechip" + (this.number == null ? " unnumbered" : "");
    el.textContent = this.number == null ? "▦ Table" : `▦ Table ${this.number}`;
    el.title =
      `${this.rows} row${this.rows === 1 ? "" : "s"} × ${this.cols} column${this.cols === 1 ? "" : "s"}` +
      (this.hasCaption ? " + caption" : "") +
      "\nClick here (or any rendered cell) to edit the source";
    return el;
  }
  ignoreEvent() {
    // Let CodeMirror process the click: it places the caret inside the block,
    // which is exactly what reveals the source.
    return false;
  }
}

interface Entry {
  from: number;
  to: number;
  widget: TableSrcWidget;
}

export interface TableFoldValue {
  /** Every table in the document, in order — collapsed or not. */
  entries: Entry[];
  /** The collapsed ones, as replacing decorations (what the view renders). */
  deco: DecorationSet;
  /** All table spans — the changeGate's proximity clause (c) reads this, so a
   *  caption keystroke inside a REVEALED table still rebuilds. */
  spans: DecorationSet;
  /** Indices of the revealed tables: the cheap "did anything open/close" key. */
  key: string;
}

const SPAN = Decoration.mark({});

function entriesOf(state: EditorState): Entry[] {
  const tables = scanTablesCached(state.doc, frontMatterEndLine(state.doc));
  const numbers = numberTables(tables);
  return tables.map((t: ParsedTable) => ({
    from: t.from,
    to: t.to,
    widget: new TableSrcWidget(numbers.get(t) ?? null, t.rows.length, t.head.length, t.caption != null),
  }));
}

/** Revealed = a selection range touches the block, boundaries included (the
 *  embed chip's rule — landing on the first character opens it). */
function revealedIndices(state: EditorState, entries: readonly Entry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    for (const r of state.selection.ranges) {
      if (r.from <= e.to && r.to >= e.from) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

function build(entries: Entry[], spans: DecorationSet, open: readonly number[]): TableFoldValue {
  const deco: Range<Decoration>[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (open.includes(i)) continue;
    const e = entries[i];
    deco.push(Decoration.replace({ widget: e.widget }).range(e.from, e.to));
  }
  return { entries, deco: Decoration.set(deco, true), spans, key: open.join(",") };
}

function derive(state: EditorState): TableFoldValue {
  paperPerf.tableFold++;
  const entries = entriesOf(state);
  const spans = Decoration.set(
    entries.map((e) => SPAN.range(e.from, e.to)),
    true,
  );
  return build(entries, spans, revealedIndices(state, entries));
}

// Mapping matches how the decorations themselves map: a replacing decoration is
// non-inclusive at both ends, so an insertion at either edge falls OUTSIDE.
function mapValue(value: TableFoldValue, changes: ChangeDesc): TableFoldValue {
  return {
    entries: value.entries.map((e) => ({
      from: changes.mapPos(e.from, 1),
      to: changes.mapPos(e.to, -1),
      widget: e.widget,
    })),
    deco: value.deco.map(changes),
    spans: value.spans.map(changes),
    key: value.key,
  };
}

// The widget field's gate (science/tables.ts): a pipe / aligned-delimiter /
// fence token on a touched line, a newline, or an edit within two lines of a
// table — the caption may sit one blank line below the block.
const TABLE_GATE = { tokens: ["|", ":-", "```", "~~~"], guardLines: 2 } as const;

export const scienceTableFold = StateField.define<TableFoldValue>({
  create: (state) => derive(state),
  update(value, tr) {
    if (tr.effects.some((e) => e.is(refreshChips))) return derive(tr.state);
    let next = value;
    if (tr.docChanged) {
      if (touchesMe(tr, value.spans, TABLE_GATE)) return derive(tr.state);
      next = mapValue(value, tr.changes);
    }
    if (next === value && !tr.selection) return value;
    const open = revealedIndices(tr.state, next.entries);
    const key = open.join(",");
    // Same open/closed set → keep the value object: CodeMirror's decoration
    // diff then finds every chunk shared and does no height work at all.
    return key === next.key ? next : build(next.entries, next.spans, open);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
