// Structured reference-search query (Redesign v2): `author:smith year:2020
// journal:nature` over the parsed .bib. Pure + unit-testable; backs the
// Reference Search pane and the omnibox auto-route.

import type { BibEntry } from "../../scholar/bib";

export type Field = "author" | "year" | "journal" | "title" | "doi" | "any";

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
};

/** True when the text reads as a structured query (has a known `field:` token). */
export function isStructured(q: string): boolean {
  return /(?:^|\s)(?:author|authors|au|year|yr|journal|venue|container|title|ti|doi):/i.test(q);
}

/** Split on whitespace (quote-aware); each token splits on its first ":". */
export function parseQuery(q: string): Clause[] {
  const tokens = q.match(/"[^"]*"|\S+/g) ?? [];
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

function clauseMatches(e: BibEntry, c: Clause): boolean {
  const v = c.value.toLowerCase();
  switch (c.field) {
    case "author":
      return e.authors.join(" ").toLowerCase().includes(v);
    case "journal":
      return (e.container ?? "").toLowerCase().includes(v);
    case "title":
      return e.title.toLowerCase().includes(v);
    case "doi":
      return (e.doi ?? "").toLowerCase().includes(v);
    case "year":
      return /^\d{4}$/.test(c.value) ? e.year === c.value : e.year.startsWith(c.value);
    case "any":
    default:
      return [e.title, e.authors.join(" "), e.container ?? "", e.year, e.key, e.doi ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(v);
  }
}

export function matchEntry(e: BibEntry, clauses: Clause[]): boolean {
  return clauses.every((c) => clauseMatches(e, c));
}

/** Filter + light relevance ranking (author/title prefix hits float up). */
export function runQuery(entries: BibEntry[], q: string): BibEntry[] {
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
