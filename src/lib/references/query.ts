// Structured reference-search query (`author:smith year:2020 journal:nature`)
// over RefEntry[]. Pure + unit-testable; the single implementation behind the GUI
// Reference Search pane and the agent `search_references` tool / `flux search`
// CLI verb — so all of them share identical semantics.
import type { RefEntry, EnrichEntry } from "./types";

export type Field =
  | "author"
  | "year"
  | "journal"
  | "title"
  | "doi"
  | "abstract"
  | "keyword"
  | "topic"
  | "tag"
  | "status"
  | "collection"
  | "any";

export interface Clause {
  field: Field;
  value: string;
}

const FIELD_ALIASES: Record<string, Field> = {
  author: "author",
  authors: "author",
  au: "author",
  year: "year",
  yr: "year",
  journal: "journal",
  venue: "journal",
  container: "journal",
  title: "title",
  ti: "title",
  doi: "doi",
  abstract: "abstract",
  abs: "abstract",
  keyword: "keyword",
  keywords: "keyword",
  kw: "keyword",
  topic: "topic",
  // 3.3 library organization
  tag: "tag",
  tags: "tag",
  status: "status",
  read: "status",
  collection: "collection",
  collections: "collection",
  coll: "collection",
};

/** True when the text reads as a structured query (has a known `field:` token). */
export function isStructured(q: string): boolean {
  return /(?:^|\s)(?:author|authors|au|year|yr|journal|venue|container|title|ti|doi|tag|tags|status|read|collection|collections|coll):/i.test(q);
}

// 2.3 Full-text search lives OUTSIDE the metadata grammar: `fulltext:`/`ft:`/`text:`
// can't be answered from a RefEntry — it needs a disk scan of items/*/fulltext.txt.
// The prefix switches the Library into full-text mode; everything after it is the
// full-text query (handed verbatim to flux-core parseQueryTerms — quotes ⇒ phrases,
// bare words ⇒ AND terms), and any metadata clauses BEFORE it (`author:smith ft:…`)
// restrict the scan's scope. Positional-tail capture keeps the common
// "which papers mention X Y" case prefix-once, not prefix-per-word.
const FULLTEXT_PREFIX = /(?:^|\s)(?:fulltext|ft|text):/i;

/** True when the query requests a full-text scan (`ft:` / `fulltext:` / `text:`). */
export function hasFulltext(q: string): boolean {
  return FULLTEXT_PREFIX.test(q);
}

/** Split a raw query into its full-text tail and the leading metadata scope. */
export function extractFulltext(q: string): { fulltext: string; rest: string } {
  const m = FULLTEXT_PREFIX.exec(q);
  if (!m) return { fulltext: "", rest: q };
  const valueStart = m.index + m[0].length;
  return { fulltext: q.slice(valueStart).trim(), rest: q.slice(0, m.index).trim() };
}

/** Split on whitespace (quote-aware); each token splits on its first ":". A quoted value
 *  may follow a field prefix (`collection:"to read"`, `journal:"nature neuroscience"`) or
 *  stand alone (`"exact phrase"`) — both keep their internal spaces as one token. */
