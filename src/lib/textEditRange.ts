// The CHARACTER range a style control should act on (2026-09-24).
//
// Per-range formatting existed, but only Ctrl+B/I/U typed inside the inline
// editor reached it. Every other style control (the Inspector's B/I/U buttons,
// its text colour, Ctrl+B pressed after the editor closed) formatted the whole
// box, because none of them knew which letters were selected, and clicking a
// panel control blurs the textarea, which ends the edit and loses the
// selection. Owner report: "the style would just apply to the whole box
// instead of to the selected letters".
//
// Canvas publishes the textarea's selection here while editing and KEEPS it
// when the editor closes by losing focus, so the control that took the focus
// still knows what to format. The kept range is only honoured while it still
// describes the document: the same single element stays selected and its text
// is unchanged. Selecting anything else, clicking the canvas, or editing the
// text again retires it.
import { get, writable } from "svelte/store";
import { commit, project, selection } from "./store";
import * as ops from "./ops";
import { applyTextLayout } from "./text";
import type { Id, Project, TextElement } from "./types";

export interface TextEditRange {
  id: Id;
  from: number;
  to: number;
  /** The element's text when the range was taken; a range is offsets into it. */
  text: string;
  /** True while the inline editor is open and focused on it. */
  live: boolean;
}

export const textEditRange = writable<TextEditRange | null>(null);

/** While the inline editor is open, its Canvas routes a toggle through the edit
 *  session (one undo entry, selection restored) instead of a separate commit.
 *  Every mounted canvas registers one; each returns true only when it owns the
 *  focused editor. */
type LiveToggle = (which: "bold" | "italic" | "underline") => boolean;
const liveToggles = new Set<LiveToggle>();
export function registerLiveRangeToggle(fn: LiveToggle): () => void {
  liveToggles.add(fn);
  return () => { liveToggles.delete(fn); };
}

function findText(p: Project, id: Id): TextElement | null {
  for (const f of p.figures) for (const e of f.elements) if (e.id === id && e.type === "text") return e;
  return null;
}

/** Publish (or with null, retire) the range. A collapsed selection, or one that
 *  spans the whole text, means the BOX, which is what those have always meant,
 *  so neither is kept as a range. */
export function publishTextRange(r: TextEditRange | null): void {
  const next = r && r.to > r.from && !(r.from === 0 && r.to === r.text.length) ? r : null;
  const cur = get(textEditRange);
  if (!cur && !next) return;
  if (cur && next && cur.id === next.id && cur.from === next.from && cur.to === next.to && cur.text === next.text && cur.live === next.live) return;
  textEditRange.set(next);
}

/** Keep the range but mark the editor closed (the textarea lost focus). */
export function detachTextRange(): void {
  const cur = get(textEditRange);
  if (cur?.live) textEditRange.set({ ...cur, live: false });
}

/** The range that applies right now, with its element, or null when the
 *  controls should act on whole elements as usual. */
export function activeTextRange(p: Project = get(project), sel: Set<Id> = get(selection)): { range: TextEditRange; element: TextElement } | null {
  const range = get(textEditRange);
  if (!range || sel.size !== 1 || !sel.has(range.id)) return null;
  const element = findText(p, range.id);
  if (!element || element.text !== range.text) return null;
  return { range, element };
}

/** Toggle bold/italic/underline on the active range. Returns false when there
 *  is none, so the caller falls back to formatting whole elements. */
export function toggleActiveRange(which: "bold" | "italic" | "underline"): boolean {
  const hit = activeTextRange();
  if (!hit) return false;
  if (hit.range.live) for (const fn of liveToggles) if (fn(which)) return true;
  const { id, from, to } = hit.range;
  commit((p) => {
    ops.toggleTextRunStyle(p, id, from, to, which);
    const e = findText(p, id);
    if (e) applyTextLayout(e); // bold changes metrics, so re-wrap
  });
  return true;
}

// Any selection other than the range's own element retires it.
selection.subscribe((sel) => {
  const range = get(textEditRange);
  if (range && !(sel.size === 1 && sel.has(range.id))) textEditRange.set(null);
});
