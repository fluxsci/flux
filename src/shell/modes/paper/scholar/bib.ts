// Bibliography store. Parsing (BibTeX → entries), DOI fetch and autocomplete are
// filled in by B5; this module owns the entry shape, lookups, and inline-citation
// formatting used by the cite chips and the References preview.

import { get, writable } from "svelte/store";
import type { RefEntry } from "../../../../lib/references/types";

// The scholar UI's entry type IS the shared reference entry — one definition
// across the editor, FluxLib, and flux-core (CLI/MCP).
export type BibEntry = RefEntry;

export const bibEntries = writable<BibEntry[]>([]);

// M12: surfaces a non-blocking notice when library.bib fails to parse (so a
// corrupt file doesn't silently yield zero citations). null = no problem.
export const bibError = writable<string | null>(null);

// PAP-22: index entries by citekey so cite chips resolve in O(1) instead of a linear `find`
// per key per chip per rebuild (chips rebuild on every keystroke over the visible range, and
// a bib can hold the whole cited FluxLib subset). Subscribing keeps it current across every set.
let entryByKey = new Map<string, BibEntry>();
bibEntries.subscribe((entries) => {
  const m = new Map<string, BibEntry>();
  for (const e of entries) if (!m.has(e.key)) m.set(e.key, e); // first-match, mirrors find()
  entryByKey = m;
});

export function bibEntry(key: string): BibEntry | undefined {
  return entryByKey.get(key);
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
