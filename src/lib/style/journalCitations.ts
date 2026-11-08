// Journal citations — numbering, marks and punctuation placement for a
// submission export (Nature, Science, Cell).
//
// Pandoc+CSL cannot do three things these venues require, which is why the
// journal export literalizes citations itself instead:
//   • Nature numbers Methods references on in a SECOND list after the Methods.
//   • Cell sets the superscript AFTER the full stop ("…observation.¹"), Nature
//     and Science BEFORE it ("…observation¹." / "…observation (1).") — pandoc
//     never moves a numeric citation across punctuation.
//   • Science turns notes into numbered entries of "References and Notes".
//
// Input is the assembled manuscript in pandoc markdown; output is the same text
// with every resolvable citation replaced by its printed mark, plus the ordinal
// table the reference lists are built from. Numbering follows the order of first
// citation in the text AS EXPORTED (after section reordering and legend placement).
//
// The citation grammar is pandoc's: `[@a; see @b, p. 3]`, `[-@a]`, narrative
// `@a`, keys `@{odd key}`. Crossref labels (@fig-, @tbl-, @sec-, @eq-…) are not
// citations and are left for Quarto. Code, math and YAML are never touched.
//
// Pure: no Svelte, no DOM, no Node. Twin-engine shared core (flux-core → src/lib).

import { mapUnprotected } from "../manuscript/documentContext";
import type { CslRecord } from "../references/zoteroFields";
import type { CiteNumericSpec } from "./journalStyle";
import { narrativeAuthors } from "./journalRefs";

const CROSSREF_RE = /^(fig|tbl|sec|eq|lst|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg)-/;
// A pandoc citation key: starts alnum/_, internal punctuation allowed, ends alnum/_.
const KEY = String.raw`[A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_])?`;

export interface CiteItem {
  key: string;
  prefix: string;
  suffix: string;
  suppressAuthor: boolean;
}

export interface CitationResult {
  text: string;
  /** citekey → ordinal, in order of first citation. */
  ordinals: Map<string, number>;
  /** ordinal → character offset (in the OUTPUT text) of its first citation. */
  firstAt: Map<number, number>;
  /** Science notes: ordinal → note markdown. */
  notes: Map<number, string>;
  /** Keys cited but absent from the bibliography (left visible as [?key]). */
  missing: string[];
  /** How many groups carried a locator/prefix the venue prints in words. */
  annotated: number;
  /** Total citation groups rewritten. */
  groups: number;
}

export interface CitationOptions {
  spec: CiteNumericSpec;
  records: Record<string, CslRecord>;
  /** Science: inline footnotes `^[…]` become numbered notes in the list. */
  notesInReferences?: boolean;
  /** Wrap each printed mark (Zotero live-field markers). */
  wrap?: (keys: string[], mark: string) => string;
}

/** Split a bracketed group's inner text into items (pandoc's `;` grammar). */
export function parseCiteGroup(inner: string): CiteItem[] | null {
  const items: CiteItem[] = [];
  for (const raw of inner.split(";")) {
    const m = new RegExp(String.raw`^(.*?)(-?)@(\{[^}]+\}|${KEY})(.*)$`, "s").exec(raw.trim());
    if (!m) return null; // a `;` part without a key — not a citation group
    let key = m[3];
    if (key.startsWith("{")) key = key.slice(1, -1);
    items.push({
      key,
      prefix: m[1].trim(),
      suffix: m[4].replace(/^\s*,\s*/, "").trim(),
      suppressAuthor: m[2] === "-",
    });
  }
  return items.length ? items : null;
}

/** [1,2,3,5] → ["1–3","5"] under the spec's collapse threshold. */
export function collapseOrdinals(nums: number[], spec: CiteNumericSpec): string[] {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i + 1 >= spec.collapseRunsOfAtLeast) {
      out.push(`${sorted[i]}${spec.rangeSeparator}${sorted[j]}`);
      i = j + 1;
    } else {
      out.push(String(sorted[i]));
      i++;
    }
  }
  return out;
}

/** The printed mark for a group of ordinals, as pandoc markdown. */
export function printedMark(nums: number[], spec: CiteNumericSpec): string {
  const segs = collapseOrdinals(nums, spec);
  switch (spec.presentation) {
    case "superscript":
      return `^${segs.join(spec.separator)}^`;
    case "parens-italic":
      // Italic numerals, roman parentheses and separators: (*1*, *2*–*4*).
      return `(${segs.map((s) => s.split(spec.rangeSeparator).map((n) => `*${n}*`).join(spec.rangeSeparator)).join(spec.separator)})`;
    case "parens":
      return `(${segs.join(spec.separator)})`;
    default:
      return `\\[${segs.join(spec.separator)}\\]`;
  }
}

