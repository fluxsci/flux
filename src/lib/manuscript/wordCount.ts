// THE word counter — every word count Flux shows comes from here (the status
// bar, the Statistics pane, the outline, the word-count popover, Journal Check,
// the journal export summary and flux-connect's document list). Before this
// module there were five counters and they disagreed: four `\S+` variants with
// different punctuation scrubs, so `[@smith2021; @lee2020]`, figure-embed lines,
// table pipes, code and math all counted as words, by different amounts.
//
// THE COUNTING LAW (Nature's convention — a journal counts the words a reader
// reads in the submitted file, so markup is never a word):
//   · a word is a whitespace-separated run that contains a letter or a digit
//     ("state-of-the-art" = 1, "3.5" = 1, "p < 0.05" = 2, a lone "—" = 0);
//   · NOT words: YAML front matter, fenced code (incl. executable chunks),
//     inline code, display and inline math, raw LaTeX command lines, HTML
//     comments and tags (an autolink is one word), Quarto shortcodes, attribute blocks (`{#fig-x}`,
//     `{.mark}`), div fences (`:::`), link targets, inline images, list and
//     quote markers, table pipes and delimiter rows;
//   · citations count ZERO: `[@a; @b]` and a bare `@key` print as numbered
//     superscripts in Nature, and references are outside every word limit;
//   · a cross-reference (`@fig-x`, `@tbl-x`, `@eq-x`, `@sec-x`, panels too)
//     counts the TWO words it prints ("Fig. 2b", "Table 1"), exactly what the
//     exported document says;
//   · figure-embed lines are not main text: their caption (the alt text, or the
//     figure model's caption via `legendFor`) counts as LEGEND words, as does a
//     table caption (`: … {#tbl-x}`) and everything inside a `::: {#fig-…}` /
//     `::: {#tbl-…}` div;
//   · table cells count as TABLE words — counted, but in their own bucket;
//   · heading words are HEADING words — counted in a selection, never in a
//     section or the main text (a section's count is its body).
//
// The analysis is computed ONCE per idle tick (PaperMode's 150 ms mirror),
// never on the keystroke path; a selection count is then two binary searches
// over the cached word offsets. Budgets per venue (abstract / main / Methods /
// legends) live in wordBudget.ts.
//
// Twin-engine shared core (flux-core → src/lib): no Svelte, no DOM, no Node.

import { frontMatterBounds } from "../../shell/modes/paper/frontmatter";
import { findInlineMath } from "./mathGrammar";

export const WORD_PROSE = 0;
export const WORD_LEGEND = 1;
export const WORD_TABLE = 2;
export const WORD_HEADING = 3;
export type WordKind = typeof WORD_PROSE | typeof WORD_LEGEND | typeof WORD_TABLE | typeof WORD_HEADING;

export interface CountHeading {
  /** Offset of the heading line's first character (what the outline keys on). */
  from: number;
  /** Offset just past the heading line (its body starts after the newline). */
  lineEnd: number;
  level: number;
  /** Heading text as authored, without the #s (attributes kept). */
  text: string;
}

/** A figure-model caption standing in for an empty-alt embed line. */
export interface ExternalLegend {
  /** Offset of the embed line. */
  at: number;
  label: string;
  words: number;
}

export interface WordAnalysis {
  /** Length of the analysed source — a cache key for range counts. */
  length: number;
  bodyStart: number;
  /** Word count; word i (< n) spans [starts[i], ends[i]) and has kind
   *  kinds[i], sorted by start. (Typed arrays may be longer than n.) */
  n: number;
  starts: Int32Array;
  ends: Int32Array;
  kinds: Uint8Array;
  headings: CountHeading[];
  external: ExternalLegend[];
  /** Every legend — figure (alt text or model caption) and table caption —
   *  with its own word count, for per-legend limits. */
  legendItems: ExternalLegend[];
  /** Words of a front-matter `abstract:` (null when the key is absent). */
  fmAbstract: number | null;
}

