// Targeted single-line YAML front-matter edits (2.2) — the citation-style toggle
// and friends write `key: value` as a MINIMAL span change (feel invariant 9: never
// a whole-doc replace, so selection/scroll/comment marks survive): replace the
// existing line, else insert before the closing ---, else create front matter.
import type { EditorView } from "@codemirror/view";

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
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const cap = Math.min(doc.lines, 100);
  for (let i = 2; i <= cap; i++) {
    const l = doc.line(i);
    if (l.text.trim() === "---") {
      // No existing key — insert just before the closing fence.
      view.dispatch({
        changes: { from: l.from, to: l.from, insert: `${key}: ${value}\n` },
        userEvent: "input",
      });
      return;
    }
    if (keyRe.test(l.text)) {
      view.dispatch({
        changes: { from: l.from, to: l.to, insert: `${key}: ${value}` },
        userEvent: "input",
      });
      return;
    }
  }
  // Unclosed front matter (malformed) — leave the document alone.
}
