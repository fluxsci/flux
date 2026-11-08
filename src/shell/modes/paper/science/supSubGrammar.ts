// ---------------------------------------------------------------------------
// Superscript `^…^` and subscript `~…~` — THE grammar (2026-11-08).
//
// Pandoc's `superscript` / `subscript` extensions (on by default, so Quarto's
// Word/PDF exports already print `CO~2~`, `Ca^2+^`, `10^-3^`): a single marker,
// at least one character, no unescaped whitespace (`\ ` is an escaped space),
// never a doubled marker (`~~strike~~`, `^^`), and `^[` opens an inline
// footnote, not a superscript. The editor parses with @lezer/markdown's
// `Superscript` / `Subscript` (the same rule); every OTHER surface — the
// markdown-it Preview/house HTML (`markdownItSupSub`), widget captions and
// table cells (`mdInline`), the spelling protection (`supSubWordRanges`) — reads
// this one module, and `verify-paper-supsub.ts` pins all of them against Lezer
// and against Pandoc's own output for a corpus.
//
// Pure: no DOM, no markdown-it import (the plugin receives the instance).
// ---------------------------------------------------------------------------

export type SupSubKind = "sup" | "sub";

export interface SupSubSpan {
  kind: SupSubKind;
  /** Offset of the opening marker. */
  from: number;
  /** Offset just past the closing marker. */
  to: number;
  /** The raw text between the markers (escapes kept). */
  inner: string;
}

/** One regex for both, used with the `g` flag. Group 1 = sup inner, 2 = sub inner. */
export const SUP_SUB_SOURCE = String.raw`(?<!\\)\^(?![\^\[])((?:\\.|[^\s\^\\])+)\^|(?<![\\~])~(?!~)((?:\\.|[^\s~\\])+)~(?!~)`;

export function supSubRe(): RegExp {
  return new RegExp(SUP_SUB_SOURCE, "g");
}

/** Every sup/sub span on a line or block of plain inline text. */
export function findSupSub(text: string): SupSubSpan[] {
  if (!text.includes("^") && !text.includes("~")) return [];
  const out: SupSubSpan[] = [];
  for (const m of text.matchAll(supSubRe())) {
    const from = m.index ?? 0;
    out.push({ kind: m[1] !== undefined ? "sup" : "sub", from, to: from + m[0].length, inner: m[1] ?? m[2] });
  }
  return out;
}

const UNESCAPE_RE = /\\([ \\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g;

/** The printed text of a span's inner source. An escaped space is Pandoc's
 *  non-breaking space (`a\ b` → `a\u00a0b`), exactly what the exports print. */
export function unescapeSupSub(inner: string): string {
  return inner.replace(UNESCAPE_RE, (_m, c: string) => (c === " " ? "\u00a0" : c));
}

/** Source text for wrapping `text` in a marker: Pandoc allows no bare
 *  whitespace inside, so spaces are escaped (`10 ms` → `10\ ms`). */
export function escapeForSupSub(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/ /g, "\\ ").replace(/[\^~]/g, (c) => `\\${c}`);
}

/** Ranges spelling must never judge: each sup/sub span widened over the word
 *  it is attached to (`H~2~O`, `Ca^2+^`, `µm^2^`), so a checker that splits on
 *  the markers never sees `H`, `O` or `Ca` as words of their own. */
export function supSubWordRanges(text: string): Array<[number, number]> {
  const spans = findSupSub(text);
  if (!spans.length) return [];
  const word = /[\p{L}\p{M}\p{N}]/u;
  const out: Array<[number, number]> = [];
  for (const s of spans) {
    let a = s.from, b = s.to;
    while (a > 0 && word.test(text[a - 1])) a--;
    while (b < text.length && word.test(text[b])) b++;
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** markdown-it plugin: `^x^` → `<sup>`, `~x~` → `<sub>`. Runs before the
 *  built-in strikethrough so `~~` stays strikethrough; `^[` is left to the
 *  footnote plugin's inline notes. */
export function markdownItSupSub(md: any): void {
  const rule = (marker: number, tag: SupSubKind) => (state: any, silent: boolean): boolean => {
    const max: number = state.posMax;
    const start: number = state.pos;
    if (state.src.charCodeAt(start) !== marker || silent || start + 2 >= max) return false;
    const next = state.src.charCodeAt(start + 1);
    if (next === marker || (marker === 0x5e && next === 0x5b)) return false;
    if (marker === 0x7e && start > 0 && state.src.charCodeAt(start - 1) === marker) return false;
    state.pos = start + 1;
    let found = false;
    while (state.pos < max) {
      if (state.src.charCodeAt(state.pos) === marker) {
        found = true;
        break;
      }
      state.md.inline.skipToken(state);
    }
    const end: number = state.pos;
    const content: string = state.src.slice(start + 1, end);
    const doubledClose = marker === 0x7e && state.src.charCodeAt(end + 1) === marker;
    if (!found || !content || /(^|[^\\])(\\\\)*\s/.test(content) || doubledClose) {
      state.pos = start;
      return false;
    }
    const ch = String.fromCharCode(marker);
    const open = state.push(`${tag}_open`, tag, 1);
    open.markup = ch;
    const text = state.push("text", "", 0);
    text.content = unescapeSupSub(content);
    const close = state.push(`${tag}_close`, tag, -1);
    close.markup = ch;
    state.pos = end + 1;
    return true;
  };
  md.inline.ruler.before("strikethrough", "flux_sup", rule(0x5e, "sup"));
  md.inline.ruler.before("strikethrough", "flux_sub", rule(0x7e, "sub"));
}