export interface AnalyzeOptions {
  /** Caption text for an empty-alt figure embed, by label (`fig-growth`). */
  legendFor?: (label: string) => string | undefined;
}

const WORDY = /[\p{L}\p{N}]/u;
const SPECIAL = /[`$[\]{}<>@^\\|!*+:#0-9-]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const IMAGE_LINE = /^(\s*!\[)((?:\\.|[^\]])*)\]\(([^)]*)\)(\{[^}]*\})?\s*$/;
const LATEX_LINE = /^\s*\\[A-Za-z]+\*?(?:\[[^\]]*\]|\{[^}]*\})*\s*$/;
const BEGIN_ENV = /^\s*\\begin\{([A-Za-z]+\*?)\}/;
const CROSSREF = /^(?:fig|tbl|eq|sec|lst|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem)-/i;
// Pandoc citekey: starts and ends with a word character, internal punctuation allowed.
const KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?`;
const PANELS = String.raw`(?:,[A-Za-z]\d*(?:-[A-Za-z]\d*)?)*`;
const BRACKET_CITE = /\[[^[\]]*@[^[\]]*\](?!\()/g;
const KEY_IN = new RegExp(String.raw`(^|[^\p{L}\p{N}_])-?@(${KEY})(${PANELS})`, "gu");
const BARE_CITE = new RegExp(String.raw`(^|[\s(;"'“‘ ])(-?@(${KEY})(${PANELS}))`, "gu");

const spaces = (n: number) => " ".repeat(n);
const blank = (m: string) => spaces(m.length);

/** Mask inline markup in one line, preserving offsets (masked chars → spaces).
 *  `refs` receives the [from, to) of every cross-reference (worth two words). */
function maskInline(line: string, refs: [number, number][]): string {
  if (!SPECIAL.test(line)) return line;
  let s = line;
  // Code spans first: nothing inside them is markup.
  if (s.includes("`")) {
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") { out += s.slice(i, i + 2); i += 2; continue; }
      if (ch !== "`") { out += ch; i++; continue; }
      let end = i + 1;
      while (s[end] === "`") end++;
      const run = s.slice(i, end);
      let close = s.indexOf(run, end);
      while (close >= 0 && (s[close - 1] === "`" || s[close + run.length] === "`")) close = s.indexOf(run, close + run.length);
      if (close < 0) { out += run; i = end; continue; }
      out += spaces(close + run.length - i);
      i = close + run.length;
    }
    s = out;
  }
  if (s.includes("$")) {
    // Single-line display math `$$…$$` first; findInlineMath never opens on `$$`.
    s = s.replace(/\$\$(?:\\.|[^$])*\$\$/g, blank);
    for (const m of findInlineMath(s)) s = s.slice(0, m.from) + spaces(m.to - m.from) + s.slice(m.to);
  }
  if (s.includes("{")) {
    s = s.replace(/\{\{<[\s\S]*?>\}\}/g, blank); // shortcodes
  }
  if (s.includes("![")) s = s.replace(/!\[(?:\\.|[^\]])*\]\([^)]*\)(?:\{[^}]*\})?/g, blank); // inline images
  if (s.includes("](")) s = s.replace(/\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, (m) => "]" + spaces(m.length - 1)); // link targets
  if (s.includes("{")) s = s.replace(/\{(?:[#.=-]|[^{}]*=)[^{}]*\}/g, blank); // attribute blocks
  // Raw HTML tags (an autolink `<https://…>` is not a tag: it prints as one word).
  if (s.includes("<")) s = s.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, blank);
  if (s.includes("@")) {
    s = s.replace(BRACKET_CITE, (m, offset: number) => {
      // A bracket that cites ([@a; @b], [see @a, p. 3]) prints as a superscript
      // number: zero words — except its cross-references, which print text.
      if (!/(^|[^\p{L}\p{N}_])-?@[\p{L}\p{N}_]/u.test(m)) return m; // e.g. [a@b.c]
      for (const k of m.matchAll(KEY_IN)) {
        if (CROSSREF.test(k[2])) {
          const from = offset + k.index! + k[1].length;
          refs.push([from, offset + k.index! + k[0].length]);
        }
      }
      return blank(m);
    });
    s = s.replace(BARE_CITE, (m, lead: string, body: string, key: string, _p: string, offset: number) => {
      if (CROSSREF.test(key)) refs.push([offset + lead.length, offset + m.length]);
      return lead + blank(body);
    });
  }
  if (s.includes("^")) {
    s = s.replace(/\[\^[^\]]+\]:?/g, blank); // footnote refs / definitions
    s = s.replace(/\^[\d\s,–—-]+\^/g, blank); // literal superscript citations (^1,2^)
    s = s.replace(/\^\[/g, "  "); // inline footnote opener; its body is prose
  }
  // Block markers at the start of the line: quotes, bullets, ordered items, task boxes.
  s = s.replace(/^(\s*(?:>\s*)*)(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/, blank);
  return s;
}

/** Word spans of one masked line, relative offsets [s0, e0, s1, e1, …]. */
function lineSpans(masked: string, refs: [number, number][]): Int32Array {
  const out: number[] = [];
  let r = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    // Cross-references interleave in offset order (they were masked out);
    // "Fig. 2b" — the two printed words share the token's span.
    while (r < refs.length && refs[r][0] < m.index) { out.push(refs[r][0], refs[r][1], refs[r][0], refs[r][1]); r++; }
    if (wordy(m[0])) out.push(m.index, m.index + m[0].length);
  }
  for (; r < refs.length; r++) out.push(refs[r][0], refs[r][1], refs[r][0], refs[r][1]);
  return Int32Array.from(out);
}

function wordy(tok: string): boolean {
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    if (c > 127) return WORDY.test(tok.slice(i));
  }
  return false;
}

// Memo of line → word spans, one map per kind. Edits touch a paragraph, so an
// idle re-analysis re-masks only the lines that changed. Bounded: cleared
// wholesale past the cap (a new document re-fills it in one pass).
const LINE_CACHE: Map<string, Int32Array>[] = [new Map(), new Map(), new Map(), new Map()];
const LINE_CACHE_MAX = 50_000;

function spansOf(line: string, kind: WordKind): Int32Array {
  const cache = LINE_CACHE[kind];
  let spans = cache.get(line);
  if (!spans) {
    const refs: [number, number][] = [];
    const masked = maskInline(line, refs);
    if (refs.length > 1) refs.sort((x, y) => x[0] - y[0]);
    spans = lineSpans(masked, refs);
    if (cache.size >= LINE_CACHE_MAX) cache.clear();
    cache.set(line, spans);
  }
  return spans;
}

function grow(a: WordAnalysis, need: number): void {
  let cap = a.starts.length;
  if (need <= cap) return;
  while (cap < need) cap = Math.max(1024, cap * 2);
  const s = new Int32Array(cap), e = new Int32Array(cap), k = new Uint8Array(cap);
  s.set(a.starts.subarray(0, a.n));
  e.set(a.ends.subarray(0, a.n));
  k.set(a.kinds.subarray(0, a.n));
  a.starts = s;
  a.ends = e;
  a.kinds = k;
}

function countLine(a: WordAnalysis, line: string, base: number, kind: WordKind): void {
  const spans = spansOf(line, kind);
  if (!spans.length) return;
  grow(a, a.n + spans.length / 2);
  for (let i = 0; i < spans.length; i += 2) {
    a.starts[a.n] = base + spans[i];
    a.ends[a.n] = base + spans[i + 1];
    a.kinds[a.n] = kind;
    a.n++;
  }
}

/** Words in a front-matter `abstract:` (plain or block scalar), or null. */
function frontMatterAbstract(fmText: string): number | null {
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^abstract:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let text = m[1].trim();
    if (/^[|>][+-]?\d*$/.test(text) || text === "") {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || lines[j] === ""); j++) body.push(lines[j]);
      text = body.join("\n");
    } else {
      const q = /^(["'])([\s\S]*)\1$/.exec(text);
      if (q) text = q[2];
    }
    return proseWords(text);
  }
  return null;
}

