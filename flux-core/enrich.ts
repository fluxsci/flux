// flux-core/enrich.ts — hydrate the FluxLib personal library with OpenAlex Tier-1/2
// metadata, and serve whole-world lookups (search / author / cites / related).
//
// Node side: used by the CLI (`flux hydrate`, world verbs) and the MCP tools. The
// GUI does the same work over the cite:openalex IPC, but BOTH go through the SAME
// pure mappers + URL builders in src/lib/references/openalex.ts so they can't drift
// (mirrors the fluxlib.ts / fluxlibBridge.ts split). OpenAlex needs no key — only a
// polite `mailto` (env FLUX_MAILTO → preferences.fluxMailto). CrossRef backfills
// abstracts OpenAlex is missing.
import type { EnrichEntry } from "../src/lib/references/types";
import type { EnrichMap } from "../src/lib/references/enrich";
import { enrichCoverage } from "../src/lib/references/enrich";
import {
  OPENALEX_WORKS,
  ENRICH_SELECT,
  BRIEF_SELECT,
  bareDoi,
  shortId,
  workToEnrich,
  workToBrief,
  batchByDoiUrl,
  worldSearchUrl,
  worldSemanticUrl,
  authorWorksUrl,
  citingWorksUrl,
  worksByIdsUrl,
  type WorldBrief,
} from "../src/lib/references/openalex";
import {
  ensureFluxLib,
  loadLibrary,
  loadEnrich,
  mergeEnrichDelta,
  getPreferences,
  getSecret,
} from "./fluxlib";

const UA = "Flux/0.1 (reference hydration; +https://github.com/fluxsci/flux)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */

async function politeMailto(): Promise<string | undefined> {
  return (await getSecret("mailto")) || ((await getPreferences()).fluxMailto as string) || undefined;
}

/** GET an OpenAlex URL as JSON, appending the free `api_key` (10× budget) when set.
 *  On a 400 with a `select=` (an unknown field), retry once without `select`. */
