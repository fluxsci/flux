// Inline chip widgets: a @fig/@tbl cross-ref renders as "Fig N"/"Table N", a
// citation as "(Author, Year)". Resolution happens in the constructor and feeds
// eq(), so a chip's DOM is reused while typing elsewhere but re-rendered when the
// underlying figure/bib data loads or changes (Flux_Paper_Plan.md B1/B5).

import { WidgetType } from "@codemirror/view";
import { resolveFigure } from "../scholar/figures";
import { resolveCite } from "../scholar/bib";
import { formatNumericLabel, type CitationStyle } from "../scholar/citeNumbering";
import type { PaperNumbering } from "../scholar/numberingFacet";
import { renderTexCached } from "./katexLoader";
import { chipHandlers } from "./chipContext";

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
      chipHandlers.onActivate?.({ kind: "figref", label: this.label }, el);
    });
    el.addEventListener("mouseenter", () =>
      chipHandlers.onHover?.({ kind: "figref", label: this.label }, el),
    );
    el.addEventListener("mouseleave", () => chipHandlers.onLeave?.());
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
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-embedchip" + (this.resolved ? "" : " unresolved");
    el.textContent = `⌗ ${this.display}`;
    el.title = this.resolved
      ? `${this.raw.trim()}\nClick to place the caret (reveals the source); double-click to open in Figure`
      : `Unresolved figure embed: ${this.raw.trim()}`;
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chipHandlers.onActivate?.({ kind: "figref", label: this.label }, el);
    });
    return el;
  }
  ignoreEvent(e: Event) {
    return e.type === "dblclick";
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
      chipHandlers.onActivate?.({ kind: "cite", keys: this.keys }, el);
    });
    el.addEventListener("mouseenter", () =>
      chipHandlers.onHover?.({ kind: "cite", keys: this.keys }, el),
    );
    el.addEventListener("mouseleave", () => chipHandlers.onLeave?.());
    return el;
  }
  ignoreEvent(e: Event) {
    return e.type === "dblclick";
  }
}