export function parseQuery(q: string): Clause[] {
  const tokens = q.match(/[^\s:"]+:"[^"]*"|"[^"]*"|\S+/g) ?? [];
  const clauses: Clause[] = [];
  for (const raw of tokens) {
    const tok = raw.replace(/"/g, "");
    const colon = tok.indexOf(":");
    if (colon > 0) {
      const key = tok.slice(0, colon).toLowerCase();
      const field = FIELD_ALIASES[key];
      if (field) {
        const value = tok.slice(colon + 1).trim();
        if (value) clauses.push({ field, value });
        continue;
      }
    }
    if (tok.trim()) clauses.push({ field: "any", value: tok.trim() });
  }
  return clauses;
}

/** WS-8.1: the "any"-clause haystack for one entry — the exact concat
 *  clauseMatches builds, factored so it can be PRECOMPUTED once per entry
 *  instead of per entry × per keystroke (the measured query hot path). */
function buildHay(e: RefEntry): string {
  const en = (e as { enrich?: EnrichEntry }).enrich;
  const topicText = [en?.primaryTopic?.name, ...(en?.topics ?? []).map((t) => t.name)]
    .filter(Boolean)
    .join(" ");
  return [
    e.title,
    e.authors.join(" "),
    e.container ?? "",
    e.year,
    e.key,
    e.doi ?? "",
    en?.abstract ?? "",
    (en?.keywords ?? []).join(" "),
    topicText,
  ]
    .join(" ")
    .toLowerCase();
}

/** WS-8.1: stamp a non-enumerable `_hay` (lowercased "any" haystack) on each
 *  entry so free-text matching is one precomputed `includes` instead of a
 *  9-field join+lowercase per entry per keystroke. Non-enumerable: invisible
 *  to JSON/structuredClone, so persisted shapes are untouched. Call it where
 *  the merged entry array is (re)built — stale hays cannot outlive the entry
 *  objects they are stamped on. Returns the same array. */
export function attachHaystacks<T extends RefEntry>(entries: T[]): T[] {
  for (const e of entries) {
    Object.defineProperty(e, "_hay", { value: buildHay(e), enumerable: false, configurable: true, writable: true });
  }
  return entries;
}

function clauseMatches(e: RefEntry, c: Clause): boolean {
  const v = c.value.toLowerCase();
  // Enriched fields (abstract/keywords/topics) are matched when the entry has been
  // hydrated — see EnrichEntry. Absent on a bare RefEntry; accessed structurally so
  // runQuery stays generic over plain or enriched entries.
  const en = (e as { enrich?: EnrichEntry }).enrich;
  // 3.3: organize data (tags/status/collections) merged onto the entry when present.
  const org = (e as { organize?: { tags?: string[]; status?: string; collections?: string[] } }).organize;
  const topicText = () =>
    [en?.primaryTopic?.name, ...(en?.topics ?? []).map((t) => t.name)].filter(Boolean).join(" ");
  switch (c.field) {
    case "tag":
      return (org?.tags ?? []).some((t) => t.toLowerCase() === v || t.toLowerCase().includes(v));
    case "status":
      return (org?.status ?? "unread").toLowerCase() === v;
    case "collection":
      return (org?.collections ?? []).some((cl) => cl.toLowerCase() === v || cl.toLowerCase().includes(v));
    case "author":
      return e.authors.join(" ").toLowerCase().includes(v);
    case "journal":
      return (e.container ?? "").toLowerCase().includes(v);
    case "title":
      return e.title.toLowerCase().includes(v);
    case "doi":
      return (e.doi ?? "").toLowerCase().includes(v);
    case "abstract":
      return (en?.abstract ?? "").toLowerCase().includes(v);
    case "keyword":
      return (en?.keywords ?? []).join(" ").toLowerCase().includes(v);
    case "topic":
      return topicText().toLowerCase().includes(v);
    case "year":
      return /^\d{4}$/.test(c.value) ? e.year === c.value : e.year.startsWith(c.value);
    case "any":
    default: {
      // WS-8.1: use the precomputed haystack when the caller attached one.
      const hay = (e as { _hay?: string })._hay;
      return (typeof hay === "string" ? hay : buildHay(e)).includes(v);
    }
  }
}

export function matchEntry(e: RefEntry, clauses: Clause[]): boolean {
  return clauses.every((c) => clauseMatches(e, c));
}

/** WS-8.1: a stateful query runner with incremental REFINEMENT — when the new
 *  query extends the previous one and both are pure free-text (every clause
 *  "any": each typed character only narrows the match set), the scan pool is
 *  the previous matches instead of the whole library. The pool is re-filtered
 *  in ORIGINAL entry order (Set membership, O(1)/entry) so ranking tie-order
 *  is IDENTICAL to a from-scratch runQuery — the pure gate asserts equality.
 *  Any change to the entries array identity, a structured/fulltext query, or a
 *  non-extending edit falls back to the full scan. */
export function createQueryRunner<T extends RefEntry>(): (entries: T[], q: string) => T[] {
  let lastEntries: T[] | null = null;
  let lastQ = "";
  let lastMatches: Set<T> | null = null;
  return (entries, q) => {
    const freeText = (s: string) => !isStructured(s) && !hasFulltext(s);
    const refinable =
      lastEntries === entries &&
      lastMatches !== null &&
      lastQ !== "" &&
      q.startsWith(lastQ) &&
      freeText(q) &&
      freeText(lastQ);
    const pool = refinable ? entries.filter((e) => lastMatches!.has(e)) : entries;
    const out = runQuery(pool, q);
    lastEntries = entries;
    lastQ = q;
    lastMatches = new Set(out);
    return out;
  };
}

/** Filter + light relevance ranking (author/title/journal prefix hits float up). */
export function runQuery<T extends RefEntry>(entries: T[], q: string): T[] {
  const clauses = parseQuery(q);
  if (!clauses.length) return entries;
  const scored = entries
    .filter((e) => matchEntry(e, clauses))
    .map((e) => {
      let score = 0;
      for (const c of clauses) {
        const hay =
          c.field === "author"
            ? e.authors.join(" ")
            : c.field === "title"
              ? e.title
              : c.field === "journal"
                ? e.container ?? ""
                : "";
        if (hay.toLowerCase().startsWith(c.value.toLowerCase())) score += 2;
      }
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.e);
}
