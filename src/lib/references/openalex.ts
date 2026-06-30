// Pure OpenAlex helpers — the shared layer behind both the Node fetch path
// (flux-core/enrich.ts, used by the CLI/MCP/agents) and the renderer path
// (the cite:openalex IPC → window.fig). No I/O here: just JSON → our shapes and
// query → URL. Kept dependency-free so it imports cleanly in the browser and Node,
// mirroring the existing src/lib/references/{bibtex,query,citekey}.ts split.
import type { EnrichEntry, EnrichTopic } from "./types";

export const OPENALEX_WORKS = "https://api.openalex.org/works";

// Fields we request when hydrating a library entry (everything we map below).
export const ENRICH_SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "cited_by_count",
  "counts_by_year",
  "abstract_inverted_index",
  "primary_topic",
  "topics",
  "keywords",
  "mesh",
  "referenced_works",
  "related_works",
  "open_access",
  "authorships",
  "ids",
];

// A lighter projection for discovery/lookup results (no referenced_works etc.).
export const BRIEF_SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "cited_by_count",
  "abstract_inverted_index",
  "primary_topic",
  "primary_location",
  "authorships",
  "open_access",
];

// Semantic search needs relevance_score; cited_by_count can be SELECTED (just not
// sorted/filtered server-side), so we pull it and sort the ≤50 hits client-side.
export const SEMANTIC_SELECT = [
  "id",
  "doi",
  "title",
  "publication_year",
  "cited_by_count",
  "relevance_score",
  "abstract_inverted_index",
  "primary_topic",
  "primary_location",
  "authorships",
  "open_access",
];

// --- small pure utilities ---------------------------------------------------

/** Strip the `https://openalex.org/` prefix → bare id (W…/A…/T…). */
export function shortId(id?: string | null): string | undefined {
  if (!id) return undefined;
  return String(id).replace(/^https?:\/\/openalex\.org\//i, "") || undefined;
}

/** Normalize a DOI to the bare lowercase form the rest of the app uses. */
export function bareDoi(doi?: string | null): string | undefined {
  if (!doi) return undefined;
  return String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() || undefined;
}

/** Strip a URL-ish OpenAlex external id down to its bare identifier. */
function bareExternal(v?: string | null): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  // pmid: https://pubmed.ncbi.nlm.nih.gov/123 ; pmcid: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123
  const m = s.match(/[^/]+$/);
  return (m ? m[0] : s) || undefined;
}

/** Build a query string; values are URL-encoded, keys are passed literally
 *  (OpenAlex uses `per-page`, and decodes `%7C`/`%3A` in filter values fine). */
