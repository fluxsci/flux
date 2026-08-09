// Structure of an extracted paper: where the body ends and the bibliography begins.
//
// Why this exists: full-text search over a whole PDF silently conflates "this paper is ABOUT X"
// with "this paper CITES something with X in its title". Measured over a sample of the owner's
// library, ~30% of all term occurrences fall inside reference lists, and ~16% of (paper, term)
// matches are reference-list-only — pure false positives. Occurrence-count ranking is skewed the
// same way: a paper with forty relevant-sounding citations outranks one that actually discusses
// the subject.
//
// Pure + string-only (no pdf.js, no I/O) so it runs identically in Node and the renderer and is
// unit-testable against fixture text.

/** A heading line detected in the extracted text. */
export interface Heading {
  text: string;
  /** Character offset of the start of the heading line. */
  offset: number;
}

export interface PaperStructure {
  /** Offset at which the bibliography starts, or null when none was found with confidence. */
  referencesStart: number | null;
  /** Offset at which it stops. Preprints routinely carry 50+ pages of supplementary material
   *  AFTER the bibliography; that material is body text and must stay searchable, so the
   *  bibliography is a range rather than "everything to the end". */
  referencesEnd: number | null;
  /** How the boundary was found. Nature-family journals print no "References" heading at all —
   *  their lists just begin — so a heading-only detector misses them entirely. */
  referencesMethod: "heading" | "density" | null;
  /** Why we believe it: a matching heading, corroborated by the shape of the text after it. */
  referencesConfidence: number; // 0..1
  /** Every heading-looking line we found, in document order. */
  headings: Heading[];
  /** Reference-likeness of the text after the boundary (citations per 1k chars). Diagnostic. */
  refDensity: number;
}

/** Heading text that opens a bibliography. Ordered longest-first so "references cited" wins
 *  over a bare "references" on the same line. */
const REF_HEADING =
  /^[\s\d.,)\]]*(literature\s+cited|references\s+and\s+notes|references\s+cited|works\s+cited|bibliography|references|reference\s+list)\s*:?\s*$/i;

/** Headings that commonly sit just before the bibliography; used only for diagnostics. */
const SECTION_HEADING =
  /^[\s\d.]*(abstract|introduction|background|results|discussion|conclusions?|methods?|materials\s+and\s+methods|experimental\s+procedures|acknowledg(?:e)?ments?|author\s+contributions|declaration\s+of\s+competing\s+interest|conflicts?\s+of\s+interest|data\s+availability|funding|supplementary\s+(?:material|information)|appendix)\s*:?\s*$/i;

/** An author in bibliography form: "Smith, J.", "Van Horn, S.C.", "O'Brien, M.A.". This is the
 *  single strongest signal there is — running prose essentially never contains it, whereas every
 *  reference entry contains several. Counting years alone was not enough: a Methods or
 *  Acknowledgements section is full of years and grant numbers, and got misread as a bibliography. */
const AUTHOR_INITIALS = /\b[A-Z][A-Za-z'’À-ɏ-]{1,20},\s*(?:[A-Z]\.\s*){1,4}/g;
/** Volume/page ranges: "348, 481–510". */
const PAGE_RANGE = /\b\d{1,5}\s*[–—]\s*\d{1,5}\b/g;
const ET_AL = /\bet al\b/g;
/** A year in citation position — supporting evidence rather than the primary signal. */
const CITATION_YEAR = /\b(?:19|20)\d{2}\b/g;
const DOI_IN_TEXT = /\b10\.\d{4,9}\//g;
/** Numbered-entry openers: "[12]" or "12." at the start of a line. */
const NUMBERED_ENTRY = /^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s+\S/;

/** Bibliography-likeness, in signals per 1000 characters.
 *
 *  Weighted rather than a raw count: author-initial patterns and page ranges are near-exclusive
 *  to reference lists, while bare years appear throughout a paper. Measured on this library,
 *  body text scores under ~2 and reference sections score 9-25. */
export function referenceDensity(text: string): number {
  if (!text) return 0;
  const authors = (text.match(AUTHOR_INITIALS) || []).length;
  const ranges = (text.match(PAGE_RANGE) || []).length;
  const etal = (text.match(ET_AL) || []).length;
  const years = (text.match(CITATION_YEAR) || []).length;
  const dois = (text.match(DOI_IN_TEXT) || []).length;
  let numbered = 0;
  for (const line of text.split("\n")) if (NUMBERED_ENTRY.test(line)) numbered++;
  const score = 2 * authors + 1.5 * ranges + etal + 0.5 * years + dois + numbered;
  return (score / text.length) * 1000;
}

/** Offsets of every line start in `text`, paired with the line itself. */
function lines(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    out.push({ text: line, offset: at });
    at += line.length + 1;
  }
  return out;
}

