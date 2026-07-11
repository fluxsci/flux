// The single authority for editing `[@…]` citations in the document (Redesign
// v2). Insert a new group, replace the group under the caret (edit-in-place),
// or remove a key everywhere. All are plain CodeMirror dispatches so undo works.
// The key char-class + cross-ref exclusion MUST mirror PaperMode.citedKeys so
// the red-dot state and removal target stay consistent.

import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { frontMatterBounds } from "../frontmatter";
import type { CitationGroup } from "../margin/types";
import { isCrossrefKey as isCrossref } from "../science/grammar";

// Mirrors grammar.ts KEY: never ends in punctuation ("@smith2020." cites smith2020).
const KEY_RE = /@([A-Za-z](?:[\w:.-]*\w)?)/g;

function keysIn(text: string): string[] {
  const out: string[] = [];
  KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(text))) if (!isCrossref(m[1])) out.push(m[1]);
  return out;
}

function insideBracket(doc: string, pos: number): boolean {
  const bracket = /\[@[^\]]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(doc))) {
    if (pos >= m.index && pos < m.index + m[0].length) return true;
  }
  return false;
}

/** First body position past any YAML front-matter (so inserts never land in it).
 *  WS-4.1: single-source boundary (frontmatter.ts) — its bodyStart already
 *  lands past the close line's newline (the old +4-then-skip arithmetic). */
function bodyStart(doc: string): number {
  return frontMatterBounds(doc).bodyStart;
}

/** Locate the citation enclosing `pos`: a `[@…]` group, else a bare `@key`.
 *  LINE-LOCAL (citations never span lines) — O(line), cheap enough that the
 *  active-citation watcher can call it on every caret move. */
export function citationGroupAt(state: EditorState, pos: number): CitationGroup | null {
  const line = state.doc.lineAt(Math.min(Math.max(0, pos), state.doc.length));
  const text = line.text;
  const rel = pos - line.from;
  const bracket = /\[@[^\]]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(text))) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (rel >= from && rel <= to)
      return { from: line.from + from, to: line.from + to, keys: keysIn(m[0]) };
  }
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(text))) {
    if (isCrossref(m[1])) continue;
    const from = m.index;
    const to = m.index + m[0].length;
    if (rel >= from && rel <= to && !insideBracket(text, from)) {
      return { from: line.from + from, to: line.from + to, keys: [m[1]] };
    }
  }
  return null;
}

/** Insert (no target) or replace (target given) a citation group. Empty keys
 *  with a target delete the group (plus a stray adjacent space). */
export function writeCiteGroup(
  view: EditorView,
  keys: string[],
  target?: { from: number; to: number },
): void {
  const docStr = view.state.doc.toString();
  const text = keys.length ? `[@${keys.join("; @")}]` : "";
  if (target) {
    let { from, to } = target;
    if (!keys.length) {
      if (docStr[to] === " ") to++;
      else if (from > 0 && docStr[from - 1] === " ") from--;
    }
    view.dispatch({ changes: { from, to, insert: text }, userEvent: "input" });
  } else {
    let pos = view.state.selection.main.head;
    const bs = bodyStart(docStr);
    if (pos < bs) pos = bs;
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: "input",
    });
  }
  view.focus();
}

export function insertCites(view: EditorView, keys: string[]): void {
  writeCiteGroup(view, keys);
}

/** Remove every occurrence of `key` — from bracketed groups and bare tokens. */
export function removeCite(view: EditorView, key: string): void {
  const doc = view.state.doc.toString();
  const changes: { from: number; to: number; insert: string }[] = [];
  const bracket = /\[@[^\]]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(doc))) {
    const keys = keysIn(m[0]);
    if (!keys.includes(key)) continue;
    const remaining = keys.filter((k) => k !== key);
    let from = m.index;
    let to = m.index + m[0].length;
    if (!remaining.length) {
      if (doc[to] === " ") to++;
      else if (from > 0 && doc[from - 1] === " ") from--;
      changes.push({ from, to, insert: "" });
    } else {
      changes.push({ from, to, insert: `[@${remaining.join("; @")}]` });
    }
  }
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(doc))) {
    if (m[1] !== key || isCrossref(m[1]) || insideBracket(doc, m.index)) continue;
    let from = m.index;
    let to = m.index + m[0].length;
    if (doc[to] === " ") to++;
    else if (from > 0 && doc[from - 1] === " ") from--;
    changes.push({ from, to, insert: "" });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "delete" });
  view.focus();
}
