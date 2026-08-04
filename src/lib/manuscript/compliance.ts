// Journal Check — the advisory compliance pass.
//
// ADVISORY BY DESIGN, never blocking. Nature states plainly that it is flexible
// about format at initial submission ("Style and length will not influence
// consideration"); compliance binds only at acceptance. So findings are `info`
// or `warn`, they never stop an export, and the stage scales their severity.
//
// THE DIVISION OF LABOUR, learned the hard way from a real manuscript:
//   Flux auto-formats what it OWNS — structured `@fig-…` tokens, model
//   captions, CSL-rendered citations. It only ADVISES on hand-typed prose.
// The manuscript that taught this contains "Gao Figure 2D establishes
// column-level modular diversity" — a reference to a figure in SOMEONE ELSE'S
// paper, three times. Rewriting literal figure references to house style would
// have silently corrupted a citation of another work. Flux cannot tell "our
// Figure 2, panel D" from "Gao's Figure 2D", so it never rewrites prose; it
// points, and the author decides. `authorAdjacent` below is what suppresses
// exactly that shape.
//
// Twin-engine shared core (flux-core → src/lib): no Svelte, no DOM, no Node.

import type { ResolvedJournalStyle } from "../style/journalStyle";
import { normalizeHeading, scanSections, type RoleAliases } from "./sections";

export type Severity = "info" | "warn";
export type SubmissionStage = "initial" | "final";

export interface Finding {
  /** Stable id, e.g. "nat.fig.spaced-panels" — gates and UI key on this. */
  ruleId: string;
  severity: Severity;
  message: string;
  /** A one-line suggested replacement, when there is an unambiguous one. */
  suggestion?: string;
  /** Character range in the document, when the finding has a location. */
  from?: number;
  to?: number;
  /** The offending text, for display. */
  excerpt?: string;
}

export interface ComplianceInput {
  doc: string;
  style: ResolvedJournalStyle;
  aliases: RoleAliases;
  stage?: SubmissionStage;
  /** Distinct figures in the project, for display-item budgeting. */
  figureCount?: number;
  /** Distinct cited keys resolved in the main text, for the reference cap. */
  mainRefCount?: number;
}

/** Regions whose contents are not prose: front matter, fenced code, inline
 *  code, math. Findings inside them would be noise. */
function maskedRanges(src: string): [number, number][] {
  const out: [number, number][] = [];
  if (/^---\s*$/m.test(src.slice(0, 4))) {
    const end = src.indexOf("\n---", 3);
    if (end >= 0) out.push([0, end + 4]);
  }
  const push = (re: RegExp) => {
    for (const m of src.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  };
  push(/```[\s\S]*?```/g);
  push(/`[^`\n]*`/g);
  push(/\$\$[\s\S]*?\$\$/g);
  push(/\$[^$\n]*\$/g);
  return out;
}

const inMasked = (ranges: [number, number][], i: number) =>
  ranges.some(([a, b]) => i >= a && i < b);

/**
 * True when an author surname or a citation sits just before a figure
 * reference — "Gao Figure 2D", "Smith et al. Fig. 3", "[@key] Figure 1".
 * That shape means the reference belongs to ANOTHER paper, so house-style
 * advice about it would be wrong.
 */
/** Capitalised words that routinely precede a figure reference and are NOT
 *  surnames. Without these, "See Fig. 2a-c" reads as an author called See. */
const NOT_A_SURNAME = new Set(
  ("see the this that these those our their its his her they there here thus hence however " +
    "although while when where which what who whom whose and but for nor yet so both all each " +
    "every any some most many few note data figure fig table panel panels left right top bottom " +
    "inset scale error mean median source extended supplementary supplementary-figure related " +
    "compare compared shown show shows showing described reported detail details example " +
    "results result methods method discussion introduction summary abstract main also " +
    "additionally furthermore moreover finally first second third next previous above below " +
    "using used use with without from into onto after before during between within across " +
    "again then now if unless because since as at by in on of to is are was were be been"
  ).split(/\s+/),
);

function authorAdjacent(src: string, at: number): boolean {
  const before = src.slice(Math.max(0, at - 60), at);
  if (/\]\s*$/.test(before)) return true; // a citation bracket just closed
  if (/\bet al\.?\s*$/i.test(before)) return true;
  if (/\bref\.\s*\d*\s*$/i.test(before)) return true;
  // A capitalised word immediately before the reference, i.e. a surname:
  // "Gao Figure 2D". Common sentence words are excluded, or ordinary prose
  // ("See Fig. 1a") would read as an attribution and silence real advice.
  const m = /\b([A-Z][a-z]{2,})\s+$/.exec(before);
  return !!m && !NOT_A_SURNAME.has(m[1].toLowerCase());
}

function words(s: string): number {
  return (s.replace(/[#*_`>|]/g, " ").match(/\S+/g) ?? []).length;
}

