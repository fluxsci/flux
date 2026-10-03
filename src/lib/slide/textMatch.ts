// ---------------------------------------------------------------------------
// Flux Slide — TEXT MATCHING for the glyph-matched text morph (oct2 W3 §3.1).
// Pure and DOM-free: the player, the static sampler and the gates all read it.
//
// The model is Keynote's Magic Move / PowerPoint's Morph "by word" (and manim's
// TransformMatchingStrings): text that both versions share GLIDES from where it
// sits in the old text to where it sits in the new one; everything else fades
// out (old) or in (new), staggered in reading order. Four passes, each only
// over what the previous ones left:
//   1. exact WORD (and punctuation) LCS, weighted by length so long words win;
//   2. the same LCS case- and accent-insensitively ("Light" ↔ "light");
//   3. numbers that differ only in their digits become a count-up glide;
//   4. CHARACTER blocks inside a leftover gap, only when the two gap strings are
//      "close" (similarity ≥ 0.4, both ≤ 60 chars) — a lone letter flying across
//      a rewrite reads as noise, a word stem gliding into its plural reads as magic.
// Runs are maximal spans that move as ONE unit; exits/enters are whole words.
// `planTextMorph` cuts runs at visual-line (and style-segment) boundaries,
// applies the span caps and returns the reading-ordered spans the driver draws;
// `textMorphTimeline` gives every span its window — ONE pure answer for the
// live player and any static reader.
// ---------------------------------------------------------------------------

import { numericTextTween } from "./tween";

export type TokenKind = "word" | "space" | "punct";
export interface TextToken { text: string; start: number; end: number; kind: TokenKind }
export interface TextRange { from: number; to: number }
/** exact: identical text · fold: equal ignoring case/accents (crossfades while it
 *  glides) · count: a number whose digits count up · char: a shared letter block. */
export type RunKind = "exact" | "fold" | "count" | "char";
export interface MatchRun { a: TextRange; b: TextRange; kind: RunKind }
export interface TextMatch {
  runs: MatchRun[];
  /** Old-only words, reading order. */
  exits: TextRange[];
  /** New-only words, reading order. */
  enters: TextRange[];
  /** Whether pass 4 ran on any gap, was refused by the closeness policy, or had nothing to do. */
  charLevel: "used" | "refused" | "none";
}

/** The policy thresholds, exported so the gate pins them (never tune silently). */
export const TEXT_MATCH_POLICY = Object.freeze({
  /** Pass 4 runs only on gap strings at least this similar (Ratcliff–Obershelp ratio). */
  charRatio: 0.4,
  /** …and only when both gap strings are at most this long. */
  charMaxLength: 60,
  /** A shared character block shorter than this never flies on its own. */
  minCharBlock: 2,
});

/** Caps that keep a long rewrite one calm motion (and the layer count bounded). */
export const TEXT_MORPH_CAPS = Object.freeze({
  /** Above this many spans, coarsen: drop char blocks, then fade per line. */
  maxSpans: 48,
  /** Above this many characters on either side, morph whole visual lines. */
  maxChars: 200,
});

