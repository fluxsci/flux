// Pure PDF-acquisition helpers — resolver URL builders + response parsers + magic-byte
// validation. Shared by flux-core/acquire.ts (CLI/MCP) and the renderer bridge (GUI);
// the orchestrators do the actual fetching. Ported + extended from ~/fluxfinder
// (adds OpenAlex-OA + Europe PMC). No I/O → imports cleanly in browser + Node.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type ResolverId =
  | "openalex-oa"
  | "unpaywall"
  | "europepmc"
  | "pmc-oa"
  | "arxiv"
  | "biorxiv"
  | "crossref";

export interface PdfInputs {
  doi?: string;
  openAccessUrl?: string; // enrich.openAccess.url
  isOa?: boolean;
  pmid?: string;
  pmcid?: string; // "PMC1234567" or "1234567"
}

/** %PDF- magic — guards against HTML paywall/login pages served as 200 (fluxfinder net.py:72). */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
export function looksLikePdf(contentType: string | undefined, bytes: Uint8Array): boolean {
  if (isPdfBytes(bytes)) return true; // magic wins (some servers send octet-stream)
  return !!contentType && /application\/pdf/i.test(contentType) && bytes.length > 1000;
}

export const bareDoi = (d?: string): string | undefined =>
  d ? d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim().toLowerCase() : undefined;

// --- arXiv -------------------------------------------------------------------
export function arxivIdFromDoi(doi?: string): string | undefined {
  const m = bareDoi(doi)?.match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? m[1] : undefined;
}
export const arxivPdfUrl = (arxivId: string): string => `https://arxiv.org/pdf/${arxivId}`;

// --- Unpaywall (metadata → pdf urls) -----------------------------------------
export const unpaywallUrl = (doi: string, email: string): string =>
  `https://api.unpaywall.org/v2/${encodeURIComponent(bareDoi(doi)!)}?email=${encodeURIComponent(email)}`;
/** Unpaywall OA locations with their host classification — `repo` = host_type
 *  "repository" (PMC, institutional repos, preprint servers…) vs the publisher's own
 *  site. Repository copies are listed first: they're the ones safe to bulk-download. */
export function unpaywallPdfLocations(json: any): { url: string; repo: boolean }[] {
  const locs = [json?.best_oa_location, ...(json?.oa_locations ?? [])].filter((l: any) => l?.url_for_pdf);
  const seen = new Set<string>();
  const out: { url: string; repo: boolean }[] = [];
  for (const l of locs) {
    if (seen.has(l.url_for_pdf)) continue;
    seen.add(l.url_for_pdf);
    out.push({ url: l.url_for_pdf, repo: String(l.host_type ?? "") === "repository" });
  }
  out.sort((a, b) => Number(b.repo) - Number(a.repo)); // repository copies first (stable)
  return out;
}
export function unpaywallPdfUrls(json: any): string[] {
  return unpaywallPdfLocations(json).map((l) => l.url);
}

// --- PMC OA (NCBI oa.fcgi → pdf href) ----------------------------------------
export function pmcNumber(pmcid?: string): string | undefined {
  return pmcid?.match(/(\d+)/)?.[1];
}

/** Extract a PMC id from an OA URL that points at PMC (NCBI often gives OpenAlex a PMC
 *  ARTICLE-PAGE url — HTML, not a PDF — and enrich.ids.pmcid is empty; the id is right
 *  there in the path). Recognizes .../pmc/articles/PMC123, .../pmc/articles/123, and
 *  pmc.ncbi.nlm.nih.gov/articles/PMC123. Returns "PMC123" or undefined. */
export function pmcidFromUrl(url?: string): string | undefined {
  const m = String(url || "").match(/(?:ncbi\.nlm\.nih\.gov\/(?:pmc\/)?articles\/|\/pmc\/articles\/)(?:PMC)?(\d+)/i);
  return m ? `PMC${m[1]}` : undefined;
}

/** Resolve a PMID → PMCID via NCBI's ID converter (only worth calling for papers OpenAlex
 *  already flags open-access). Lets the reliable PMC/Europe PMC resolvers fire for green-OA
 *  papers whose OA url is a publisher/landing page rather than PMC. null if no PMC copy. */
