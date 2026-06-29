// Heading outline derived from the Lezer markdown tree (Flux_Paper_Plan.md A4).

import { syntaxTree } from "@codemirror/language";
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
  path: string;
  children: OutlineNode[];
}

/** Build the nested tree from the flat, in-order heading list. Skipped levels
 *  (e.g. h1 → h3) are handled by the `>=` pop condition. */
export function buildTree(items: OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const item of items) {
    const node: OutlineNode = { item, path: "", children: [] };
    while (stack.length && stack[stack.length - 1].item.level >= item.level) stack.pop();
    if (stack.length === 0) {
      node.path = String(roots.length);
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1];
      node.path = `${parent.path}/${parent.children.length}`;
      parent.children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

export function getOutline(state: EditorState): OutlineItem[] {
  const items: OutlineItem[] = [];
  syntaxTree(state).iterate({
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
