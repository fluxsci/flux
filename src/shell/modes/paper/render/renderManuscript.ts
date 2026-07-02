// The shared manuscript renderer (Flux_Paper_Plan.md D1/D2): Quarto markdown →
// journal HTML, used by both the in-app Preview and the PDF/HTML exports so what
// you preview is what you ship. Front-matter via js-yaml; body via markdown-it
// (html:false, footnotes/attrs/deflists); figures inlined as self-contained SVG
// (figureToSvg); @fig/@tbl cross-refs and [@cite] citations resolved + linked; a
// References section built from the cited works. All heavy libs are dynamic-
// imported on first render to stay off the editor hot path.

import { resolveFigure, renderFigureSvg } from "../scholar/figures";
import { bibEntry, type BibEntry } from "../scholar/bib";
import { journalCss } from "./journal";
import { crossrefRe, bracketCiteRe, bareCiteRe, isCrossrefKey } from "../science/grammar";
import { EMBED_RE, parseEmbedAttrs, cssWidth } from "../science/figureAttrs";
import {
  buildCitationOrdinals,
  collapseOrdinals,
  parseCitationStyle,
  type CitationStyle,
} from "../scholar/citeNumbering";

/* eslint-disable @typescript-eslint/no-explicit-any */
let _md: any = null;
async function getMd(): Promise<any> {
  if (!_md) {
    const MarkdownIt = (await import("markdown-it")).default;
    const footnote = (await import("markdown-it-footnote")).default;
    const attrs = (await import("markdown-it-attrs")).default;
    const deflist = (await import("markdown-it-deflist")).default;
    const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
    md.use(footnote);
    md.use(attrs);
    md.use(deflist);
    // Keep smart quotes but NOT the (c)/(tm)/dash text replacements — they mangle
    // scientific sub-panel labels like "(a) (b) (c)" into ©, etc.
    md.disable("replacements");
    _md = md;
  }
  return _md;
}
let _yaml: any = null;
async function getYaml(): Promise<any> {
  if (!_yaml) _yaml = await import("js-yaml");
  return _yaml;
}

