// mtime-keyed parse cache for the enrichment sidecar (B1, the dominant scale wall):
// enrich.json is ~12MB at 1.7k papers and was fully JSON.parse'd on Library mount, on
// EVERY fluxLibRevision bump, and PER LOOKUP (every reader open / citing / similar /
// author action) — ~150ms of main-thread jank each, several copies resident. This
// module parses ONCE per actual file change: consumers share one Map keyed on the
// file's mtime+size; concurrent callers share one in-flight load.
//
// Factory-style (deps injected) so the cache logic is pure-testable; fluxlibBridge
// wires it to the real bridge and keeps `loadEnrichMap()` as the cached entry point.
// Locked read-modify-writes must NOT read through the cache (they need the freshest
// bytes inside their lock) — they use the fresh loader directly and `invalidate()`
// after writing.

import type { EnrichMap } from "./enrich";

export interface EnrichCacheDeps {
  /** enrich.json's absolute path, or null when no FluxLib is available. */
  path: () => Promise<string | null>;
  /** File identity for cache keying; null = file absent. */
  stat: (path: string) => Promise<{ mtimeMs: number; size: number } | null>;
  /** The real read+parse (quarantine-on-corrupt behavior lives here, unchanged). */
  load: () => Promise<EnrichMap>;
}

export interface EnrichCache {
  get(): Promise<EnrichMap>;
  getKey(key: string): Promise<EnrichMap[string] | undefined>;
  invalidate(): void;
}

export function createEnrichCache(deps: EnrichCacheDeps): EnrichCache {
  let cached: EnrichMap | null = null;
  let cacheKey = "";
  let inflight: Promise<EnrichMap> | null = null;

  async function get(): Promise<EnrichMap> {
    const p = await deps.path();
    if (!p) return {};
    const st = await deps.stat(p).catch(() => null);
    // No stat capability (older bridge / fixture) → no safe identity → stay fresh.
    if (st === null && cached === null) return deps.load();
    const key = st ? `${st.mtimeMs}:${st.size}` : "absent";
    if (cached && key === cacheKey) return cached;
    if (inflight) return inflight; // concurrent callers share one parse
    inflight = deps
      .load()
      .then((m) => {
        cached = m;
        cacheKey = key;
        return m;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    get,
    getKey: async (key) => (await get())[key],
    invalidate() {
      cached = null;
      cacheKey = "";
    },
  };
}