function qs(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- abstract reconstruction -------------------------------------------------

/** Rebuild plain-text abstract from OpenAlex's {word: [positions]} inverted index. */
export function reconstructAbstract(inv?: Record<string, number[]> | null): string | undefined {
  if (!inv || typeof inv !== "object") return undefined;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (typeof p === "number" && p >= 0) slots[p] = word;
  }
  const text = Array.from(slots, (w) => w ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

// --- mappers -----------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

function topicOf(t: any): EnrichTopic | undefined {
  if (!t) return undefined;
  return {
    id: shortId(t.id) ?? String(t.id ?? ""),
    name: t.display_name ?? "",
    score: typeof t.score === "number" ? t.score : undefined,
    subfield: t.subfield?.display_name,
    field: t.field?.display_name,
    domain: t.domain?.display_name,
  };
}

/** Map one OpenAlex `work` JSON object → an EnrichEntry for citekey `key`. */
export function workToEnrich(w: any, key: string, sources: string[] = ["openalex"]): EnrichEntry {
  const topics: EnrichTopic[] = Array.isArray(w?.topics)
    ? (w.topics.map(topicOf).filter(Boolean) as EnrichTopic[])
    : [];
  const authors = Array.isArray(w?.authorships)
    ? w.authorships.map((a: any) => ({
        name: a?.author?.display_name ?? "",
        openalexId: shortId(a?.author?.id),
        orcid: a?.author?.orcid ?? undefined,
      }))
    : [];
  const ids = {
    pmid: bareExternal(w?.ids?.pmid),
    pmcid: bareExternal(w?.ids?.pmcid),
    mag: w?.ids?.mag != null ? String(w.ids.mag) : undefined,
  };
  return {
    key,
    doi: bareDoi(w?.doi),
    openalexId: shortId(w?.id),
    abstract: reconstructAbstract(w?.abstract_inverted_index),
    primaryTopic: topicOf(w?.primary_topic),
    topics,
    keywords: Array.isArray(w?.keywords)
      ? w.keywords.map((k: any) => k?.display_name).filter(Boolean)
      : undefined,
    mesh: Array.isArray(w?.mesh)
      ? w.mesh.map((m: any) => m?.descriptor_name).filter(Boolean)
      : undefined,
    citedByCount: typeof w?.cited_by_count === "number" ? w.cited_by_count : undefined,
    countsByYear: Array.isArray(w?.counts_by_year)
      ? w.counts_by_year.map((c: any) => ({ year: c?.year, cited: c?.cited_by_count }))
      : undefined,
    referencedWorks: Array.isArray(w?.referenced_works)
      ? (w.referenced_works.map(shortId).filter(Boolean) as string[])
      : undefined,
    relatedWorks: Array.isArray(w?.related_works)
      ? (w.related_works.map(shortId).filter(Boolean) as string[])
      : undefined,
    openAccess: w?.open_access
      ? {
          isOa: !!w.open_access.is_oa,
          status: w.open_access.oa_status ?? undefined,
          url: w.open_access.oa_url ?? undefined,
        }
      : undefined,
    authors: authors.length ? authors : undefined,
    ids: ids.pmid || ids.pmcid || ids.mag ? ids : undefined,
    fetchedAt: "", // stamped by the caller (Date is unavailable in some contexts)
    sources,
  };
}

/** A light record for discovery/lookup result lists (and one-click add). */
export interface WorldBrief {
  openalexId: string;
  doi?: string;
  title: string;
  authors: string[]; // display names, in order
  year: string;
  container?: string;
  citedByCount?: number;
  abstract?: string;
  oaUrl?: string;
  topic?: string;
  relevanceScore?: number; // semantic cosine score (only on search.semantic results)
  tldr?: string; // one-line summary (only when sourced from Semantic Scholar)
  source?: "openalex" | "s2"; // which API produced this brief (for the dual views)
  influential?: boolean; // S2: an "influential citation" (used a citation context)
  context?: string; // S2: the sentence in which this work cites the seed paper
}

/** Map one OpenAlex `work` → a light WorldBrief. */
export function workToBrief(w: any): WorldBrief {
  return {
    openalexId: shortId(w?.id) ?? "",
    doi: bareDoi(w?.doi),
    title: w?.title ?? w?.display_name ?? "",
    authors: Array.isArray(w?.authorships)
      ? w.authorships.map((a: any) => a?.author?.display_name).filter(Boolean)
      : [],
    year: w?.publication_year != null ? String(w.publication_year) : "",
    container:
      w?.primary_location?.source?.display_name ?? w?.host_venue?.display_name ?? undefined,
    citedByCount: typeof w?.cited_by_count === "number" ? w.cited_by_count : undefined,
    abstract: reconstructAbstract(w?.abstract_inverted_index),
    oaUrl: w?.open_access?.oa_url ?? undefined,
    topic: w?.primary_topic?.display_name ?? undefined,
    relevanceScore: typeof w?.relevance_score === "number" ? w.relevance_score : undefined,
    source: "openalex",
  };
}

// --- URL builders (Part 1 hydration + Part 2 lookups) ------------------------

export interface UrlOpts {
  mailto?: string;
  select?: string[];
  perPage?: number;
  sort?: string;
  page?: number;
}

/** OR-filter URLs to hydrate up to 50 DOIs per request (the §1.3 batch call). */
export function batchByDoiUrl(dois: string[], opts: UrlOpts = {}): string[] {
  const clean = Array.from(new Set(dois.map((d) => bareDoi(d)).filter(Boolean) as string[]));
  const select = (opts.select ?? ENRICH_SELECT).join(",");
  return chunk(clean, Math.min(opts.perPage ?? 50, 50)).map(
    (group) =>
      OPENALEX_WORKS +
      qs({
        filter: "doi:" + group.join("|"),
        "per-page": group.length,
        select,
        mailto: opts.mailto,
      }),
  );
}

/** Full-text discovery search across all of OpenAlex (Part 2 `search_world`). */
export function worldSearchUrl(query: string, opts: UrlOpts & { filter?: string } = {}): string {
  return (
    OPENALEX_WORKS +
    qs({
      search: query || undefined,
      filter: opts.filter,
      sort: opts.sort, // e.g. "cited_by_count:desc" | "publication_date:desc"; default = relevance
      "per-page": opts.perPage ?? 25,
      page: opts.page,
      select: (opts.select ?? BRIEF_SELECT).join(","),
      mailto: opts.mailto,
    })
  );
}

/** Trim arbitrary text to OpenAlex's 2000-char semantic-query cap. */
export function semanticQuery(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

/** Corpus-wide SEMANTIC search (query-by-meaning) via `search.semantic` — embeds the
 *  query with the same model as every work's title+abstract and ranks by cosine.
 *  Caveats: 1 req/s, ≤50 results (no deep paging), and `cited_by_count` can't be
 *  sorted/filtered server-side (we SELECT it and sort the ≤50 client-side). */
export function worldSemanticUrl(text: string, opts: UrlOpts & { filter?: string } = {}): string {
  return (
    OPENALEX_WORKS +
    qs({
      "search.semantic": semanticQuery(text),
      filter: opts.filter,
      "per-page": Math.min(opts.perPage ?? 50, 50),
      select: (opts.select ?? SEMANTIC_SELECT).join(","),
      mailto: opts.mailto,
    })
  );
}

/** Other works by an author (Part 2 `author_works`). */
export function authorWorksUrl(authorId: string, opts: UrlOpts = {}): string {
  return (
    OPENALEX_WORKS +
    qs({
      filter: "author.id:" + (shortId(authorId) ?? authorId),
      sort: opts.sort ?? "cited_by_count:desc",
      "per-page": opts.perPage ?? 25,
      page: opts.page,
      select: (opts.select ?? BRIEF_SELECT).join(","),
      mailto: opts.mailto,
    })
  );
}

/** Works that cite a given work (Part 2 `citing_works`). */
export function citingWorksUrl(workId: string, opts: UrlOpts = {}): string {
  return (
    OPENALEX_WORKS +
    qs({
      filter: "cites:" + (shortId(workId) ?? workId),
      sort: opts.sort ?? "cited_by_count:desc",
      "per-page": opts.perPage ?? 25,
      page: opts.page,
      select: (opts.select ?? BRIEF_SELECT).join(","),
      mailto: opts.mailto,
    })
  );
}

/** Resolve a list of OpenAlex work IDs to brief records (≤50 per URL).
 *  Used to flesh out related_works / referenced_works (Part 2). */
export function worksByIdsUrl(ids: string[], opts: UrlOpts = {}): string[] {
  const clean = Array.from(new Set(ids.map(shortId).filter(Boolean) as string[]));
  const select = (opts.select ?? BRIEF_SELECT).join(",");
  return chunk(clean, 50).map(
    (group) =>
      OPENALEX_WORKS +
      qs({
        filter: "openalex_id:" + group.join("|"),
        "per-page": group.length,
        select,
        mailto: opts.mailto,
      }),
  );
}
