// Per-publisher rate limiter for PDF acquisition — the guard against publisher IP blocks.
//
// Cell Press/Elsevier temporarily block an IP that creates "more than 90 sessions in 5
// minutes"; every cookie-less GET (Phase A OA candidates) and every proxy capture (Phase B
// navigation chain) creates one-or-more such sessions. This module gives every fetch path a
// shared sliding-window "session budget" per PUBLISHER GROUP (one publisher runs many hosts:
// cell.com + sciencedirect.com + linkinghub.elsevier.com are all Elsevier), sized well under
// the observed wall. Metadata APIs built for programmatic access (OpenAlex, Unpaywall,
// Crossref, NCBI, Europe PMC) are exempt — the existing politeness delays cover them.
//
// Pure (no I/O, injectable clock) → shared by the renderer bridge (GUI) and flux-core
// (CLI/MCP), and unit-testable with tsx.

export const RATE_WINDOW_MS = 5 * 60_000;
/** Budget of "session units" per group per window — 2× under Cell Press's 90/5min wall. */
export const SESSION_BUDGET = 45;
/** One direct GET of a candidate PDF URL (Phase A / OA waterfall). */
export const GET_COST = 1;
/** One proxy browser capture: DOI nav + interstitial hops + pdf nav + retries ≈ several
 *  sessions. Budgeted conservatively (45/6 → ~7 captures per publisher per 5 min). */
export const CAPTURE_COST = 6;

/** Metadata/API hosts designed for programmatic access — never rate-limited here. */
const API_HOSTS = new Set([
  "api.openalex.org",
  "api.unpaywall.org",
  "api.crossref.org",
  "api.biorxiv.org",
  "api.semanticscholar.org",
  "www.ebi.ac.uk", // Europe PMC REST
  "europepmc.org",
  "www.ncbi.nlm.nih.gov", // PMC OA service
  "pmc.ncbi.nlm.nih.gov",
  "ftp.ncbi.nlm.nih.gov", // PMC OA package host (already https-rewritten)
  "eutils.ncbi.nlm.nih.gov",
]);

/** Publisher families: many hosts, one rate-limit bucket. Keyed by registrable domain. */
const DOMAIN_GROUPS: Record<string, string> = {
  "sciencedirect.com": "elsevier",
  "cell.com": "elsevier",
  "elsevier.com": "elsevier",
  "elsevierhealth.com": "elsevier",
  "nature.com": "springer",
  "springer.com": "springer",
  "springernature.com": "springer",
  "biomedcentral.com": "springer",
  "wiley.com": "wiley",
  "oup.com": "oup",
  "science.org": "aaas",
  "sciencemag.org": "aaas",
  "pnas.org": "pnas",
  "tandfonline.com": "tandf",
  "sagepub.com": "sage",
  "jneurosci.org": "sfn",
  "eneuro.org": "sfn",
  "physiology.org": "aps",
};

/** DOI prefix → publisher group, for when we only have a DOI (proxy phase: the landed host
 *  isn't known until after navigation). Unknown prefixes still get a per-prefix bucket —
 *  the danger case is always MANY papers from ONE publisher. */
const DOI_PREFIX_GROUPS: Record<string, string> = {
  "10.1016": "elsevier",
  "10.1006": "elsevier",
  "10.1053": "elsevier",
  "10.1038": "springer",
  "10.1007": "springer",
  "10.1186": "springer",
  "10.1002": "wiley",
  "10.1111": "wiley",
  "10.1113": "wiley",
  "10.1093": "oup",
  "10.1126": "aaas",
  "10.1073": "pnas",
  "10.1523": "sfn",
  "10.1152": "aps",
  "10.1080": "tandf",
  "10.1177": "sage",
};

/** Open-repository hosts: mirror/archive services designed to serve full texts in bulk
 *  (PMC, Europe PMC, preprint servers, general-purpose repositories). These are the ONLY
 *  hosts the bulk OA phase is allowed to download PDFs from — publisher sites are never
 *  contacted directly in bulk (they session-count every request and IP-block; paywalled
 *  AND publisher-hosted-OA papers both go through the real-browser proxy route instead). */
const REPOSITORY_DOMAINS = new Set([
  "nih.gov", // www.ncbi.nlm.nih.gov (PMC), ftp.ncbi.nlm.nih.gov, pmc.ncbi.nlm.nih.gov
  "europepmc.org",
  "ebi.ac.uk", // Europe PMC REST host
  "arxiv.org",
  "biorxiv.org",
  "medrxiv.org",
  "zenodo.org",
  "osf.io",
  "core.ac.uk",
  "hal.science",
  "archives-ouvertes.fr", // HAL legacy host
  "semanticscholar.org", // pdfs.semanticscholar.org mirror
]);