/** Locate the bibliography and the document's headings.
 *
 *  The heading regex alone is not enough — papers cite the word "References", table-of-contents
 *  lines repeat it, and a running header can put it on every page. So every candidate is scored
 *  on the text that FOLLOWS it: a real bibliography is dense with years and DOIs and runs to the
 *  end of the document. The last candidate that clears the bar wins, because appendices and
 *  supplementary sections legitimately sit after the references in many journals. */
export function analyzePaperStructure(text: string): PaperStructure {
  const ls = lines(text);
  const headings: Heading[] = [];
  const candidates: number[] = [];
  for (const l of ls) {
    const t = l.text.trim();
    if (!t || t.length > 60) continue;
    if (REF_HEADING.test(t)) {
      candidates.push(l.offset);
      headings.push({ text: t, offset: l.offset });
    } else if (SECTION_HEADING.test(t)) {
      headings.push({ text: t, offset: l.offset });
    }
  }

  const total = text.length;
  let best: { offset: number; end: number; score: number; density: number } | null = null;
  for (const offset of candidates) {
    // A "References" line in the first fifth of a paper is a table-of-contents entry or a
    // cross-reference in the prose, not the real thing.
    if (offset / Math.max(total, 1) < 0.2) continue;
    if (total - offset < 400) continue; // a trailing header line with nothing under it
    const end = runEnd(text, offset, ls);
    const density = referenceDensity(text.slice(offset, end));
    if (density < MIN_DENSITY) continue;
    // Rank by total bibliographic mass, NOT by position. Nature-format papers print References
    // BEFORE Methods, so "the last candidate" picks up a Methods/Acknowledgements block instead.
    const score = density * (end - offset);
    if (!best || score > best.score) best = { offset, end, score, density };
  }

  if (best) {
    return {
      referencesStart: best.offset,
      referencesEnd: best.end,
      referencesMethod: "heading",
      referencesConfidence: Math.round(Math.min(1, best.density / 20) * 100) / 100,
      headings,
      refDensity: Math.round(best.density * 10) / 10,
    };
  }

  const dens = densityBoundary(text, ls);
  return {
    referencesStart: dens ? dens.offset : null,
    referencesEnd: dens ? dens.end : null,
    referencesMethod: dens ? "density" : null,
    referencesConfidence: dens ? Math.round(Math.min(1, dens.density / 20) * 100) / 100 : 0,
    headings,
    refDensity: dens ? Math.round(dens.density * 10) / 10 : 0,
  };
}

const WINDOW = 1500;
const STEP = 500;
// Calibrated against papers whose bibliography is preceded by an unambiguous heading, so the true
// boundary is known: body sides scored 0.4-6.4 (mean 2.8), reference sides 6.2-72.7 (mean 31.9).
/** Density to START believing a run is a bibliography — set above the highest body score seen. */
const MIN_DENSITY = 12;
/** Density to KEEP believing it. Deliberately lower: a window straddling two long entries dips,
 *  and without this hysteresis the scan stopped at the "B" authors and leaked five sixths of a
 *  bibliography back into the body. */
const CONTINUE_DENSITY = 6;

/** A line that OPENS a reference entry: a numbered entry, or one beginning with an author in
 *  "Surname, A.B." form. Used to place a density-derived boundary exactly. */