// A word is letters/marks/digits with inner apostrophes; a number keeps its
// decimal point and thousands separators so "0.01" is one token, not three.
const TOKEN = /(\d+(?:[.,]\d+)*)|([\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*)|(\s+)|([^\s])/gu;

/** Split text into words, whitespace runs and single punctuation marks. Unicode-
 *  aware; attached punctuation is its own token, so "Light." still matches "Light". */
export function tokenize(text: string): TextToken[] {
  const out: TextToken[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index!;
    out.push({ text: m[0], start, end: start + m[0].length, kind: m[3] ? "space" : m[4] ? "punct" : "word" });
  }
  return out;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const isNumber = (s: string) => /^\d+(?:[.,]\d+)*$/.test(s);

/** Weighted LCS over two token lists under `key` equality (score = matched
 *  characters, so one long word outweighs two commas). Deterministic: ties keep
 *  the earliest A token. Returns index pairs in increasing order. */
function lcs(a: TextToken[], b: TextToken[], key: (t: TextToken) => string): [number, number][] {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  const ka = a.map(key), kb = b.map(key);
  // Long inputs are coarsened by the caller before they reach here; this bound
  // keeps a pathological call O(n·m) ≤ 250k cells.
  if (n * m > 250_000) {
    const out: [number, number][] = [];
    let j = 0;
    for (let i = 0; i < n && j < m; i++) { const k = kb.indexOf(ka[i], j); if (k >= 0) { out.push([i, k]); j = k + 1; } }
    return out;
  }
  const w = m + 1, score = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const here = ka[i] === kb[j] ? a[i].text.length + score[(i + 1) * w + j + 1] : 0;
    score[i * w + j] = Math.max(here, score[(i + 1) * w + j], score[i * w + j + 1]);
  }
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j] && score[i * w + j] === a[i].text.length + score[(i + 1) * w + j + 1]) { out.push([i, j]); i++; j++; }
    else if (score[(i + 1) * w + j] >= score[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/** Ratcliff–Obershelp matching blocks (difflib's SequenceMatcher idea): the
 *  longest common substring, then recursively left and right of it. Blocks
 *  shorter than `min` are discarded, which is what keeps lone letters home. */
function matchingBlocks(a: string, b: string, min: number): { a: number; b: number; len: number }[] {
  const out: { a: number; b: number; len: number }[] = [];
  const walk = (a0: number, a1: number, b0: number, b1: number) => {
    let best = { a: 0, b: 0, len: 0 };
    let prev = new Uint16Array(b1 - b0 + 1), cur = new Uint16Array(b1 - b0 + 1);
    for (let i = a0; i < a1; i++) {
      for (let j = b0; j < b1; j++) {
        const len = a[i] === b[j] ? prev[j - b0] + 1 : 0;
        cur[j - b0 + 1] = len;
        if (len > best.len) best = { a: i - len + 1, b: j - len + 1, len };
      }
      [prev, cur] = [cur, prev];
      cur.fill(0);
    }
    if (best.len < min || !a.slice(best.a, best.a + best.len).trim()) return;
    walk(a0, best.a, b0, best.b);
    out.push(best);
    walk(best.a + best.len, a1, best.b + best.len, b1);
  };
  walk(0, a.length, 0, b.length);
  return out;
}

/** The pass-4 closeness policy: similarity = 2·M / (|a|+|b|) over the matching
 *  blocks (≥ minCharBlock); allowed when ≥ charRatio and both ≤ charMaxLength. */
export function charLevelAllowed(a: string, b: string): { allowed: boolean; ratio: number } {
  const A = a.trim(), B = b.trim();
  if (!A || !B) return { allowed: false, ratio: 0 };
  if (A.length > TEXT_MATCH_POLICY.charMaxLength || B.length > TEXT_MATCH_POLICY.charMaxLength) return { allowed: false, ratio: 0 };
  const m = matchingBlocks(A, B, TEXT_MATCH_POLICY.minCharBlock).reduce((s, k) => s + k.len, 0);
  const ratio = (2 * m) / (A.length + B.length);
  return { allowed: ratio >= TEXT_MATCH_POLICY.charRatio, ratio };
}

interface Pair { i: number; j: number; kind: Exclude<RunKind, "char"> }

/** Match two texts: runs that glide, exits that fade out, enters that fade in.
 *  Pass order (each sees only what the earlier ones left):
 *   1. exact LCS — the in-order backbone ("anchors");
 *   2. case/accent-folded LCS inside each gap between anchors;
 *   3. REORDERS: a leftover word equal to a leftover word anywhere in the other
 *      text (exact, then folded), nearest in reading order first — Magic Move
 *      matches by content, not by position, so "Alpha beta gamma" → "Gamma beta
 *      alpha" glides all three;
 *   4. numbers differing only in digits inside a gap → a count-up glide;
 *   5. CHARACTER blocks between a leftover old word and a leftover new word
 *      when the two are close (charLevelAllowed): "Microscope" → "Microscopy",
 *      "quick" → "quickly", "text" → "Subtextual". */
export function matchTokens(a: string, b: string, opts: { charLevel?: boolean } = {}): TextMatch {
  const ta = tokenize(a).filter(t => t.kind !== "space"), tb = tokenize(b).filter(t => t.kind !== "space");
  const pairs: Pair[] = lcs(ta, tb, t => t.text).map(([i, j]) => ({ i, j, kind: "exact" }));
  const usedA = new Set(pairs.map(p => p.i)), usedB = new Set(pairs.map(p => p.j));
  const take = (p: Pair) => { pairs.push(p); usedA.add(p.i); usedB.add(p.j); };
  /** Gaps between the monotone anchors, as the unused token indices on each side. */
  const gaps = (): [number[], number[]][] => {
    const anchors = pairs.filter(p => p.kind === "exact" || p.kind === "fold").sort((x, y) => x.i - y.i);
    const out: [number[], number[]][] = [];
    let pi = -1, pj = -1;
    for (const anchor of [...anchors, { i: ta.length, j: tb.length }]) {
      const ga: number[] = [], gb: number[] = [];
      for (let i = pi + 1; i < anchor.i; i++) if (!usedA.has(i)) ga.push(i);
      for (let j = pj + 1; j < anchor.j; j++) if (!usedB.has(j)) gb.push(j);
      if (ga.length && gb.length) out.push([ga, gb]);
      pi = anchor.i; pj = anchor.j;
    }
    return out;
  };
  // 2 — folded LCS inside gaps.
  for (const [ga, gb] of gaps()) for (const [x, y] of lcs(ga.map(i => ta[i]), gb.map(j => tb[j]), t => fold(t.text))) take({ i: ga[x], j: gb[y], kind: "fold" });
  // 3 — reorders: whole WORDS only (a comma flying across a sentence is noise).
  for (const kind of ["exact", "fold"] as const) {
    const key = (t: TextToken) => kind === "exact" ? t.text : fold(t.text);
    const candidates: { i: number; j: number; d: number }[] = [];
    for (let i = 0; i < ta.length; i++) {
      if (usedA.has(i) || ta[i].kind !== "word") continue;
      for (let j = 0; j < tb.length; j++) if (!usedB.has(j) && tb[j].kind === "word" && key(ta[i]) === key(tb[j]))
        candidates.push({ i, j, d: Math.abs(i / Math.max(1, ta.length) - j / Math.max(1, tb.length)) });
    }
    candidates.sort((x, y) => x.d - y.d || x.i - y.i || x.j - y.j);
    for (const c of candidates) if (!usedA.has(c.i) && !usedB.has(c.j)) take({ i: c.i, j: c.j, kind: kind === "exact" && ta[c.i].text === tb[c.j].text ? "exact" : "fold" });
  }
  // 4 — numbers inside gaps, in order.
  for (const [ga, gb] of gaps()) {
    const na = ga.filter(i => isNumber(ta[i].text)), nb = gb.filter(j => isNumber(tb[j].text));
    for (let k = 0; k < Math.min(na.length, nb.length); k++) if (numericTextTween(ta[na[k]].text, tb[nb[k]].text)) take({ i: na[k], j: nb[k], kind: "count" });
  }
  pairs.sort((x, y) => x.i - y.i);

  // Merge consecutive same-kind pairs into maximal runs when they are adjacent
  // tokens on BOTH sides and the text between them is the same whitespace (so
  // "Learning rate" is ONE flight). Count runs never merge (their text changes).
  const runs: MatchRun[] = [];
  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k], prev = pairs[k - 1];
    const ra = { from: ta[p.i].start, to: ta[p.i].end }, rb = { from: tb[p.j].start, to: tb[p.j].end };
    const last = runs[runs.length - 1];
    if (last && prev && last.kind === p.kind && p.kind !== "count" && prev.i === p.i - 1 && prev.j === p.j - 1) {
      const gapA = a.slice(last.a.to, ra.from), gapB = b.slice(last.b.to, rb.from);
      if (gapA === gapB && !gapA.trim()) { last.a.to = ra.to; last.b.to = rb.to; continue; }
    }
    runs.push({ a: ra, b: rb, kind: p.kind });
  }

  // 5 — character blocks between close leftover words.
  let charLevel: TextMatch["charLevel"] = "none";
  if (opts.charLevel !== false) {
    const wa = leftovers(a, runs.map(r => r.a)), wb = leftovers(b, runs.map(r => r.b));
    const candidates: { x: number; y: number; ratio: number; d: number }[] = [];
    for (let x = 0; x < wa.length; x++) for (let y = 0; y < wb.length; y++) {
      const policy = charLevelAllowed(a.slice(wa[x].from, wa[x].to), b.slice(wb[y].from, wb[y].to));
      if (policy.allowed) candidates.push({ x, y, ratio: policy.ratio, d: Math.abs(x / wa.length - y / wb.length) });
      else if (policy.ratio > 0 && charLevel === "none") charLevel = "refused";
    }
    if (wa.length && wb.length && charLevel === "none") charLevel = "refused";
    candidates.sort((p, q) => q.ratio - p.ratio || p.d - q.d || p.x - q.x || p.y - q.y);
    const doneA = new Set<number>(), doneB = new Set<number>();
    for (const c of candidates) {
      if (doneA.has(c.x) || doneB.has(c.y)) continue;
      doneA.add(c.x); doneB.add(c.y); charLevel = "used";
      const A = a.slice(wa[c.x].from, wa[c.x].to), B = b.slice(wb[c.y].from, wb[c.y].to);
      for (const k of matchingBlocks(A, B, TEXT_MATCH_POLICY.minCharBlock))
        runs.push({ a: { from: wa[c.x].from + k.a, to: wa[c.x].from + k.a + k.len }, b: { from: wb[c.y].from + k.b, to: wb[c.y].from + k.b + k.len }, kind: "char" });
    }
  }
  runs.sort((x, y) => x.a.from - y.a.from);
  return { runs, exits: leftovers(a, runs.map(r => r.a)), enters: leftovers(b, runs.map(r => r.b)), charLevel };
}

