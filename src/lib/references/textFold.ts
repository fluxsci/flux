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
  // Preserve the Unicode mapping while normalizing ordinary ASCII runs in one
  // operation. Per-codepoint normalize/regex work dominated full-library scans.
  const normalizedParts: string[] = [], normStarts: number[] = [], normShifts: number[] = [];
  let length = 0, priorShift = 0;
  const normPoint = (at: number, original: number) => {
    const shift = original-at;
    if (shift !== priorShift) { normStarts.push(at); normShifts.push(shift); priorShift=shift; }
  };
  for (const match of s.matchAll(/[\x00-\x7f]+|[^\x00-\x7f]/gu)) {
    const part=match[0], at=match.index!;
    if (part.charCodeAt(0)<128) {
      normPoint(length,at); normalizedParts.push(part.toLowerCase()); length+=part.length;
    } else {
      const folded=foldText(part);
      for(let j=0;j<folded.length;j++) normPoint(length+j,at+Math.min(j,part.length-1));
      normalizedParts.push(folded); length+=folded.length;
    }
  }
  normPoint(length,s.length);
  const normalized:FoldedText={text:normalizedParts.join(""),starts:Uint32Array.from(normStarts),shifts:Int32Array.from(normShifts)};
  const parts:string[]=[],starts:number[]=[],shifts:number[]=[];
  let outputLength=0, previous=0, mapping=0, cursor=0;
  const point=(at:number,original:number)=>{const shift=original-at;if(shift!==previous){starts.push(at);shifts.push(shift);previous=shift;}};
  const range=(from:number,to:number)=>{
    if(to<=from)return;
    point(outputLength,originalOffset(normalized,from));
    while(mapping<normStarts.length && normStarts[mapping]<from)mapping++;
    while(mapping<normStarts.length && normStarts[mapping]<to){const at=normStarts[mapping];point(outputLength+at-from,at+normShifts[mapping]);mapping++;}
    parts.push(normalized.text.slice(from,to));outputLength+=to-from;
  };
  for(const match of normalized.text.matchAll(SEPARATORS)){
    const from=match.index!,to=from+match[0].length;
    range(cursor,from);point(outputLength,originalOffset(normalized,from));
    parts.push(match[0].includes("\f")?"\f":" ");outputLength++;cursor=to;
  }
  range(cursor,normalized.text.length);point(outputLength,s.length);
  return {text:parts.join(""),starts:Uint32Array.from(starts),shifts:Int32Array.from(shifts)};
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