/**
 * Analyse a manuscript (or any fragment): every countable word with its kind
 * and offsets, the headings, and the figure-model legends of empty-alt embeds.
 * O(document), single pass; run it on idle, never per keystroke.
 */
export function analyzeWords(src: string, opts: AnalyzeOptions = {}): WordAnalysis {
  const fm = frontMatterBounds(src);
  const a: WordAnalysis = {
    length: src.length,
    bodyStart: fm.has ? fm.bodyStart : 0,
    n: 0,
    starts: new Int32Array(0),
    ends: new Int32Array(0),
    kinds: new Uint8Array(0),
    headings: [],
    external: [],
    legendItems: [],
    fmAbstract: fm.has ? frontMatterAbstract(fm.fmText) : null,
  };
  let fenceCh = "", fenceLen = 0;
  let mathEnd = "";
  let inComment = false;
  let inTable = false;
  const divs: boolean[] = []; // true = a figure/table div (its content is legend)
  let pos = a.bodyStart;
  const n = src.length;
  while (pos <= n) {
    let nl = src.indexOf("\n", pos);
    if (nl < 0) nl = n;
    let line = src.slice(pos, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const base = pos;
    pos = nl + 1;
    if (fenceCh) {
      const f = FENCE.exec(line);
      if (f && f[1][0] === fenceCh && f[1].length >= fenceLen && !line.slice(f[0].length).trim()) fenceCh = "";
      continue;
    }
    if (mathEnd) {
      if (line.includes(mathEnd)) mathEnd = "";
      continue;
    }
    // HTML comments may open and close anywhere, across lines: blank them first.
    if (inComment || line.includes("<!--")) {
      let out = "";
      let i = 0;
      while (i < line.length) {
        if (inComment) {
          const close = line.indexOf("-->", i);
          if (close < 0) { out += spaces(line.length - i); i = line.length; break; }
          out += spaces(close + 3 - i);
          i = close + 3;
          inComment = false;
        } else {
          const open = line.indexOf("<!--", i);
          if (open < 0) { out += line.slice(i); break; }
          out += line.slice(i, open);
          i = open;
          inComment = true;
        }
      }
      line = out;
      if (!line.trim()) continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { inTable = false; continue; }
    const kind: WordKind = divs.length && divs[divs.length - 1] ? WORD_LEGEND : WORD_PROSE;

    if (inTable) {
      countLine(a, line.replace(/(^|[^\\])\|/g, (m, pre: string) => pre + " "), base, WORD_TABLE);
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) { fenceCh = fence[1][0]; fenceLen = fence[1].length; continue; }
    if (trimmed.startsWith("$$")) {
      if (!trimmed.slice(2).includes("$$")) mathEnd = "$$";
      continue;
    }
    if (trimmed.startsWith("\\[")) {
      if (!trimmed.includes("\\]")) mathEnd = "\\]";
      continue;
    }
    const env = BEGIN_ENV.exec(line);
    if (env) {
      if (!line.includes(`\\end{${env[1]}}`)) mathEnd = `\\end{${env[1]}}`;
      continue;
    }
    if (LATEX_LINE.test(line)) continue;
    if (/^\s*:::/.test(line)) {
      const rest = trimmed.replace(/^:+/, "").trim();
      if (rest) divs.push(/#(?:fig|tbl)-/.test(rest));
      else divs.pop();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const text = (h[2] ?? "").replace(/[ \t]+#+$/, "");
      a.headings.push({ from: base, lineEnd: Math.min(nl + 1, n), level: h[1].length, text });
      const at = line.indexOf(text, h[1].length);
      if (text) countLine(a, text, base + (at < 0 ? h[1].length + 1 : at), WORD_HEADING);
      continue;
    }
    if (/^:\s/.test(line) && /\{#tbl-/.test(line)) {
      const before = a.n;
      countLine(a, " " + line.slice(1), base, WORD_LEGEND);
      a.legendItems.push({ at: base, label: /#(tbl-[A-Za-z0-9_-]+)/.exec(line)?.[1] ?? "", words: a.n - before });
      continue;
    }
    const img = IMAGE_LINE.exec(line);
    if (img) {
      const alt = img[2];
      const label = /#((?:fig|slide)-[A-Za-z0-9_-]+)/.exec(img[4] ?? "")?.[1] ?? "";
      if (alt.trim()) {
        const before = a.n;
        countLine(a, alt, base + img[1].length, WORD_LEGEND);
        a.legendItems.push({ at: base, label, words: a.n - before });
      } else if (opts.legendFor && label) {
        const caption = opts.legendFor(label);
        if (caption) {
          const item = { at: base, label, words: proseWords(caption) };
          a.external.push(item);
          a.legendItems.push(item);
        }
      }
      continue;
    }
    if (line.includes("|") && pos <= n) {
      let nextEnd = src.indexOf("\n", pos);
      if (nextEnd < 0) nextEnd = n;
      const next = src.slice(pos, nextEnd);
      if (next.includes("-") && next.includes("|") && DELIM.test(next)) {
        countLine(a, line.replace(/(^|[^\\])\|/g, (m, pre: string) => pre + " "), base, WORD_TABLE);
        pos = nextEnd + 1; // the delimiter row is pure markup
        inTable = true;
        continue;
      }
    }
    countLine(a, line, base, kind);
  }
  return a;
}

/** Index of the first word whose end is > pos. */
function firstEndingAfter(a: WordAnalysis, pos: number): number {
  let lo = 0, hi = a.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a.ends[mid] > pos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index of the first word whose start is >= pos. */
function firstStartingAt(a: WordAnalysis, pos: number): number {
  let lo = 0, hi = a.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a.starts[mid] >= pos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface KindCounts {
  prose: number;
  legend: number;
  table: number;
  heading: number;
}

/** Words of each kind STARTING in [from, to) — the section arithmetic (a word
 *  belongs to exactly one section, so section counts sum to the whole). */
export function countKinds(a: WordAnalysis, from: number, to: number): KindCounts {
  const out: KindCounts = { prose: 0, legend: 0, table: 0, heading: 0 };
  const end = firstStartingAt(a, to);
  for (let i = firstStartingAt(a, from); i < end; i++) {
    const k = a.kinds[i] as WordKind;
    if (k === WORD_PROSE) out.prose++;
    else if (k === WORD_LEGEND) out.legend++;
    else if (k === WORD_TABLE) out.table++;
    else out.heading++;
  }
  return out;
}

/** Figure-model legend words for embeds whose line starts in [from, to). */
export function externalLegendWords(a: WordAnalysis, from: number, to: number): number {
  let n = 0;
  for (const e of a.external) if (e.at >= from && e.at < to) n += e.words;
  return n;
}

/**
 * Words a selection [from, to) touches — every kind (a selected heading or
 * table cell is words the writer selected), a partly selected word counting
 * once, as in a word processor. O(log n + words in range).
 */
export function countRange(a: WordAnalysis, from: number, to: number): number {
  if (to <= from) return 0;
  const lo = firstEndingAfter(a, from);
  const hi = firstStartingAt(a, to);
  return Math.max(0, hi - lo);
}

/** Prose words of a fragment (a section body, an abstract, a caption) — the
 *  unit every journal limit is written in. */
export function proseWords(text: string): number {
  if (!text) return 0;
  const a = analyzeWords(text);
  let n = 0;
  for (let i = 0; i < a.n; i++) if (a.kinds[i] === WORD_PROSE) n++;
  return n;
}
