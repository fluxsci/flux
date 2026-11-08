// One scan per run, shared by every pack: the masked prose, line index,
// cross-reference and citation tokens, figure embeds, tables, equations and
// label definitions. Each pack reads this instead of re-walking the document,
// which keeps a whole-document run linear (and well under the 50 ms budget on
// the 20k-line scale fixture — verify-manuscript-check.ts records it).
//
// Pure: no Svelte, no DOM, no Node.

import { Text } from "@codemirror/state";
import { protectedDocumentSpans, type SourceSpan } from "../documentContext";
import { crossrefRe } from "../grammar";
import { scanCitations, type CitationOccurrence } from "../citations";
import { frontMatterBounds, frontMatterEndLine } from "../frontmatter";
import { scanTables, numberTables, type ParsedTable } from "../tableModel";
import { scanEqNumbers } from "../refNumbers";
import { EMBED_RE } from "../../exportQmd";
import { createFigureReferenceResolver } from "../../figureReferences";
import type { CheckFigure, CheckInput } from "./types";

export type CrossrefKind = "fig" | "tbl" | "eq" | "sec";

export interface CrossrefToken {
  kind: CrossrefKind;
  /** The token without its `@` ("fig-growth-a,c"). */
  token: string;
  from: number;
  to: number;
}

export interface EmbedLine {
  label: string;
  /** The whole embed line. */
  from: number;
  to: number;
}

export interface LabelDef {
  label: string;
  /** The `{#label` text (from the brace). */
  from: number;
  to: number;
}

export interface CheckContext {
  input: CheckInput;
  text: string;
  bodyStart: number;
  /** `text` with front matter, code, math and HTML comments blanked to spaces
   *  (newlines kept, so offsets are identical). Prose-reading rules scan this. */
  prose: string;
  /** `text` with only front matter, code and HTML comments blanked — labels
   *  live inside display math (`$$ … $$ {#eq-x}`), so math stays visible. */
  structural: string;
  crossrefs: CrossrefToken[];
  citations: CitationOccurrence[];
  embeds: EmbedLine[];
  tables: ParsedTable[];
  /** Labeled table → number (appearance order, the editor's rule). */
  tableNumbers: Map<string, number>;
  /** Labeled equation → number. */
  eqNumbers: Map<string, number>;
  labelDefs: LabelDef[];
  figByLabel: Map<string, CheckFigure>;
  resolveFigure: (token: string) => { ref: CheckFigure; panelSpec?: string } | null;
  /** 1-based line/col of an offset. */
  pos: (offset: number) => { line: number; col: number };
}

/** Blank `spans` to spaces, keeping newlines (offsets stay identical). */
export function blankSpans(text: string, spans: readonly SourceSpan[]): string {
  if (!spans.length) return text;
  const parts: string[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.to <= pos) continue;
    const from = Math.max(s.from, pos);
    parts.push(text.slice(pos, from));
    parts.push(text.slice(from, s.to).replace(/[^\n]/g, " "));
    pos = s.to;
  }
  parts.push(text.slice(pos));
  return parts.join("");
}

function sortedSpans(spans: SourceSpan[]): SourceSpan[] {
  return spans.sort((a, b) => a.from - b.from || a.to - b.to);
}

const SEC_RE = /(?<![\w.@])@(sec-[A-Za-z0-9_-]*[A-Za-z0-9_])/g;
const LABEL_DEF_RE = /\{#((?:fig|tbl|eq|sec)-[A-Za-z0-9_-]+)/g;

export function buildContext(input: CheckInput): CheckContext {
  const text = input.text;
  const fm = frontMatterBounds(text);
  const proseSpans = sortedSpans(protectedDocumentSpans(text));
  // protectedDocumentSpans only masks front matter that opens on line 1 and
  // closes; frontMatterBounds is THE front-matter rule (an unterminated opener
  // is body) — the two agree for every closed block, so add the bounds span
  // explicitly to be exact either way.
  if (fm.has) proseSpans.unshift({ from: 0, to: fm.bodyStart });
  const prose = blankSpans(text, sortedSpans(proseSpans));
  const blockSpans = protectedDocumentSpans(text, { math: false, inline: false });
  const structuralSpans = sortedSpans([...blockSpans]);
  if (fm.has) structuralSpans.unshift({ from: 0, to: fm.bodyStart });
  const structural = blankSpans(text, sortedSpans(structuralSpans));

  // Line index.
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const pos = (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
  };

  // Cross-references (the editor chips' grammar), in document order.
  const crossrefs: CrossrefToken[] = [];
  if (prose.includes("@")) {
    for (const m of prose.matchAll(crossrefRe())) {
      crossrefs.push({ kind: m[1] as CrossrefKind, token: m[0].slice(1), from: m.index!, to: m.index! + m[0].length });
    }
    for (const m of prose.matchAll(SEC_RE)) {
      crossrefs.push({ kind: "sec", token: m[1], from: m.index!, to: m.index! + m[0].length });
    }
    crossrefs.sort((a, b) => a.from - b.from);
  }

  // Figure embeds — one per line, outside code/comments.
  const embeds: EmbedLine[] = [];
  if (structural.includes("![")) {
    let offset = 0;
    for (const line of structural.split("\n")) {
      if (line.includes("![")) {
        const m = EMBED_RE.exec(line);
        if (m) embeds.push({ label: m[3], from: offset, to: offset + line.length });
      }
      offset += line.length + 1;
    }
  }

  // Tables and equations — the numbering rule the editor and the export share.
  const lines = text.split("\n");
  const doc = Text.of(lines);
  const fmEndLine = frontMatterEndLine(doc);
  const tables = text.includes("|") ? scanTables(doc, fmEndLine) : [];
  const tableNumbers = new Map<string, number>();
  for (const [t, n] of numberTables(tables)) if (t.label && !tableNumbers.has(t.label)) tableNumbers.set(t.label, n);
  const eqNumbers = text.includes("{#eq-") ? scanEqNumbers(text, blockSpans) : new Map<string, number>();

  const labelDefs: LabelDef[] = [];
  if (structural.includes("{#")) {
    for (const m of structural.matchAll(LABEL_DEF_RE)) {
      labelDefs.push({ label: m[1], from: m.index!, to: m.index! + m[0].length });
    }
  }

  const figByLabel = new Map<string, CheckFigure>();
  for (const f of input.figures) if (f.label && !figByLabel.has(f.label)) figByLabel.set(f.label, f);
  const resolveFigure = createFigureReferenceResolver(input.figures);

  return {
    input,
    text,
    bodyStart: fm.bodyStart,
    prose,
    structural,
    crossrefs,
    citations: prose.includes("@") ? scanCitations(text) : [],
    embeds,
    tables,
    tableNumbers,
    eqNumbers,
    labelDefs,
    figByLabel,
    resolveFigure,
    pos,
  };
}
