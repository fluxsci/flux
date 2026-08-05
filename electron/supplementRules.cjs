// Telling an article's MAIN TEXT apart from its SUPPLEMENTARY material.
//
// This is the single source of truth for that judgement. It lives here (dependency-free
// CommonJS under electron/) because the Electron main process runs unbundled and `src/` is
// excluded from the packaged app (see electron-builder.yml) — main can only require from
// electron/. The TypeScript consumers (flux-core, verify scripts, and the renderer via
// src/lib/references/supplement.ts) import it through supplementRules.d.cts, the same
// pattern fluxPaths.cjs/execResolve.cjs already use.
//
// WHY THIS EXISTS: a supplement frequently downloads more readily than the paywalled main
// text, and publisher article pages often list the supplement ABOVE the PDF control. Left
// unranked and unverified, the capture engine stored the supplement as paper.pdf — the
// "Science paper is actually the supplement" bug. See notes/Flux_Supplement_Capture_Report.md.
//
// THE LESSON THAT SHAPES THIS FILE: the first attempt at this fix was pure URL pattern
// matching on the way IN, and it regressed the moment science.org changed its template.
// Pattern-matching publisher HTML has no floor. So the rules here come in two independent
// layers — URL shape (cheap, fallible) and document CONTENT (slow, authoritative) — and
// callers are expected to apply the content layer AFTER the bytes land, where it can catch
// anything the URL layer missed.

// ---------------------------------------------------------------------------
// Layer 1 — URL shape
// ---------------------------------------------------------------------------

// Deliberately a list of SPECIFIC shapes rather than the bare word "supplement". A bare
// word matches `academic.oup.com/sleep/article-pdf/42/Supplement_1/…`, which is a journal
// ISSUE supplement — a perfectly ordinary main text — and misfiling those would be a worse
// bug than the one this fixes.
const SUPPLEMENT_URL_PATTERNS = [
  /downloadsupplement/i, //                    Atypon + Wiley action endpoint
  /\/suppl\/|suppl_file/i, //                  Atypon path form: Science, PNAS, ACS
  /supplement(ary|al)?[-_ ]?(materials?|information|info|data|files?|text|figures?|tables?|methods?|notes?|movies?|videos?|appendix)/i,
  /supporting[-_ ]?(information|info|material)/i, //  ACS/RSC/Wiley wording
  /\/esm\/|MOESM/i, //                         Springer Nature electronic supplementary material
  /(^|[-_/])mmc\d+\b/i, //                     Elsevier multimedia component
  /[-_.]s(m|i|app)\.pdf/i, //                  AAAS `-sm.pdf`/`.sm.pdf`, ACS `_si.pdf`, PNAS `.sapp.pdf`
  /[-_]sup[-_]?\d/i, //                        Wiley `-sup-0001`
  /[-_]suppinfo/i,
  // Reporting/compliance artefacts. Not supplementary science, but definitely not the
  // article either — one of these (an MDAR checklist) was stored as a whole paper.
  /\bmdar\b/i,
  /reproducibility[-_ ]?checklist/i,
  /reporting[-_ ]?summary/i,
];

/** True if `u` looks like a supplementary/supporting file rather than the article itself. */
function isSupplementUrl(u) {
  const s = String(u || "");
  return SUPPLEMENT_URL_PATTERNS.some((rx) => rx.test(s));
}

// ---------------------------------------------------------------------------
// Layer 2 — document content (authoritative)
// ---------------------------------------------------------------------------

// How much of page 1 each pattern may match against. This window is the difference between
// "this document IS the supplement" and "this article MENTIONS its supplement". Position
// alone can't tell those apart — a paper's own first page may well say "…see Supplementary
// Materials for detailed methods". What DOES separate them is line structure: a supplement
// carries its banner as its own line, directly above the paper's title, whereas an article
// mentions it mid-sentence. Both text extractors Flux uses preserve line breaks (pdf.js's
// joinTextItems emits \n on a baseline jump), so "starts a line" is a reliable test.
//
// `banner` patterns must BEGIN one of the first few lines. `marker` patterns identify the
// document's whole type (a compliance form is one cover to cover) and may match anywhere
// near the top.
const BANNER_LINES = 12; // a masthead lives in the first handful of lines
const MARKER_CHARS = 1200;

