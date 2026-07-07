// Renderer-side enrichment + whole-world lookups — the browser/Electron twin of
// flux-core/enrich.ts. The renderer can't fetch cross-origin, so OpenAlex calls go
// through window.fig.fetchOpenAlex (main, no CORS); the SAME pure mappers + URL
// builders in ./openalex are used on both sides so they can't drift. CrossRef
// abstract backfill reuses the existing fetchDoi bridge.
import { fileBridge, joinPath } from "../project/types";
import { resolveFluxLibPath, loadFluxLib, loadEnrichMap, loadEnrichMapFresh, invalidateEnrichCache } from "./fluxlibBridge";
import { withIpcLock } from "./libLock";
import { bumpFluxLib } from "./revision";
import type { EnrichMap } from "./enrich";
import {
  ENRICH_SELECT,
  BRIEF_SELECT,
  batchByDoiUrl,
  worldSearchUrl,
  worldSemanticUrl,
  authorWorksUrl,
  citingWorksUrl,
  worksByIdsUrl,
  workToEnrich,
  workToBrief,
  bareDoi,
  type WorldBrief,
} from "./openalex";
import {
  s2PaperId,
  s2RecommendationsUrl,
  s2CitationsUrl,
  s2ToBrief,
  s2CitationToBrief,
} from "./semanticscholar";

/* eslint-disable @typescript-eslint/no-explicit-any */

