// ---------------------------------------------------------------------------
// Text measurement + wrapping — the one source for how a TextElement's lines
// are produced. Element.svelte (canvas render), export.ts (SVG export, also
// used headless by flux-core) and the Canvas textarea editor must all agree:
//
//   fontString(el)     — the exact CSS font shorthand shared by measurement,
//                        the SVG attrs and the textarea (exact agreement).
//   wrapText(...)      — greedy word wrap with an injectable measure fn (pure,
//                        unit-testable): +0.5px tolerance, trailing whitespace
//                        never forces a break (CSS hanging-space rule), words
//                        longer than a line char-break via binary search,
//                        blank lines preserved.
//   applyTextLayout(el)— recompute the element's derived `lines` cache + hug
//                        its box per its sizing mode. HEADLESS-SAFE: without a
//                        DOM it deletes the cache (renderers fall back to the
//                        hard lines via visualLines) and never crashes.
//   visualLines(el)    — what to render: the wrap cache, else the hard lines.
// ---------------------------------------------------------------------------

import type { Element, Id, Project, TextElement } from "./types";

// Default line height as a multiple of fontSize; overridable per element.
export const LINE_HEIGHT = 1.2;

/** One line's advance in canvas px for this element. */
export function lineH(e: TextElement): number {
  return e.fontSize * (e.lineHeight ?? LINE_HEIGHT);
}

/** The CSS font shorthand for an element — canvas measure, SVG render and the
 *  textarea editor all derive from this so they can never disagree. */
export function fontString(e: TextElement): string {
  return `${e.fontStyle} ${e.fontWeight} ${e.fontSize}px ${e.fontFamily}`;
}

// Shared offscreen canvas for fast text measurement (browser only).
let ctx: CanvasRenderingContext2D | null = null;
function context(): CanvasRenderingContext2D {
  if (!ctx) {
    const c = document.createElement("canvas");
    ctx = c.getContext("2d")!;
  }
  return ctx;
}

/** A measure function (string → advance width in px) for a font shorthand.
 *  Browser only — headless callers inject their own measure into wrapText. */
export function browserMeasure(font: string): (s: string) => number {
  const c = context();
  return (s: string) => {
    c.font = font; // re-set every call: the ctx is shared across elements
    return c.measureText(s).width;
  };
}

// Can this environment actually measure text? `typeof document` alone is not
// enough: DOM shims (linkedom in the pure verify tier) define `document` but
// return no 2d canvas context — such environments must take the headless
// path, not crash in browserMeasure. Only a POSITIVE answer is cached: a
// capable DOM never goes away, while headless harnesses may inject one
// mid-process (verify-text-parity does).
let _canMeasure = false;
export function canMeasureText(): boolean {
  if (_canMeasure) return true;
  try {
    _canMeasure = typeof document !== "undefined" && !!document.createElement("canvas").getContext?.("2d");
  } catch {
    _canMeasure = false;
  }
  return _canMeasure;
}

// A hugged box may be re-wrapped at exactly its measured width — the tolerance
// absorbs float noise so content never spuriously wraps against itself.
export const WRAP_TOLERANCE = 0.5;