// A supplement's masthead names the paper it belongs to — "Supplementary Materials for
// <Title>". That "for <something other than itself>" is what separates it from the two
// things an ARTICLE legitimately prints:
//
//   1. a section heading, bare: "SUPPLEMENTARY MATERIALS" followed by a URL and a figure
//      list. Science's print layout puts the previous article's tail on page 1 of the next
//      one, so this appears near the top of main texts that have nothing to do with it —
//      it falsely condemned Takahashi 2016 during this fix.
//   2. a pointer: "Supplementary material for this article is available at …".
//
// Hence: the banner must be followed by "for", and by something that isn't a self-reference.
// The lookahead spans the whitespace so the banner still matches when "for" ENDS the line
// and the paper's title is on the next one — which is how AAAS actually lays these out.
const NOT_SELF_REF = "(?!\\s+(?:this|these|its|the\\s+(?:online|present))\\b)";
// For a BARE heading (no "for"), the give-away that it's a pointer rather than the document's
// own identity is the self-referential continuation: "Supplementary material for this article
// is available at …". Reject that whole phrasing.
const NOT_POINTER = "(?!\\s+for\\s+(?:this|these|its|the\\s+(?:online|present))\\b)";
const SUPPLEMENT_DOC_PATTERNS = [
  { rx: new RegExp("^supplement(ary|al)?\\s+(materials?|information|data|text)\\s+for\\b" + NOT_SELF_REF, "i"), why: "supplementary-material-for", kind: "banner" },
  { rx: new RegExp("^supporting\\s+(online\\s+)?(materials?|information)\\s+for\\b" + NOT_SELF_REF, "i"), why: "supporting-material-for", kind: "banner" },
  // A bare heading only counts as the document's own identity when it IS the document's
  // opening line (an SI title page), never when it's buried in a reference section.
  { rx: new RegExp("^supplement(ary|al)?\\s+(materials?|information|data|text)\\b" + NOT_POINTER, "i"), why: "supplementary-title-page", kind: "first-line" },
  { rx: new RegExp("^supporting\\s+information\\b" + NOT_POINTER, "i"), why: "supporting-information-title-page", kind: "first-line" },
  { rx: /^(nature\s+(research|portfolio)\s+)?reporting\s+summary\b/i, why: "reporting-summary", kind: "first-line" },
  // Document-TYPE markers: a compliance form is one cover to cover, so these are safe to
  // scan for anywhere near the top. (`suppl/DC1` is deliberately NOT here — that is exactly
  // the URL an article prints when pointing at its own supplement.)
  { rx: /materials?\s+design\s+analysis\s+reporting/i, why: "mdar-checklist", kind: "marker" },
  { rx: /reproducibility\s+checklist/i, why: "reproducibility-checklist", kind: "marker" },
];

// The embedded Title is a short, deliberate label, so it can be matched unanchored — a
// supplement's Title says so somewhere in it ("Microsoft Word - deVivo-Science-Supplementary
// Material - for NIH.docx"), while no article titles itself that way. The qualifier after
// the word is required, so a paper about the SUPPLEMENTARY MOTOR AREA is untouched.
const SUPPLEMENT_TITLE_PATTERNS = [
  { rx: /supplement(ary|al)?[-_\s]+(materials?|information|data)\b/i, why: "supplement-title" },
  { rx: /supporting[-_\s]+(online[-_\s]+)?(materials?|information)\b/i, why: "supporting-title" },
  { rx: /\bmdar\b|reproducibility[-_\s]+checklist/i, why: "mdar-checklist" },
];

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * Decide whether an ALREADY-DOWNLOADED PDF is supplementary material.
 * Returns a short machine-readable reason string, or null if it looks like an article.
 *
 * `title`     — embedded Title (XMP dc:title or Info /Title), if any
 * `page1Text` — extracted text of page 1
 * `finalUrl`  — the URL the bytes actually came from, AFTER redirects (this is the field
 *               that catches the Science case: the page linked `/doi/suppl/…`, which the
 *               URL layer missed, but it redirected to `/action/downloadSupplement?…`,
 *               which it catches — checking on the way OUT sees what the way IN could not)
 */
