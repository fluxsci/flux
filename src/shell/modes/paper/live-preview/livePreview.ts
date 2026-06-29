// The live-preview decoration engine (Flux_Paper_Plan.md A1).
//
// Strategy: the existing `fluxHighlight` HighlightStyle already styles the
// *content* of headings, bold/italic/strike, inline code and links. So this
// engine only needs to (1) HIDE the raw syntax markers when the cursor is not
// on their line, (2) add a few line-level treatments the highlighter can't do
// (blockquote rule, code-block background), and (3) render block widgets
// (horizontal rules, clean bullets). The document text is never touched —
// decorations are a pure view layer, so `doc.toString()` stays byte-identical
// Quarto markdown (Flux_Paper_Plan.md Principle 6).

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { BulletWidget, HrWidget } from "./widgets";

/** True if any selection range intersects [from,to] (± `pad` chars of adjacency). */
function rangesTouch(state: EditorState, from: number, to: number, pad: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to + pad && r.to >= from - pad) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): {
  deco: DecorationSet;
  atomic: DecorationSet;
} {
  const { state } = view;
  // F6: reveal a construct's raw syntax only when a selection touches THAT
  // construct's own extent (its parent node) — not merely its line — so clicking
  // elsewhere on a line no longer expands (and reflows) every chip/link/mark on
  // it. Inline marks use ±1 adjacency so a caret resting just outside a construct
  // still reveals it for editing; block constructs (heading/quote/list/HR) reveal
  // only on their own line.
  const composing = view.composing;
  const touches = (from: number, to: number, pad = 1) => rangesTouch(state, from, to, pad);
  const parentTouches = (
    node: { from: number; to: number; node: { parent: { from: number; to: number } | null } },
    pad = 0,
  ) => {
    const p = node.node.parent;
    return p ? touches(p.from, p.to, pad) : touches(node.from, node.to, pad);
  };
  const lineTouched = (pos: number) => {
    const ln = state.doc.lineAt(pos);
    return touches(ln.from, ln.to, 0);
  };

  const marks: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  // Hidden raw syntax is made ATOMIC so Left/Right step over the now-invisible
  // markers in a single keystroke (F6) — except during IME composition, where
  // atomic ranges can disrupt the composing region.
  const hide = (from: number, to: number) => {
    if (from >= to) return;
    (composing ? marks : atomic).push(Decoration.replace({}).range(from, to));
  };
  const lineClass = (node_from: number, node_to: number, cls: string) => {
    let pos = node_from;
    while (pos <= node_to && pos <= state.doc.length) {
      const line = state.doc.lineAt(pos);
      marks.push(Decoration.line({ class: cls }).range(line.from));
      if (line.to + 1 > node_to) break;
      pos = line.to + 1;
    }
  };

  // ---- YAML front-matter. GFM has no front-matter rule, so a leading
  // `---\n…\n---` mis-parses as a horizontal rule + setext H2 (rendered huge).
  // Detect the block by text and render it as quiet metadata — view-only, the
  // document is untouched and the title pill is the real editing surface.
  let fmEnd = -1;
  if (state.doc.lineAt(0).text.trim() === "---" && state.doc.lines > 1) {
    for (let n = 2; n <= state.doc.lines; n++) {
      const ln = state.doc.line(n);
      if (ln.text.trim() === "---") {
        fmEnd = ln.to;
        for (let k = 1; k <= n; k++) {
          marks.push(Decoration.line({ class: "cm-frontmatter" }).range(state.doc.line(k).from));
        }
        break;
      }
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const nf = node.from;
        const nt = node.to;
        const parent = node.node.parent?.name;

        // ---- Heading marker: hide "## " when inactive (size comes from highlight)
        if (name === "HeaderMark") {
          if (nf < fmEnd) return; // keep the front-matter closing `---` visible
          if (!parentTouches(node, 0)) {
            let end = nt;
            if (state.doc.sliceString(nt, nt + 1) === " ") end = nt + 1;
            hide(nf, end);
          }
          return;
        }

        // ---- Emphasis / strong / strikethrough markers
        if (name === "EmphasisMark" || name === "StrikethroughMark") {
          if (!parentTouches(node)) hide(nf, nt);
          return;
        }

        // ---- Inline code backticks (leave fenced-code fences alone)
        if (name === "CodeMark") {
          if (parent === "InlineCode" && !parentTouches(node)) hide(nf, nt);
          return;
        }

        // ---- Links: style the whole node, hide the [ ]( url ) plumbing.
        // Quarto citations `[@key]` are parsed by Lezer as shortcut links — skip
        // them entirely (return false → don't descend to their LinkMarks) so the
        // science-chip engine owns that range instead of hiding the brackets.
        if (name === "Link") {
          if (state.doc.sliceString(nf, nf + 2) === "[@") return false;
          marks.push(
            Decoration.mark({ class: "cm-flux-link" }).range(nf, nt),
          );
          return;
        }
        if (name === "LinkMark") {
          if (parent === "Link" && !parentTouches(node)) hide(nf, nt);
          return;
        }
        if (name === "URL") {
          if (parent === "Link" && !parentTouches(node)) hide(nf, nt);
          return;
        }

        // ---- Blockquote: a left rule per line; hide the ">" markers
        if (name === "Blockquote") {
          lineClass(nf, nt, "cm-flux-quote");
          return;
        }
        if (name === "QuoteMark") {
          // Reveal the ">" only on the line being edited.
          if (!lineTouched(nf)) {
            let end = nt;
            if (state.doc.sliceString(nt, nt + 1) === " ") end = nt + 1;
            hide(nf, end);
          }
          return;
        }

        // ---- Fenced code: tint the block
        if (name === "FencedCode") {
          lineClass(nf, nt, "cm-flux-codeblock");
          return;
        }

        // ---- Bullet lists: a clean • when inactive (keep ordered numbers)
        if (name === "ListMark") {
          const txt = state.doc.sliceString(nf, nt);
          if (/^[-*+]$/.test(txt) && !lineTouched(nf)) {
            atomic.push(
              Decoration.replace({ widget: new BulletWidget() }).range(nf, nt),
            );
          }
          return;
        }

        // ---- Horizontal rule
        if (name === "HorizontalRule") {
          if (nf < fmEnd) return; // the front-matter fence, not a real rule
          if (!lineTouched(nf)) {
            atomic.push(
              Decoration.replace({ widget: new HrWidget(), block: false }).range(
                nf,
                nt,
              ),
            );
          }
          return;
        }
      },
    });
  }

  const all = marks.concat(atomic);
  return {
    deco: Decoration.set(all, true),
    atomic: Decoration.set(atomic, true),
  };
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;
    constructor(view: EditorView) {
      const r = buildDecorations(view);
      this.decorations = r.deco;
      this.atomic = r.atomic;
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        const r = buildDecorations(u.view);
        this.decorations = r.deco;
        this.atomic = r.atomic;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
      ),
  },
);