/** Publisher rate-limit GROUPS the bulk OA phase must not download from directly — the
 *  ones that IP-block an address for opening too many sessions too fast. `elsevier`
 *  (Cell Press / ScienceDirect: cell.com, sciencedirect.com, linkinghub.elsevier.com,
 *  DOI 10.1016/10.1006/10.1053) is the confirmed cause of the "90 sessions in 5 minutes"
 *  bulk IP blocks; its papers are captured via the real-browser proxy route instead
 *  (cookie-carrying single session + the cell.com hop).
 *
 *  Everything NOT in this set is bulk-safe to download directly: open repositories AND
 *  ordinary/gold-OA publishers (MDPI, Frontiers, PLOS, Hindawi, Wiley-OA, institutional
 *  repositories, eScholarship, HDL handles, …). The cookie-jar netGet (one session per
 *  host) + the per-publisher sliding-window limiter + the circuit breaker bound the
 *  volume, so a blanket "repositories only" rule is unnecessary and was starving bulk of
 *  the vast majority of genuinely-open PDFs. Keep this set MINIMAL — only add a publisher
 *  here once it has actually IP-blocked us. */
export const BULK_AVOID_GROUPS = new Set(["elsevier"]);

const registrableDomain = (host: string): string => host.split(".").slice(-2).join(".");
// ebi.ac.uk / core.ac.uk / hal.archives-ouvertes.fr need three labels to be meaningful.
const longDomain = (host: string): string => host.split(".").slice(-3).join(".");

/** True if `url` is on a known open-repository host (safe for direct bulk download). */
export function isRepositoryUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return REPOSITORY_DOMAINS.has(registrableDomain(host)) || REPOSITORY_DOMAINS.has(longDomain(host));
  } catch {
    return false;
  }
}

/** Rate-limit group for a URL, or null if exempt (API host) / unparsable. Groups by
 *  registrable domain (publisher domains are all two-label .com/.org) with the publisher
 *  alias map collapsing families onto one bucket. doi.org is NOT exempt: a GET to a
 *  doi.org link lands on (and session-counts at) the DOI's publisher, so it's grouped by
 *  the DOI prefix in its path — treating it as free was one of the holes behind the
 *  second Cell Press IP block. */
