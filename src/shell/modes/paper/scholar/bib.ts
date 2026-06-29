// Bibliography store. Parsing (BibTeX → entries), DOI fetch and autocomplete are
// filled in by B5; this module owns the entry shape, lookups, and inline-citation
// formatting used by the cite chips and the References preview.

import { get, writable } from "svelte/store";

export interface BibEntry {
  key: string;
  title: string;
  authors: string[]; // family names, in order
  year: string;
  container?: string; // journal / venue
  doi?: string;
  url?: string;
  raw?: string; // the original BibTeX entry text
}

export const bibEntries = writable<BibEntry[]>([]);

// M12: surfaces a non-blocking notice when library.bib fails to parse (so a
// corrupt file doesn't silently yield zero citations). null = no problem.
export const bibError = writable<string | null>(null);

export function bibEntry(key: string): BibEntry | undefined {
  return get(bibEntries).find((e) => e.key === key);
}

/** "Smith" | "Smith & Jones" | "Smith et al." */
function authorLabel(e: BibEntry): string {
  const a = e.authors;
  if (!a || a.length === 0) return e.key;
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} & ${a[1]}`;
  return `${a[0]} et al.`;
}

/** Format an in-text citation for one or more keys: "(Smith et al., 2021)". */
export function resolveCite(keys: string[]): string | null {
  const entries = keys.map((k) => bibEntry(k)).filter(Boolean) as BibEntry[];
  if (entries.length === 0) return null;
  const inner = entries
    .map((e) => `${authorLabel(e)}${e.year ? ", " + e.year : ""}`)
    .join("; ");
  return `(${inner})`;
}

export function citeAuthorLabel(e: BibEntry): string {
  return authorLabel(e);
}

export function __seedBib(entries: BibEntry[]) {
  bibEntries.set(entries);
}
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__fluxSeedBib = __seedBib;
  (window as unknown as Record<string, unknown>).__fluxBib = {
    entries: () => get(bibEntries),
    keys: () => get(bibEntries).map((e) => e.key),
  };
}
