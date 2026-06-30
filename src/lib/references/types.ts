// The shared reference-entry shape. One definition, imported by the renderer's
// scholar UI (scholar/bib.ts re-exports it as BibEntry), by flux-core (CLI/MCP),
// and by the FluxLib engine. Kept dependency-free so it imports cleanly in both
// the browser and Node.
export interface RefEntry {
  key: string;
  title: string;
  authors: string[]; // family names, in order
  year: string;
  container?: string; // journal / venue
  doi?: string;
  url?: string;
  raw?: string; // the original BibTeX entry text
}

/** Result of adding BibTeX to FluxLib (shared by the Node engine + renderer adapter). */
export interface AddResult {
  added: RefEntry[]; // newly written (with resolved keys)
  deduped: RefEntry[]; // already present (matched by DOI) — existing keys
  keys: string[]; // resolved keys for ALL incoming entries, in order
}

/** One classification node (topic / subfield / field / domain) from OpenAlex. */
export interface EnrichTopic {
  id: string;
  name: string;
  score?: number;
  subfield?: string;
  field?: string;
  domain?: string;
}

/**
 * Derived Tier-1/2 enrichment for a FluxLib entry, keyed by citekey and stored in
 * the rebuildable sidecar `~/FluxLib/.fluxlib/enrich.json` — NOT in the canonical
 * `.bib`. Sourced primarily from OpenAlex (abstract, topics, citation graph, IDs),
 * with CrossRef abstract backfill. Everything past `key` is optional: absence just
 * means "not hydrated yet". `embedding` is RESERVED for the (deferred) semantic-
 * search work. Kept dependency-free (imports cleanly in browser + Node).
 */
export interface EnrichEntry {
  key: string; // citekey — the join key to RefEntry / the .bib
  doi?: string;
  openalexId?: string; // short form, e.g. "W2741809807"
  abstract?: string; // reconstructed from OpenAlex abstract_inverted_index
  primaryTopic?: EnrichTopic;
  topics?: EnrichTopic[];
  keywords?: string[];
  mesh?: string[];
  citedByCount?: number;
  countsByYear?: { year: number; cited: number }[];
  referencedWorks?: string[]; // OpenAlex work IDs (out-edges — the local half of the graph)
  relatedWorks?: string[]; // OpenAlex work IDs (precomputed similar)
  openAccess?: { isOa: boolean; status?: string; url?: string };
  authors?: { name: string; openalexId?: string; orcid?: string }[];
  ids?: { pmid?: string; pmcid?: string; mag?: string };
  embedding?: number[]; // RESERVED — empty for now (deferred semantic search)
  fetchedAt: string; // ISO timestamp of the hydration
  sources: string[]; // provenance, e.g. ["openalex","crossref"]
}
