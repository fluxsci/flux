// Unified autocomplete for the manuscript (Flux_Paper_Plan.md A2/B1/B5/B6):
//   • "@"  → figure/table/section cross-refs + bibliography citekeys
//   • "/"  at line start → an insert palette (headings, lists, table, callout…)
// One source of truth: figureRefs + bibEntries. Cross-refs apply as "@fig-id",
// citations as "[@citekey]".

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { get } from "svelte/store";
import { figureRefs } from "./figures";
import { bibEntries } from "./bib";
import { fluxLibEntries } from "../../../../lib/references/revision";
import { slashHandlers } from "../science/chipContext";

function refKind(label: string): string {
  if (label.startsWith("tbl-")) return "Table";
  if (label.startsWith("sec-")) return "Section";
  if (label.startsWith("eq-")) return "Eq.";
  return "Figure";
}

// The two `@` grammars are kept intentionally separate at the input layer:
// plain `@` completes CITATIONS only (figures go through `@@` → FigRefPicker).
// Cross-ref completion still appears once the token is explicitly a cross-ref
// (`@f`, `@fig-gro`, `@tbl…`) so raw label typing stays fluent.
const CROSSREF_KINDS = ["fig-", "tbl-"];

function atSource(ctx: CompletionContext): CompletionResult | null {
  const tok = ctx.matchBefore(/@[\w:.-]*/);
  if (!tok) return null;
  if (tok.from === tok.to && !ctx.explicit) return null;
  const typed = tok.text.slice(1);
  const wantsCrossref =
    typed.length > 0 && CROSSREF_KINDS.some((k) => typed.startsWith(k) || k.startsWith(typed));

  const options: Completion[] = [];
  if (wantsCrossref) {
    for (const f of get(figureRefs)) {
      options.push({
        label: "@" + f.label,
        detail: `${refKind(f.label)} ${f.number}`,
        info: f.name || f.caption,
        apply: "@" + f.label,
        type: "figure",
      });
    }
  }
  // Citations: the whole FluxLib (so a fresh project can cite anything you own),
  // unioned with this project's subset. Citing a not-yet-local entry materializes it
  // into the project (PaperMode's cited-keys effect) so the [@key] resolves.
  const seenRef = new Set<string>();
  for (const e of [...get(fluxLibEntries), ...get(bibEntries)]) {
    if (!e.key || seenRef.has(e.key)) continue;
    seenRef.add(e.key);
    const who = e.authors[0] ?? e.key;
    options.push({
      label: "@" + e.key,
      detail: `${who}${e.year ? " " + e.year : ""}`,
      info: e.title,
      apply: applyCite(e.key),
      type: "reference",
    });
  }
  if (!options.length) return null;
  // No validFor: the option set itself depends on the typed prefix (citations
  // vs. citations+crossrefs), so the source must re-run per keystroke.
  return { from: tok.from, options };
}

function insert(text: string, cursor?: number) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + (cursor ?? text.length) },
      userEvent: "input.complete",
    });
    view.focus();
  };
}

// PAP-5: apply a citation bracket-aware. Completing inside an existing group (`[@sm`, or a
// multi-cite `[@a; @sm`) must insert a BARE `@key`, not another `[@key]` — the old
// unconditional wrap produced `[[@key]`, which never parses into a chip. Add the closing `]`
// only when the open group isn't already closed ahead of the cursor.
function applyCite(key: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const doc = view.state.doc;
    const line = doc.lineAt(from);
    const pre = doc.sliceString(line.from, from);
    const post = doc.sliceString(to, line.to);
    const inGroup = pre.lastIndexOf("[") > pre.lastIndexOf("]");
    const closeIdx = post.indexOf("]");
    const openIdx = post.indexOf("[");
    const closedAhead = closeIdx >= 0 && (openIdx < 0 || closeIdx < openIdx);
    const text = !inGroup ? `[@${key}]` : closedAhead ? `@${key}` : `@${key}]`;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.complete",
    });
    view.focus();
  };
}

const SLASH: Completion[] = [
  {
    label: "/figure",
    detail: "Embed a figure",
    type: "figure",
    apply: (view, _c, from, to) => {
      view.dispatch({ changes: { from, to, insert: "" }, userEvent: "input.complete" });
      slashHandlers.onInsertFigure?.();
    },
  },
  {
    label: "/table",
    detail: "Insert a table",
    type: "table",
    apply: insert(
      "| Column A | Column B |\n| --- | --- |\n|  |  |\n|  |  |\n\n: Caption {#tbl-}\n",
    ),
  },
  {
    label: "/citation",
    detail: "Cite a reference",
    type: "reference",
    apply: insert("[@", 2),
  },
  {
    label: "/cross-reference",
    detail: "Reference a figure (@@)",
    type: "figure",
    apply: (view, _c, from, to) => {
      view.dispatch({ changes: { from, to, insert: "" }, userEvent: "input.complete" });
      slashHandlers.onInsertFigRef?.();
    },
  },
  { label: "/heading", detail: "Section heading", type: "keyword", apply: insert("## ", 3) },
  {
    label: "/subheading",
    detail: "Sub-section heading",
    type: "keyword",
    apply: insert("### ", 4),
  },
  { label: "/bullet list", detail: "Bulleted list", type: "keyword", apply: insert("- ", 2) },
  {
    label: "/numbered list",
    detail: "Ordered list",
    type: "keyword",
    apply: insert("1. ", 3),
  },
  { label: "/quote", detail: "Block quote", type: "keyword", apply: insert("> ", 2) },
  {
    label: "/code block",
    detail: "Fenced code",
    type: "keyword",
    apply: insert("```\n\n```\n", 4),
  },
  {
    label: "/callout",
    detail: "Quarto callout",
    type: "keyword",
    apply: insert("::: {.callout-note}\n\n:::\n", 21),
  },
  { label: "/divider", detail: "Horizontal rule", type: "keyword", apply: insert("---\n", 4) },
];

function slashSource(ctx: CompletionContext): CompletionResult | null {
  const tok = ctx.matchBefore(/\/[\w-]*/);
  if (!tok) return null;
  const line = ctx.state.doc.lineAt(tok.from);
  // Only at the start of an otherwise-empty line (an insert command, not a path).
  if (ctx.state.doc.sliceString(line.from, tok.from).trim() !== "") return null;
  if (tok.from === tok.to && !ctx.explicit) return null;
  return { from: tok.from, options: SLASH, validFor: /^\/[\w-]*$/ };
}

export const scholarCompletion = autocompletion({
  override: [atSource, slashSource],
  icons: true,
  // Arrow/Enter/Esc are owned by the list ONLY while it is open (the bindings
  // are status-guarded), and activation requires typed @/slash input — plain
  // navigation is never intercepted.
  defaultKeymap: true,
  activateOnTyping: true,
  closeOnBlur: true,
  maxRenderedOptions: 60, // FluxLib can be large; keep the tooltip DOM cheap
});
