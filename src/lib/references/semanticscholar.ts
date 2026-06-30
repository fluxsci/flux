// Pure Semantic Scholar helpers — URL builders + result mappers, shared by the Node
// path (flux-core/s2.ts, CLI/MCP) and the renderer (over the cite:s2 IPC). No I/O.
// S2 is used for its strengths: SPECTER2 "recommendations" (papers like this) and
// citation CONTEXTS / intents / influential-citation flags (the "how/why cited"
// richness OpenAlex lacks). A free S2 key (x-api-key, attached in main/flux-core)
// is effectively required — keyless is heavily 429-throttled.
import type { WorldBrief } from "./openalex";

export const S2_BASE = "https://api.semanticscholar.org";

// Fields we request for a citing/recommended paper (S2 nests these under citingPaper
// for the citations endpoint; flat for recommendations).
const PAPER_FIELDS = "paperId,title,year,abstract,externalIds,citationCount,authors,venue,tldr";

/** An S2 paperId from a DOI (`DOI:<doi>`) or an explicit S2 id. The DOI's slash stays
 *  literal in the path — S2 captures it as part of the id (do NOT percent-encode it). */
export function s2PaperId(ref: { doi?: string; s2Id?: string }): string | undefined {
  if (ref.s2Id) return ref.s2Id;
  if (ref.doi) return "DOI:" + ref.doi;
  return undefined;
}

const clampLimit = (n: number | undefined, max: number, def: number) =>
  Math.max(1, Math.min(n ?? def, max));

/** "Papers like this" — S2 SPECTER2 recommendations for a single seed paper. */
export function s2RecommendationsUrl(paperId: string, opts: { limit?: number } = {}): string {
  return (
    `${S2_BASE}/recommendations/v1/papers/forpaper/${paperId}` +
    `?fields=${encodeURIComponent(PAPER_FIELDS)}&limit=${clampLimit(opts.limit, 100, 30)}`
  );
}

/** Papers that CITE the seed — with citation contexts, intents, and influential flag. */
export function s2CitationsUrl(paperId: string, opts: { limit?: number; offset?: number } = {}): string {
  const fields = "isInfluential,contexts,intents," + PAPER_FIELDS;
  return (
    `${S2_BASE}/graph/v1/paper/${paperId}/citations` +
    `?fields=${encodeURIComponent(fields)}&limit=${clampLimit(opts.limit, 1000, 50)}&offset=${opts.offset ?? 0}`
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Map an S2 paper object → our WorldBrief (source:"s2", carries tldr). */
export function s2ToBrief(p: any): WorldBrief {
  const doi = p?.externalIds?.DOI ? String(p.externalIds.DOI).toLowerCase() : undefined;
  return {
    openalexId: p?.paperId ? "S2:" + p.paperId : doi ? "doi:" + doi : "s2:" + (p?.title ?? ""),
    doi,
    title: p?.title ?? "",
    authors: Array.isArray(p?.authors) ? p.authors.map((a: any) => a?.name).filter(Boolean) : [],
    year: p?.year != null ? String(p.year) : "",
    container: p?.venue || undefined,
    citedByCount: typeof p?.citationCount === "number" ? p.citationCount : undefined,
    abstract: p?.abstract || undefined,
    tldr: p?.tldr?.text || undefined,
    source: "s2",
  };
}

/** Map one S2 citations[] entry → a WorldBrief for the *citing* paper, annotated with
 *  the citation context (first sentence) + the influential-citation flag. */
export function s2CitationToBrief(c: any): WorldBrief {
  const b = s2ToBrief(c?.citingPaper || {});
  b.influential = !!c?.isInfluential;
  b.context = Array.isArray(c?.contexts) && c.contexts.length ? String(c.contexts[0]) : undefined;
  return b;
}