function supplementDocSignal({ title, page1Text, finalUrl } = {}) {
  if (finalUrl && isSupplementUrl(finalUrl)) return "supplement-url";
  const t = squash(title);
  if (t) {
    for (const { rx, why } of SUPPLEMENT_TITLE_PATTERNS) if (rx.test(t)) return why;
  }
  const raw = String(page1Text || "");
  if (!raw.trim()) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, BANNER_LINES);
  const head = squash(raw).slice(0, MARKER_CHARS);
  for (const { rx, why, kind } of SUPPLEMENT_DOC_PATTERNS) {
    const hit = kind === "banner" ? lines.some((l) => rx.test(l)) : kind === "first-line" ? rx.test(lines[0] ?? "") : rx.test(head);
    if (hit) return why;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 3 — candidate ranking
// ---------------------------------------------------------------------------

// A page usually offers several PDF-ish affordances. Trying them in DOM order means
// whatever the publisher's template happens to list first wins, which is how a supplement
// beat the article. Score them instead, so "which of these is the paper?" is an explicit
// question with an explicit answer.
const VIEWER_URL = /\/doi\/(reader|epdf)\/|\/epdf\/|\/doi\/full\//i;

/** Escape a DOI for embedding in a RegExp. */
const escapeRx = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True if `url` is the canonical main-text PDF endpoint for `doi` on its publisher. */
function isMainPdfUrl(url, doi) {
  const u = String(url || "");
  if (/\/action\/showPdf\?pii=/i.test(u)) return true; // Cell Press
  if (!doi) return false;
  const d = escapeRx(doi);
  return new RegExp("/doi/(pdf|pdfdirect)/" + d + "(\\?|#|$)", "i").test(u);
}

/**
 * Score a scraped candidate. Higher is more likely to BE the article. Supplements are not
 * scored — callers partition them out first with isSupplementUrl.
 */
function scoreCandidate(c, doi) {
  const url = (c && c.url) || "";
  const kind = (c && c.kind) || "";
  // A viewer page is HTML, not a PDF. It costs a wasted round-trip and, worse, navigating
  // into one can poison a later capture with a cached 206 partial — so it sorts last.
  if (url && VIEWER_URL.test(url)) return 5;
  if (isMainPdfUrl(url, doi)) return 100;
  if (kind === "citation_pdf_url") return 95;
  if (kind === "link-pdf") return 80;
  if (kind === "elsevier-json") return 75;
  if (/\.pdf(\?|#|$)|\/pdfft\b|pdfdirect/i.test(url)) return 60;
  if (kind === "anchor-href") return 50;
  if (kind === "anchor-text") return 20;
  if (kind === "button") return 10; // href-less; can't be judged, but a "Download PDF" button is usually the main text
  return 30;
}

/**
 * Split scraped candidates into the main-PDF attempts (best first) and the supplements.
 * The sort is stable, so equal scores keep their original page order.
 */
function partitionCandidates(candidates, doi) {
  const list = Array.isArray(candidates) ? candidates : [];
  const supplements = list.filter((c) => c && c.url && isSupplementUrl(c.url));
  const main = list.filter((c) => !(c && c.url && isSupplementUrl(c.url)));
  const scored = main.map((c, i) => ({ c, i, s: scoreCandidate(c, doi) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return { main: scored.map((x) => x.c), supplements };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * A readable filename for a supplement, derived from its URL: prefer the `?file=` query
 * param publishers use on their download endpoints, else the last path segment.
 * Returns "" when nothing usable is present (caller supplies a fallback).
 */
function supplementNameFromUrl(u) {
  let name = "";
  try {
    const x = new URL(String(u));
    const q = x.searchParams.get("file") || x.searchParams.get("filename");
    name = q || decodeURIComponent(x.pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    const m = String(u || "").match(/[?&]file=([^&]+)/i);
    if (m) {
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = m[1];
      }
    }
  }
  name = name.split(/[\\/]/).pop() || "";
  return name.replace(/[\u0000-\u001f]/g, "").trim();
}

module.exports = {
  isSupplementUrl,
  supplementDocSignal,
  scoreCandidate,
  isMainPdfUrl,
  partitionCandidates,
  supplementNameFromUrl,
  SUPPLEMENT_URL_PATTERNS,
  SUPPLEMENT_DOC_PATTERNS,
};
