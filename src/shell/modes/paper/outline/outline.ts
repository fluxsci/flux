// Heading outline derived from the Lezer markdown tree (Flux_Paper_Plan.md A4).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface OutlineItem {
  level: number;
  text: string;
  from: number;
}

/** A nested heading node. `path` (e.g. "0/2/1") is a STABLE collapse key —
 *  unlike `from`, it doesn't shift on every keystroke. */
export interface OutlineNode {
  item: OutlineItem;
  /** Position in the tree ("0/2/1"): unique, the keyed-each identity. */
  path: string;
  /** The chain of heading texts down to this one ("Results › Methods"): what a FOLDED
   *  section is remembered by. A position would point at a different section the moment a
   *  heading is inserted above it; same-named siblings get "#2", "#3". */
  key: string;
  children: OutlineNode[];
}

/** Build the nested tree from the flat, in-order heading list. Skipped levels
 *  (e.g. h1 → h3) are handled by the `>=` pop condition. */
export function buildTree(items: OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const named = (siblings: OutlineNode[], parentKey: string, text: string): string => {
    const base = parentKey ? `${parentKey} \u203a ${text}` : text;
    let key = base;
    for (let n = 2; siblings.some((sib) => sib.key === key); n++) key = `${base} #${n}`;
    return key;
  };
  for (const item of items) {
    const node: OutlineNode = { item, path: "", key: "", children: [] };
    while (stack.length && stack[stack.length - 1].item.level >= item.level) stack.pop();
    if (stack.length === 0) {
      node.path = String(roots.length);
      node.key = named(roots, "", item.text);
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1];
      node.path = `${parent.path}/${parent.children.length}`;
      node.key = named(parent.children, parent.key, item.text);
      parent.children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

export function getOutline(state: EditorState): OutlineItem[] {
  // The bare tree ends wherever the parser last got to (init covers only the
  // first ~3k chars; edits parse only to the viewport), so a bare-tree walk
  // silently drops every heading past that point. Force a bounded
  // whole-document parse; on budget overrun fall back to the partial tree —
  // PaperMode's parse-progress listener re-runs us as the worker catches up.
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const items: OutlineItem[] = [];
  tree.iterate({
    enter: (node) => {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (m) {
        const line = state.doc.lineAt(node.from);
        const text = line.text.replace(/^#{1,6}\s+/, "").trim();
        if (text) items.push({ level: Number(m[1]), text, from: line.from });
      }
    },
  });
  return items;
}