/** The uncovered non-whitespace stretches of `text`, one per word. */
function leftovers(text: string, covered: TextRange[]): TextRange[] {
  const mask = new Uint8Array(text.length);
  for (const r of covered) mask.fill(1, r.from, r.to);
  const out: TextRange[] = [];
  let from = -1;
  for (let i = 0; i <= text.length; i++) {
    const free = i < text.length && !mask[i] && !/\s/.test(text[i]);
    if (free && from < 0) from = i;
    else if (!free && from >= 0) { out.push({ from, to: i }); from = -1; }
  }
  return out;
}

// --- the morph plan: spans the driver draws -----------------------------------

export interface TextMorphSpan {
  kind: "glide" | "exit" | "enter";
  /** Present on glides. */
  run?: RunKind;
  a?: TextRange;
  b?: TextRange;
  /** Reading-order rank within its kind (the stagger key). */
  order: number;
  /** A fade glued to a glide inside the SAME word ("quick|ly", "Microscop|e"):
   *  the index (in `spans`) of that glide; the fade rides with it. */
  with?: number;
}
export interface TextMorphPlan {
  spans: TextMorphSpan[];
  /** What granularity the caps settled on. */
  level: "char" | "word" | "line";
  /** Fading spans are single LETTERS (a reading-order wave) when they fit the
   *  span cap, else whole words/lines. */
  fadeUnit: "letter" | "word";
  match: TextMatch;
}

