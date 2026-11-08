// The find bar's two missing pieces, on top of CodeMirror's stock search panel
// (markdown-setup.ts keeps `search({ top: true })` — the behaviour stays CM's):
//
//   1. THE TITLE PILL NEVER COVERS IT. The pill straddles the editor column's
//      top edge, so half of it sat over the panel's first row (the Find field's
//      neighbours and the case / regexp / word toggles). While the panel is
//      open we measure how far anything pill-shaped in the column reaches below
//      the panel's top and pad the panel by exactly that (+ a gap). Measured,
//      not hard-coded: the pill's size is the title's business.
//   2. "3 of 17". A match count beside the Find field, recomputed on the idle
//      settle (150 ms after the last query / document / selection change, the
//      same beat as Paper's idle mirror) — never per keystroke — and capped at
//      1,000 so a one-letter query on a 20k-line manuscript stays cheap. It
//      reads "k of n" when the selection is a match (after Enter / next /
//      previous) and "n matches" otherwise. Nothing runs while the panel is shut.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { paperPerf } from "../science/changeGate";

export const FIND_COUNT_CAP = 1000;
const SETTLE_MS = 150;
const PILL_GAP = 6;
/** Chrome that overlays the column's top edge (Paper's title pill). */
const OVERLAY_SELECTOR = ".titlepill-wrap > *";

export interface FindCount {
  /** Matches found (stops at FIND_COUNT_CAP). */
  total: number;
  /** 1-based index of the match the selection sits on, 0 when none. */
  current: number;
  capped: boolean;
}

/** Count the open query's matches (pure over the state; capped). */
export function countMatches(state: EditorState, cap = FIND_COUNT_CAP): FindCount | null {
  const q = getSearchQuery(state);
  if (!q.search || !q.valid) return null;
  const main = state.selection.main;
  const cur = q.getCursor(state);
  let total = 0;
  let current = 0;
  for (let r = cur.next(); !r.done; r = cur.next()) {
    total++;
    if (!current && r.value.from === main.from && r.value.to === main.to) current = total;
    if (total >= cap) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

export function formatFindCount(c: FindCount | null): string {
  if (!c) return "";
  const n = `${c.total.toLocaleString("en-US")}${c.capped ? "+" : ""}`;
  if (!c.total) return "No matches";
  if (c.current) return `${c.current.toLocaleString("en-US")} of ${n}`;
  return `${n} ${c.total === 1 && !c.capped ? "match" : "matches"}`;
}

class FindPanelHelper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private countEl: HTMLElement | null = null;
  private pad = -1;

  constructor(private readonly view: EditorView) {
    if (searchPanelOpen(view.state)) this.opened();
  }

  update(u: ViewUpdate): void {
    if (!searchPanelOpen(u.state)) {
      if (this.countEl || this.timer) this.closed();
      return;
    }
    if (!searchPanelOpen(u.startState) || !this.countEl?.isConnected) {
      this.opened();
      return;
    }
    if (u.geometryChanged) this.place();
    if (u.docChanged || u.selectionSet || !getSearchQuery(u.state).eq(getSearchQuery(u.startState))) this.schedule();
  }

  private opened(): void {
    this.pad = -1;
    this.place();
    this.schedule();
  }

  private closed(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.countEl = null;
    this.pad = -1;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!searchPanelOpen(this.view.state)) return;
      paperPerf.findCounts++;
      const text = formatFindCount(countMatches(this.view.state));
      if (this.countEl && this.countEl.textContent !== text) this.countEl.textContent = text;
    }, SETTLE_MS);
  }

  /** Pad the panel clear of the title pill; insert the count element. */
  private place(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const panel = view.dom.querySelector<HTMLElement>(".cm-panels-top .cm-search");
        if (!panel) return null;
        const top = panel.getBoundingClientRect().top;
        const col = view.dom.closest(".editor-col") ?? view.dom.parentElement;
        let reach = 0;
        for (const el of col?.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR) ?? []) {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.top < top + 1) reach = Math.max(reach, r.bottom - top);
        }
        return { panel, pad: reach > 0 ? Math.ceil(reach) + PILL_GAP : 0 };
      },
      write: (m) => {
        if (!m) return;
        if (!this.countEl || !this.countEl.isConnected) {
          const el = document.createElement("span");
          el.className = "cm-flux-find-count";
          el.setAttribute("aria-live", "polite");
          el.setAttribute("data-find-count", "");
          const field = m.panel.querySelector('input[name="search"]');
          if (field) field.after(el);
          else m.panel.prepend(el);
          this.countEl = el;
        }
        if (m.pad !== this.pad) {
          this.pad = m.pad;
          m.panel.style.paddingTop = m.pad ? `${m.pad}px` : "";
        }
      },
    });
  }

  destroy(): void {
    clearTimeout(this.timer);
  }
}

const findCountTheme = EditorView.theme({
  ".cm-flux-find-count": {
    display: "inline-block",
    minWidth: "6.5em",
    margin: "0 6px 0 2px",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: "var(--ts-xs)",
    color: "var(--c-tx-muted)",
    fontVariantNumeric: "tabular-nums",
    verticalAlign: "middle",
  },
  // The toggles read as toggles: the checkbox sits tight to its word.
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "3px", marginRight: "6px", color: "var(--c-tx-2)" },
  ".cm-panel.cm-search label input": { margin: "0", accentColor: "var(--c-accent)" },
});

/** Paper's find-bar helper: pill clearance + the idle "k of n" count. */
export function findCount() {
  return [ViewPlugin.fromClass(FindPanelHelper), findCountTheme];
}