async function getMailto(): Promise<string | undefined> {
  try {
    const p = await fileBridge()?.prefsGet?.();
    const m = p?.fluxMailto;
    return typeof m === "string" && m.trim() ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch an OpenAlex URL through main; throws on a bridge/HTTP error. */
async function fetchOA(url: string): Promise<any> {
  const fb = fileBridge();
  if (!fb?.fetchOpenAlex) throw new Error("OpenAlex fetch needs the desktop app.");
  const r = (await fb.fetchOpenAlex(url)) as any;
  if (r && r.error) throw new Error(String(r.error));
  return r;
}

export interface HydrateResult {
  total: number;
  candidates: number;
  fetched: number;
  crossrefBackfill: number;
  hydrated: number;
  withAbstract: number;
}

/**
 * Hydrate FluxLib from OpenAlex into `<lib>/.fluxlib/enrich.json` (the .bib is never
 * touched). Incremental by default; `refresh` re-fetches all. Reports progress per
 * batch. Bumps fluxLibRevision so open surfaces pick up the enrichment.
 */
export async function hydrateFluxLib(
  opts: { refresh?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<HydrateResult> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const blank: HydrateResult = {
    total: 0,
    candidates: 0,
    fetched: 0,
    crossrefBackfill: 0,
    hydrated: 0,
    withAbstract: 0,
  };
  if (!fb || !lib) return blank;

  const mailto = await getMailto();
  const entries = await loadFluxLib();
  const existing = await loadEnrichMap();

  let targets = entries.filter((e) => e.doi);
  if (!opts.refresh) targets = targets.filter((e) => !existing[e.key]);

  const doiToKey = new Map<string, string>();
  for (const e of targets) if (e.doi) doiToKey.set(e.doi.toLowerCase(), e.key);

  const map: EnrichMap = { ...existing };
  const delta: EnrichMap = {}; // only this run's fetched/updated keys (W3 merge unit)
  const now = new Date().toISOString();
  let fetched = 0;

  const urls = batchByDoiUrl(
    targets.map((e) => e.doi as string),
    { mailto, select: ENRICH_SELECT },
  );
  let done = 0;
  let failedBatches = 0;
  let lastBatchErr: unknown;
  for (const url of urls) {
    try {
      const json = await fetchOA(url);
      for (const w of json?.results ?? []) {
        const doi = bareDoi(w?.doi);
        const key = doi ? doiToKey.get(doi) : undefined;
        if (!key) continue;
        const en = workToEnrich(w, key);
        en.fetchedAt = now;
        map[key] = en;
        delta[key] = en;
        fetched++;
      }
    } catch (e) {
      // Skip a failed batch — others still proceed — but count it: a fully
      // failed run (offline, bad key) must surface as an error, not "Enriched 0".
      failedBatches++;
      lastBatchErr = e;
    }
    done++;
    // Entry-based progress (batches are 50 DOIs each) — "150/1713" is honest;
    // the old batch counts ("3/35") read like entries and undersold a hydrate.
    opts.onProgress?.(Math.min(done * 50, targets.length), targets.length);
  }
  if (urls.length > 0 && failedBatches === urls.length) {
    const detail = lastBatchErr instanceof Error ? lastBatchErr.message : String(lastBatchErr);
    throw new Error(`Enrichment failed — all ${urls.length} OpenAlex batches errored (${detail})`);
  }

  // CrossRef abstract backfill (reuse the existing fetchDoi bridge). Paced at 60ms
  // between calls like the flux-core twin — a first hydrate of a 1,700-entry library
  // must not hammer api.crossref.org back-to-back.
  let crossrefBackfill = 0;
  for (const e of targets) {
    const en = map[e.key];
    if (en && !en.abstract && e.doi && fb.fetchDoi) {
      await new Promise((r) => setTimeout(r, 60));
      try {
        const r = (await fb.fetchDoi(e.doi)) as any;
        const ab = r?.message?.abstract;
        if (ab && typeof ab === "string") {
          const clean = ab.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
          if (clean) {
            en.abstract = clean;
            if (!en.sources.includes("crossref")) en.sources.push("crossref");
            delta[e.key] = en;
            crossrefBackfill++;
          }
        }
      } catch {
        /* best-effort */
      }
    }
  }

  // W3: merge only this run's delta under the FluxLib "enrich" lock — the fetch
  // loop above can run for minutes, and a whole-map write here would clobber
  // whatever another process (CLI hydrate, a second window) enriched meanwhile.
  if (Object.keys(delta).length) {
    await withIpcLock("fluxlib", "enrich", async () => {
      // Fresh read INSIDE the lock (never the mtime cache), invalidate after writing.
      const freshMap = await loadEnrichMapFresh();
      await fb.writeText(
        joinPath(lib, ".fluxlib", "enrich.json"),
        JSON.stringify({ ...freshMap, ...delta }, null, 2) + "\n",
      );
      invalidateEnrichCache();
    });
  }
  bumpFluxLib(); // refresh editor surfaces with the enrichment

  const vals = Object.values(map);
  return {
    total: entries.length,
    candidates: targets.length,
    fetched,
    crossrefBackfill,
    hydrated: vals.length,
    withAbstract: vals.filter((v) => !!(v.abstract && v.abstract.length)).length,
  };
}

// --- whole-world lookups (Part 2) — return brief records for display/add ----

export async function searchWorld(
  query: string,
  opts: { sort?: string; perPage?: number; page?: number } = {},
): Promise<WorldBrief[]> {
  const json = await fetchOA(
    worldSearchUrl(query, { sort: opts.sort, perPage: opts.perPage, page: opts.page, mailto: await getMailto() }),
  );
  return (json?.results ?? []).map(workToBrief);
}

/** Works that cite a hydrated FluxLib entry (by citekey). */
export async function citingWorksByKey(
  key: string,
  opts: { sort?: string; perPage?: number; page?: number } = {},
): Promise<WorldBrief[]> {
  const id = (await loadEnrichMap())[key]?.openalexId;
  if (!id) throw new Error("Enrich this entry first to look up citers.");
  const json = await fetchOA(
    citingWorksUrl(id, { sort: opts.sort, perPage: opts.perPage, page: opts.page, mailto: await getMailto() }),
  );
  return (json?.results ?? []).map(workToBrief);
}

/** Other works by a hydrated entry's first author (by citekey). */
export async function authorWorksByKey(
  key: string,
  opts: { perPage?: number; page?: number } = {},
): Promise<WorldBrief[]> {
  const id = (await loadEnrichMap())[key]?.authors?.[0]?.openalexId;
  if (!id) throw new Error("Enrich this entry first to look up the author's works.");
  const json = await fetchOA(
    authorWorksUrl(id, { perPage: opts.perPage, page: opts.page, mailto: await getMailto() }),
  );
  return (json?.results ?? []).map(workToBrief);
}

/** OpenAlex SEMANTIC discovery (search.semantic). ≤50 hits, 1 req/s; 'citations'
 *  sorts the returned set client-side. */
export async function searchWorldSemantic(
  text: string,
  opts: { sort?: "relevance" | "citations"; perPage?: number } = {},
): Promise<WorldBrief[]> {
  const json = await fetchOA(worldSemanticUrl(text, { perPage: opts.perPage ?? 50, mailto: await getMailto() }));
  let out: WorldBrief[] = (json?.results ?? []).map(workToBrief);
  if (opts.sort === "citations") out = [...out].sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0));
  return out;
}

/** OpenAlex semantic "more like this" for a library entry (seeded from title+abstract). */
export async function similarOpenAlexByKey(
  key: string,
  opts: { sort?: "relevance" | "citations" } = {},
): Promise<WorldBrief[]> {
  const [entries, map] = await Promise.all([loadFluxLib(), loadEnrichMap()]);
  const e = entries.find((x) => x.key === key);
  const seed = [e?.title, map[key]?.abstract].filter(Boolean).join(". ");
  if (!seed.trim()) throw new Error("Enrich this entry first (needs a title/abstract).");
  const out = await searchWorldSemantic(seed, { sort: opts.sort, perPage: 50 });
  const selfDoi = e?.doi?.toLowerCase();
  return selfDoi ? out.filter((b) => b.doi?.toLowerCase() !== selfDoi) : out;
}

// --- Semantic Scholar (over the cite:s2 IPC; x-api-key attached in main) ----

async function fetchS2(url: string): Promise<any> {
  const fb = fileBridge();
  if (!fb?.fetchS2) throw new Error("Semantic Scholar needs the desktop app.");
  const r = (await fb.fetchS2(url)) as any;
  if (r && r.error) {
    throw new Error(
      /429/.test(String(r.error))
        ? "Semantic Scholar rate-limited — add a free S2 key in ⚙ Keys."
        : String(r.error),
    );
  }
  return r;
}
async function doiForKey(key: string): Promise<string | undefined> {
  const [entries, map] = await Promise.all([loadFluxLib(), loadEnrichMap()]);
  return entries.find((e) => e.key === key)?.doi || (map[key]?.doi as string | undefined);
}

/** S2 SPECTER2 recommendations ("papers like this") for a library entry. */
export async function s2SimilarByKey(key: string): Promise<WorldBrief[]> {
  const id = s2PaperId({ doi: await doiForKey(key) });
  if (!id) throw new Error("Need a DOI on this entry to query Semantic Scholar.");
  const json = await fetchS2(s2RecommendationsUrl(id, { limit: 40 }));
  return (json?.recommendedPapers ?? []).map(s2ToBrief);
}

/** S2 citing papers WITH citation contexts + influential flags, for a library entry. */
export async function s2CitingByKey(key: string): Promise<WorldBrief[]> {
  const id = s2PaperId({ doi: await doiForKey(key) });
  if (!id) throw new Error("Need a DOI on this entry to query Semantic Scholar.");
  const json = await fetchS2(s2CitationsUrl(id, { limit: 50 }));
  return (json?.data ?? []).map(s2CitationToBrief);
}

/** Related papers for a hydrated entry (OpenAlex precomputed similarity). */
export async function relatedWorksByKey(key: string): Promise<WorldBrief[]> {
  const ids = (await loadEnrichMap())[key]?.relatedWorks;
  if (!ids?.length) return [];
  const mailto = await getMailto();
  const out: WorldBrief[] = [];
  for (const url of worksByIdsUrl(ids, { mailto, select: BRIEF_SELECT })) {
    const json = await fetchOA(url);
    out.push(...(json?.results ?? []).map(workToBrief));
  }
  return out;
}

/** The works a hydrated entry CITES (its OpenAlex referenced_works) — the reference
 *  list, resolved to brief records. Order is preserved (batched in ≤50s by OpenAlex).
 *  Backs the FluxReader reference sidebar. */
export async function referencedWorksByKey(key: string): Promise<WorldBrief[]> {
  const ids = (await loadEnrichMap())[key]?.referencedWorks;
  if (!ids?.length) return [];
  const mailto = await getMailto();
  const byId = new Map<string, WorldBrief>();
  for (const url of worksByIdsUrl(ids, { mailto, select: BRIEF_SELECT })) {
    const json = await fetchOA(url);
    for (const w of json?.results ?? []) {
      const b = workToBrief(w);
      if (b.openalexId) byId.set(b.openalexId, b);
    }
  }
  // Preserve the citing order from referenced_works.
  return ids.map((id) => byId.get(id)).filter((b): b is WorldBrief => !!b);
}
