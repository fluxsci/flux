// The deterministic citekey scheme — the durable join key across FluxLib, the
// per-project subset, and the manuscript's `@key` citations (Flux_Project_Format
// §6.3). The format is Better BibTeX's DEFAULT pattern —
// `auth.lower + shorttitle(3,3) + year`, e.g. `mullerNeuralBasisDecision2024` —
// so keys minted by Flux and keys arriving from a user's Zotero+BBT setup share
// ONE style (owner decision, 2026-07-29; Zotero sync). Emulation is stylistic,
// not byte-exact (BBT's skip-word list is longer and locale-aware): the same
// paper arriving from both sides can differ in key, and that is fine — dedupe
// is by DOI, then title+year+author signature (never by key).
//
// Collisions are disambiguated with base-26 alpha suffixes, compared
// CASE-INSENSITIVELY: citekeys name `items/<key>/` directories, and macOS/
// Windows filesystems fold case — two keys differing only in case would share
// a directory. Pure + stable: the SAME entry always yields the same base key.
//
// IMPORTANT: changing this algorithm changes keys for newly-added entries ONLY.
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

/** Diacritic-strip WITHOUT case-folding (title words keep their inner case,
 *  so acronyms survive: "fMRI" -> "FMRI" once capitalized). */
function foldKeepCase(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
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

// English function words excluded from the title segment — the working subset of
// Better BibTeX's skip list (theirs is longer + localized; see header note).
const SKIP_WORDS = new Set(
  (
    "a an the and or nor but so yet of in on at to from by for with without about as into onto upon over under " +
    "between among through during before after above below up down out off again further then once here there " +
    "when where why how all any both each few more most other some such no not only own same than too very via " +
    "versus vs is are was were be been being do does did doing it its this that these those what which who whom " +
    "toward towards within along across behind beyond plus except per around near"
  ).split(" "),
);

/** The first `max` significant title words, ascii-folded, each Capitalized —
 *  BBT's `shorttitle(3,3)`: "The neural basis of decision" -> "NeuralBasisDecision". */
function shortTitle(title: string, max = 3): string {
  const words: string[] = [];
  for (const raw of title.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const w = foldKeepCase(raw).replace(/[^a-zA-Z0-9]/g, "");
    if (!w) continue;
    if (SKIP_WORDS.has(w.toLowerCase())) continue;
    words.push(w.charAt(0).toUpperCase() + w.slice(1));
    if (words.length >= max) break;
  }
  return words.join("");
}

/**
 * Deterministic BBT-style `<firstauthor><ShortTitle3Words><year>` citekey,
 * disambiguated against `taken` with a/b/c… suffixes (case-insensitive — see
 * header). The base (pre-suffix) form is a pure function of the entry, so
 * re-deriving the same paper is stable.
 */
export function makeCitekey(
  entry: Pick<RefEntry, "authors" | "year" | "title">,
  taken: Set<string> = new Set(),
): string {
  const family = entry.authors?.[0] ?? "anon";
  const a = fold(family).replace(/[^a-z0-9]/g, "") || "anon";
  const yr = (entry.year ?? "").replace(/[^0-9]/g, "");
  // Keep the key filename-sane: trim the title segment so the whole key stays ≤ 60
  // chars WITHOUT ever dropping the year (the most identifying part).
  const words = shortTitle(entry.title ?? "").slice(0, Math.max(0, 60 - a.length - yr.length));
  const base = `${a}${words}${yr}` || "ref";
  const lcTaken = new Set<string>();
  for (const k of taken) lcTaken.add(k.toLowerCase());
  let key = base;
  let n = 0;
  while (lcTaken.has(key.toLowerCase())) key = base + alphaSuffix(++n);
  return key;
}

/**
 * LR-9: a normalized dedupe signature for entries that lack a DOI — first-author family + year +
 * the ascii-folded title (all non-alphanumerics dropped). Two records with the same signature are
 * the same work, so adding a paper WITHOUT a DOI and later WITH one no longer splits it into two
 * citekeys (which would fork its PDF + annotations). Returns null when there's too little to match
 * safely: a very short/empty title, or neither an author nor a year to anchor it.
 */
export function dupeSignature(entry: Pick<RefEntry, "authors" | "year" | "title">): string | null {
  const title = fold(entry.title ?? "").replace(/[^a-z0-9]+/g, "");
  if (title.length < 8) return null; // too short/generic to safely match on title alone
  const family = fold(entry.authors?.[0] ?? "").replace(/[^a-z0-9]/g, "");
  const yr = (entry.year ?? "").replace(/[^0-9]/g, "");
  if (!family && !yr) return null;
  return `${family}|${yr}|${title}`;
}