/** Wording for a group with a prefix or locator: superscript venues print
 *  "(see ref. 3, p. 5)"; parenthetical ones "(see *3*, p. 5)". */
function annotatedMark(nums: number[], prefix: string, suffix: string, spec: CiteNumericSpec): string {
  const segs = collapseOrdinals(nums, spec);
  const many = nums.length > 1;
  const pre = prefix ? `${prefix} ` : "";
  const suf = suffix ? `, ${suffix}` : "";
  if (spec.presentation === "parens-italic") {
    const inner = segs.map((s) => s.split(spec.rangeSeparator).map((n) => `*${n}*`).join(spec.rangeSeparator)).join(spec.separator);
    return `(${pre}${inner}${suf})`;
  }
  return `(${pre}${many ? "refs" : "ref."} ${segs.join(spec.separator)}${suf})`.replace("refs ", "refs. ");
}

const TOKEN = (i: number) => `\u0001${i}\u0002`;
const TOKEN_RE = /\u0001(\d+)\u0002/g;
const PUNCT = "[.,;:]";

interface Pending {
  keys: string[];
  /** Ordinals this mark prints (citations and Science notes alike). */
  ords: number[];
  mark: (ord: Map<string, number>) => string;
  /** Narrative marks are never moved across punctuation. */
  movable: boolean;
}

/**
 * Number and print every citation in `text`. Two passes: the first replaces each
 * citation with a placeholder in document order (assigning ordinals on first
 * sight); placement then works on placeholders, so moving a mark across a full
 * stop can never re-parse or split a citation.
 */