const inside = (cuts: number[], r: TextRange) => cuts.filter(c => c > r.from && c < r.to);

/** Split a range at cuts (each piece keeps only its non-whitespace extent). */
function cutRange(text: string, r: TextRange, cuts: number[]): TextRange[] {
  const out: TextRange[] = [];
  let from = r.from;
  for (const c of [...inside(cuts, r).sort((x, y) => x - y), r.to]) {
    const piece = text.slice(from, c), lead = piece.length - piece.trimStart().length, trail = piece.length - piece.trimEnd().length;
    if (piece.trim()) out.push({ from: from + lead, to: c - trail });
    from = c;
  }
  return out;
}

function lineOf(lines: TextRange[], at: number): number {
  for (let i = 0; i < lines.length; i++) if (at >= lines[i].from && at < Math.max(lines[i].to, lines[i].from + 1)) return i;
  return lines.length - 1;
}

/** Build the morph plan. `aLines`/`bLines` are each text's visual-line ranges
 *  (a span never crosses a line: it is one positioned glyph run); `aCuts`/`bCuts`
 *  are extra boundaries (style segments, justified word starts). */
export function planTextMorph(a: string, b: string, opts: { aLines: TextRange[]; bLines: TextRange[]; aCuts?: number[]; bCuts?: number[] }): TextMorphPlan {
  const aCuts = [...opts.aLines.map(l => l.from), ...opts.aLines.map(l => l.to), ...(opts.aCuts ?? [])];
  const bCuts = [...opts.bLines.map(l => l.from), ...opts.bLines.map(l => l.to), ...(opts.bCuts ?? [])];
  const build = (match: TextMatch, perLine: boolean): TextMorphSpan[] => {
    const spans: TextMorphSpan[] = [];
    for (const run of match.runs) {
      const ca = inside(aCuts, run.a), cb = inside(bCuts, run.b);
      if (!ca.length && !cb.length) { spans.push({ kind: "glide", run: run.kind, a: { ...run.a }, b: { ...run.b }, order: 0 }); continue; }
      // Equal-length runs split at the union of both sides' cuts, offset-aligned;
      // a count/fold run whose length differs cannot be split and fades instead.
      if (run.a.to - run.a.from !== run.b.to - run.b.from) {
        spans.push({ kind: "exit", a: { ...run.a }, order: 0 }, { kind: "enter", b: { ...run.b }, order: 0 });
        continue;
      }
      const rel = [...new Set([...ca.map(c => c - run.a.from), ...cb.map(c => c - run.b.from)])].sort((x, y) => x - y);
      for (const piece of cutRange(a, run.a, rel.map(r => run.a.from + r))) {
        const d = piece.from - run.a.from;
        spans.push({ kind: "glide", run: run.kind, a: piece, b: { from: run.b.from + d, to: run.b.from + d + piece.to - piece.from }, order: 0 });
      }
    }
    const lineGroups = (text: string, ranges: TextRange[], lines: TextRange[], cuts: number[]) => {
      if (!perLine) return ranges.flatMap(r => cutRange(text, r, cuts));
      const out: TextRange[] = [];
      for (const r of ranges.flatMap(r => cutRange(text, r, cuts))) {
        const last = out[out.length - 1];
        if (last && lineOf(lines, last.from) === lineOf(lines, r.from)) last.to = r.to; else out.push({ ...r });
      }
      return out;
    };
    for (const r of lineGroups(a, match.exits, opts.aLines, aCuts)) spans.push({ kind: "exit", a: r, order: 0 });
    for (const r of lineGroups(b, match.enters, opts.bLines, bCuts)) spans.push({ kind: "enter", b: r, order: 0 });
    return spans;
  };
  let level: TextMorphPlan["level"] = "char";
  let match: TextMatch;
  let spans: TextMorphSpan[];
  if (Math.max(a.length, b.length) > TEXT_MORPH_CAPS.maxChars) {
    level = "line";
    match = matchLines(a, b, opts.aLines, opts.bLines);
    spans = build(match, true);
  } else {
    match = matchTokens(a, b);
    spans = build(match, false);
    if (spans.length > TEXT_MORPH_CAPS.maxSpans && match.charLevel === "used") { level = "word"; match = matchTokens(a, b, { charLevel: false }); spans = build(match, false); }
    if (spans.length > TEXT_MORPH_CAPS.maxSpans) { level = "word"; spans = build(match, true); }
    if (spans.length > TEXT_MORPH_CAPS.maxSpans) { level = "line"; match = matchLines(a, b, opts.aLines, opts.bLines); spans = build(match, true); }
    if (level === "char" && match.charLevel !== "used") level = "word";
  }
  // Fades break into letters when they fit: a wave of letters dropping out and
  // rising in reads as one motion sweeping the line, where whole words just dissolve.
  let fadeUnit: TextMorphPlan["fadeUnit"] = "word";
  if (level !== "line") {
    const letters = (text: string, r: TextRange): TextRange[] => {
      const out: TextRange[] = [];
      for (let i = r.from; i < r.to;) {
        const cp = text.codePointAt(i)!, len = cp > 0xffff ? 2 : 1;
        // a combining mark stays with its base letter
        let end = i + len;
        while (end < r.to && /\p{M}/u.test(text[end])) end++;
        if (text.slice(i, end).trim()) out.push({ from: i, to: end });
        i = end;
      }
      return out;
    };
    const split = spans.flatMap(sp => sp.kind === "exit" ? letters(a, sp.a!).map(r => ({ kind: "exit" as const, a: r, order: 0 }))
      : sp.kind === "enter" ? letters(b, sp.b!).map(r => ({ kind: "enter" as const, b: r, order: 0 })) : [sp]);
    if (split.length <= TEXT_MORPH_CAPS.maxSpans && split.length > spans.length) { spans = split; fadeUnit = "letter"; }
  }
  // Reading order per kind: glides by their destination, exits by the old text,
  // enters by the new text — the order a reader's eye follows each.
  const rank = (kind: TextMorphSpan["kind"], key: (s: TextMorphSpan) => number) =>
    spans.filter(s => s.kind === kind).sort((x, y) => key(x) - key(y)).forEach((s, i) => { s.order = i; });
  rank("glide", s => s.b!.from); rank("exit", s => s.a!.from); rank("enter", s => s.b!.from);
  spans.sort((x, y) => (x.kind === y.kind ? x.order - y.order : ["glide", "exit", "enter"].indexOf(x.kind) - ["glide", "exit", "enter"].indexOf(y.kind)));
  // Glue fades to a glide in the same word on their own side: a suffix that
  // appears rides with its stem instead of waiting at the finish line.
  const word = (text: string, x: number, y: number) => x <= y ? !/\s/.test(text.slice(x, y)) : !/\s/.test(text.slice(y, x));
  spans.forEach((sp) => {
    if (sp.kind === "glide") return;
    const side = sp.kind === "exit" ? "a" : "b", text = side === "a" ? a : b, r = sp[side]!;
    let best = -1, gap = Infinity;
    spans.forEach((g, k) => {
      if (g.kind !== "glide") return;
      const gr = g[side]!;
      const d = gr.to <= r.from ? r.from - gr.to : r.to <= gr.from ? gr.from - r.to : 0;
      const joined = gr.to <= r.from ? word(text, gr.to, r.from) : word(text, r.to, gr.from);
      if (joined && d < gap) { gap = d; best = k; }
    });
    if (best >= 0) sp.with = best;
  });
  return { spans, level, fadeUnit, match };
}