/**
 * Run the venue's mechanically-checkable rules over a document.
 *
 * Deliberately NOT run per keystroke — the caller triggers it on demand, on
 * idle, or at export (Nielsen §6: a whole-document sweep is not a typing-path
 * operation).
 */
export function checkCompliance(input: ComplianceInput): Finding[] {
  const { doc, style, aliases } = input;
  const stage: SubmissionStage = input.stage ?? "initial";
  const lim = style.limits;
  const out: Finding[] = [];
  const masked = maskedRanges(doc);
  // At the initial stage Nature's own position is that format does not matter;
  // structural gaps are information, not warnings, until acceptance.
  const structural: Severity = stage === "final" ? "warn" : "info";
  const add = (f: Finding) => out.push(f);

  // --- title ----------------------------------------------------------------
  const titleM = /^title:\s*["']?(.+?)["']?\s*$/m.exec(doc.slice(0, 600));
  if (titleM && lim.titleChars && titleM[1].length > lim.titleChars) {
    add({
      ruleId: "title.too-long",
      severity: "warn",
      message: `Title is ${titleM[1].length} characters; ${style.name} asks for ${lim.titleChars} or fewer.`,
      from: titleM.index,
      to: titleM.index + titleM[0].length,
      excerpt: titleM[1],
    });
  }

  // --- summary paragraph ----------------------------------------------------
  const st = scanSections(doc, aliases);
  const abstractWords = st.preamble.words;
  if (lim.abstractWords && abstractWords > lim.abstractWords) {
    const hard = lim.abstractWordsHard ?? lim.abstractWords;
    add({
      ruleId: "abstract.too-long",
      severity: abstractWords > hard ? "warn" : "info",
      message:
        abstractWords > hard
          ? `Summary paragraph is ~${abstractWords} words, past the ${hard}-word ceiling.`
          : `Summary paragraph is ~${abstractWords} words; ${style.name} asks for ${lim.abstractWords} ` +
            `(up to ${hard} when it closes with a broader-perspective passage).`,
      from: st.preamble.from,
      to: st.preamble.to,
    });
  }

  // --- headings -------------------------------------------------------------
  const tops = st.sections.filter((s) => s.level === 1);
  for (const s of st.sections) {
    if (s.level === 1 && style.structure.forbiddenHeadings.includes(normalizeHeading(s.heading))) {
      add({
        ruleId: "heading.forbidden",
        severity: "warn",
        message:
          `${style.name} does not print a "${s.heading}" heading — its main text runs under short ` +
          `descriptive subheadings instead.`,
        from: s.from,
        to: s.from + s.heading.length + 2,
        excerpt: s.heading,
      });
    }
    if (lim.subheadChars && s.level >= 2 && s.heading.length > lim.subheadChars) {
      add({
        ruleId: "heading.subhead-too-long",
        severity: "info",
        message: `Subheading is ${s.heading.length} characters; the limit is ${lim.subheadChars}.`,
        from: s.from,
        to: s.from + s.heading.length + 3,
        excerpt: s.heading,
      });
    }
  }

  // --- required sections ----------------------------------------------------
  const present = new Set(tops.map((s) => s.role));
  const required: [string, string][] = [
    ["methods", "Methods"],
    ["data-availability", "Data availability"],
    ["code-availability", "Code availability"],
    ["author-contributions", "Author contributions"],
    ["competing-interests", "Competing interests"],
  ];
  if (style.structure.order.length) {
    for (const [role, label] of required) {
      if (style.structure.order.includes(role) && !present.has(role as never)) {
        add({
          ruleId: `section.missing.${role}`,
          severity: structural,
          message: `No "${label}" section. ${style.name} requires one at acceptance.`,
        });
      }
    }
  }

  // --- Methods budget + display items ---------------------------------------
  const methods = tops.find((s) => s.role === "methods");
  if (methods && lim.methodsWords && methods.words > lim.methodsWords) {
    add({
      ruleId: "methods.too-long",
      severity: "info",
      message: `Methods is ~${methods.words} words; ${style.name} suggests under ${lim.methodsWords}.`,
      from: methods.from,
      to: methods.to,
    });
  }
  const bodyWords = tops.filter((s) => s.role === "body" || s.role === "discussion")
    .reduce((n, s) => n + s.words, 0) + abstractWords;
  if (lim.mainTextWords && bodyWords > lim.mainTextWords) {
    add({
      ruleId: "maintext.too-long",
      severity: "info",
      message:
        `Main text is ~${bodyWords} words against a budget of about ${lim.mainTextWords}. ` +
        `${style.name} counts pages, not words, so display items spend the same budget.`,
    });
  }
  if (lim.displayItems && (input.figureCount ?? 0) > lim.displayItems) {
    add({
      ruleId: "display-items.too-many",
      severity: "info",
      message: `${input.figureCount} display items; ${style.name} allows about ${lim.displayItems}.`,
    });
  }
  if (lim.mainRefs && (input.mainRefCount ?? 0) > lim.mainRefs) {
    add({
      ruleId: "refs.too-many",
      severity: "info",
      message:
        `${input.mainRefCount} main-text references; the cap is ${lim.mainRefs} ` +
        `(Methods and Supplementary references are excluded from it).`,
    });
  }

  // --- hand-typed figure references (ADVISE ONLY) ---------------------------
  // Never rewritten: see the header. Each finding offers the house form, and
  // the author decides whether it is even about this paper's figure.
  const p = style.figures.panels;
  const litRe = /\b(Fig(?:ure|s?\.|s)?)\s*(\d+)\s*([A-Za-z](?:\s*[,–-]\s*[A-Za-z])*)?/g;

  // A figure number introduced ONCE beside an author name belongs to another
  // paper for the whole document. Authors write "Gao Figure 2D establishes …"
  // and then refer to plain "Figure 2D" thereafter — suppressing only the
  // first mention would still advise house style on someone else's figure.
  const foreignNumbers = new Set<string>();
  for (const m of doc.matchAll(litRe)) {
    if (!inMasked(masked, m.index!) && authorAdjacent(doc, m.index!)) foreignNumbers.add(m[2]);
  }
  // A number beyond the project's own figure count is likewise not ours.
  const ownFigures = input.figureCount;

  for (const m of doc.matchAll(litRe)) {
    const i = m.index!;
    if (inMasked(masked, i)) continue;
    // Skip our own generated caption leads ("Fig. 1 | …").
    if (/^\s*\|/.test(doc.slice(i + m[0].length, i + m[0].length + 3))) continue;
    if (authorAdjacent(doc, i)) continue; // "Gao Figure 2D" — another paper's figure
    if (foreignNumbers.has(m[2])) continue; // …and every later bare mention of it
    if (ownFigures != null && Number(m[2]) > ownFigures) continue; // no such figure here

    const panels = m[3]?.replace(/\s+/g, "") ?? "";
    const problems: string[] = [];
    if (panels && /[A-Z]/.test(panels) && p.letterCase === "lower") problems.push("capital panel letters");
    if (m[3] && /\s/.test(m[3])) problems.push("a space inside the panel list");
    if (panels.includes("-")) problems.push("a hyphen where the range takes an en dash");
    if (/^Figure$/.test(m[1])) {
      // Spelled out mid-sentence: only flag when it is not sentence-initial.
      const before = doc.slice(Math.max(0, i - 2), i);
      if (!/(^|[.!?]\s|\n)$/.test(before)) problems.push('"Figure" spelled out mid-sentence');
    }
    if (!problems.length) continue;

    const want = `${/^Figure$/.test(m[1]) ? "Fig." : m[1]} ${m[2]}${
      panels
        ? panels
            .toLowerCase()
            .replace(/-/g, p.rangeSeparator)
            .split(",")
            .join(p.listSeparator)
        : ""
    }`;
    add({
      ruleId: "fig.literal-house-style",
      severity: "info",
      message:
        `"${m[0].trim()}" is typed out rather than written as a @fig- reference, and has ` +
        `${problems.join(" and ")}. Flux only styles references it owns.`,
      suggestion: want,
      from: i,
      to: i + m[0].length,
      excerpt: m[0].trim(),
    });
  }

  // --- statistics house style ----------------------------------------------
  for (const m of doc.matchAll(/\bp\s*[<=>]\s*0?\.\d+/g)) {
    if (inMasked(masked, m.index!)) continue;
    add({
      ruleId: "stats.p-lowercase",
      severity: "info",
      message: `${style.name} sets P values as an italic capital P.`,
      suggestion: m[0].replace(/^p/, "P"),
      from: m.index!,
      to: m.index! + m[0].length,
      excerpt: m[0],
    });
  }
  for (const m of doc.matchAll(/\bP\s*<\s*0?\.0\d+/g)) {
    if (inMasked(masked, m.index!)) continue;
    add({
      ruleId: "stats.inexact-p",
      severity: "info",
      message: `${style.name} asks for exact P values rather than a threshold.`,
      from: m.index!,
      to: m.index! + m[0].length,
      excerpt: m[0],
    });
  }

  return out;
}

/** Group findings for display: warnings first, then by rule. */
export function sortFindings(f: readonly Finding[]): Finding[] {
  const rank = (s: Severity) => (s === "warn" ? 0 : 1);
  return [...f].sort(
    (a, b) => rank(a.severity) - rank(b.severity) || a.ruleId.localeCompare(b.ruleId) || (a.from ?? 0) - (b.from ?? 0),
  );
}