/** Wrap ONE hard line (no "\n") to maxW. Pure. */
export function wrapLine(line: string, maxW: number, measure: (s: string) => number): string[] {
  const fits = (s: string) => measure(s) <= maxW + WRAP_TOLERANCE;
  if (!line || fits(line)) return [line];
  const out: string[] = [];
  let cur = "";
  // Char-break `word` onto lines starting with the current prefix (empty or
  // line-leading whitespace): binary-search the longest fitting prefix, always
  // taking ≥1 char per line so the loop provably advances.
  const hardBreak = (word: string) => {
    let rest = word;
    while (rest && !fits(cur + rest)) {
      let lo = 1;
      let hi = rest.length - 1;
      let k = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(cur + rest.slice(0, mid))) {
          k = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      out.push(cur + rest.slice(0, k));
      cur = ""; // any leading indent applies to the first broken line only
      rest = rest.slice(k);
    }
    cur += rest;
  };
  for (const tok of line.match(/\s+|\S+/g) ?? []) {
    if (/\s/.test(tok[0])) {
      cur += tok; // trailing whitespace NEVER forces a break (it hangs)
      continue;
    }
    if (cur.trim() === "") {
      hardBreak(tok); // line-leading word — may itself be longer than the line
      continue;
    }
    if (fits(cur + tok)) {
      cur += tok;
      continue;
    }
    out.push(cur.replace(/\s+$/, "")); // wrap point: the break whitespace hangs
    cur = "";
    hardBreak(tok);
  }
  // A char-break that consumed the word exactly leaves cur = "" with its last
  // chunk already pushed — don't emit a phantom empty line after it.
  if (cur !== "" || out.length === 0) out.push(cur);
  return out;
}

/** Wrap full text (hard lines split on "\n", blank lines preserved). Pure. */
export function wrapText(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const hard of text.split("\n")) out.push(...wrapLine(hard, maxW, measure));
  return out;
}

/** Hugged (unwrapped) box size for a text element: the widest hard line
 *  (ceiled + 2px caret slack) × line count. Browser only. */
export function measureText(e: TextElement): { width: number; height: number } {
  const m = browserMeasure(fontString(e));
  const lines = (e.text || " ").split("\n");
  let w = 0;
  for (const ln of lines) w = Math.max(w, m(ln || " "));
  return { width: Math.ceil(w) + 2, height: Math.ceil(lines.length * lineH(e)) };
}

/** Recompute a text element's derived layout from its sizing mode:
 *    auto   — box hugs the text; no wrap cache (hard lines render directly)
 *    auto-h — wrap at el.width; height hugs the wrapped lines
 *    fixed  — wrap at el.width; box untouched (overflow renders unclipped)
 *  Headless (no `document`): deletes the stale cache and returns — flux-core
 *  edits stay correct (visualLines falls back), the GUI re-wraps on load. */
export function applyTextLayout(el: Element): void {
  if (el.type !== "text") return;
  if (!canMeasureText()) {
    delete el.lines;
    // WS-12: a wrapping element just lost its cache with no way to rebuild it
    // here — flag it so headless renders warn and the next GUI open re-wraps.
    if (el.sizing === "auto-h" || el.sizing === "fixed") el.needsLayout = true;
    return;
  }
  if (el.sizing === "auto" || !el.sizing) {
    delete el.lines; // hug: the visual lines ARE the hard lines
    delete el.needsLayout; // WS-12: measured — layout-honest again
    const m = measureText(el);
    el.width = m.width;
    el.height = m.height;
    return;
  }
  const lines = wrapText(el.text, Math.max(1, el.width), browserMeasure(fontString(el)));
  el.lines = lines;
  delete el.needsLayout; // WS-12: measured — layout-honest again
  if (el.sizing === "auto-h") el.height = Math.ceil(lines.length * lineH(el));
}

/** The lines a renderer draws: the wrap cache when present, else the text's
 *  own hard lines. The headless seam — flux-core can't measure fonts, so its
 *  exports render whatever the GUI last computed (or unwrapped text). */
export function visualLines(e: TextElement): string[] {
  return e.lines && e.lines.length ? e.lines : e.text.split("\n");
}

/** GUI seam: re-run applyTextLayout over the given elements. Call INSIDE a
 *  commit/mutate right after a headless-shaped patch lands (bridge set_style /
 *  toggle_text_style / paste-style / style apply) — ops stays DOM-free, the
 *  GUI reflows. No-op headless. */
export function reflowTexts(p: Project, ids: Id[]): void {
  if (typeof document === "undefined") return;
  const set = new Set(ids);
  for (const f of p.figures)
    for (const e of f.elements) if (set.has(e.id) && e.type === "text") applyTextLayout(e);
}