/** Line-level matching for long texts: identical visual lines glide (LCS over
 *  lines), every other line fades as one unit. */
function matchLines(a: string, b: string, aLines: TextRange[], bLines: TextRange[]): TextMatch {
  const tok = (text: string, lines: TextRange[]): TextToken[] => lines.map(l => ({ text: text.slice(l.from, l.to).trim(), start: l.from, end: l.to, kind: "word" as const })).filter(t => t.text);
  const la = tok(a, aLines), lb = tok(b, bLines);
  const runs: MatchRun[] = lcs(la, lb, t => t.text).map(([i, j]) => {
    const trim = (t: TextToken, text: string) => { const s = text.slice(t.start, t.end); return { from: t.start + (s.length - s.trimStart().length), to: t.end - (s.length - s.trimEnd().length) }; };
    return { a: trim(la[i], a), b: trim(lb[j], b), kind: "exact" as const };
  });
  return { runs, exits: leftovers(a, runs.map(r => r.a)), enters: leftovers(b, runs.map(r => r.b)), charLevel: "none" };
}

// --- the timeline -----------------------------------------------------------------

export interface SpanWindow { start: number; end: number }
export interface TextMorphTimeline { glide: SpanWindow; exits: SpanWindow[]; enters: SpanWindow[] }

/** Word fades: the exit window ends by 55 % of the morph, the enter window
 *  starts at 40 %; the overlap is what keeps the text from ever looking empty.
 *  Letter fades are a wave: each letter's own window is short and the reading-
 *  order sweep is longer, so the line visibly turns over left to right. */
