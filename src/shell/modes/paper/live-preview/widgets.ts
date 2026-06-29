// Block/inline widgets used by the live-preview engine. Kept deliberately tiny:
// these render the "finished" form of a markdown construct when its raw syntax
// is hidden (cursor off the line). See livePreview.ts.

import { WidgetType } from "@codemirror/view";

/** A drawn horizontal rule, replacing a `---` / `***` line when inactive. */
export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-flux-hr";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** A clean bullet glyph replacing a `-` / `*` / `+` list marker when inactive. */
export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-flux-bullet";
    el.textContent = "•";
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
