// Inline figure embeds (Flux_Paper_Plan.md B2/B4). A canonical Quarto figure
// line — `![Caption](../fig/renders/<id>.svg){#fig-<id>}` — renders as the
// actual figure (live, from figureToSvg) in a block widget placed AFTER the
// source line. The source line itself stays present and navigable (styled as a
// compact mono "source chip" via cm-flux-embedsrc), so vertical cursor motion
// costs exactly one keypress per line and never reflows the document: the
// decoration set is a pure function of the document (docChanged/refreshChips
// only — never selection). The `.qmd` on disk stays standard Quarto.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { resolveFigure, renderFigureSvg } from "../scholar/figures";
import { embedHandlers } from "./chipContext";
import { refreshChips } from "./chips";

const EMBED_RE =
  /^\s*!\[(.*?)\]\(([^)]*)\)\{#(fig-[A-Za-z0-9_-]+)([^}]*)\}\s*$/;

// The usable width of the art card: the 72ch/17px serif measure (~640px) minus
// the card's own chrome (2×18px padding + borders). Only an ESTIMATE for
// unrendered widgets — CodeMirror replaces it with the measured height once the
// widget scrolls into view, and because widgets no longer unmount on
// navigation, that measurement is stable for the rest of the session.
const EST_COL_W = 604;
const ART_CHROME = 38; // card padding + border
const WRAP_PAD = 48; // .flux-embed vertical padding (2 × 1.4em @ 17px)
const CAP_H = 32;

class FigureEmbedWidget extends WidgetType {
  readonly number: string | null;
  readonly svg: string | undefined;
  readonly figId: string | undefined;
  private readonly estH: number;
  constructor(
    readonly label: string,
    readonly caption: string,
  ) {
    super();
    const r = resolveFigure(label);
    this.number = r ? r.number : null;
    this.figId = r?.ref.id;
    this.svg = this.figId ? renderFigureSvg(this.figId) : undefined;
    const dims = this.svg && /width="([\d.]+)" height="([\d.]+)"/.exec(this.svg);
    if (dims) {
      const w = parseFloat(dims[1]);
      const h = parseFloat(dims[2]);
      const art = Math.min(440, h * Math.min(1, EST_COL_W / w));
      this.estH = art + ART_CHROME + WRAP_PAD + (this.caption ? CAP_H : 0);
    } else {
      this.estH = 60 + ART_CHROME + WRAP_PAD; // "missing figure" placeholder
    }
  }
  get estimatedHeight() {
    return this.estH;
  }
  eq(o: FigureEmbedWidget) {
    return (
      o.label === this.label &&
      o.caption === this.caption &&
      o.number === this.number &&
      o.svg === this.svg
    );
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "flux-embed";
    wrap.setAttribute("contenteditable", "false");

    const fig = document.createElement("div");
    fig.className = "flux-embed-art";
    if (this.svg) {
      fig.innerHTML = this.svg;
    } else {
      fig.classList.add("missing");
      fig.textContent = `Unknown figure @${this.label}`;
    }
    wrap.appendChild(fig);

    const cap = document.createElement("div");
    cap.className = "flux-embed-cap";
    const lbl = document.createElement("b");
    lbl.textContent = `Figure ${this.number ?? "?"}.`;
    cap.appendChild(lbl);
    if (this.caption) cap.appendChild(document.createTextNode(" " + this.caption));
    wrap.appendChild(cap);

    if (this.figId) {
      const bar = document.createElement("div");
      bar.className = "flux-embed-bar";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open in Figure";
      open.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        embedHandlers.onOpenFigure?.(this.figId!);
      });
      bar.appendChild(open);
      wrap.appendChild(bar);
    }
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

// Block widgets must be supplied from a StateField (they affect layout/height),
// so we scan the whole document. The `![` fast-bail makes non-embed lines O(1),
// so this stays cheap — and since the set no longer depends on the selection,
// pure navigation costs zero rebuilds (better than the old PAP-7 heuristics).
// Widgets still render lazily (CodeMirror only calls toDOM for the visible
// range); estimatedHeight keeps off-screen layout stable in the meantime.
function build(state: EditorState): DecorationSet {
  const deco: Range<Decoration>[] = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.length === 0) continue;
    if (line.text.indexOf("![") < 0) continue; // fast-bail before the regex
    const m = EMBED_RE.exec(line.text);
    if (m) {
      deco.push(Decoration.line({ class: "cm-flux-embedsrc" }).range(line.from));
      deco.push(
        Decoration.widget({
          widget: new FigureEmbedWidget(m[3], m[1]),
          block: true,
          side: 1, // a block AFTER the source line — never replaces text
        }).range(line.to),
      );
    }
  }
  return Decoration.set(deco, true);
}

export const scienceEmbeds = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(refreshChips))) return build(tr.state);
    // Selection changes NEVER touch embed decorations — the caret moving onto
    // an embed line must not cause any layout shift (the old reveal-on-cursor
    // replace-widget was the root cause of multi-line arrow jumps).
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