export const TEXT_MORPH_TIMING = Object.freeze({
  word: { exitEnd: 0.55, enterStart: 0.40, exitStagger: 0.12, enterStagger: 0.15 },
  letter: { exitEnd: 0.55, enterStart: 0.30, exitStagger: 0.25, enterStagger: 0.30 },
  /** One step of stagger is at most this long in real time, so a short morph
   *  of a few words stays one motion rather than a ripple. */
  stepMs: 45,
});

/** Per-span windows in morph progress (0..1): glides span the whole duration on
 *  the track's curve; exits fade out by 55 % and enters fade in to the end, each
 *  staggered by reading order (words ≤ 12 % / ≤ 15 % in total; letters ≤ 25 % /
 *  ≤ 30 %), every step at most `stepMs` of real time. */
export function textMorphTimeline(exitCount: number, enterCount: number, durationMs: number, unit: "word" | "letter" = "word"): TextMorphTimeline {
  const T = TEXT_MORPH_TIMING[unit];
  const step = (n: number, cap: number) => n > 1 ? Math.min(cap / (n - 1), durationMs > 0 ? TEXT_MORPH_TIMING.stepMs / durationMs : cap) : 0;
  const se = step(exitCount, T.exitStagger), sn = step(enterCount, T.enterStagger);
  const exitLen = T.exitEnd - se * Math.max(0, exitCount - 1);
  const enterLen = 1 - T.enterStart - sn * Math.max(0, enterCount - 1);
  return {
    glide: { start: 0, end: 1 },
    exits: Array.from({ length: exitCount }, (_, i) => ({ start: i * se, end: i * se + exitLen })),
    enters: Array.from({ length: enterCount }, (_, i) => ({ start: T.enterStart + i * sn, end: T.enterStart + i * sn + enterLen })),
  };
}

