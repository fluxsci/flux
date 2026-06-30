// The deterministic citekey scheme — the durable join key across FluxLib, the
// per-project subset, and the manuscript's `@key` citations (Flux_Project_Format
// §6.3). Better-BibTeX-style `authorYearShorttitle`, ascii-folded, lowercased,
// with base-26 alpha suffixing on collision. Pure + stable: the SAME entry always
// yields the same key, so it is safe for both codepaths to call.
//
// IMPORTANT: changing this algorithm would change keys for newly-added entries.
// Existing entries are NEVER re-keyed (FluxLib preserves keys + dedupes by DOI),
// so churn is bounded; still, treat the scheme as pinned by fluxlib.json.schemaVersion.
import type { RefEntry } from "./types";

/** Strip diacritics + lowercase: "Müller" -> "muller". */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, ""); // strip combining diacritical marks
}

/** 1 -> "a", 26 -> "z", 27 -> "aa" … (base-26, a-indexed). */
function alphaSuffix(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/**
 * Deterministic `<firstAuthorFamily><year><firstSignificantTitleWord>` citekey,
 * disambiguated against `taken` with a/b/c… suffixes. The base (pre-suffix) form
 * is a pure function of the entry, so re-deriving the same paper is stable.
 */
export function makeCitekey(
  entry: Pick<RefEntry, "authors" | "year" | "title">,
  taken: Set<string> = new Set(),
): string {
  const family = entry.authors?.[0] ?? "anon";
  const a = fold(family).replace(/[^a-z0-9]/g, "") || "anon";
  const yr = (entry.year ?? "").replace(/[^0-9]/g, "");
  const w =
    (entry.title ?? "")
      .split(/\s+/)
      .map((x) => fold(x).replace(/[^a-z0-9]/g, ""))
      .find((x) => x.length > 3) ?? "";
  const base = `${a}${yr}${w}`.slice(0, 40) || "ref";
  let key = base;
  let n = 0;
  while (taken.has(key)) key = base + alphaSuffix(++n);
  return key;
}
