// Inline chip widgets: a @fig/@tbl cross-ref renders as "Fig N"/"Table N", a
// citation as "(Author, Year)". Resolution happens in the constructor and feeds
// eq(), so a chip's DOM is reused while typing elsewhere but re-rendered when the
// underlying figure/bib data loads or changes (Flux_Paper_Plan.md B1/B5).

import { WidgetType, type EditorView } from "@codemirror/view";
import { resolveFigure } from "../scholar/figures";
import { resolveCite } from "../scholar/bib";
import { formatNumericLabel, type CitationStyle } from "../scholar/citeNumbering";
import type { PaperNumbering } from "../scholar/numberingFacet";
import { renderTexCached } from "./katexLoader";
import { handlersForEl } from "./chipContext";
import { armChipActivation } from "./chipActivation";
import type { SlideChipLabel } from "./slideChipCatalog";
import type { SlideEmbedRef } from "../../../../lib/slide/embed";

/** Inline `$…$` math (2.1) — an atomic inline chip like cites/cross-refs: rendered
 *  KaTeX in place, raw TeX revealed when the selection touches it (chips.ts owns
 *  the reveal). Until KaTeX loads, the raw TeX shows styled as pending; the loader
 *  kick refreshes chips once ready. */
export class MathWidget extends WidgetType {
  readonly rendered: string | null;
  constructor(readonly tex: string) {
    super();
    this.rendered = renderTexCached(tex, false);
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.rendered === this.rendered;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-math";
    if (this.rendered != null) el.innerHTML = this.rendered;
    else {
      el.classList.add("pending");
      el.textContent = this.tex;
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

export class FigRefWidget extends WidgetType {
  readonly display: string;
  readonly resolved: boolean;
  constructor(
    readonly label: string,
    nums?: PaperNumbering,
  ) {
    super();
    // Family-formatted display comes from the resolver ("Fig. S4a–c",
    // "Mov. 3", "Table 2") — no prefix assembly here. sec- never resolves →
    // the raw-@ fallback, same as any unresolved label.
    const r = resolveFigure(label, nums);
    this.resolved = !!r;
    this.display = r ? r.display : "@" + label;
  }
  eq(o: FigRefWidget) {
    return o.label === this.label && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-chip flux-figref" + (this.resolved ? "" : " unresolved");
    el.textContent = this.display;
    // PAP-22: double-click activation is otherwise undiscoverable — hint it natively.
    el.title = this.resolved ? "Double-click to jump to this figure/table" : "Unresolved cross-reference";
    // A single click must place the caret (CodeMirror handles it; the chip is an
    // atomic range so the caret snaps to its edge) — that keeps cursor navigation
    // through prose native. The jump-to-figure action is a deliberate double-click.
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handlersForEl(el)?.chip?.onActivate?.({ kind: "figref", label: this.label }, el);
    });
    el.addEventListener("mouseenter", () =>
      handlersForEl(el)?.chip?.onHover?.({ kind: "figref", label: this.label }, el),
    );
    el.addEventListener("mouseleave", () => handlersForEl(el)?.chip?.onLeave?.());
    return el;
  }
  ignoreEvent(e: Event) {
    // Let CodeMirror process pointer events (caret placement); the widget keeps
    // its own dblclick/hover listeners.
    return e.type === "dblclick";
  }
}

/** The collapsed figure-embed SOURCE line: a compact accent chip carrying the
 *  figure's NAME (the model field the owner edits in Figure mode / Inspector) —
 *  all an embed line IS is a pointer to a figure. chips.ts owns the collapse/
 *  reveal (selection-aware); the rendered figure below is embeds.ts' separate
 *  block widget, untouched by this. */
export class EmbedSrcWidget extends WidgetType {
  readonly display: string;
  readonly resolved: boolean;
  constructor(
    readonly label: string,
    readonly raw: string,
  ) {
    super();
    const r = resolveFigure(label);
    this.resolved = !!r;
    this.display = r ? r.ref.name || label : label;
  }
  eq(o: EmbedSrcWidget) {
    return o.label === this.label && o.display === this.display && o.resolved === this.resolved;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "flux-embedchip" + (this.resolved ? "" : " unresolved");
    el.textContent = `⌗ ${this.display}`;
    el.title = this.resolved
      ? `${this.raw.trim()}\nClick to place the caret (reveals the source); double-click to open in Figure`
      : `Unresolved figure embed: ${this.raw.trim()}`;
    // The first click reveals the source and removes this element, so the
    // double-click is armed here and fired by chipActivation (see there).
    // Resolve handlers through view.dom: `el` may be detached by then.
    armChipActivation(view, el, () =>
      handlersForEl(view.dom)?.chip?.onActivate?.({ kind: "figref", label: this.label }, view.dom),
    );
    return el;
  }
  ignoreEvent(e: Event) {
    return e.type === "dblclick";
  }
}

/** The collapsed SLIDE-embed source line: `▷ Deck 3 · Slide 4` in the same
 *  chip family as the figure chip (`flux-embedchip` + `slide`). The label is
 *  resolved synchronously by slideChipCatalog; slideEmbeds.ts owns the
 *  collapse/reveal and the live player block below, which this never touches. */
export class SlideSrcWidget extends WidgetType {
  constructor(
    readonly ref: SlideEmbedRef,
    readonly label: SlideChipLabel,
    readonly onOpen: (ref: SlideEmbedRef) => void,
  ) {
    super();
  }
  eq(o: SlideSrcWidget) {
    return (
      o.ref.deck === this.ref.deck &&
      o.ref.slide === this.ref.slide &&
      o.label.text === this.label.text &&
      o.label.tooltip === this.label.tooltip &&
      o.label.resolved === this.label.resolved &&
      o.label.pending === this.label.pending
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "flux-embedchip slide" + (this.label.resolved ? "" : " unresolved") + (this.label.pending ? " pending" : "");
    el.textContent = `▷ ${this.label.text}`;
    el.title = this.label.tooltip;
    el.dataset.deck = this.ref.deck;
    el.dataset.slide = this.ref.slide;
    // An unresolved chip opens nothing (as the figure chip); the block below
    // carries the Replace… repair.
    armChipActivation(view, el, () => {
      if (this.label.resolved) this.onOpen(this.ref);
    });
    return el;
  }
  ignoreEvent(e: Event) {
    return e.type === "dblclick";
  }
}

/** One elided value on a REVEALED slide-embed source line (`…`, the full
 *  value in the tooltip). slideEmbeds.ts drops it the moment a selection
 *  touches the value, so the caret only ever edits real text. */
export class SourceElideWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: SourceElideWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-srcelide";
    el.textContent = "…";
    el.title = this.text;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

export class CiteWidget extends WidgetType {
  readonly display: string;
  readonly resolved: boolean;
  constructor(
    readonly keys: string[],
    readonly raw: string,
    style: CitationStyle,
    ordinalOf: (key: string) => number | undefined,
  ) {
    super();
    if (style === "numeric") {
      // "[3,5,9–14]" from the live per-editor registry (citeNumbers publishes
      // it synchronously before chips rebuild); unresolved keys show as "?".
      const n = formatNumericLabel(keys, ordinalOf);
      this.resolved = n.allResolved;
      // Nothing resolves → echo what was typed (same affordance as author-year).
      this.display = n.anyResolved ? n.text : raw;
    } else {
      const r = resolveCite(keys);
      this.resolved = !!r;
      this.display = r ?? raw; // unresolved → echo exactly what was typed
    }
  }
  eq(o: CiteWidget) {
    return o.raw === this.raw && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-chip flux-cite" + (this.resolved ? "" : " unresolved");
    el.textContent = this.display;
    el.title = this.resolved ? "Double-click to edit this citation" : "Unresolved citation — double-click to edit"; // PAP-22
    // Single click → caret placement (handled by CodeMirror); the caret lands at
    // the citation's edge, where `citationGroupAt` still matches, so Alt+C opens
    // edit mode for it. Double-click triggers the chip action.
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handlersForEl(el)?.chip?.onActivate?.({ kind: "cite", keys: this.keys }, el);
    });
    el.addEventListener("mouseenter", () =>
      handlersForEl(el)?.chip?.onHover?.({ kind: "cite", keys: this.keys }, el),
    );
    el.addEventListener("mouseleave", () => handlersForEl(el)?.chip?.onLeave?.());
    return el;
  }
  ignoreEvent(e: Event) {
    return e.type === "dblclick";
  }
}