async function fetchWorks(url: string): Promise<any> {
  const key = await getSecret("openAlexKey");
  let target = url;
  if (key && !/[?&]api_key=/.test(target)) {
    target += (target.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(key);
  }
  let res = await fetch(target, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 400 && /[?&]select=/.test(target)) {
    const u2 = target.replace(/([?&])select=[^&]*(?:&|$)/, (_m, p1) => p1).replace(/[?&]$/, "");
    res = await fetch(u2, { headers: { "User-Agent": UA, Accept: "application/json" } });
  }
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  return res.json();
}

/** CrossRef abstract (JATS) for a DOI, tags stripped — the backfill for the ~40% of
 *  OpenAlex works without an abstract. Best-effort; returns undefined on any failure. */
async function crossrefAbstract(doi: string, mailto?: string): Promise<string | undefined> {
  try {
    const url =
      `https://api.crossref.org/works/${encodeURIComponent(doi)}` +
      (mailto ? `?mailto=${encodeURIComponent(mailto)}` : "");
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return undefined;
    const j = await res.json();
    const ab = j?.message?.abstract;
    if (!ab || typeof ab !== "string") return undefined;
    return ab.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface HydrateResult {
  total: number; // entries in the library
  candidates: number; // entries targeted this run (have a DOI; not already done unless --refresh)
  fetched: number; // entries matched + mapped from OpenAlex this run
  crossrefBackfill: number; // abstracts filled from CrossRef
  hydrated: number; // entries with any enrichment after this run
  withAbstract: number; // entries with an abstract after this run
  missing: string[]; // targeted citekeys OpenAlex returned nothing for
}

/**
 * Hydrate FluxLib entries from OpenAlex into the rebuildable sidecar
 * `<FluxLib>/.fluxlib/enrich.json`. Incremental by default (skips already-hydrated
 * entries); `refresh` re-fetches all; `key` limits to one citekey. Never touches the
 * `.bib`. Batches 50 DOIs/request; polite delays between calls.
 */
export async function hydrateLibrary(
  opts: { refresh?: boolean; key?: string; libPath?: string } = {},
): Promise<HydrateResult> {
  const lib = await ensureFluxLib(opts.libPath);
  const entries = await loadLibrary(lib);
  const mailto = await politeMailto();
  const existing = await loadEnrich(lib);

  let targets = entries.filter((e) => e.doi);
  if (opts.key) targets = targets.filter((e) => e.key === opts.key);
  if (!opts.refresh) targets = targets.filter((e) => !existing[e.key]);

  const doiToKey = new Map<string, string>();
  for (const e of targets) if (e.doi) doiToKey.set(e.doi.toLowerCase(), e.key);

  const map: EnrichMap = { ...existing };
  const delta: EnrichMap = {}; // only this run's fetched/updated keys (W3 merge unit)
  const now = new Date().toISOString();
  let fetched = 0;

  for (const url of batchByDoiUrl(targets.map((e) => e.doi as string), { mailto, select: ENRICH_SELECT })) {
    let json: any;
    try {
      json = await fetchWorks(url);
    } catch {
      continue; // skip a failed batch; others still proceed
    }
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
    await sleep(120); // ≤10 req/s polite pool
  }

  // CrossRef abstract backfill for hydrated-but-abstract-less targets.
  let crossrefBackfill = 0;
  for (const e of targets) {
    const en = map[e.key];
    if (en && !en.abstract && e.doi) {
      const ab = await crossrefAbstract(e.doi, mailto);
      if (ab) {
        en.abstract = ab;
        if (!en.sources.includes("crossref")) en.sources.push("crossref");
        delta[e.key] = en;
        crossrefBackfill++;
      }
      await sleep(60);
    }
  }

  // W3: merge only this run's delta under the "enrich" lock — the network loop
  // above can take minutes, and a whole-map write here would clobber anything
  // another process (the app, a second CLI) enriched meanwhile.
  await mergeEnrichDelta(delta, lib);
  const cov = enrichCoverage(entries.length, map);
  return {
    total: entries.length,
    candidates: targets.length,
    fetched,
    crossrefBackfill,
    hydrated: cov.hydrated,
    withAbstract: cov.withAbstract,
    missing: targets.filter((e) => !map[e.key]).map((e) => e.key),
  };
}

// --- whole-world lookups (Part 2) -------------------------------------------
// Each accepts an OpenAlex id directly, or a FluxLib citekey (resolved via the
// enrich sidecar — so an agent can say "papers citing @lecun2015deep").

const isWid = (s: string) => /^W\d+$/i.test(s);
const isAid = (s: string) => /^A\d+$/i.test(s);

async function enrichFor(key: string, libPath?: string): Promise<EnrichEntry | undefined> {
  return (await loadEnrich(libPath))[key];
}

/** Full-text discovery across all of OpenAlex. sort: undefined=relevance |
 *  "cited_by_count:desc" | "publication_date:desc". */
export async function searchWorld(
  query: string,
  opts: { sort?: string; perPage?: number; page?: number } = {},
): Promise<WorldBrief[]> {
  const mailto = await politeMailto();
  const json = await fetchWorks(
    worldSearchUrl(query, { sort: opts.sort, perPage: opts.perPage, page: opts.page, mailto }),
  );
  return (json?.results ?? []).map(workToBrief);
}

/** Other works by an author — `ref` is an OpenAlex author id (A…) or a FluxLib
 *  citekey (uses its first author). */
export async function authorWorks(
  ref: string,
  opts: { sort?: string; perPage?: number; libPath?: string } = {},
): Promise<WorldBrief[]> {
  let authorId: string | undefined = isAid(ref) ? ref : undefined;
  if (!authorId) authorId = (await enrichFor(ref, opts.libPath))?.authors?.[0]?.openalexId;
  if (!authorId) throw new Error(`no OpenAlex author id for "${ref}" (hydrate the entry first)`);
  const mailto = await politeMailto();
  const json = await fetchWorks(authorWorksUrl(authorId, { sort: opts.sort, perPage: opts.perPage, mailto }));
  return (json?.results ?? []).map(workToBrief);
}

/** Works that cite this one — `ref` is an OpenAlex work id (W…) or a FluxLib citekey. */
export async function citingWorks(
  ref: string,
  opts: { sort?: string; perPage?: number; libPath?: string } = {},
): Promise<WorldBrief[]> {
  let workId: string | undefined = isWid(ref) ? ref : undefined;
  if (!workId) workId = (await enrichFor(ref, opts.libPath))?.openalexId;
  if (!workId) throw new Error(`no OpenAlex id for "${ref}" (hydrate the entry first)`);
  const mailto = await politeMailto();
  const json = await fetchWorks(citingWorksUrl(workId, { sort: opts.sort, perPage: opts.perPage, mailto }));
  return (json?.results ?? []).map(workToBrief);
}

/** Related papers (OpenAlex precomputed similarity) — `ref` is a work id (W…, fetched
 *  on demand) or a FluxLib citekey (uses the related_works stored at hydration). */
export async function relatedWorks(
  ref: string,
  opts: { libPath?: string } = {},
): Promise<WorldBrief[]> {
  const mailto = await politeMailto();
  let ids: string[] | undefined;
  if (isWid(ref)) {
    const w = await fetchWorks(
      `${OPENALEX_WORKS}/${ref}?select=related_works${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ""}`,
    );
    ids = (w?.related_works ?? []).map(shortId).filter(Boolean) as string[];
  } else {
    ids = (await enrichFor(ref, opts.libPath))?.relatedWorks;
  }
  if (!ids?.length) return [];
  const out: WorldBrief[] = [];
  for (const url of worksByIdsUrl(ids, { mailto, select: BRIEF_SELECT })) {
    const json = await fetchWorks(url);
    out.push(...(json?.results ?? []).map(workToBrief));
  }
  return out;
}

/** Corpus-wide SEMANTIC discovery (OpenAlex `search.semantic` — query by meaning).
 *  ≤50 hits, 1 req/s; `sort:"citations"` is applied client-side over the returned set. */
export async function searchWorldSemantic(
  text: string,
  opts: { sort?: "relevance" | "citations"; perPage?: number; filter?: string } = {},
): Promise<WorldBrief[]> {
  const json = await fetchWorks(
    worldSemanticUrl(text, { perPage: opts.perPage ?? 50, filter: opts.filter, mailto: await politeMailto() }),
  );
  let out: WorldBrief[] = (json?.results ?? []).map(workToBrief);
  if (opts.sort === "citations") out = [...out].sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0));
  return out;
}

/** "More like this" via OpenAlex semantic — seeds the query from the entry's
 *  title + abstract (resolved from the library + enrich sidecar), drops the entry itself. */
export async function similarByKey(
  ref: string,
  opts: { sort?: "relevance" | "citations"; libPath?: string } = {},
): Promise<WorldBrief[]> {
  const [lib, map] = await Promise.all([loadLibrary(opts.libPath), loadEnrich(opts.libPath)]);
  const e = lib.find((x) => x.key === ref);
  const seed = [e?.title, map[ref]?.abstract].filter(Boolean).join(". ");
  if (!seed.trim()) throw new Error(`"${ref}" has no title/abstract to match (hydrate it first).`);
  const out = await searchWorldSemantic(seed, { sort: opts.sort, perPage: 50 });
  const selfDoi = e?.doi?.toLowerCase();
  return selfDoi ? out.filter((b) => b.doi?.toLowerCase() !== selfDoi) : out;
}
