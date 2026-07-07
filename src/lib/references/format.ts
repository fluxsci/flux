// 2.2 — the ONE reference formatter: a submittable reference list (volume/issue/
// pages/author initials) for both citation styles, consumed by the renderer/export
// (bibliographyHtml), the margin Bibliography view, and hover cards — pure and
// dependency-free so flux-core and tests import it too.
//
// Two hand-tuned formats (not a citeproc engine — deliberate): in-text chips read
// ordinals/labels SYNCHRONOUSLY per keystroke (feel invariant 8), so an arbitrary
// CSL style whose in-text form differs would fork editor from export — the exact
// divergence class the shared-grammar work exists to prevent. Exact journal styles
// remain available on the Quarto path (`csl:` front matter). A future citeproc
// option can slot into bibliographyHtml behind this same interface.
//
//   author-year (APA-shaped):
//     Watson, J. D., & Crick, F. H. C. (1953). Molecular structure of nucleic
//     acids. *Nature*, 171(4356), 737–738. doi
//   numeric (Vancouver-shaped):
//     Watson JD, Crick FHC. Molecular structure of nucleic acids. Nature.
//     1953;171(4356):737–738. doi

import type { RefEntry } from "./types";

export type RefStyle = "author-year" | "numeric";

export interface FormattedRef {
  authors: string;
  year: string;
  title: string;
  venue: string;
  /** volume(issue), pages — "" when unknown. */
  locator: string;
  doi?: string;
}

/** "Jean-Paul" → "J.-P.", "F. H. C." → "F. H. C.", "Francis" → "F." */
function initials(given: string): string {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w
        .split("-")
        .map((p) => (p ? `${p[0].toUpperCase()}.` : ""))
        .join("-"),
    )
    .join(" ");
}

function names(e: RefEntry): { family: string; given?: string }[] {
  if (e.authorsFull?.length) return e.authorsFull;
  return (e.authors ?? []).map((family) => ({ family }));
}

function authorsAuthorYear(e: RefEntry): string {
  const ns = names(e);
  if (!ns.length) return e.key;
  const one = (n: { family: string; given?: string }) => (n.given ? `${n.family}, ${initials(n.given)}` : n.family);
  const MAX = 20;
  const list = ns.slice(0, MAX).map(one);
  const truncated = ns.length > MAX;
  if (list.length === 1) return list[0] + (truncated ? ", et al." : "");
  const last = list.pop()!;
  return list.join(", ") + (truncated ? `, ${last}, et al.` : `, & ${last}`);
}

function authorsNumeric(e: RefEntry): string {
  const ns = names(e);
  if (!ns.length) return e.key;
  const one = (n: { family: string; given?: string }) =>
    n.given ? `${n.family} ${initials(n.given).replace(/\.|\s/g, "").replace(/-/g, "-")}` : n.family;
  const MAX = 6;
  const list = ns.slice(0, MAX).map(one);
  return list.join(", ") + (ns.length > MAX ? ", et al." : "");
}

function locatorOf(e: RefEntry, style: RefStyle): string {
  const vol = e.volume?.trim();
  const iss = e.issue?.trim();
  const pages = e.pages?.trim().replace(/--/g, "–").replace(/-(?=\d)/g, "–");
  if (!vol && !pages) return "";
  const vi = vol ? `${vol}${iss ? `(${iss})` : ""}` : "";
  if (style === "numeric") return [vi, pages].filter(Boolean).join(":");
  return [vi, pages].filter(Boolean).join(", ");
}

/** Structured pieces (callers escape + wrap each — the venue gets italics). */
export function formatReference(e: RefEntry, style: RefStyle): FormattedRef {
  const doi = e.doi?.trim() || undefined;
  if (style === "numeric") {
    return {
      authors: authorsNumeric(e),
      year: e.year ?? "",
      title: e.title ?? "",
      venue: e.container ?? (e.publisher ?? ""),
      locator: locatorOf(e, "numeric"),
      doi,
    };
  }
  return {
    authors: authorsAuthorYear(e),
    year: e.year ?? "",
    title: e.title ?? "",
    venue: e.container ?? (e.publisher ?? ""),
    locator: locatorOf(e, "author-year"),
    doi,
  };
}

/** One plain-text line (margin views, tooltips, tests). */
export function formatReferenceLine(e: RefEntry, style: RefStyle): string {
  const f = formatReference(e, style);
  if (style === "numeric") {
    return [`${f.authors}.`, f.title ? `${f.title}.` : "", f.venue ? `${f.venue}.` : "", [f.year, f.locator].filter(Boolean).join(";") + ".", f.doi ? `doi:${f.doi}` : ""]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return [
    `${f.authors}`,
    f.year ? `(${f.year}).` : "",
    f.title ? `${f.title}.` : "",
    [f.venue, f.locator].filter(Boolean).join(", ") + (f.venue || f.locator ? "." : ""),
    f.doi ? `https://doi.org/${f.doi}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The in-text author-year core — ONE implementation for chips, hover cards, and
 *  the export (they used to carry three copies of the "Smith et al." rule). */
export function inTextAuthorYear(e: RefEntry): string {
  const a = e.authors ?? [];
  const who = !a.length ? e.key : a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} & ${a[1]}` : `${a[0]} et al.`;
  return e.year ? `${who}, ${e.year}` : who;
}
