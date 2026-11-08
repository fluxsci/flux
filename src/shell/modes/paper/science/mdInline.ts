// Minimal synchronous inline-markdown → DOM for widget captions and table
// cells: bold, italic, inline code, backslash escapes, Pandoc superscript
// `^…^` / subscript `~…~` (as <sup>/<sub>) — plus, opt-in, inline
// `$…$` math (lazy KaTeX via katexLoader — pending shows the raw TeX) and
// RESOLVED cross-ref/citation tokens ("Fig. 2", "(Smith et al., 2021)") so a
// table cell shows what the export prints. The full markdown-it pipeline is
// deliberately dynamic-imported off the editor hot path
// (render/renderManuscript.ts); widgets need this tiny subset, built as real
// DOM nodes (innerHTML only for KaTeX output, the math.ts precedent).
// Bold maps to <strong> so `.flux-embed-cap b { … }` keeps styling ONLY the
// "Figure N." prefix the widget builds itself.
//
// Resolution runs BEFORE formatting (the export's transformProse order):
// citation keys may contain `_`/`*`, which the emphasis pass would otherwise
// tear apart. The cosmetic cost — emphasis markers spanning a resolved token
// don't bold it — matches how rarely that occurs inside table cells.

import { findInlineMath } from "./mathGrammar";
import { renderTexCached, katexReady } from "./katexLoader";
import { bracketCiteRe, crossrefRe, bareCiteRe, isCrossrefKey } from "./grammar";
import { SUP_SUB_SOURCE, unescapeSupSub } from "./supSubGrammar";

// `|` joins the escape set: inside table cells `\|` is a literal pipe
// (markdown-it's escapedSplit consumes it before inline rules ever run, and
// prose backslash-escapes cover it too). `^`/`~` join it for the Pandoc
// superscript/subscript spans (groups 7/8 — the shared supSubGrammar source).
const BASE_INLINE_RE = /(\*\*|__)(.+?)\1|([*_])([^*_]+?)\3|`([^`]+)`|\\([\\`*_[\]()|^~])/;
const INLINE_RE = new RegExp(`${BASE_INLINE_RE.source}|${SUP_SUB_SOURCE}`, "g");

export interface InlineResolvers {
  /** Render `$…$` spans via KaTeX (raw TeX styled pending until it loads). */
  math?: boolean;
  /** `@fig-x`/`@tbl-x`/`@eq-x` label (without `@`) → display text, null = leave raw. */
  resolveRef?: (label: string) => string | null;
  /** Citation key group (bracketed or bare) → display text, null = leave raw. */
  resolveCite?: (keys: string[]) => string | null;
}

function fmtInto(frag: DocumentFragment | HTMLElement, src: string): void {
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) frag.appendChild(document.createTextNode(src.slice(last, i)));
    const internalUnderscore = (m[1]?.startsWith("_") || m[3] === "_") &&
      (/[\p{L}\p{N}]/u.test(src[i - 1] ?? "") || /[\p{L}\p{N}]/u.test(src[i + m[0].length] ?? ""));
    if (internalUnderscore) frag.appendChild(document.createTextNode(m[0]));
    else if (m[2] !== undefined) {
      const el = document.createElement("strong");
      fmtInto(el, m[2]);
      frag.appendChild(el);
    } else if (m[4] !== undefined) {
      const el = document.createElement("em");
      fmtInto(el, m[4]);
      frag.appendChild(el);
    } else if (m[5] !== undefined) {
      const el = document.createElement("code");
      el.textContent = m[5];
      frag.appendChild(el);
    } else if (m[7] !== undefined || m[8] !== undefined) {
      const el = document.createElement(m[7] !== undefined ? "sup" : "sub");
      el.textContent = unescapeSupSub(m[7] ?? m[8]);
      frag.appendChild(el);
    } else {
      frag.appendChild(document.createTextNode(m[6]));
    }
    last = i + m[0].length;
  }
  if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
}

const keysOf = (inner: string): string[] =>
  inner
    .split(";")
    .map((s) => s.trim().replace(/^@/, "").replace(/[,\s].*$/, "").trim())
    .filter(Boolean);

