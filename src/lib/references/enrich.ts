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
