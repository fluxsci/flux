// Case/diacritic folding shared by the full-text search engine (flux-core/
// fulltextSearch.ts) and the GUI's snippet highlighting (2.3) — both sides MUST
// fold identically or a highlighted hit won't be the matched hit. Pure.

/** Lowercase + strip combining diacritics (é→e, ü→u). Length-preserving for
 *  ASCII; combining marks are removed AFTER NFD so offsets into the folded
 *  string are computed against the folded haystack only (never mixed). */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** A folded haystack plus the map back to offsets in the ORIGINAL text.
 *
 *  `starts[i]` is an offset in the folded string; `shifts[i]` is what to add to reach the
 *  original. Normalization only ever DELETES characters (whitespace runs collapse, line-wrap
 *  dashes vanish), never inserts or reorders, so the map is monotonic and needs an entry only
 *  where a deletion happened — a few thousand per paper rather than one per character. */
export interface FoldedText {
  text: string;
  starts: Uint32Array;
  shifts: Int32Array;
}

/** Characters that separate words for matching purposes. A line wrap, a run of spaces and a
 *  single space are the same thing to someone typing a query — the whole reason quoted phrases
 *  used to fail up to 94% of the time was that the stored text said "\n" where the query said " ".
 *  Hyphens join the set so "decision-making" and "decision making" are one query. */
const SEPARATORS = /[\s -]+/g;

/** Fold text for matching AND record how to get back. Collapses every separator run to a single
 *  space, on top of the case/diacritic folding above. Run this over BOTH the stored text and the
 *  query so the two sides can never disagree about spacing. */
export function foldForMatch(s: string): FoldedText {
  const folded = foldText(s);
  let out = "";
  const starts: number[] = [];
  const shifts: number[] = [];
  let last = 0;
  let drift = 0; // originalOffset - foldedOffset
  SEPARATORS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEPARATORS.exec(folded))) {
    // A form feed is a page boundary — searching must keep it so a snippet can name its page.
    const run = m[0];
    const keep = run.includes("\f") ? "\f" : " ";
    if (run === keep) continue;
    out += folded.slice(last, m.index) + keep;
    const removed = run.length - keep.length;
    drift += removed;
    starts.push(out.length);
    shifts.push(drift);
    last = m.index + run.length;
  }
  out += folded.slice(last);
  return { text: out, starts: Uint32Array.from(starts), shifts: Int32Array.from(shifts) };
}

/** Map an offset in a folded string back to the original text. */
export function originalOffset(f: FoldedText, offset: number): number {
  let lo = 0;
  let hi = f.starts.length - 1;
  let shift = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f.starts[mid] <= offset) {
      shift = f.shifts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return offset + shift;
}

export interface QueryTerms {
  /** AND terms (each must appear). */
  terms: string[];
  /** Quoted phrases (each must appear verbatim, folded). */
  phrases: string[];
}

/** Split a raw query into folded AND-terms + "quoted phrases". Phrases are separator-folded the
 *  same way the haystack is, so a typed phrase matches text that wrapped mid-phrase. */
export function parseQueryTerms(raw: string): QueryTerms {
  const terms: string[] = [];
  const phrases: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) {
      const p = foldForMatch(m[1]).text.trim();
      if (p) phrases.push(p);
    } else {
      const t = foldForMatch(m[2]).text.trim();
      if (t) terms.push(t);
    }
  }
  return { terms, phrases };
}
