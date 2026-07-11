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
import { frontMatterEndLine } from "../frontmatter";
import { StateEffect, type EditorState, type Range } from "@codemirror/state";
import { CiteWidget, EmbedSrcWidget, FigRefWidget, MathWidget } from "./widgets";
import { crossrefRe, bracketCiteRe, bareCiteRe, isCrossrefKey } from "./grammar";
import { findInlineMath } from "./mathGrammar";
import { ensureKatex, katexReady } from "./katexLoader";
import { EMBED_RE } from "./figureAttrs";

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
// PAP-19: grammar lives in ./grammar (shared with renderManuscript, PaperMode.citedKeys, and
// citeOps). PAP-14 note: only fig/tbl are numbered cross-refs; @sec-/@eq- render as plain text
// but isCrossrefKey still lists sec|eq so a bare @sec-x isn't mis-parsed as a citation.
const CROSSREF = crossrefRe();
const BRACKET_CITE = bracketCiteRe();
const BARE_CITE = bareCiteRe();

interface Tok {
  from: number;
  to: number;
  widget: FigRefWidget | CiteWidget | MathWidget;
}

function keysFrom(inner: string): string[] {
  return inner
    .split(";")
    .map((s) => s.trim().replace(/^@/, "").replace(/[,\s].*$/, "").trim())
    .filter(Boolean);
}

function scanLine(lineFrom: number, text: string, allowMath: boolean): Tok[] {
  const toks: Tok[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) =>
    taken.some(([x, y]) => a < y && b > x);
  let m: RegExpExecArray | null;

  // Inline math FIRST (2.1): a `$…$` span claims its range so a cite/cross-ref
  // lookalike INSIDE the TeX ($x_{[@key]}$) can never chip — mirroring the
  // renderer, which extracts math before its transforms.
  if (allowMath && text.indexOf("$") >= 0) {
    for (const s of findInlineMath(text)) {
      const from = lineFrom + s.from;
      const to = lineFrom + s.to;
      toks.push({ from, to, widget: new MathWidget(s.tex) });
      taken.push([from, to]);
    }
  }

  BRACKET_CITE.lastIndex = 0;
  while ((m = BRACKET_CITE.exec(text))) {
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    if (overlaps(from, to)) continue;
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
    if (isCrossrefKey(m[2])) continue; // a cross-ref, handled above
    toks.push({ from, to, widget: new CiteWidget([m[2]], "@" + m[2]) });
    taken.push([from, to]);
  }
  return toks;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const deco: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  // Front-matter end: `$`-bearing YAML values must not chip as math (2.1). Line
  // walk, capped — build runs per keystroke, so no whole-doc toString here.
  let fmEnd = 0;
  {
    // WS-4.1: single-source boundary (uncapped — the old 100-line cap missed
    // closes in long front matter).
    const closeLine = frontMatterEndLine(state.doc);
    if (closeLine > 0) fmEnd = state.doc.line(closeLine).to + 1;
  }
  let pendingMath = false;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      // Figure-embed SOURCE line: collapse the whole line content to a compact
      // name chip unless a selection touches the line (same reveal rule as the
      // HorizontalRule widget in livePreview — an INLINE atomic replace; the
      // line itself stays, so vertical nav still costs exactly one keypress,
      // and embeds.ts' block widget below is a separate, doc-pure concern).
      if (line.length && line.text.indexOf("![") >= 0) {
        const em = EMBED_RE.exec(line.text);
        if (em) {
          if (!rangesTouch(state, line.from, line.to, 0)) {
            const indent = line.text.length - line.text.trimStart().length;
            deco.push(
              Decoration.replace({ widget: new EmbedSrcWidget(em[3], line.text) }).range(
                line.from + indent,
                line.to,
              ),
            );
          }
          // Nothing inside a (collapsed or revealed) embed line chips separately.
          if (line.to + 1 > to) break;
          pos = line.to + 1;
          continue;
        }
      }
      for (const tk of scanLine(line.from, line.text, line.from >= fmEnd)) {
        if (tk.widget instanceof MathWidget && tk.widget.rendered == null) pendingMath = true;
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
  // First math seen before KaTeX loaded: load it, then refresh so raw-TeX chips
  // re-render (idempotent — ensureKatex caches the module + in-flight promise).
  if (pendingMath && !katexReady()) {
    void ensureKatex().then(() => view.dispatch({ effects: refreshChips.of(null) }));
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