function tokenSpan(cls: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

/** Resolution pass for one plain-text segment: bracketed cites, then
 *  cross-refs, then bare cites (the transformProse order); the text between
 *  resolved tokens flows through the formatting pass. */
function resolveInto(frag: DocumentFragment, src: string, r: InlineResolvers): void {
  interface Piece {
    text: string;
    node?: Node;
  }
  let pieces: Piece[] = [{ text: src }];
  const pass = (re: RegExp, make: (m: RegExpExecArray) => Node | null, keepLead = 0) => {
    const next: Piece[] = [];
    for (const p of pieces) {
      if (p.node) {
        next.push(p);
        continue;
      }
      let last = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(p.text))) {
        const node = make(m);
        if (!node) continue;
        const lead = keepLead ? (m[1] ?? "") : "";
        const start = m.index + lead.length;
        if (start > last) next.push({ text: p.text.slice(last, start) });
        next.push({ text: p.text.slice(start, m.index + m[0].length), node });
        last = m.index + m[0].length;
      }
      if (last < p.text.length) next.push({ text: p.text.slice(last) });
    }
    pieces = next;
  };
  if (r.resolveCite) {
    pass(bracketCiteRe(), (m) => {
      const t = r.resolveCite!(keysOf(m[1]));
      return t ? tokenSpan("mdi-cite", t) : null;
    });
  }
  if (r.resolveRef) {
    pass(crossrefRe(), (m) => {
      const t = r.resolveRef!(m[0].slice(1));
      return t ? tokenSpan("mdi-ref", t) : null;
    });
  }
  if (r.resolveCite) {
    pass(
      bareCiteRe(),
      (m) => {
        if (isCrossrefKey(m[2])) return null;
        const t = r.resolveCite!([m[2]]);
        return t ? tokenSpan("mdi-cite", t) : null;
      },
      1, // group 1 is the boundary char before `@` — it stays as text
    );
  }
  for (const p of pieces) {
    if (p.node) frag.appendChild(p.node);
    else fmtInto(frag, p.text);
  }
}

export function mdInlineFragment(src: string, opts?: InlineResolvers): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!opts) {
    fmtInto(frag, src);
    return frag;
  }
  const spans = opts.math ? findInlineMath(src) : [];
  let at = 0;
  const seg = (text: string) => {
    if (!text) return;
    if (opts.resolveRef || opts.resolveCite) resolveInto(frag, text, opts);
    else fmtInto(frag, text);
  };
  for (const s of spans) {
    seg(src.slice(at, s.from));
    const el = document.createElement("span");
    el.className = "mdi-math";
    const html = renderTexCached(s.tex, false);
    if (html != null) el.innerHTML = html; // KaTeX output, the math.ts precedent
    else {
      el.classList.add("pending");
      el.textContent = s.tex;
    }
    frag.appendChild(el);
    at = s.to;
  }
  seg(src.slice(at));
  return frag;
}

/** Cheap render signature for widget eq()/updateDOM: changes exactly when
 *  mdInlineFragment(src, opts) would produce different DOM — resolution
 *  results and KaTeX readiness fold in, formatting doesn't (it's a pure
 *  function of the raw text). Fast-bails to `src` for plain cells. */
export function inlineSig(src: string, opts?: InlineResolvers): string {
  if (!opts || !/[$@[]/.test(src)) return src;
  let sig = src;
  if (opts.math && src.includes("$")) {
    const spans = findInlineMath(src);
    if (spans.length) sig += "\0M" + spans.map(span => renderTexCached(span.tex, false) == null ? "0" : "1").join("");
  }
  if (opts.resolveCite) {
    let m: RegExpExecArray | null;
    const br = bracketCiteRe();
    while ((m = br.exec(src))) sig += "\0C" + (opts.resolveCite(keysOf(m[1])) ?? "");
    const bare = bareCiteRe();
    while ((m = bare.exec(src)))
      if (!isCrossrefKey(m[2])) sig += "\0c" + (opts.resolveCite([m[2]]) ?? "");
  }
  if (opts.resolveRef) {
    const cr = crossrefRe();
    let m: RegExpExecArray | null;
    while ((m = cr.exec(src))) sig += "\0R" + (opts.resolveRef(m[0].slice(1)) ?? "");
  }
  return sig;
}