const ENTRY_OPENER = /^\s*(?:\[\d{1,3}\]|\d{1,3}\.\s)?\s*[A-Z][A-Za-z'’À-ɏ-]{1,20},\s*(?:[A-Z]\.\s*){1,4}/;

/** First line in [from, limit) that opens a reference entry, or null. */
function firstEntryLine(ls: { text: string; offset: number }[], from: number, limit: number): number | null {
  for (const l of ls) {
    if (l.offset < from) continue;
    if (l.offset >= limit) break;
    if (NUMBERED_ENTRY.test(l.text) || ENTRY_OPENER.test(l.text)) return l.offset;
  }
  return null;
}

/** Walk forward from a boundary while the text still reads like a reference list, and return
 *  where it stops. Tolerates short dips (a page header, a figure legend interleaved by the
 *  extractor) before declaring the section over. */
function runEnd(text: string, from: number, ls: { text: string; offset: number }[]): number {
  let at = from;
  let dips = 0;
  let lastGood = from;
  while (at + WINDOW <= text.length) {
    const d = referenceDensity(text.slice(at, at + WINDOW));
    if (d < CONTINUE_DENSITY) {
      if (++dips > 3) break;
    } else {
      dips = 0;
      lastGood = at;
    }
    at += STEP;
  }
  const stop = Math.min(text.length, lastGood + WINDOW);
  // When the bibliography runs to the very end of the document, the windowed scan stops a little
  // short of it. Returning that short offset would let bodyOf() stitch the leftover entries back
  // into the body — the exact false positives this whole boundary exists to remove.
  if (text.length - stop < WINDOW || referenceDensity(text.slice(stop)) >= CONTINUE_DENSITY) return text.length;
  const line = ls.find((l) => l.offset >= stop);
  return line ? line.offset : text.length;
}

/** Fallback for the (common) journals that print no bibliography heading: walk backwards from the
 *  end of the document while the text keeps LOOKING like a reference list, and call the point
 *  where that stops the boundary.
 *
 *  Works on a sliding window rather than per line, because reference entries wrap: only the first
 *  line of an entry carries the number, and continuation lines look like ordinary prose. A trailing
 *  copyright/footer block is tolerated — the scan starts at the last window that is dense, not at
 *  the very end. */
function densityBoundary(
  text: string,
  ls: { text: string; offset: number }[],
): { offset: number; end: number; density: number; score: number } | null {
  if (text.length < 4000) return null;

  const starts: number[] = [];
  for (let s = 0; s + WINDOW <= text.length; s += STEP) starts.push(s);
  if (!starts.length) return null;
  const dens = starts.map((s) => referenceDensity(text.slice(s, s + WINDOW)));

  // Enumerate every contiguous dense run, then keep the one carrying the most bibliographic mass.
  // Picking the LAST run is wrong for Nature-format papers, which print References before Methods:
  // there the final dense block is the acknowledgements, not the bibliography.
  let bestRun: { offset: number; end: number; density: number; score: number } | null = null;
  let i = 0;
  while (i < dens.length) {
    if (dens[i] < MIN_DENSITY) {
      i++;
      continue;
    }
    // Grow from a core window in both directions. Sub-MIN windows are crossed only in short
    // stretches (a wrapped entry, an interleaved page header) — an unbounded walk at the
    // CONTINUE level bridges a citation-heavy figure-legend block straight into the bibliography.
    const MAX_BRIDGE = 3;
    let s = i;
    for (let dip = 0, j = i - 1; j >= 0; j--) {
      if (dens[j] >= MIN_DENSITY) { dip = 0; s = j; continue; }
      if (dens[j] >= CONTINUE_DENSITY && ++dip <= MAX_BRIDGE) continue;
      break;
    }
    let e = i;
    for (let dip = 0, j = i + 1; j < dens.length; j++) {
      if (dens[j] >= MIN_DENSITY) { dip = 0; e = j; continue; }
      if (dens[j] >= CONTINUE_DENSITY && ++dip <= MAX_BRIDGE) continue;
      break;
    }
    i = e + 1;
    // A real section, not one dense paragraph: at least 6 windows (~4k chars).
    if (e - s < 5) continue;
    const offset = starts[s];
    if (offset < text.length * 0.2) continue;
    // A window is dense because MOST of it is references — it can still begin mid-Discussion. Snap
    // forward to the first line that actually opens a reference entry so the boundary is exact.
    const snapped = firstEntryLine(ls, offset, offset + 2 * WINDOW) ?? offset;
    const stop = Math.min(text.length, starts[e] + WINDOW);
    // Score the RUN, not everything that follows it — a preprint's supplementary material sits
    // after the bibliography and would otherwise dilute a perfectly good detection to nothing.
    const density = referenceDensity(text.slice(snapped, stop));
    if (density < MIN_DENSITY) continue;
    const score = density * (stop - snapped);
    if (!bestRun || score > bestRun.score) bestRun = { offset: snapped, end: stop, density, score };
  }
  return bestRun;
}

/** The paper minus its bibliography — what topical full-text search should match against.
 *  Anything AFTER the bibliography (supplementary methods, extended figures) is body text and is
 *  stitched back on, because in a preprint that can be most of the document. */
export function bodyOf(text: string, structure?: PaperStructure): string {
  const s = structure ?? analyzePaperStructure(text);
  if (s.referencesStart == null) return text;
  const tail = s.referencesEnd != null && s.referencesEnd < text.length ? text.slice(s.referencesEnd) : "";
  return tail ? text.slice(0, s.referencesStart) + "\n" + tail : text.slice(0, s.referencesStart);
}

/** The bibliography alone (empty when none was found). Kept searchable separately so "which of
 *  my papers cites Smith 2019" stays answerable. */
export function referencesOf(text: string, structure?: PaperStructure): string {
  const s = structure ?? analyzePaperStructure(text);
  if (s.referencesStart == null) return "";
  return text.slice(s.referencesStart, s.referencesEnd ?? text.length);
}
