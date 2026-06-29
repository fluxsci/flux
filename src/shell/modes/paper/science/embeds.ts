// Inline figure embeds (Flux_Paper_Plan.md B2/B4). A canonical Quarto figure
// line — `![Caption](../fig/renders/<id>.svg){#fig-<id>}` — renders in place as
// the actual figure (live, from figureToSvg) with a numbered "Figure N." caption.
// Cursor entering the line reveals the raw markdown (reveal-on-cursor), and the
// `.qmd` on disk stays standard Quarto. Rebuilds on edit/scroll/selection and on
// the shared refreshChips effect (so editing the figure re-renders the embed).

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { resolveFigure, renderFigureSvg } from "../scholar/figures";
import { embedHandlers } from "./chipContext";
import { refreshChips } from "./chips";

const EMBED_RE =
  /^\s*!\[(.*?)\]\(([^)]*)\)\{#(fig-[A-Za-z0-9_-]+)([^}]*)\}\s*$/;

class FigureEmbedWidget extends WidgetType {
  readonly number: string | null;
  readonly svg: string | undefined;
  readonly figId: string | undefined;
  constructor(
    readonly label: string,
    readonly caption: string,
  ) {
    super();
    const r = resolveFigure(label);
    this.number = r ? r.number : null;
    this.figId = r?.ref.id;
    this.svg = this.figId ? renderFigureSvg(this.figId) : undefined;
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

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

// Block widgets must be supplied from a StateField (they affect layout/height),
// so we scan the whole document — the leading `![` makes non-embed lines bail
// instantly, so this stays cheap.
function build(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const deco: Range<Decoration>[] = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.length === 0 || active.has(line.number)) continue;
    const m = EMBED_RE.exec(line.text);
    if (m) {
      deco.push(
        Decoration.replace({
          widget: new FigureEmbedWidget(m[3], m[1]),
          block: true,
        }).range(line.from, line.to),
      );
    }
  }
  return Decoration.set(deco, true);
}

export const scienceEmbeds = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(refreshChips))
    )
      return build(tr.state);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false) ?? Decoration.none,
    ),
  ],
});
