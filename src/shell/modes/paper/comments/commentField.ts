// In-session comment anchoring: a StateField of highlight marks that CodeMirror
// remaps through every edit (value.map), so highlights stay glued to their text
// with zero in-session drift (Flux_Paper_Plan.md C1). The Svelte margin layer
// reads live ranges from here to align cards; persistence/re-anchoring lives in
// comments.ts.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export const addCommentMark = StateEffect.define<{ id: string; from: number; to: number }>();
export const removeCommentMark = StateEffect.define<string>();
export const setCommentActive = StateEffect.define<string | null>();
export const clearCommentMarks = StateEffect.define<null>();
/** A colour of its own for some comments (id → #rrggbb): a tagged comment wears its tag's. */
export const setCommentColors = StateEffect.define<ReadonlyMap<string, string>>();

interface CState {
  set: DecorationSet;
  active: string | null;
  colors: ReadonlyMap<string, string>;
}
interface Anchor {
  id: string;
  from: number;
  to: number;
}

function mark(id: string, active: boolean, color: string | undefined) {
  return Decoration.mark({
    class: "cm-comment-hl" + (active ? " active" : ""),
    inclusive: false,
    // --cm-hl is read by the theme (flux-theme.ts); without it the highlight is the setting's colour.
    attributes: color ? { "data-cid": id, style: `--cm-hl:${color}` } : { "data-cid": id },
  });
}

function rangesOf(set: DecorationSet): Anchor[] {
  const out: Anchor[] = [];
  const it = set.iter();
  while (it.value) {
    if (it.from < it.to) {
      const id = it.value.spec.attributes?.["data-cid"];
      if (id) out.push({ id, from: it.from, to: it.to });
    }
    it.next();
  }
  return out;
}

function buildSet(anchors: Anchor[], active: string | null, colors: ReadonlyMap<string, string>): DecorationSet {
  return Decoration.set(
    anchors
      .filter((a) => a.from < a.to)
      .sort((x, y) => x.from - y.from)
      .map((a) => mark(a.id, a.id === active, colors.get(a.id)).range(a.from, a.to)),
    true,
  );
}

export const commentField = StateField.define<CState>({
  create: () => ({ set: Decoration.none, active: null, colors: new Map() }),
  update(value, tr) {
    let set = value.set.map(tr.changes);
    let active = value.active;
    let colors = value.colors;
    for (const e of tr.effects) {
      if (e.is(addCommentMark)) {
        const anchors = rangesOf(set).filter((a) => a.id !== e.value.id);
        anchors.push(e.value);
        set = buildSet(anchors, active, colors);
      } else if (e.is(removeCommentMark)) {
        set = buildSet(rangesOf(set).filter((a) => a.id !== e.value), active, colors);
      } else if (e.is(setCommentActive)) {
        active = e.value;
        set = buildSet(rangesOf(set), active, colors);
      } else if (e.is(setCommentColors)) {
        colors = e.value;
        set = buildSet(rangesOf(set), active, colors);
      } else if (e.is(clearCommentMarks)) {
        set = Decoration.none;
        active = null;
      }
    }
    return { set, active, colors };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.set),
});

/** Current live range of every anchored comment, by id. */
export function commentRanges(view: EditorView): Map<string, { from: number; to: number }> {
  const map = new Map<string, { from: number; to: number }>();
  const st = view.state.field(commentField, false);
  if (!st) return map;
  for (const a of rangesOf(st.set)) map.set(a.id, { from: a.from, to: a.to });
  return map;
}

/** The colours the editor is drawing with now (what `setCommentColors` last set on THIS state). */
export const commentColors = (view: EditorView): ReadonlyMap<string, string> => view.state.field(commentField, false)?.colors ?? new Map();

const highlightAt = (target: EventTarget | null): { id: string; el: HTMLElement } | null => {
  const el = (target as HTMLElement | null)?.closest?.(".cm-comment-hl") as HTMLElement | null;
  const id = el?.getAttribute("data-cid");
  return el && id ? { id, el } : null;
};

/** A plain click on a highlight → its comment (installed by the layer); rest the pointer on
 *  one → its card. `onHover(null)` = the pointer left the highlight. The element handed over is
 *  the piece of the highlight under the pointer, which is where the card should hang.
 *
 *  A click is a press and a release in the same place with nothing selected: dragging a
 *  selection through commented text is not asking for its comment. It is NOT the browser's
 *  `click` event, whose target is the common ancestor of the pressed and the released node:
 *  the editor may redraw the line in between (the caret arriving reveals its markup), and the
 *  ancestor of a replaced node is the line, not the highlight. So the piece is looked up again,
 *  by position, at the release. Observers: nothing here takes an event from the editor. */
export function commentClickHandler(
  onClick: (id: string, el: HTMLElement) => void,
  onHover?: (hit: { id: string; el: HTMLElement } | null) => void,
) {
  let press: { id: string; x: number; y: number } | null = null;
  return EditorView.domEventObservers({
    mousedown(e) {
      const plain = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const hit = plain ? highlightAt(e.target) : null;
      press = hit ? { id: hit.id, x: e.clientX, y: e.clientY } : null;
    },
    mouseup(e, view) {
      const from = press;
      press = null;
      if (!from || Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4 || !view.state.selection.main.empty) return;
      const hit = highlightAt(view.root.elementFromPoint(e.clientX, e.clientY));
      if (hit?.id === from.id) onClick(hit.id, hit.el);
    },
    mouseover(e) {
      if (!onHover) return;
      const hit = highlightAt(e.target);
      if (hit) onHover(hit);
    },
    mouseout(e) {
      if (!onHover || !highlightAt(e.target)) return;
      // Moving between two pieces of the same highlight (it can span lines) is not leaving it.
      const next = highlightAt(e.relatedTarget);
      if (!next || next.id !== highlightAt(e.target)?.id) onHover(null);
    },
  });
}
/** An OBSERVER, not a handler: the keymap answers most keys before a later handler is asked,
 *  and this must hear every one of them. */
export const commentTypingObserver = (onType: () => void) =>
  EditorView.domEventObservers({
    keydown(e) {
      if (e.key !== "Control" && e.key !== "Shift" && e.key !== "Alt" && e.key !== "Meta") onType();
    },
  });
