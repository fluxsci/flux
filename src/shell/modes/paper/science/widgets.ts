// Inline chip widgets: a @fig/@tbl cross-ref renders as "Fig N"/"Table N", a
// citation as "(Author, Year)". Resolution happens in the constructor and feeds
// eq(), so a chip's DOM is reused while typing elsewhere but re-rendered when the
// underlying figure/bib data loads or changes (Flux_Paper_Plan.md B1/B5).

import { WidgetType } from "@codemirror/view";
import { resolveFigure } from "../scholar/figures";
import { resolveCite } from "../scholar/bib";
import { chipHandlers } from "./chipContext";

export class FigRefWidget extends WidgetType {
  readonly display: string;
  readonly resolved: boolean;
  constructor(readonly label: string) {
    super();
    const r = resolveFigure(label);
    const kind = label.startsWith("tbl-")
      ? "Table "
      : label.startsWith("sec-")
        ? "Section "
        : label.startsWith("eq-")
          ? "Eq. "
          : "Fig ";
    this.resolved = !!r;
    this.display = r ? kind + r.number : "@" + label;
  }
  eq(o: FigRefWidget) {
    return o.label === this.label && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-chip flux-figref" + (this.resolved ? "" : " unresolved");
    el.textContent = this.display;
    // A single click must place the caret (CodeMirror handles it; the chip is an
    // atomic range so the caret snaps to its edge) — that keeps cursor navigation
    // through prose native. The jump-to-figure action is a deliberate double-click.
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chipHandlers.onActivate?.({ kind: "figref", label: this.label });
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

export class CiteWidget extends WidgetType {
  readonly display: string;
  readonly resolved: boolean;
  constructor(
    readonly keys: string[],
    readonly raw: string,
  ) {
    super();
    const r = resolveCite(keys);
    this.resolved = !!r;
    this.display = r ?? raw; // unresolved → echo exactly what was typed
  }
  eq(o: CiteWidget) {
    return o.raw === this.raw && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "flux-chip flux-cite" + (this.resolved ? "" : " unresolved");
    el.textContent = this.display;
    // Single click → caret placement (handled by CodeMirror); the caret lands at
    // the citation's edge, where `citationGroupAt` still matches, so alt-f opens
    // edit mode for it. Double-click triggers the chip action.
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chipHandlers.onActivate?.({ kind: "cite", keys: this.keys });
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