/** Progress through a window (clamped 0..1). */
export function windowProgress(w: SpanWindow, t: number): number {
  return w.end <= w.start ? (t >= w.end ? 1 : 0) : Math.max(0, Math.min(1, (t - w.start) / (w.end - w.start)));
}

/** The look of a fading span at its window progress p (pure; the coherence rules
 *  of §3.3: exits drift down 6 % of the font size and shrink to 0.92, enters rise
 *  from +8 % and grow from 0.96 — subtle, never bouncy). `dy` is in font sizes. */
export function fadeLook(kind: "exit" | "enter", p: number): { opacity: number; dy: number; scale: number } {
  return kind === "exit"
    ? { opacity: 1 - p, dy: 0.06 * p, scale: 1 - 0.08 * p }
    : { opacity: p, dy: 0.08 * (1 - p), scale: 0.96 + 0.04 * p };
}

/** Words that trade places along one line would slide THROUGH each other; a
 *  shallow arc lifts rightward movers and dips leftward ones (Magic Move's
 *  lanes), so crossing words stay readable. Zero at both ends, zero for short or
 *  mostly vertical moves; at most 0.3 of the font size. Pure, clamped progress. */
export function crossArc(dx: number, dy: number, size: number, t: number): number {
  if (Math.abs(dx) < size * 0.75 || Math.abs(dy) > Math.abs(dx)) return 0;
  const lift = Math.min(0.3 * size, 0.1 * Math.abs(dx));
  return -Math.sign(dx) * lift * 4 * t * (1 - t);
}
