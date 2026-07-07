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

export interface QueryTerms {
  /** AND terms (each must appear). */
  terms: string[];
  /** Quoted phrases (each must appear verbatim, folded). */
  phrases: string[];
}

/** Split a raw query into folded AND-terms + "quoted phrases". */
export function parseQueryTerms(raw: string): QueryTerms {
  const terms: string[] = [];
  const phrases: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) {
      const p = foldText(m[1]).trim();
      if (p) phrases.push(p);
    } else {
      const t = foldText(m[2]).trim();
      if (t) terms.push(t);
    }
  }
  return { terms, phrases };
}