export function hostGroup(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === "doi.org" || host === "dx.doi.org") {
    return doiGroup(u.pathname.replace(/^\//, "")) ?? "doi.org";
  }
  if (API_HOSTS.has(host)) return null;
  const domain = registrableDomain(host);
  return DOMAIN_GROUPS[domain] ?? domain;
}

/** Rate-limit group for a bare DOI ("10.1016/j.cell…"), or null if not DOI-shaped. */
export function doiGroup(doi: string | undefined): string | null {
  const m = doi?.match(/^(10\.\d{4,9})\//);
  if (!m) return null;
  return DOI_PREFIX_GROUPS[m[1]] ?? `doi:${m[1]}`;
}

/** True if `url` belongs to a publisher the bulk OA phase must NOT download from directly
 *  (it IP-blocks on volume — see BULK_AVOID_GROUPS). Such candidates are left to the
 *  real-browser proxy route instead. Everything else — repositories and ordinary/gold-OA
 *  publishers alike — is bulk-safe. Uses the same grouping as the rate limiter, so a
 *  doi.org link is judged by the DOI's publisher, not by "doi.org". */
export function isBulkAvoidUrl(url: string | undefined): boolean {
  const g = hostGroup(url);
  return g != null && BULK_AVOID_GROUPS.has(g);
}

/** A sleep that rejects with AbortError as soon as `signal` aborts, so a cancel never
 *  waits out a politeness/rate-limit delay. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onA);
      resolve();
    }, ms);
    const onA = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onA, { once: true });
  });
}

/** Round-robin items across their groups so a bulk run alternates publishers — one
 *  rate-limited publisher then throttles only its own papers instead of stalling the whole
 *  queue behind a run of same-publisher items. Stable within each group. */
export function interleaveByGroup<T>(items: T[], groupOf: (item: T) => string | null): T[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const g = groupOf(it) ?? "";
    let b = buckets.get(g);
    if (!b) buckets.set(g, (b = []));
    b.push(it);
  }
  if (buckets.size <= 1) return items.slice();
  const queues = [...buckets.values()];
  const out: T[] = [];
  for (let i = 0; out.length < items.length; i++) for (const q of queues) if (i < q.length) out.push(q[i]);
  return out;
}

/** Sliding-window budget tracker. `acquire` waits (abortably) until the group has room,
 *  then records the spend. Sequential callers only (both bulk loops are sequential). */
export class HostLimiter {
  #hits = new Map<string, { t: number; c: number }[]>();
  #budget: number;
  #budgets: Record<string, number>;
  #window: number;
  #now: () => number;
  #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: {
    budget?: number;
    /** Per-group budget overrides — a group not listed here uses `budget`. Lets one limiter
     *  give a ban-prone publisher (elsevier) a strict cap while everyone else stays generous. */
    budgets?: Record<string, number>;
    windowMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {}) {
    this.#budget = opts.budget ?? SESSION_BUDGET;
    this.#budgets = opts.budgets ?? {};
    this.#window = opts.windowMs ?? RATE_WINDOW_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep = opts.sleep ?? abortableSleep;
  }

  /** The budget that applies to `group` (its override, else the default). */
  #budgetFor(group: string): number {
    return this.#budgets[group] ?? this.#budget;
  }
  /** The effective budget for `group` (exposed for tests/assertions). */
  budgetFor(group: string): number {
    return this.#budgetFor(group);
  }

  #prune(group: string, now: number): { t: number; c: number }[] {
    const hits = (this.#hits.get(group) ?? []).filter((h) => now - h.t < this.#window);
    this.#hits.set(group, hits);
    return hits;
  }

  /** Units spent in the current window for `group`. */
  spent(group: string): number {
    return this.#prune(group, this.#now()).reduce((s, h) => s + h.c, 0);
  }

  /** 0 if `cost` fits now, else ms until enough old spend ages out of the window. */
  msUntilAllowed(group: string, cost: number): number {
    const now = this.#now();
    const hits = this.#prune(group, now);
    let over = hits.reduce((s, h) => s + h.c, 0) + cost - this.#budgetFor(group);
    if (over <= 0) return 0;
    for (const h of hits) {
      // hits are in insert order = time order; freeing the oldest first
      over -= h.c;
      if (over <= 0) return Math.max(0, h.t + this.#window - now);
    }
    return this.#window; // cost alone exceeds the budget — wait a full window (shouldn't happen)
  }

  /** Record a spend without waiting (e.g. a redirect that landed on a different publisher). */
  record(group: string, cost: number): void {
    this.#prune(group, this.#now()).push({ t: this.#now(), c: cost });
  }

  /** Wait (abortably) until `group` has room for `cost`, then record it. */
  async acquire(group: string, cost: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const wait = this.msUntilAllowed(group, cost);
      if (wait <= 0) break;
      await this.#sleep(wait, signal);
    }
    this.record(group, cost);
  }
}

/** The app-session-wide limiter (renderer) for proxy CAPTURES — each capture is a real
 *  multi-navigation browser session, the actual "90 sessions in 5 minutes" ban vector, so
 *  it keeps the strict SESSION_BUDGET. Module-level so windows span bulk runs. */
export const sharedLimiter = new HostLimiter();

/** Budget for cookie-jar GET fetches (the OA phase's candidate-PDF downloads). The
 *  renderer/harness fetch OA PDFs through Chromium's persistent-partition `ses.fetch`, which
 *  reuses ONE server-side session per host no matter how many requests we make — so the
 *  session-count IP block that the old cookie-LESS Node fetch triggered can't happen here.
 *  Most groups therefore get a generous 500-unit cap (only a runaway guard + light politeness;
 *  it keeps a high-yield OA publisher like OUP/Wiley from stalling a sweep). */
export const GET_SESSION_BUDGET = 500;
/** BUT the bulk sweep now DOES GET publisher-hosted OA from `elsevier` (Cell Press cell.com —
 *  the publisher that IP-blocks at ">90 sessions/5min"). The cookie jar should collapse those
 *  to one session, but we do NOT let the no-ban guarantee rest on that assumption: cap the
 *  elsevier group at 45 GETs/5min — mathematically half the wall regardless of session
 *  collapse. This is the load-bearing ban backstop, not belt-and-suspenders. */
export const ELSEVIER_GET_BUDGET = 45;
export const getLimiter = new HostLimiter({ budget: GET_SESSION_BUDGET, budgets: { elsevier: ELSEVIER_GET_BUDGET } });
