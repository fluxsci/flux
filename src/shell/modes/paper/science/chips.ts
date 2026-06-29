// Science-chip decoration engine: scans visible lines for @fig/@tbl/@sec/@eq
// cross-refs and @cite / [@cite] citations, replacing each with an atomic widget
// — except on the active line (raw text revealed for editing), and except inside
// code/URLs. Rebuilds on edit, scroll, selection move, and on a refresh effect
// (when figure/bib data loads). Mirrors livePreview.ts (Flux_Paper_Plan.md B).

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Range } from "@codemirror/state";
import { CiteWidget, FigRefWidget } from "./widgets";

/** Dispatched when figure/bib data changes, to force a chip rebuild. */
export const refreshChips = StateEffect.define<null>();

/** True if any selection range intersects [from,to] (± `pad` chars of adjacency). */
function rangesTouch(state: EditorState, from: number, to: number, pad = 1): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to + pad && r.to >= from - pad) return true;
  }
  return false;
}

// A trailing `,a` / `,a-c` (comma immediately followed by a panel letter, no
// space) extends the ref into a non-contiguous panel list; a prose ", and"
// never matches because the comma must be followed directly by a letter.
const CROSSREF = /@(?:fig|tbl|sec|eq)-[A-Za-z0-9_-]+(?:,[A-Za-z](?:-[A-Za-z])?)*/g;
const BRACKET_CITE = /\[(@[^\]]+?)\]/g;
const BARE_CITE = /(^|[\s([])@([A-Za-z][\w:.-]*)/g;

interface Tok {
  from: number;
  to: number;
  widget: FigRefWidget | CiteWidget;
}

function keysFrom(inner: string): string[] {
  return inner
    .split(";")
    .map((s) => s.trim().replace(/^@/, "").replace(/[,\s].*$/, "").trim())
    .filter(Boolean);
}

function scanLine(lineFrom: number, text: string): Tok[] {
  const toks: Tok[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) =>
    taken.some(([x, y]) => a < y && b > x);
  let m: RegExpExecArray | null;

  BRACKET_CITE.lastIndex = 0;
  while ((m = BRACKET_CITE.exec(text))) {
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    const keys = keysFrom(m[1]);
    if (keys.length) {
      toks.push({ from, to, widget: new CiteWidget(keys, m[0]) });
      taken.push([from, to]);
    }
  }
  CROSSREF.lastIndex = 0;
  while ((m = CROSSREF.exec(text))) {
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    if (overlaps(from, to)) continue;
    toks.push({ from, to, widget: new FigRefWidget(m[0].slice(1)) });
    taken.push([from, to]);
  }
  BARE_CITE.lastIndex = 0;
  while ((m = BARE_CITE.exec(text))) {
    const lead = m[1].length;
    const from = lineFrom + m.index + lead;
    const to = from + 1 + m[2].length;
    if (overlaps(from, to)) continue;
    if (/^(?:fig|tbl|sec|eq)-/.test(m[2])) continue; // a cross-ref, handled above
    toks.push({ from, to, widget: new CiteWidget([m[2]], "@" + m[2]) });
    taken.push([from, to]);
  }
  return toks;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const deco: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      for (const tk of scanLine(line.from, line.text)) {
        // F6: reveal a chip's raw text only when a selection touches THAT chip
        // (± 1 char) — not when the caret is merely somewhere on the line. This is
        // what stops a click elsewhere on the line from expanding every chip and
        // reflowing the caret away from where it was placed.
        if (rangesTouch(state, tk.from, tk.to, 0)) continue;
        const nm = tree.resolveInner(tk.from, 1).name;
        if (/Code|URL/.test(nm)) continue; // don't chip-ify inside code/links
        deco.push(Decoration.replace({ widget: tk.widget }).range(tk.from, tk.to));
      }
      if (line.to + 1 > to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(deco, true);
}

export const scienceChips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      const refreshed = u.transactions.some((t) =>
        t.effects.some((e) => e.is(refreshChips)),
      );
      if (u.docChanged || u.viewportChanged || u.selectionSet || refreshed)
        this.decorations = build(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
      ),
  },
);
