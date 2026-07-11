// Targeted single-line YAML front-matter edits (2.2) — the citation-style toggle
// and friends write `key: value` as a MINIMAL span change (feel invariant 9: never
// a whole-doc replace, so selection/scroll/comment marks survive): replace the
// existing line, else insert before the closing ---, else create front matter.
import type { EditorView } from "@codemirror/view";
import { frontMatterEndLine } from "../frontmatter";

export function setFrontMatterKey(view: EditorView, key: string, value: string): void {
  const doc = view.state.doc;
  const first = doc.lines >= 1 ? doc.line(1) : null;
  if (!first || first.text.trim() !== "---") {
    view.dispatch({
      changes: { from: 0, to: 0, insert: `---\n${key}: ${value}\n---\n\n` },
      userEvent: "input",
    });
    return;
  }
  // WS-4.1: the close comes from the single-source scanner (UNCAPPED — the
  // old 100-line cap silently no-op'd on long front matter). Writer semantics
  // unchanged: replace an existing key line, else insert before the close;
  // unclosed front matter still means "leave the document alone".
  const closeLine = frontMatterEndLine(doc);
  if (closeLine === 0) return; // unclosed (malformed) — leave the document alone
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  for (let i = 2; i < closeLine; i++) {
    const l = doc.line(i);
    if (keyRe.test(l.text)) {
      view.dispatch({
        changes: { from: l.from, to: l.to, insert: `${key}: ${value}` },
        userEvent: "input",
      });
      return;
    }
  }
  const close = doc.line(closeLine);
  view.dispatch({
    changes: { from: close.from, to: close.from, insert: `${key}: ${value}\n` },
    userEvent: "input",
  });
}
