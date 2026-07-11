// Display math (2.1): `$$ … $$` blocks render as a KaTeX block widget placed
// AFTER their source lines — the embeds/tables shape, the only EDITING-FEEL-
// compliant one (invariants 1–4): the source lines stay present and navigable
// (`cm-flux-mathsrc`, identical metrics active/inactive → one keypress per line,
// goal column safe), decorations are a pure function of the DOCUMENT (StateField;
// rebuilds on docChanged/refreshChips only — NEVER on selection), and the widget
// carries an estimatedHeight + reuses DOM via eq(). Per-keystroke cost is one
// cheap per-line pass (trim/startsWith fast-bails), the same accepted class as
// the embeds/tables fields.
//
// Labeled equations ({#eq-id} on the closing line) get appearance-order numbers,
// published synchronously into the scholar/numbering registry during build (the
// tables pattern) so @eq chips in the same transaction never render stale.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { MathBlockTracker } from "./mathGrammar";
import { refreshChips } from "./chips";
import { numberingFacet } from "../scholar/numberingFacet";
import { ensureKatex, katexReady, renderTexCached } from "./katexLoader";
import { touchesMe, paperPerf } from "./changeGate";
import { frontMatterEndLine } from "../frontmatter";

class MathBlockWidget extends WidgetType {
  readonly rendered: string | null;
  constructor(
    readonly tex: string,
    readonly label: string | undefined,
    readonly number: number | undefined,
  ) {
    super();
    this.rendered = renderTexCached(tex, true);
  }
  eq(o: MathBlockWidget) {
    return o.tex === this.tex && o.label === this.label && o.number === this.number && o.rendered === this.rendered;
  }
  get estimatedHeight() {
    // ~one row per \\ line break + block padding; corrected by the first live measure.
    return 58 + 26 * (this.tex.split("\\\\").length - 1);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "flux-mathblock";
    const body = document.createElement("div");
    body.className = "mb-body";
    if (this.rendered != null) body.innerHTML = this.rendered;
    else {
      body.classList.add("pending");
      body.textContent = this.tex;
    }
    wrap.appendChild(body);
    if (this.number != null) {
      const n = document.createElement("span");
      n.className = "mb-num";
      n.textContent = `(${this.number})`;
      wrap.appendChild(n);
    }
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState): DecorationSet {
  paperPerf.math++;
  const numbered: { label: string; number: number }[] = [];
  const deco: Range<Decoration>[] = [];
  let inFence = false;
  let eqN = 0;
  let sawPending = false;
  const tracker = new MathBlockTracker();
  // Skip YAML front matter (a $$ inside it isn't math). WS-4.1: single-source
  // boundary (frontmatter.ts).
  let startLine = 1;
  {
    const closeLine = frontMatterEndLine(state.doc);
    if (closeLine > 0) startLine = closeLine + 1;
  }
  for (let n = startLine; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const text = line.text;
    // Fast bails: outside math, only fence markers and `$$`-bearing lines matter.
    if (!tracker.inMath) {
      if (/^\s*(```|~~~)/.test(text)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || text.indexOf("$$") < 0) continue;
    }
    const block = tracker.feed(n, text);
    if (!block) continue;
    let number: number | undefined;
    if (block.label) {
      number = ++eqN;
      numbered.push({ label: block.label, number });
    }
    for (let i = block.startLine; i <= block.endLine; i++) {
      deco.push(Decoration.line({ class: "cm-flux-mathsrc" }).range(state.doc.line(i).from));
    }
    const w = new MathBlockWidget(block.tex, block.label, number);
    if (w.rendered == null) sawPending = true;
    deco.push(Decoration.widget({ widget: w, block: true, side: 1 }).range(state.doc.line(block.endLine).to));
  }
  {
    // WS-4.2: per-editor numbering instance (facet), replace-contents.
    const reg = state.facet(numberingFacet);
    reg.eq.clear();
    for (const p of numbered) reg.eq.set(p.label, p.number);
  }
  if (sawPending) kickKatex();
  return Decoration.set(deco, true);
}

// "KaTeX just loaded → rebuild the decorations that showed raw TeX." The paper
// editor registers itself (trackMathView); the kick arms once per load.
const liveViews = new Set<EditorView>();
let kickArmed = false;
export function kickKatex(): void {
  if (katexReady() || kickArmed) return;
  kickArmed = true;
  void ensureKatex().then(() => {
    kickArmed = false;
    for (const v of liveViews) v.dispatch({ effects: refreshChips.of(null) });
  });
}
export function trackMathView(view: EditorView): () => void {
  liveViews.add(view);
  return () => {
    liveViews.delete(view);
  };
}

// WS-2 Fix 1: rebuild only when the change could plausibly touch display math —
// `$$` on a touched line, a fence marker (``` or ~~~ flip whether a $$ counts),
// a newline, or an edit within one line of an existing math decoration. Prose
// keystrokes map the set instead of walking the whole doc. setEqNumbers
// republishes exactly when a construct can change (changeGate.ts).
const MATH_GATE = { tokens: ["$$", "```", "~~~"], guardLines: 1 } as const;

export const scienceMathBlocks = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    // Document changes and explicit refreshes ONLY — never selection (invariant 1).
    if (tr.effects.some((e) => e.is(refreshChips))) return build(tr.state);
    if (!tr.docChanged) return value;
    if (touchesMe(tr, value, MATH_GATE)) return build(tr.state);
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
