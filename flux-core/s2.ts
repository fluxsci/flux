// flux-core/s2.ts — Semantic Scholar (Node side: CLI/MCP/agents). Used for S2's
// strengths: SPECTER2 "recommendations" (papers like this) and citation CONTEXTS /
// intents / influential-citation flags. Shares the pure builders+mappers in
// src/lib/references/semanticscholar.ts with the renderer (cite:s2 IPC). A free S2
// key (x-api-key) is effectively required — keyless is heavily 429-throttled.
import type { WorldBrief } from "../src/lib/references/openalex";
import {
  s2PaperId,
  s2RecommendationsUrl,
  s2CitationsUrl,
  s2ToBrief,
  s2CitationToBrief,
} from "../src/lib/references/semanticscholar";
import { getSecret, loadLibrary, loadEnrich } from "./fluxlib";

const UA = "Flux/0.1 (reference)";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function s2Fetch(url: string): Promise<any> {
  const key = await getSecret("s2Key");
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...(key ? { "x-api-key": key } : {}) },
  });
  if (res.status === 429)
    throw new Error("Semantic Scholar rate-limited (429) — set a free key: flux keys --s2 <KEY>.");
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
  return res.json();
}

const isDoi = (s: string) => /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(s);
const bareDoi = (s: string) => s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();

/** Resolve a ref (citekey or DOI) to a bare DOI via the library + enrich sidecar. */
async function doiForRef(ref: string, libPath?: string): Promise<string | undefined> {
  if (isDoi(ref)) return bareDoi(ref);
  const [lib, map] = await Promise.all([loadLibrary(libPath), loadEnrich(libPath)]);
  return lib.find((e) => e.key === ref)?.doi || (map[ref]?.doi as string | undefined);
}

/** S2 "papers like this" (SPECTER2 recommendations). `ref` = a citekey or a DOI. */
export async function s2Similar(
  ref: string,
  opts: { limit?: number; libPath?: string } = {},
): Promise<WorldBrief[]> {
  const id = s2PaperId({ doi: await doiForRef(ref, opts.libPath) });
  if (!id) throw new Error(`no DOI for "${ref}" to query Semantic Scholar.`);
  const json = await s2Fetch(s2RecommendationsUrl(id, { limit: opts.limit ?? 30 }));
  return (json?.recommendedPapers ?? []).map(s2ToBrief);
}

/** S2 citing papers WITH citation contexts + influential flags. `ref` = citekey or DOI. */
export async function s2Citing(
  ref: string,
  opts: { limit?: number; offset?: number; libPath?: string } = {},
): Promise<WorldBrief[]> {
  const id = s2PaperId({ doi: await doiForRef(ref, opts.libPath) });
  if (!id) throw new Error(`no DOI for "${ref}" to query Semantic Scholar.`);
  const json = await s2Fetch(s2CitationsUrl(id, { limit: opts.limit ?? 50, offset: opts.offset }));
  return (json?.data ?? []).map(s2CitationToBrief);
}