// One embed grammar with the editor (science/figureAttrs) — group 4 is the
// attr tail; width= is honored in the emitted HTML (and Quarto DOCX reads the
// .qmd attrs natively, so all exports agree).
const FIG_EMBED = EMBED_RE;
const TBL_CAPTION = /^\s*:\s+(.*?)\s*\{#(tbl-[A-Za-z0-9_-]+)\}\s*$/;
// PAP-19: grammar shared with the editor chips (science/grammar). PAP-14: only fig/tbl resolve to
// a number; @sec-/@eq- fall through to plain text but isCrossrefKey still lists sec|eq so they
// aren't mis-linked as citations either.
const CROSSREF = crossrefRe();
const BRACKET_CITE = bracketCiteRe();
const BARE_CITE = bareCiteRe();

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function refKindWord(prefix: string): string {
  return prefix === "tbl" ? "Table" : prefix === "sec" ? "Section" : prefix === "eq" ? "Eq." : "Figure";
}

/** Per-render citation context: the cited-key collector plus the numbering
 *  pass when the front matter selects the numeric style. */
interface CiteCtx {
  cited: Set<string>;
  style: CitationStyle;
  /** key → 1-based ordinal (numeric style only). */
  ordinals: Map<string, number>;
  /** ordinal → key (for linking collapsed segments to their first entry). */
  keyOf: Map<number, string>;
}

function makeCiteCtx(style: CitationStyle, body: string): CiteCtx {
  const cited = new Set<string>();
  if (style !== "numeric") return { cited, style, ordinals: new Map(), keyOf: new Map() };
  const { map } = buildCitationOrdinals(body, (k) => !!bibEntry(k));
  const keyOf = new Map<number, string>();
  for (const [k, n] of map) keyOf.set(n, k);
  return { cited, style, ordinals: map, keyOf };
}

/** Numeric in-text form for a key group: `[3,5,9–14]` (outer brackets literal,
 *  each segment linked to its first entry; unresolved keys → plain "?"). */
function numericGroup(keys: string[], ctx: CiteCtx): string {
  const nums: number[] = [];
  let unresolved = 0;
  for (const k of keys) {
    const n = ctx.ordinals.get(k);
    if (n === undefined) unresolved++;
    else {
      nums.push(n);
      ctx.cited.add(k);
    }
  }
  const parts = collapseOrdinals(nums).map(
    (s) => `[${s.text}](#ref-${ctx.keyOf.get(s.ordinals[0])})`,
  );
  for (let u = 0; u < unresolved; u++) parts.push("?");
  return `\\[${parts.join(",")}\\]`;
}

/** Replace cross-refs + citations on a line with markdown links; collect cites. PAP-13: never
 *  rewrite inside inline code — the editor's chips skip code spans, so transforming them here
 *  diverged Preview/export from what the author sees. Split on backtick runs and only
 *  transform the prose between them (the code span is emitted verbatim). */
function transformInline(line: string, ctx: CiteCtx): string {
  const CODE = /(`+)(?:.*?)\1/g; // n-backtick … n-backtick inline-code runs
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE.exec(line))) {
    out += transformProse(line.slice(last, m.index), ctx);
    out += m[0]; // code span, untouched
    last = m.index + m[0].length;
  }
  return out + transformProse(line.slice(last), ctx);
}

/** The actual cross-ref + citation substitution, applied only to non-code prose. */
function transformProse(line: string, ctx: CiteCtx): string {
  const { cited } = ctx;
  // [@a; @b] bracketed citations
  line = line.replace(BRACKET_CITE, (_full, inner: string) => {
    const keys = inner
      .split(";")
      .map((s) => s.trim().replace(/^@/, "").replace(/[,\s].*$/, "").trim())
      .filter(Boolean);
    if (!keys.length) return _full;
    if (ctx.style === "numeric") return numericGroup(keys, ctx);
    const parts: string[] = [];
    for (const k of keys) {
      const e = bibEntry(k);
      if (e) cited.add(k);
      const who = e ? authorYear(e) : k;
      parts.push(`[${who}](#ref-${k})`);
    }
    return "(" + parts.join("; ") + ")";
  });
  // @fig-x / @tbl-x cross-refs
  line = line.replace(CROSSREF, (full) => {
    const label = full.slice(1);
    const prefix = label.slice(0, label.indexOf("-"));
    const r = resolveFigure(label);
    const word = refKindWord(prefix);
    return r ? `[${word} ${r.number}](#${label})` : full;
  });
  // bare @key citations
  line = line.replace(BARE_CITE, (full, lead: string, key: string) => {
    if (isCrossrefKey(key)) return full;
    if (ctx.style === "numeric") return `${lead}${numericGroup([key], ctx)}`;
    const e = bibEntry(key);
    if (e) cited.add(key);
    const who = e ? authorYear(e) : key;
    return `${lead}[${who}](#ref-${key})`;
  });
  return line;
}

