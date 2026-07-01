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
export function unpaywallPdfUrls(json: any): string[] {
  const out: string[] = [];
  if (json?.best_oa_location?.url_for_pdf) out.push(json.best_oa_location.url_for_pdf);
  for (const loc of json?.oa_locations ?? []) if (loc?.url_for_pdf) out.push(loc.url_for_pdf);
  return [...new Set(out)];
}

// --- PMC OA (NCBI oa.fcgi → pdf href) ----------------------------------------
export function pmcNumber(pmcid?: string): string | undefined {
  return pmcid?.match(/(\d+)/)?.[1];
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

/** The ordered resolver plan for an entry (only applicable resolvers, OA-first). */
export function resolverPlan(x: PdfInputs): ResolverId[] {
  const plan: ResolverId[] = [];
  if (x.openAccessUrl) plan.push("openalex-oa");
  if (x.doi) plan.push("unpaywall");
  if (x.pmcid) plan.push("europepmc", "pmc-oa");
  if (arxivIdFromDoi(x.doi)) plan.push("arxiv");
  if (isBiorxivDoi(x.doi)) plan.push("biorxiv");
  if (x.doi) plan.push("crossref");
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

/** Candidate PDF URLs for one resolver (some need a metadata fetch via deps). */
async function candidatesFor(id: ResolverId, x: PdfInputs, deps: FetchDeps): Promise<string[]> {
  switch (id) {
    case "openalex-oa":
      return x.openAccessUrl ? [x.openAccessUrl] : [];
    case "unpaywall":
      return x.doi && deps.email ? unpaywallPdfUrls(await deps.getJson(unpaywallUrl(x.doi, deps.email))) : [];
    case "europepmc":
      return x.pmcid ? [europePmcPdfUrl(x.pmcid)] : [];
    case "pmc-oa": {
      if (!x.pmcid) return [];
      const href = pmcOaPdfHref((await deps.getText(pmcOaUrl(x.pmcid))) ?? "");
      return href ? [href] : [];
    }
    case "arxiv": {
      const a = arxivIdFromDoi(x.doi);
      return a ? [arxivPdfUrl(a)] : [];
    }
    case "biorxiv": {
      if (!isBiorxivDoi(x.doi)) return [];
      const out: string[] = [];
      for (const s of ["biorxiv", "medrxiv"] as const) {
        const v = biorxivVersion(await deps.getJson(biorxivDetailsUrl(x.doi!, s)));
        if (v) out.push(biorxivPdfUrl(x.doi!, s, v));
      }
      return out;
    }
    case "crossref":
      return x.doi ? crossrefPdfUrls(await deps.getJson(crossrefUrl(x.doi, deps.email))) : [];
  }
}

/** Run the OA waterfall: first magic-byte-valid PDF wins. */
export async function runWaterfall(x: PdfInputs, deps: FetchDeps): Promise<WaterfallResult | null> {
  for (const id of resolverPlan(x)) {
    let cands: string[] = [];
    try {
      cands = await candidatesFor(id, x, deps);
    } catch {
      cands = [];
    }
    for (const url of cands) {
      const got = await deps.getBytes(url).catch(() => null);
      if (got && looksLikePdf(got.contentType, got.bytes) && isPdfBytes(got.bytes)) {
        return { source: id, url, finalUrl: got.finalUrl, bytes: got.bytes };
      }
    }
  }
  return null;
}