export async function pmcidFromPmid(pmid: string, deps: FetchDeps): Promise<string | undefined> {
  const email = encodeURIComponent(deps.email || "flux");
  const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?tool=flux&email=${email}&ids=${encodeURIComponent(pmid)}&format=json`;
  const j = await deps.getJson(url).catch(() => null);
  const rec = j?.records?.[0];
  const pmcid = rec?.pmcid;
  return typeof pmcid === "string" && /^PMC\d+/i.test(pmcid) ? pmcid : undefined;
}
export const pmcOaUrl = (pmcid: string): string =>
  `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC${pmcNumber(pmcid)}`;
export function pmcOaPdfHref(xml: string): string | undefined {
  const m = xml.match(/<link[^>]*format="pdf"[^>]*href="([^"]+)"/i);
  return m ? m[1].replace(/^ftp:\/\//i, "https://") : undefined;
}

// --- Europe PMC (pmcid → full-text PDF) --------------------------------------
export const europePmcPdfUrl = (pmcid: string): string =>
  `https://www.ebi.ac.uk/europepmc/webservices/rest/PMC/PMC${pmcNumber(pmcid)}/fullTextPDF`;

/** Europe PMC's supplementary-files archive (a ZIP of every supplementary file).
 *  NOTE the URL shape: unlike every other Europe PMC endpoint this one takes the PMCID
 *  WITHOUT a `/PMC/` source segment — the documented `/PMC/<id>/supplementaryFiles` form
 *  returns 404. Verified live 2026-08. Only the OA subset is served; a subscription
 *  article that is merely `inEPMC` returns 404, which is a normal "no supplements here". */
export const europePmcSupplementsUrl = (pmcid: string): string =>
  `https://www.ebi.ac.uk/europepmc/webservices/rest/PMC${pmcNumber(pmcid)}/supplementaryFiles`;

// --- bioRxiv / medRxiv (10.1101 → details → constructed pdf url) -------------
export const isBiorxivDoi = (doi?: string): boolean => /^10\.1101\//i.test(bareDoi(doi) ?? "");
export const biorxivDetailsUrl = (doi: string, server: "biorxiv" | "medrxiv"): string =>
  `https://api.biorxiv.org/details/${server}/${bareDoi(doi)}/na/json`;
export function biorxivVersion(json: any): string | undefined {
  const coll = json?.collection;
  return Array.isArray(coll) && coll.length ? String(coll[coll.length - 1].version ?? "1") : undefined;
}
export const biorxivPdfUrl = (doi: string, server: "biorxiv" | "medrxiv", version: string): string =>
  `https://www.${server}.org/content/${bareDoi(doi)}v${version}.full.pdf`;

// --- Crossref (metadata → fulltext pdf link) ---------------------------------
export const crossrefUrl = (doi: string, mailto?: string): string =>
  `https://api.crossref.org/works/${encodeURIComponent(bareDoi(doi)!)}` +
  (mailto ? `?mailto=${encodeURIComponent(mailto)}` : "");
export function crossrefPdfUrls(json: any): string[] {
  const links = json?.message?.link ?? [];
  return links
    .filter((l: any) => /pdf/i.test(l?.["content-type"] ?? "") || /\.pdf(\?|$)/i.test(l?.URL ?? ""))
    .map((l: any) => l.URL)
    .filter(Boolean);
}

/** The ordered resolver plan for an entry (only applicable resolvers). REPOSITORY-FIRST:
 *  PMC/Europe PMC/preprint servers are tried before OpenAlex's oa_url and Crossref links,
 *  because those two frequently point at the PUBLISHER'S OWN site — preferring a repository
 *  copy when one exists keeps bulk off publisher hosts even when both are available.
 *  `bulkMode` additionally drops the crossref resolver outright: its fulltext links are
 *  essentially always publisher-hosted (and mostly entitlement-gated), so the API call is
 *  wasted in a run that avoids the ban-prone publishers anyway. */
export function resolverPlan(x: PdfInputs, opts: { bulkMode?: boolean } = {}): ResolverId[] {
  const plan: ResolverId[] = [];
  if (x.pmcid) plan.push("europepmc", "pmc-oa");
  if (arxivIdFromDoi(x.doi)) plan.push("arxiv");
  if (isBiorxivDoi(x.doi)) plan.push("biorxiv");
  if (x.doi) plan.push("unpaywall"); // API is free to call; candidates are filtered per-URL
  if (x.openAccessUrl) plan.push("openalex-oa");
  if (x.doi && !opts.bulkMode) plan.push("crossref");
  return plan;
}

// --- the waterfall, with injected fetchers (so flux-core + the renderer/GUI share it) ---

export interface FetchDeps {
  getJson: (url: string) => Promise<any>;
  getText: (url: string) => Promise<string | null>;
  getBytes: (url: string) => Promise<{ bytes: Uint8Array; finalUrl: string; contentType: string } | null>;
  email?: string;
}
export interface WaterfallResult {
  source: ResolverId;
  url: string;
  finalUrl: string;
  bytes: Uint8Array;
}

/** Candidate PDF URLs for one resolver (some need a metadata fetch via deps). `repo` marks
 *  candidates KNOWN to live on an open repository (from the resolver's own semantics or
 *  Unpaywall's host_type); unknown candidates are classified by URL at filter time. */
async function candidatesFor(id: ResolverId, x: PdfInputs, deps: FetchDeps): Promise<{ url: string; repo?: boolean }[]> {
  switch (id) {
    case "openalex-oa":
      return x.openAccessUrl ? [{ url: x.openAccessUrl }] : [];
    case "unpaywall":
      return x.doi && deps.email ? unpaywallPdfLocations(await deps.getJson(unpaywallUrl(x.doi, deps.email))) : [];
    case "europepmc":
      return x.pmcid ? [{ url: europePmcPdfUrl(x.pmcid), repo: true }] : [];
    case "pmc-oa": {
      if (!x.pmcid) return [];
      const href = pmcOaPdfHref((await deps.getText(pmcOaUrl(x.pmcid))) ?? "");
      return href ? [{ url: href, repo: true }] : [];
    }
    case "arxiv": {
      const a = arxivIdFromDoi(x.doi);
      return a ? [{ url: arxivPdfUrl(a), repo: true }] : [];
    }
    case "biorxiv": {
      if (!isBiorxivDoi(x.doi)) return [];
      const out: { url: string; repo: boolean }[] = [];
      for (const s of ["biorxiv", "medrxiv"] as const) {
        const v = biorxivVersion(await deps.getJson(biorxivDetailsUrl(x.doi!, s)));
        if (v) out.push({ url: biorxivPdfUrl(x.doi!, s, v), repo: true });
      }
      return out;
    }
    case "crossref":
      return x.doi ? crossrefPdfUrls(await deps.getJson(crossrefUrl(x.doi, deps.email))).map((url: string) => ({ url })) : [];
  }
}

export interface WaterfallOpts {
  /** Bulk mode: tunes resolver ORDER/SET for a polite sweep (e.g. Crossref links are
   *  dropped). There is deliberately NO per-publisher candidate filtering anymore —
   *  ban-safety comes from the cookie-jar netGet + the per-publisher GET caps + the
   *  circuit breaker (see the comment inside runWaterfall). */
  bulkMode?: boolean;
}

/**
 * Resolve the paper's PMCID, backfilling a missing one so the reliable PMC/Europe PMC
 * routes can fire: first from the OA url itself (OpenAlex often hands us a PMC ARTICLE-PAGE
 * url — HTML, not a PDF — with enrich.ids.pmcid empty), then, for OA-flagged papers with a
 * PMID, via NCBI's ID converter. The single biggest OA-yield lever for a PubMed-heavy
 * library, and also what lets the supplements route find Europe PMC's archive.
 */
export async function resolvePmcid(x: PdfInputs, deps: FetchDeps): Promise<string | undefined> {
  if (x.pmcid) return x.pmcid;
  const fromUrl = pmcidFromUrl(x.openAccessUrl);
  if (fromUrl) return fromUrl;
  if (x.isOa && x.pmid) return await pmcidFromPmid(x.pmid, deps).catch(() => undefined);
  return undefined;
}

/** Run the OA waterfall: first magic-byte-valid PDF wins. */
export async function runWaterfall(
  x: PdfInputs,
  deps: FetchDeps,
  opts: WaterfallOpts = {},
): Promise<WaterfallResult | null> {
  // Backfill a missing PMCID so the reliable PMC/Europe PMC resolvers can fire: first from
  // the OA url itself (OpenAlex often hands us a PMC ARTICLE-PAGE url — HTML, not a PDF —
  // with enrich.ids.pmcid empty), then, for OA-flagged papers with a PMID, via NCBI's ID
  // converter. This is the single biggest OA-yield lever for a PubMed-heavy library.
  x = { ...x, pmcid: await resolvePmcid(x, deps) };
  // The bulk sweep and the single-row button run the SAME candidate set — repository-first,
  // then publisher copies (incl. Elsevier/Cell Press cell.com). There is NO candidate filtering
  // here: the previous "avoid Elsevier in bulk" rule silently starved the sweep of ~180 Cell
  // Press OA papers the button fetches fine. Ban-safety is handled downstream by the cookie-jar
  // netGet (one session per host) + the getLimiter elsevier cap (≤45 GETs/5min), not by refusing
  // to fetch. Keeping the two paths identical is what stops them drifting apart again.
  for (const id of resolverPlan(x, opts)) {
    let cands: { url: string; repo?: boolean }[] = [];
    try {
      cands = await candidatesFor(id, x, deps);
    } catch {
      cands = [];
    }
    for (const c of cands) {
      const got = await deps.getBytes(c.url).catch(() => null);
      if (got && looksLikePdf(got.contentType, got.bytes) && isPdfBytes(got.bytes)) {
        return { source: id, url: c.url, finalUrl: got.finalUrl, bytes: got.bytes };
      }
    }
  }
  return null;
}
