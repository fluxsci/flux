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
import { handlersForView, type SlashHandlers } from "../science/chipContext";
import { pushToast } from "../../../../lib/toast";
import { numberingFacet } from "./numberingFacet";


// The two `@` grammars are kept intentionally separate at the input layer:
// plain `@` completes CITATIONS only (figures go through `@@` → FigRefPicker).
// Cross-ref completion still appears once the token is explicitly a cross-ref
// (`@f`, `@fig-gro`, `@tbl…`, `@eq…`) so raw label typing stays fluent.
const CROSSREF_KINDS = ["fig-", "tbl-", "eq-"];

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
        detail: f.display, // family-formatted ("Fig. S4", "Mov. 3")
        info: f.nickname || f.caption || f.name,
        apply: "@" + f.label,
        type: "figure",
      });
    }
    // Tables + equations number IN-DOCUMENT (the per-editor registry that the
    // tables/math builds publish) — typing `@tbl-` was a dead end before this.
    const reg = ctx.state.facet(numberingFacet);
    for (const [label, meta] of reg.tblMeta) {
      options.push({
        label: "@" + label,
        detail: `Table ${reg.tbl.get(label) ?? "?"}`,
        ...(meta.caption ? { info: meta.caption } : {}),
        apply: "@" + label,
        type: "table",
      });
    }
    for (const [label, n] of reg.eq) {
      options.push({
        label: "@" + label,
        detail: `Eq. ${n}`,
        apply: "@" + label,
        type: "keyword",
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

// A slash command that opens a Svelte-side picker must resolve its handlers
// BEFORE touching the document: the old apply deleted the typed token first and
// optional-chained into the handler, so an unregistered editor swallowed the
// user's text and did nothing, with no trace anywhere (2026-08-12 report — four
// silent exits in a row). Now the text survives a miss, the failure is loud,
// and the journal records the attempt either way (the renderer was previously
// invisible in .meta/journal.ndjson for the whole slash path).
function journalSlash(name: string, resolved: boolean): void {
  const host = (globalThis as { fig?: { journalAppend?: (entry: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "slash_command", target: name, resolved });
}

function applyPickerCommand(name: string, pick: (s: SlashHandlers) => (() => void) | undefined) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const open = pick(handlersForView(view)?.slash ?? {});
    journalSlash(name, !!open);
    if (!open) {
      console.error(`${name}: no paper handlers registered for this editor — leaving the typed text in place`);
      pushToast("error", `${name} couldn't open its picker`, {
        detail: "This editor pane isn't wired for insert commands — please report this.",
      });
      return;
    }
    view.dispatch({ changes: { from, to, insert: "" }, userEvent: "input.complete" });
    open();
  };
}

const SLASH: Completion[] = [
  {
    label: "/figure",
    detail: "Embed a figure",
    type: "figure",
    apply: applyPickerCommand("/figure", (s) => s.onInsertFigure),
  },
  {
    label: "/table",
    detail: "Insert a table (Tab walks the cells)",
    type: "table",
    // A fresh table arrives labeled (unique `tbl-N` — instantly numbered and
    // @tbl-referenceable) with "Column A" selected: type the header, Tab on.
    apply: (view, _c, from, to) => {
      const used = new Set<string>();
      const re = /\{#(tbl-[A-Za-z0-9_-]+)\}/g;
      const text = view.state.doc.toString();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) used.add(m[1]);
      let n = 1;
      while (used.has(`tbl-${n}`)) n++;
      const snippet = `| Column A | Column B |\n| -------- | -------- |\n|          |          |\n|          |          |\n\n: Caption {#tbl-${n}}\n`;
      view.dispatch({
        changes: { from, to, insert: snippet },
        selection: { anchor: from + 2, head: from + 10 },
        userEvent: "input.complete",
      });
      view.focus();
    },
  },
  {
    label: "/equation",
    detail: "Numbered display equation ($$ … $$ {#eq-…})",
    type: "keyword",
    apply: insert("$$\n\n$$ {#eq-}\n", 3),
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
    apply: applyPickerCommand("/cross-reference", (s) => s.onInsertFigRef),
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
