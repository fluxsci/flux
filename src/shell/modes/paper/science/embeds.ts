// Inline figure embeds (Flux_Paper_Plan.md B2/B4). A canonical Quarto figure
// line — `![Caption](../fig/renders/<id>.svg){#fig-<id> width=60%}` — renders
// as the actual figure (live, from figureToSvg) in a block widget placed AFTER
// the source line. The source line itself stays present and navigable (styled
// as a compact mono "source chip" via cm-flux-embedsrc), so vertical cursor
// motion costs exactly one keypress per line and never reflows the document:
// the decoration set is a pure function of the document (docChanged/
// refreshChips only — never selection). The `.qmd` on disk stays standard
// Quarto; the width attr is honored live (card width as % of the text column)
// and by export, and is edited via the drag grip / hover buttons here or the
// keyboard commands in editing/figureSize.ts.
//
// Part of the LOCKED editing-feel contract — see ../EDITING-FEEL.md. In
// particular: never rebuild on selection, never add block atomicRanges.

import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { resolveFigure, renderFigureSvg } from "../scholar/figures";
import { embedHandlers } from "./chipContext";
import { refreshChips } from "./chips";
import { EMBED_RE, parseEmbedAttrs, widthFraction, cssWidth } from "./figureAttrs";

// The usable width of the art card: the 72ch/17px serif measure (~640px) minus
// the card's own chrome (2×18px padding + borders). Only an ESTIMATE for
// unrendered widgets — CodeMirror replaces it with the measured height once the
// widget scrolls into view, and because widgets no longer unmount on
// navigation, that measurement is stable for the rest of the session.
const EST_COL_W = 604;
const ART_CHROME = 38; // card padding + border
const WRAP_PAD = 36; // .flux-embed vertical padding
const CAP_H = 32;

interface EmbedDomState {
  label: string;
  caption: string;
  number: string | null;
  svg: string | undefined;
  width: string | null;
}
const domState = new WeakMap<HTMLElement, EmbedDomState>();

function applyWidth(wrap: HTMLElement, width: string | null): void {
  if (width) {
    wrap.classList.add("sized");
    wrap.style.setProperty("--embed-w", cssWidth(width));
  } else {
    wrap.classList.remove("sized");
    wrap.style.removeProperty("--embed-w");
  }
}

class FigureEmbedWidget extends WidgetType {
  readonly number: string | null;
  readonly svg: string | undefined;
  readonly figId: string | undefined;
  readonly width: string | null;
  private readonly estH: number;
  constructor(
    readonly label: string,
    readonly caption: string,
    attrsRaw: string,
  ) {
    super();
    this.width = parseEmbedAttrs(attrsRaw).width;
    const r = resolveFigure(label);
    this.number = r ? r.number : null;
    this.figId = r?.ref.id;
    this.svg = this.figId ? renderFigureSvg(this.figId) : undefined;
    const dims = this.svg && /width="([\d.]+)" height="([\d.]+)"/.exec(this.svg);
    if (dims) {
      const w = parseFloat(dims[1]);
      const h = parseFloat(dims[2]);
      const frac = widthFraction(this.width);
      // Sized: the card is frac×column and the svg fills it (no 440 cap).
      // Auto: intrinsic size, shrunk to the column, capped at 440px tall.
      const art = frac
        ? h * (Math.max(60, EST_COL_W * frac - 36) / w)
        : Math.min(440, h * Math.min(1, EST_COL_W / w));
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
      o.svg === this.svg &&
      o.width === this.width
    );
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "flux-embed";
    wrap.setAttribute("contenteditable", "false");
    applyWidth(wrap, this.width);

    const fig = document.createElement("div");
    fig.className = "flux-embed-art";
    if (this.svg) {
      fig.innerHTML = this.svg;
    } else {
      fig.classList.add("missing");
      fig.textContent = `Unknown figure @${this.label}`;
    }
    wrap.appendChild(fig);

    if (this.svg) fig.appendChild(this.makeGrip(wrap));

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
      const widthBtn = (label: string, value: string | null) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = value ? `Figure width ${value}` : "Intrinsic size, fit to column";
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          embedHandlers.onSetWidth?.(wrap, value);
        });
        return b;
      };
      for (const p of ["50%", "75%", "100%"]) bar.appendChild(widthBtn(p, p));
      bar.appendChild(widthBtn("Auto", null));
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

    domState.set(wrap, {
      label: this.label,
      caption: this.caption,
      number: this.number,
      svg: this.svg,
      width: this.width,
    });
    return wrap;
  }
  // Resize commits are a one-attr text edit → the field rebuilds → a new widget
  // that differs ONLY in width. Patch the CSS var on the live DOM instead of
  // rebuilding (no innerHTML re-parse, no scroll jump, element identity kept).
  updateDOM(dom: HTMLElement): boolean {
    const prev = domState.get(dom);
    if (
      !prev ||
      prev.label !== this.label ||
      prev.caption !== this.caption ||
      prev.number !== this.number ||
      prev.svg !== this.svg
    )
      return false;
    if (prev.width !== this.width) {
      applyWidth(dom, this.width);
      prev.width = this.width;
    }
    return true;
  }
  // Live drag: CSS-var-only while the pointer moves (zero dispatches), one
  // attr write on release via embedHandlers.onSetWidth.
  private makeGrip(wrap: HTMLElement): HTMLElement {
    const grip = document.createElement("div");
    grip.className = "flux-embed-grip";
    grip.title = "Drag to resize";
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const content = wrap.closest(".cm-content") as HTMLElement | null;
      if (!content) return;
      const cs = getComputedStyle(content);
      const rect = content.getBoundingClientRect();
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const colW = rect.width - padL - padR;
      const center = rect.left + padL + colW / 2;
      if (colW <= 0) return;
      grip.setPointerCapture(e.pointerId);
      const readout = document.createElement("div");
      readout.className = "flux-embed-readout";
      wrap.appendChild(readout);
      let pct = Math.round(((wrap.querySelector(".flux-embed-art")?.clientWidth ?? colW) / colW) * 100);
      const onMove = (ev: PointerEvent) => {
        // The card stays centered — the right edge sits at center + width/2.
        pct = Math.max(10, Math.min(100, Math.round(((ev.clientX - center) * 2 * 100) / colW)));
        applyWidth(wrap, `${pct}%`);
        readout.textContent = `${pct}%`;
      };
      const onUp = (ev: PointerEvent) => {
        grip.releasePointerCapture(ev.pointerId);
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        readout.remove();
        embedHandlers.onSetWidth?.(wrap, `${pct}%`);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });
    return grip;
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
          widget: new FigureEmbedWidget(m[3], m[1], m[4]),
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
