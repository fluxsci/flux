// Pure join between RefEntry[] (from the .bib) and the derived EnrichEntry sidecar
// (~/FluxLib/.fluxlib/enrich.json), keyed by citekey. No I/O — both the Node engine
// and the renderer read their own enrich.json and call mergeEnrich for display/search.
import type { RefEntry, EnrichEntry } from "./types";

export type EnrichMap = Record<string, EnrichEntry>;

/** A RefEntry with its enrichment attached (if hydrated). */
export type EnrichedEntry<T extends RefEntry = RefEntry> = T & { enrich?: EnrichEntry };

/** Join enrichment onto entries by citekey. Absence of a match = "not hydrated yet". */
export function mergeEnrich<T extends RefEntry>(
  entries: T[],
  map: EnrichMap | null | undefined,
): EnrichedEntry<T>[] {
  if (!map) return entries as EnrichedEntry<T>[];
  return entries.map((e) => (map[e.key] ? { ...e, enrich: map[e.key] } : e));
}

/** Coverage rollup for `flux lib` / the Library header. */
export interface EnrichCoverage {
  total: number; // entries in the library
  hydrated: number; // entries with any enrichment
  withAbstract: number; // entries with a non-empty abstract
}

export function enrichCoverage(total: number, map: EnrichMap | null | undefined): EnrichCoverage {
  const vals = map ? Object.values(map) : [];
  return {
    total,
    hydrated: vals.length,
    withAbstract: vals.filter((v) => !!(v.abstract && v.abstract.length)).length,
  };
}

/** Aggregate the topic footprint of a hydrated set — handy for ranking/personalizing
 *  discovery (Part 2) and as the seed the deferred relevant-world finder would use. */
export function topicProfile(map: EnrichMap | null | undefined): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of map ? Object.values(map) : []) {
    for (const t of v.topics ?? []) {
      if (t.name) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// WS-8.3: the GRID projection of an enrichment entry — exactly the fields any
// renderer read path consumes (grid, hover cards, query haystacks, OA fetch
// gating). The heavy graph/edge fields (referencedWorks/relatedWorks/
// countsByYear/mesh/embedding) stay ONLY in the full enrich.json, which the
// locked writers keep parsing; the projected .fluxlib/enrich-grid.json is what
// display paths load (~an order of magnitude smaller). Shared by flux-core and
// the renderer bridge so both write funnels emit an identical projection.
export const GRID_ENRICH_FIELDS = [
  "key",
  "doi",
  "openalexId",
  "abstract",
  "primaryTopic",
  "topics",
  "keywords",
  "citedByCount",
  "openAccess",
  "authors",
  "ids",
  "fetchedAt",
  "sources",
] as const;

export function projectEnrichForGrid(map: EnrichMap): EnrichMap {
  const out: EnrichMap = {};
  for (const [k, e] of Object.entries(map)) {
    const slim: Record<string, unknown> = {};
    for (const f of GRID_ENRICH_FIELDS) {
      const v = (e as unknown as Record<string, unknown>)[f];
      if (v !== undefined) slim[f] = v;
    }
    out[k] = slim as unknown as EnrichMap[string];
  }
  return out;
}
