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

interface CState {
  set: DecorationSet;
  active: string | null;
}
interface Anchor {
  id: string;
  from: number;
  to: number;
}

function mark(id: string, active: boolean) {
  return Decoration.mark({
    class: "cm-comment-hl" + (active ? " active" : ""),
    inclusive: false,
    attributes: { "data-cid": id },
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

function buildSet(anchors: Anchor[], active: string | null): DecorationSet {
  return Decoration.set(
    anchors
      .filter((a) => a.from < a.to)
      .sort((x, y) => x.from - y.from)
      .map((a) => mark(a.id, a.id === active).range(a.from, a.to)),
    true,
  );
}

export const commentField = StateField.define<CState>({
  create: () => ({ set: Decoration.none, active: null }),
  update(value, tr) {
    let set = value.set.map(tr.changes);
    let active = value.active;
    for (const e of tr.effects) {
      if (e.is(addCommentMark)) {
        const anchors = rangesOf(set).filter((a) => a.id !== e.value.id);
        anchors.push(e.value);
        set = buildSet(anchors, active);
      } else if (e.is(removeCommentMark)) {
        set = buildSet(rangesOf(set).filter((a) => a.id !== e.value), active);
      } else if (e.is(setCommentActive)) {
        active = e.value;
        set = buildSet(rangesOf(set), active);
      } else if (e.is(clearCommentMarks)) {
        set = Decoration.none;
        active = null;
      }
    }
    return { set, active };
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

/** Click a highlight → focus its card (handler installed by the layer). */
export function commentClickHandler(onClick: (id: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(e) {
      const t = e.target as HTMLElement;
      const el = t.closest?.(".cm-comment-hl") as HTMLElement | null;
      const id = el?.getAttribute("data-cid");
      if (id) onClick(id);
    },
  });
}