function authorYear(e: BibEntry): string {
  const a = e.authors;
  const who = !a.length ? e.key : a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} & ${a[1]}` : `${a[0]} et al.`;
  return e.year ? `${who}, ${e.year}` : who;
}

interface BlockSpec {
  token: string;
  html: string;
  body?: string; // inner markdown (callouts) rendered in the substitution pass
}

const CALLOUT_OPEN = /^:::+\s*\{?\s*\.callout-(\w+)/;
const CALLOUT_CLOSE = /^:::+\s*$/;

function preprocess(body: string, ctx: CiteCtx): { transformed: string; blocks: BlockSpec[] } {
  const lines = body.split("\n");
  const out: string[] = [];
  const blocks: BlockSpec[] = [];
  let inFence = false;
  let inCallout = false;
  let calloutType = "";
  let calloutLines: string[] = [];
  let tableCount = 0;
  let tok = 0;

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (inCallout) calloutLines.push(raw);
      else {
        inFence = !inFence;
        out.push(raw);
      }
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    // Quarto callouts ::: {.callout-note} … :::
    if (!inCallout) {
      const co = CALLOUT_OPEN.exec(raw);
      if (co) {
        inCallout = true;
        calloutType = co[1];
        calloutLines = [];
        continue;
      }
    } else {
      if (CALLOUT_CLOSE.test(raw)) {
        inCallout = false;
        const token = `FLUXBLOCK${tok++}X`;
        out.push("");
        out.push(token);
        out.push("");
        const label = calloutType.charAt(0).toUpperCase() + calloutType.slice(1);
        blocks.push({
          token,
          html: `<div class="callout callout-${esc(calloutType)}"><div class="callout-label">${esc(
            label,
          )}</div><div class="callout-body">__BODY__</div></div>`,
          body: calloutLines.map((l) => transformInline(l, ctx)).join("\n"),
        });
        continue;
      }
      calloutLines.push(raw);
      continue;
    }

    let m = FIG_EMBED.exec(raw);
    if (m) {
      const r = resolveFigure(m[3]);
      const svg = r?.ref.id ? renderFigureSvg(r.ref.id) : undefined;
      const num = r ? r.number : "?";
      const attrs = parseEmbedAttrs(m[4] ?? "");
      const sized = attrs.width ? ` style="width:${esc(cssWidth(attrs.width))}"` : "";
      const token = `FLUXBLOCK${tok++}X`;
      out.push("");
      out.push(token);
      out.push("");
      blocks.push({
        token,
        html: `<figure class="fig" id="${esc(m[3])}"><div class="art${attrs.width ? " sized" : ""}"${sized}>${
          svg ?? "<em>missing figure</em>"
        }</div><figcaption><b>Figure ${num}.</b> __CAP${capStash.length}__</figcaption></figure>`,
      });
      // PAP-6: index the placeholder by the CAPTION counter (capStash.length), not blocks.length.
      // Non-caption blocks (e.g. a callout) inflate blocks.length, so the old index pointed past
      // the stashed caption → an empty/wrong caption in Preview AND in the PDF/HTML export.
      capStash.push(m[1]);
      continue;
    }
    m = TBL_CAPTION.exec(raw);
    if (m) {
      tableCount++;
      const token = `FLUXBLOCK${tok++}X`;
      out.push("");
      out.push(token);
      out.push("");
      blocks.push({
        token,
        html: `<p class="cap" id="${esc(m[2])}"><b>Table ${tableCount}.</b> __CAP${capStash.length}__</p>`,
      });
      capStash.push(m[1]); // PAP-6: caption counter, not blocks.length (see the figure branch)
      continue;
    }
    out.push(transformInline(raw, ctx));
  }
  return { transformed: out.join("\n"), blocks };
}

// Caption markdown is collected during preprocess and inline-rendered after we
// have the markdown-it instance.
let capStash: string[] = [];

function bibliographyHtml(ctx: CiteCtx): string {
  // Numeric: ordered + numbered by first appearance; author-year: alphabetical.
  const entries =
    ctx.style === "numeric"
      ? [...ctx.cited]
          .map((k) => bibEntry(k))
          .filter((e): e is BibEntry => !!e)
          .sort((a, b) => (ctx.ordinals.get(a.key) ?? 0) - (ctx.ordinals.get(b.key) ?? 0))
      : [...ctx.cited]
          .map((k) => bibEntry(k))
          .filter((e): e is BibEntry => !!e)
          .sort((a, b) => (a.authors[0] ?? a.key).localeCompare(b.authors[0] ?? b.key));
  if (!entries.length) return "";
  const items = entries
    .map((e) => {
      const num =
        ctx.style === "numeric"
          ? `<span class="ref-num">${ctx.ordinals.get(e.key) ?? "?"}.</span> `
          : "";
      const authors = e.authors.length ? e.authors.join(", ") : e.key;
      const venue = e.container ? ` <span class="ref-venue">${esc(e.container)}</span>.` : "";
      const doi = e.doi ? ` <a href="https://doi.org/${esc(e.doi)}">doi.org/${esc(e.doi)}</a>` : "";
      return `<p class="ref" id="ref-${esc(e.key)}">${num}${esc(authors)}${
        e.year ? ` (${esc(e.year)})` : ""
      }. ${esc(e.title)}.${venue}${doi}</p>`;
    })
    .join("\n");
  return `<section class="references"><h2>References</h2>${items}</section>`;
}

function titleBlock(meta: any): string {
  if (!meta || typeof meta !== "object") return "";
  const rawAuthors = meta.author ?? meta.authors;
  let authors = "";
  if (Array.isArray(rawAuthors))
    authors = rawAuthors.map((a: any) => (typeof a === "string" ? a : a?.name ?? "")).filter(Boolean).join(", ");
  else if (typeof rawAuthors === "string") authors = rawAuthors;

  if (!meta.title && !authors && !meta.abstract) return "";
  let h = `<div class="title-block">`;
  if (meta.title) h += `<div class="title">${esc(String(meta.title))}</div>`;
  if (authors) h += `<div class="authors">${esc(authors)}</div>`;
  h += `</div>`;
  if (meta.abstract)
    h += `<div class="abstract"><span class="lbl">Abstract. </span>${esc(String(meta.abstract))}</div>`;
  return h;
}

// Client-side paginator for the paginated preview: distribute the rendered
// top-level blocks into fixed letter-height sheets with page numbers. A block
// taller than a page simply gets its own page (figures use break-inside:avoid).
const PAGINATOR = `(function(){function run(){var src=document.getElementById('flux-src'),pages=document.getElementById('flux-pages');if(!src||!pages)return;var blocks=[].slice.call(src.children);var maxH=880,no=0,body=null;function nl(){no++;var p=document.createElement('div');p.className='page';var b=document.createElement('div');b.className='page-body';var n=document.createElement('div');n.className='page-num';n.textContent=no;p.appendChild(b);p.appendChild(n);pages.appendChild(p);body=b;}nl();blocks.forEach(function(el){body.appendChild(el);if(body.scrollHeight>maxH&&body.children.length>1){body.removeChild(el);nl();body.appendChild(el);}});if(src.parentNode)src.parentNode.removeChild(src);}if(document.readyState!=='loading')run();else document.addEventListener('DOMContentLoaded',run);})();`;

export interface RenderResult {
  full: string; // complete standalone HTML document
  inner: string; // just the manuscript content (for embedding)
  title: string;
}

export async function renderManuscript(
  src: string,
  opts: { paginated?: boolean } = {},
): Promise<RenderResult> {
  const md = await getMd();
  const yaml = await getYaml();

  let meta: any = {};
  let body = src;
  if (src.startsWith("---")) {
    const end = src.indexOf("\n---", 3);
    if (end >= 0) {
      try {
        meta = yaml.load(src.slice(3, end)) ?? {};
      } catch {
        meta = {};
      }
      body = src.slice(end + 4);
    }
  }

  capStash = [];
  const ctx = makeCiteCtx(parseCitationStyle(meta["citation-style"]), body);
  const { transformed, blocks } = preprocess(body, ctx);
  let html = md.render(transformed);

  // Substitute block placeholders (figures, table captions) + their captions.
  blocks.forEach((b, i) => {
    let blockHtml = b.html.replace(/__CAP(\d+)__/g, (_m, idx) =>
      md.renderInline(transformInline(capStash[Number(idx)] ?? "", ctx)),
    );
    if (b.body !== undefined) blockHtml = blockHtml.replace("__BODY__", md.render(b.body));
    const wrapRe = new RegExp(`<p>\\s*${b.token}\\s*</p>`);
    if (wrapRe.test(html)) html = html.replace(wrapRe, blockHtml);
    else html = html.replace(b.token, blockHtml);
    void i;
  });

  const inner = titleBlock(meta) + html + bibliographyHtml(ctx);
  const title = (meta.title && String(meta.title)) || "Manuscript";
  const bodyClass = opts.paginated ? "paginated" : "continuous";
  const bodyInner = opts.paginated
    ? `<div id="flux-src" style="position:absolute;left:-9999px;width:6.5in">${inner}</div><div id="flux-pages"></div><script>${PAGINATOR}</script>`
    : `<div class="sheet">${inner}</div>`;
  const full = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(
    title,
  )}</title><style>${journalCss}</style></head><body class="${bodyClass}">${bodyInner}</body></html>`;

  return { full, inner, title };
}
