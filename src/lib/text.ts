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
//   visualLineInfo(el) — those lines PLUS which of them end a paragraph (the
//                        justification rule: a paragraph's last line is never
//                        stretched). Derived from the text itself, so nothing
//                        new is persisted.
//   blockLayout(el)    — the complete arrangement of the block inside the box:
//                        anchor x, first baseline y, per-line dy (line height
//                        + paragraph spacing) and the justified lines' target
//                        width. Element.svelte, export.ts (and through it the
//                        slide player) and the Canvas textarea all read it.
// ---------------------------------------------------------------------------

import type { Element, Id, Project, TextElement } from "./types";

// Default line height as a multiple of fontSize; overridable per element.
export const LINE_HEIGHT = 1.2;

/** One line's advance in canvas px for this element. */
export function lineH(e: TextElement): number {
  return e.fontSize * (e.lineHeight ?? LINE_HEIGHT);
}

/** Extra advance in canvas px before each new paragraph (0 when unset). */
export function paragraphGap(e: TextElement): number {
  const v = e.paragraphSpacing;
  return Number.isFinite(v) ? (v as number) : 0;
}

/** Tracking in canvas px (0 when unset). May be negative. */
export function letterSpacing(e: TextElement): number {
  const v = e.letterSpacing;
  return Number.isFinite(v) ? (v as number) : 0;
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
 *  `spacing` is the element's tracking in canvas px — it is part of the METRIC,
 *  so wrapping must measure with it or a tracked line wraps at the wrong word.
 *  Chromium's `CanvasRenderingContext2D.letterSpacing` matches the SVG
 *  `letter-spacing` the renderers emit (space after every glyph); a runtime
 *  without it falls back to the untracked advance.
 *  Browser only — headless callers inject their own measure into wrapText. */
export function browserMeasure(font: string, spacing = 0): (s: string) => number {
  const c = context();
  const track = Number.isFinite(spacing) ? spacing : 0;
  return (s: string) => {
    c.font = font; // re-set every call: the ctx is shared across elements
    if ("letterSpacing" in c) (c as { letterSpacing: string }).letterSpacing = `${track}px`;
    return c.measureText(s).width;
  };
}

/** The measure function for an element (font shorthand + its tracking). */
export function elementMeasure(e: TextElement): (s: string) => number {
  return browserMeasure(fontString(e), letterSpacing(e));
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
 *  (ceiled + 2px caret slack) × the block height (line height per line plus
 *  the paragraph gaps between them). Browser only. */
export function measureText(e: TextElement): { width: number; height: number } {
  const m = elementMeasure(e);
  const lines = (e.text || " ").split("\n");
  let w = 0;
  for (const ln of lines) w = Math.max(w, m(ln || " "));
  return { width: Math.ceil(w) + 2, height: Math.ceil(blockHeight(e, lines.length, lines.length - 1)) };
}

/** The block's height: one line height per visual line plus one paragraph gap
 *  per paragraph BREAK. The single source for hugging and vertical alignment. */
function blockHeight(e: TextElement, lineCount: number, breaks: number): number {
  return lineCount * lineH(e) + Math.max(0, breaks) * paragraphGap(e);
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
  const lines = wrapText(el.text, Math.max(1, el.width), elementMeasure(el));
  el.lines = lines;
  delete el.needsLayout; // WS-12: measured — layout-honest again
  if (el.sizing === "auto-h")
    el.height = Math.ceil(blockHeight(el, lines.length, paragraphBreaks(el, lines)));
}

/** The lines a renderer draws: the wrap cache when present, else the text's
 *  own hard lines. The headless seam — flux-core can't measure fonts, so its
 *  exports render whatever the GUI last computed (or unwrapped text). */
export function visualLines(e: TextElement): string[] {
  return e.lines && e.lines.length ? e.lines : e.text.split("\n");
}

export interface VisualLine {
  text: string;
  /** This line ends a PARAGRAPH (a hard "\n" break, or the text's end) — the
   *  line justification must not stretch, and the line paragraph spacing is
   *  added after. */
  paragraphEnd: boolean;
}

const inkOf = (s: string) => s.replace(/\s+/g, "");

/** Which visual lines end a PARAGRAPH, as one flag per line. DERIVED, never
 *  stored: wrapping only ever DROPS whitespace at a break point (wrapLine), so
 *  the ink of a hard line's visual lines reconstructs the hard line's own ink
 *  exactly — which is what maps the flat `lines` cache back onto paragraphs.
 *  Any mismatch (a stale cache from an aborted headless edit) degrades to
 *  "every line ends a paragraph", i.e. nothing is justified — never to a wrong
 *  stretch.
 *
 *  The two fast paths carry the dense canvas: a one-line text (every panel
 *  label) and a single-paragraph text answer without touching the ink at all —
 *  with one hard line only the last visual line can close it, whatever the
 *  cache holds. Pure. */
function paragraphEndFlags(e: TextElement, vis: string[]): boolean[] {
  const n = vis.length;
  if (n <= 1) return [true];
  const hard = e.text.split("\n");
  const flags = new Array<boolean>(n).fill(false);
  if (hard.length <= 1) {
    flags[n - 1] = true;
    return flags;
  }
  const allEnds = () => new Array<boolean>(n).fill(true);
  let i = 0;
  for (const h of hard) {
    const want = inkOf(h);
    let acc = "";
    while (i < n) {
      acc += inkOf(vis[i]);
      i++;
      if (acc === want) break;
      if (acc.length >= want.length) return allEnds(); // diverged — bail safe
    }
    if (acc !== want) return allEnds(); // ran out of visual lines
    flags[i - 1] = true;
  }
  return i === n ? flags : allEnds(); // leftover lines — bail safe
}

/** The visual lines paired with their paragraph boundaries — the readable view
 *  of `paragraphEndFlags` (blockLayout consumes the flags directly). Pure. */
export function visualLineInfo(e: TextElement): VisualLine[] {
  const vis = visualLines(e);
  const ends = paragraphEndFlags(e, vis);
  return vis.map((text, i) => ({ text, paragraphEnd: ends[i] }));
}

/** How many paragraph BREAKS the block contains (gaps to add to its height). */
function paragraphBreaks(e: TextElement, lines: string[]): number {
  const ends = paragraphEndFlags({ ...e, lines } as TextElement, lines);
  let n = 0;
  for (let k = 0; k < ends.length - 1; k++) if (ends[k]) n++;
  return n;
}

export interface LaidOutLine extends VisualLine {
  /** SVG tspan `dy` — 0 for the first line, else the line advance plus the
   *  paragraph gap when the PREVIOUS line closed a paragraph. */
  dy: number;
  /** Set on justified lines only: the width the renderer stretches them to
   *  (SVG textLength + lengthAdjust="spacing"; CSS text-align: justify). */
  justifyWidth?: number;
}

export interface TextBlockLayout {
  lines: LaidOutLine[];
  /** The x every line is anchored at, paired with `anchor`. */
  x: number;
  anchor: "start" | "middle" | "end";
  /** Baseline of the FIRST line (the `<text>` y attribute). */
  baselineY: number;
  /** Height of the whole block (line heights + paragraph gaps). */
  height: number;
  /** How far the block sits below the box top — the vertical alignment. */
  offsetY: number;
}

/** The complete arrangement of a text element's lines inside its box. ONE
 *  source for the canvas painter, the SVG serializer (and through it the slide
 *  player and every headless render) and the inline editor overlay. Pure. */
export function blockLayout(e: TextElement): TextBlockLayout {
  // ONE pass over the visual lines. This runs per text per canvas render on a
  // scene that can hold hundreds of labels, so it allocates exactly one array
  // of one object per line and nothing else.
  const vis = visualLines(e);
  const ends = paragraphEndFlags(e, vis);
  const advance = lineH(e);
  const gap = paragraphGap(e);
  const justified = e.align === "justify";
  const justifyWidth = justified ? Math.max(1, e.width) : 0;
  const lines: LaidOutLine[] = new Array(vis.length);
  let breaks = 0;
  for (let k = 0; k < vis.length; k++) {
    const paragraphEnd = ends[k];
    const line: LaidOutLine = {
      text: vis[k],
      paragraphEnd,
      dy: k === 0 ? 0 : advance + (ends[k - 1] ? gap : 0),
    };
    // A paragraph's last line keeps its natural width (the typographic rule),
    // and a single glyph has no gaps to distribute into.
    if (justified && !paragraphEnd && inkOf(vis[k]).length > 1) line.justifyWidth = justifyWidth;
    lines[k] = line;
    if (paragraphEnd && k < vis.length - 1) breaks++;
  }
  const height = blockHeight(e, vis.length, breaks);
  // Not clamped: a block taller than a fixed box overflows symmetrically when
  // centred, exactly as CSS centring does (text elements render unclipped).
  const offsetY = e.valign === "middle" ? (e.height - height) / 2 : e.valign === "bottom" ? e.height - height : 0;
  const anchor = e.align === "center" ? "middle" : e.align === "right" ? "end" : "start";
  const x = e.align === "center" ? e.x + e.width / 2 : e.align === "right" ? e.x + e.width : e.x;
  // The first baseline keeps the historical fontSize drop below the box top,
  // so a "top"-aligned element renders byte-identically to pre-arrangement Flux.
  return { lines, x, anchor, baselineY: e.y + offsetY + e.fontSize, height, offsetY };
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