export function literalizeCitations(text: string, opts: CitationOptions): CitationResult {
  const { spec, records } = opts;
  const ordinals = new Map<string, number>();
  const notes = new Map<number, string>();
  const missing = new Set<string>();
  const pending: Pending[] = [];
  let annotated = 0;
  let next = 1;
  const known = (k: string) => Object.prototype.hasOwnProperty.call(records, k);
  const assign = (k: string) => {
    if (!ordinals.has(k)) ordinals.set(k, next++);
    return ordinals.get(k)!;
  };

  const bracketRe = new RegExp(String.raw`(\^|!)?\[((?:[^\[\]]|\[[^\[\]]*\])*?@(?:\{[^}]+\}|${KEY})(?:[^\[\]]|\[[^\[\]]*\])*?)\](?![(\[{])`, "g");
  const narrativeRe = new RegExp(String.raw`(^|[^\w@\\\]])@(\{[^}]+\}|${KEY})(?:\s*\[([^\]@]*)\])?`, "g");
  const inlineNoteRe = /\^\[((?:[^[\]]|\[[^[\]]*\])*)\]/g;

  const isCitationKey = (k: string) => !CROSSREF_RE.test(k);

  function placeGroup(items: CiteItem[]): string {
    const keys = items.map((i) => i.key).filter(isCitationKey);
    if (!keys.length) return "";
    const nums: number[] = [];
    const unknown: string[] = [];
    for (const k of keys) {
      if (known(k)) nums.push(assign(k));
      else {
        missing.add(k);
        unknown.push(k);
      }
    }
    const prefix = items[0]?.prefix ?? "";
    const suffix = items[items.length - 1]?.suffix ?? "";
    const idx = pending.length;
    pending.push({
      keys: keys.filter(known),
      ords: nums,
      movable: !prefix && !suffix,
      mark: () => {
        const unk = unknown.map((k) => `\\[?${k}\\]`).join(" ");
        if (!nums.length) return unk;
        if (prefix || suffix) {
          annotated++;
          return annotatedMark(nums, prefix, suffix, spec) + (unk ? ` ${unk}` : "");
        }
        return printedMark(nums, spec) + (unk ? ` ${unk}` : "");
      },
    });
    return TOKEN(idx);
  }

  function processChunk(chunk: string): string {
    if (!opts.notesInReferences) return processInline(chunk);
    // Science notes number IN SEQUENCE with citations: text before a note is
    // numbered first, then the note, then the note's own citations.
    let out = "";
    let last = 0;
    for (const m of chunk.matchAll(inlineNoteRe)) {
      out += processInline(chunk.slice(last, m.index));
      const n = next++;
      notes.set(n, processInline(m[1]));
      const idx = pending.length;
      pending.push({ keys: [], ords: [n], movable: true, mark: () => printedMark([n], spec) });
      out += TOKEN(idx);
      last = m.index! + m[0].length;
    }
    return out + processInline(chunk.slice(last));
  }

  function processInline(chunk: string): string {
    let s = chunk.replace(bracketRe, (whole, lead: string | undefined, inner: string) => {
      if (lead === "!") return whole; // image alt text
      if (lead === "^") return whole; // inline footnote — its body is prose, cited inside
      const items = parseCiteGroup(inner);
      if (!items || !items.some((i) => isCitationKey(i.key))) return whole;
      return placeGroup(items);
    });
    // Narrative citations: "@smith2020 showed" → "Smith et al.¹ showed".
    s = s.replace(narrativeRe, (whole, pre: string, rawKey: string, locator: string | undefined) => {
      const key = rawKey.startsWith("{") ? rawKey.slice(1, -1) : rawKey;
      if (!isCitationKey(key)) return whole;
      if (!known(key)) {
        missing.add(key);
        return whole;
      }
      const n = assign(key);
      const who = narrativeAuthors(records[key]);
      const idx = pending.length;
      pending.push({
        keys: [key],
        ords: [n],
        movable: false,
        mark: () => {
          const m = locator?.trim() ? annotatedMark([n], "", locator.trim(), spec) : printedMark([n], spec);
          const glue = spec.presentation === "superscript" ? "" : " ";
          return who ? `${who}${glue}${m}` : m;
        },
      });
      return `${pre}${TOKEN(idx)}`;
    });
    return s;
  }

  let staged = mapUnprotected(text, processChunk);

  // Placement — on placeholders only.
  const superscript = spec.presentation === "superscript";
  const movable = (i: string) => pending[Number(i)]?.movable;
  if (spec.placement === "before-punctuation") {
    // "text. [@a]" / "text.[@a]" → mark before the stop.
    staged = staged.replace(new RegExp(String.raw`(${PUNCT})[ \t]*(\u0001(\d+)\u0002)`, "g"), (m, p: string, tok: string, i: string) =>
      movable(i) ? `${tok}${p}` : m,
    );
  } else if (spec.placement === "after-punctuation") {
    // "text [@a]." → "text.¹" (the stop moves in front of the mark).
    staged = staged.replace(new RegExp(String.raw`[ \t]*(\u0001(\d+)\u0002)(${PUNCT})`, "g"), (m, tok: string, i: string, p: string) =>
      movable(i) ? `${p}${tok}` : m,
    );
  }
  if (superscript) {
    // A superscript hugs the preceding word: "text [@a]" → "text¹".
    staged = staged.replace(/([^\s(\[])[ \t]+\u0001(\d+)\u0002/g, (m, c: string, i: string) =>
      pending[Number(i)]?.movable && pending[Number(i)].ords.length ? `${c}${TOKEN(Number(i))}` : m,
    );
  } else {
    // A parenthetical mark always has one space before it: "text.(1)" → "text (1).".
    staged = staged.replace(/([^\s(\[])(\u0001\d+\u0002)/g, (_m, c: string, tok: string) => `${c} ${tok}`);
  }

  // Resolve placeholders, recording where each ordinal is first printed.
  const firstAt = new Map<number, number>();
  let out = "";
  let last = 0;
  let groups = 0;
  for (const m of staged.matchAll(TOKEN_RE)) {
    out += staged.slice(last, m.index);
    const p = pending[Number(m[1])];
    const mark = p.mark(ordinals);
    for (const n of p.ords) if (!firstAt.has(n)) firstAt.set(n, out.length);
    out += opts.wrap && p.keys.length ? opts.wrap(p.keys, mark) : mark;
    groups++;
    last = m.index! + m[0].length;
  }
  out += staged.slice(last);
  // Note bodies carry placeholders of their own citations.
  for (const [n, body] of notes) {
    notes.set(n, body.replace(TOKEN_RE, (_m, i: string) => {
      const p = pending[Number(i)];
      const mark = p.mark(ordinals);
      return opts.wrap && p.keys.length ? opts.wrap(p.keys, mark) : mark;
    }));
  }

  return { text: out, ordinals, firstAt, notes, missing: [...missing], annotated, groups };
}
