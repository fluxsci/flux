// Pure-logic verification of the per-publisher rate limiter + OA-miss ledger helpers
// (the two mechanisms guarding bulk "Get PDFs": no publisher IP blocks, no re-grinding
// open-access checks). Run: npx tsx scripts/verify-ratelimit.ts
import {
  HostLimiter,
  hostGroup,
  doiGroup,
  isRepositoryUrl,
  isBulkAvoidUrl,
  interleaveByGroup,
  abortableSleep,
  SESSION_BUDGET,
  GET_COST,
  CAPTURE_COST,
  RATE_WINDOW_MS,
  getLimiter,
  GET_SESSION_BUDGET,
  ELSEVIER_GET_BUDGET,
} from "../src/lib/references/hostLimiter";
import { oaSig, isFreshOaMiss, OA_MISS_TTL_MS, type OaMiss } from "../src/lib/references/items";
import { resolverPlan, unpaywallPdfLocations, runWaterfall, pmcidFromUrl, type FetchDeps } from "../src/lib/references/pdfFinder";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- grouping ---------------------------------------------------------------
ok(hostGroup("https://www.cell.com/action/showPdf?pii=S0") === "elsevier", "cell.com → elsevier");
ok(hostGroup("https://www.sciencedirect.com/science/article/pii/X") === "elsevier", "sciencedirect → elsevier");
ok(hostGroup("https://linkinghub.elsevier.com/retrieve/pii/X") === "elsevier", "linkinghub → elsevier");
ok(hostGroup("https://www.nature.com/articles/x.pdf") === "springer", "nature → springer");
ok(hostGroup("https://api.crossref.org/works/10.1/x") === null, "crossref API exempt");
ok(hostGroup("https://api.unpaywall.org/v2/10.1?email=x") === null, "unpaywall API exempt");
ok(hostGroup("https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC1") === null, "NCBI exempt");
ok(hostGroup("https://arxiv.org/pdf/2401.1") === "arxiv.org", "unknown host → registrable-domain group");
ok(hostGroup("not a url") === null, "unparsable → null");
ok(doiGroup("10.1016/j.cell.2026.05.048") === "elsevier", "10.1016 → elsevier");
ok(doiGroup("10.1038/s41586-020-2649-2") === "springer", "10.1038 → springer");
ok(doiGroup("10.99999/whatever") === "doi:10.99999", "unknown prefix → per-prefix group");
ok(doiGroup(undefined) === null && doiGroup("noise") === null, "non-DOI → null");
// doi.org is a redirector, not an API: a GET lands on (and session-counts at) the DOI's
// publisher, so it must be grouped by the DOI prefix in its path — never exempt.
ok(hostGroup("https://doi.org/10.1016/j.cell.2026.05.048") === "elsevier", "doi.org URL → its publisher's group");
ok(hostGroup("https://dx.doi.org/10.1038/s41586-1") === "springer", "dx.doi.org URL → its publisher's group");
ok(hostGroup("https://doi.org/10.99999/x") === "doi:10.99999", "doi.org with unknown prefix → per-prefix group");

// --- repository classification (used for repository-first ordering) --------------
ok(isRepositoryUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234/pdf"), "PMC → repository");
ok(isRepositoryUrl("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf"), "pmc.ncbi → repository");
ok(isRepositoryUrl("https://europepmc.org/articles/PMC9/pdf"), "Europe PMC → repository");
ok(isRepositoryUrl("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC/PMC1/fullTextPDF"), "EBI REST → repository");
ok(isRepositoryUrl("https://arxiv.org/pdf/2401.1"), "arXiv → repository");
ok(isRepositoryUrl("https://www.biorxiv.org/content/10.1101/x.full.pdf"), "bioRxiv → repository");
ok(isRepositoryUrl("https://zenodo.org/record/1/files/x.pdf"), "Zenodo → repository");
ok(!isRepositoryUrl("https://www.cell.com/article/S0/pdf"), "cell.com → NOT repository");

// --- bulk-avoid classifier (now INERT — retained pending a follow-up delete) ----------
// The bulk sweep no longer consults isBulkAvoidUrl: since the paths were unified it fetches
// EVERY OA candidate exactly like the single ⬇ button (repository-first ordering still
// PREFERS a repo copy when one exists — it just never SKIPS the publisher copy). These
// assertions only pin the classifier's grouping so its removal is a clean delete rather than
// a behavior change; nothing in the fetch path branches on them anymore.
ok(isBulkAvoidUrl("https://www.cell.com/action/showPdf?pii=S0"), "cell.com → bulk-avoid (Elsevier)");
ok(isBulkAvoidUrl("https://www.sciencedirect.com/science/article/pii/S0/pdfft?md5=x"), "sciencedirect → bulk-avoid");
ok(isBulkAvoidUrl("https://doi.org/10.1016/j.neuron.1"), "doi.org/10.1016 → bulk-avoid (lands on Elsevier)");
ok(!isBulkAvoidUrl("https://www.mdpi.com/x/pdf"), "MDPI (gold OA) → bulk-safe");
ok(!isBulkAvoidUrl("https://www.frontiersin.org/articles/10.3389/x/pdf"), "Frontiers → bulk-safe");
ok(!isBulkAvoidUrl("https://onlinelibrary.wiley.com/doi/pdfdirect/10.1111/x"), "Wiley → bulk-safe (not a volume-banner)");
ok(!isBulkAvoidUrl("https://escholarship.org/content/x.pdf"), "eScholarship (institutional repo) → bulk-safe");
ok(!isBulkAvoidUrl("https://hdl.handle.net/2027/x"), "HDL handle → bulk-safe");
ok(!isBulkAvoidUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/pdf"), "PMC → bulk-safe");
ok(!isBulkAvoidUrl("https://some-university-repo.example.edu/x.pdf"), "unknown host → bulk-safe (default allow)");

// --- PMCID extracted from a PMC landing/article URL (so the PMC resolvers can fire) -----
ok(pmcidFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/5581692") === "PMC5581692", "PMC id from bare-number article URL");
ok(pmcidFromUrl("https://pmc.ncbi.nlm.nih.gov/articles/PMC10347576/pdf/x.pdf") === "PMC10347576", "PMC id from pmc.ncbi PDF URL");
ok(pmcidFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2736412/") === "PMC2736412", "PMC id from PMC-prefixed article URL");
ok(pmcidFromUrl("https://www.mdpi.com/1424-8220/21/3/795/pdf") === undefined, "non-PMC URL → no PMC id");
ok(pmcidFromUrl(undefined) === undefined, "undefined URL → no PMC id");

// --- resolver plan: repository-first; bulk drops crossref ------------------------
{
  const x = { doi: "10.1016/j.cell.1", openAccessUrl: "https://www.cell.com/article/S0/pdf", pmcid: "PMC1" };
  ok(
    resolverPlan(x).join(",") === "europepmc,pmc-oa,unpaywall,openalex-oa,crossref",
    "plan is repository-first",
    resolverPlan(x).join(","),
  );
  ok(
    resolverPlan(x, { bulkMode: true }).join(",") === "europepmc,pmc-oa,unpaywall,openalex-oa",
    "bulk plan drops crossref (its links are publisher-hosted)",
  );
}

// --- unpaywall host_type parsing + repository-first ordering ----------------------
{
  const json = {
    best_oa_location: { url_for_pdf: "https://www.cell.com/article/S0/pdf", host_type: "publisher" },
    oa_locations: [
      { url_for_pdf: "https://www.cell.com/article/S0/pdf", host_type: "publisher" },
      { url_for_pdf: "https://europepmc.org/articles/PMC1/pdf", host_type: "repository" },
    ],
  };
  const locs = unpaywallPdfLocations(json);
  ok(locs.length === 2 && locs[0].repo && locs[0].url.includes("europepmc"), "repository copies sort first", JSON.stringify(locs));
}

// --- waterfall bulkMode: skip ONLY the ban-prone publisher; fetch everything else ----
{
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]); // %PDF-
  const depsWith = (unpaywall: { url_for_pdf: string; host_type: string }[], fetched: string[]): FetchDeps => ({
    email: "t@t",
    getJson: async (url) => (url.includes("unpaywall") ? { oa_locations: unpaywall } : null),
    getText: async () => null,
    getBytes: async (url) => {
      fetched.push(url);
      return { bytes: pdf, finalUrl: url, contentType: "application/pdf" };
    },
  });

  // (a) Elsevier (cell.com) + repository copy both offered → repository-FIRST ordering means
  //     the repo copy is tried and wins before the cell.com URL is ever requested (no filter
  //     needed to keep bulk off the publisher when a repo copy exists).
  {
    const fetched: string[] = [];
    const r = await runWaterfall(
      { doi: "10.1016/j.cell.1", openAccessUrl: "https://www.sciencedirect.com/science/article/pii/S0/pdfft" },
      depsWith(
        [
          { url_for_pdf: "https://www.cell.com/article/S0/pdf", host_type: "publisher" },
          { url_for_pdf: "https://europepmc.org/articles/PMC1/pdf", host_type: "repository" },
        ],
        fetched,
      ),
      { bulkMode: true },
    );
    ok(!!r && r.url.includes("europepmc"), "bulk prefers the repository copy over the Elsevier one");
    ok(fetched.every((u) => !/cell\.com|sciencedirect/.test(u)), "repo copy won first → no Elsevier URL requested", fetched.join(","));
  }

  // (b) THE FIX: an ordinary/gold-OA publisher (MDPI) is now downloaded directly in bulk
  //     — the old repository-only rule wrongly skipped these (the "OA got nothing" bug).
  {
    const fetched: string[] = [];
    const r = await runWaterfall(
      { doi: "10.3390/x", openAccessUrl: "https://www.mdpi.com/1/1/1/pdf" },
      depsWith([], fetched),
      { bulkMode: true },
    );
    ok(!!r && r.url.includes("mdpi.com"), "bulk downloads a gold-OA publisher (MDPI) directly");
    ok(fetched.some((u) => u.includes("mdpi.com")), "MDPI URL was actually requested in bulk");
  }

  // (c) institutional repository not on the explicit allowlist (eScholarship) → bulk-safe.
  {
    const fetched: string[] = [];
    const r = await runWaterfall(
      { doi: "10.5555/x", openAccessUrl: "https://escholarship.org/content/qt1/qt1.pdf" },
      depsWith([], fetched),
      { bulkMode: true },
    );
    ok(!!r && r.url.includes("escholarship"), "bulk downloads an institutional repo (eScholarship) directly");
  }

  // (d) THE FIX: a Cell Press paper whose ONLY OA copy is on cell.com is now FETCHED in bulk
  //     (previously the bulkMode filter skipped it → false no-oa miss → the user's complaint).
  {
    const fetched: string[] = [];
    const r = await runWaterfall(
      { doi: "10.1016/j.neuron.1", openAccessUrl: "https://www.cell.com/article/S0/pdf" },
      depsWith([], fetched),
      { bulkMode: true },
    );
    ok(!!r && r.url.includes("cell.com") && r.source === "openalex-oa", "bulk now fetches the cell.com OA PDF (Cell Press)", JSON.stringify(r && { s: r.source, u: r.url }));
    ok(fetched.some((u) => u.includes("cell.com")), "the cell.com URL was actually requested in bulk");
  }

  // (e) bulk and single (non-bulk) are now IDENTICAL for candidates — both fetch cell.com.
  {
    const fetchedBulk: string[] = [];
    const fetchedSingle: string[] = [];
    const rb = await runWaterfall({ doi: "10.1016/j.neuron.1", openAccessUrl: "https://www.cell.com/article/S0/pdf" }, depsWith([], fetchedBulk), { bulkMode: true });
    const rs = await runWaterfall({ doi: "10.1016/j.neuron.1", openAccessUrl: "https://www.cell.com/article/S0/pdf" }, depsWith([], fetchedSingle));
    ok(!!rb && !!rs && rb.url === rs.url, "bulk and single fetch the same cell.com candidate (paths unified)");
  }

  // (f) PMCID backfilled from a PMC article-page URL (no pmcid in enrich) → the PMC OA
  //     resolver fires and fetches the repository PDF (the "OA via PubMed" path).
  {
    const fetched: string[] = [];
    const deps: FetchDeps = {
      email: "t@t",
      getJson: async () => null,
      getText: async (u) =>
        u.includes("oa.fcgi") ? '<OA><record><link format="pdf" href="https://ftp.ncbi.nlm.nih.gov/pub/pmc/x.pdf"/></record></OA>' : null,
      getBytes: async (u) => {
        fetched.push(u);
        return { bytes: pdf, finalUrl: u, contentType: "application/pdf" };
      },
    };
    const r = await runWaterfall(
      { doi: "10.5555/x", openAccessUrl: "https://www.ncbi.nlm.nih.gov/pmc/articles/5581692", isOa: true },
      deps,
      { bulkMode: true },
    );
    // Backfilled PMC5581692 → a PMC repository resolver (europepmc is first, then pmc-oa)
    // fires for a paper that had NO pmcid in enrich and only a PMC article-page URL.
    ok(
      !!r && (r.source === "europepmc" || r.source === "pmc-oa") && /ncbi\.nlm\.nih\.gov|ebi\.ac\.uk/.test(r.url),
      "PMCID from URL → PMC resolver fires + fetches",
      JSON.stringify(r && { s: r.source, u: r.url }),
    );
  }
}

// --- sliding-window budget ----------------------------------------------------
{
  let now = 0;
  const waits: number[] = [];
  const lim = new HostLimiter({
    budget: 10,
    windowMs: 1000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  for (let i = 0; i < 10; i++) await lim.acquire("pub", 1);
  ok(waits.length === 0, "budget admits spends up to the cap without waiting");
  ok(lim.msUntilAllowed("pub", 1) === 1000, "next spend must wait for the oldest to age out");
  await lim.acquire("pub", 1);
  ok(waits.length === 1 && waits[0] === 1000 && now === 1000, "acquire waited exactly until room freed", `waits=${waits}`);
  ok(lim.spent("pub") === 1, "window slid: only the new spend remains counted");
  ok(lim.msUntilAllowed("other", 10) === 0, "groups are independent");
}
{
  // Staggered spends free room incrementally: 5 units at t=0 + 5 at t=500, cost-2 acquire
  // at t=600 must wait until t=1000 (both t=0… entries needed? over=2 → oldest 2 of the
  // t=0 batch suffice → wait 400ms).
  let now = 0;
  const lim = new HostLimiter({ budget: 10, windowMs: 1000, now: () => now, sleep: async (ms) => void (now += ms) });
  for (let i = 0; i < 5; i++) lim.record("pub", 1);
  now = 500;
  for (let i = 0; i < 5; i++) lim.record("pub", 1);
  now = 600;
  ok(lim.msUntilAllowed("pub", 2) === 400, "partial age-out computes the earliest admissible time");
  await lim.acquire("pub", 2);
  ok(now === 1000, "acquire slept to that time");
}
{
  // Real-scale sanity: captures are budgeted ~7 per window per publisher.
  let now = 0;
  const lim = new HostLimiter({ now: () => now, sleep: async (ms) => void (now += ms) });
  let n = 0;
  while (lim.msUntilAllowed("elsevier", CAPTURE_COST) === 0) {
    lim.record("elsevier", CAPTURE_COST);
    n++;
  }
  ok(
    n === Math.floor(SESSION_BUDGET / CAPTURE_COST),
    `captures per window = ${Math.floor(SESSION_BUDGET / CAPTURE_COST)}`,
    `got ${n}`,
  );
  ok(RATE_WINDOW_MS === 5 * 60_000, "window matches the publisher's 5-minute measurement window");
}

// --- per-group GET budget: the load-bearing Elsevier ban backstop ---------------
// The OA phase downloads publisher-hosted OA (cell.com) through the cookie-jar `getLimiter`,
// whose DEFAULT budget (500) is deliberately > the 90/5min wall — the jar collapses a host's
// requests to one server-side session, so the default is only a runaway guard. Ban-safety must
// NOT rest on that assumption, so the `elsevier` group is capped independently at 45 (½ the
// wall) regardless of session collapse. Verify both the production limiter and the mechanism.
{
  ok(getLimiter.budgetFor("elsevier") === ELSEVIER_GET_BUDGET, "getLimiter caps the elsevier group at its override budget");
  ok(getLimiter.budgetFor("elsevier") < 90, "the effective elsevier GET budget stays under the 90-sessions/5min wall");
  ok(getLimiter.budgetFor("springer") === GET_SESSION_BUDGET, "an unlisted group keeps the generous default GET budget");
}
{
  // The per-group override throttles ONLY the capped group; a default group is untouched.
  let now = 0;
  const lim = new HostLimiter({ budget: GET_SESSION_BUDGET, budgets: { elsevier: ELSEVIER_GET_BUDGET }, windowMs: 1000, now: () => now, sleep: async (ms) => void (now += ms) });
  for (let i = 0; i < ELSEVIER_GET_BUDGET; i++) lim.record("elsevier", GET_COST);
  ok(lim.msUntilAllowed("elsevier", GET_COST) === 1000, `elsevier throttles after ${ELSEVIER_GET_BUDGET} GETs (the ban backstop)`);
  for (let i = 0; i < ELSEVIER_GET_BUDGET; i++) lim.record("springer", GET_COST);
  ok(lim.msUntilAllowed("springer", GET_COST) === 0, "a default-budget group is unaffected by the elsevier cap at the same instant");
  // ...and the default group only throttles at its own (much larger) cap.
  for (let i = ELSEVIER_GET_BUDGET; i < GET_SESSION_BUDGET; i++) lim.record("springer", GET_COST);
  ok(lim.msUntilAllowed("springer", GET_COST) === 1000, `the default group throttles only at ${GET_SESSION_BUDGET} GETs`);
}

// --- interleave ---------------------------------------------------------------
{
  const items = ["a1", "a2", "a3", "b1", "b2", "c1"];
  const out = interleaveByGroup(items, (s) => s[0]);
  ok(out.join(",") === "a1,b1,c1,a2,b2,a3", "round-robins across groups", out.join(","));
  ok(interleaveByGroup(items, () => null).join(",") === items.join(","), "single/ungrouped keeps order");
  ok(interleaveByGroup([], (s) => s).length === 0, "empty in → empty out");
}

// --- abortable sleep ------------------------------------------------------------
{
  const ctrl = new AbortController();
  const p = abortableSleep(60_000, ctrl.signal).then(
    () => "resolved",
    (e: Error) => e.name,
  );
  ctrl.abort();
  ok((await p) === "AbortError", "abort during a rate-limit wait rejects immediately");
}

// --- OA-miss helpers -------------------------------------------------------------
{
  const sig = oaSig({ doi: " 10.1016/J.CELL.2026.05.048 ", openAccessUrl: undefined, pmcid: undefined });
  ok(sig === "10.1016/j.cell.2026.05.048||", "oaSig normalizes DOI case/whitespace", sig);
  const now = Date.now();
  const fresh: OaMiss = { at: new Date(now - 1000).toISOString(), attempts: 1, sig };
  ok(isFreshOaMiss(fresh, sig, now), "recent same-sig miss is fresh (skipped)");
  ok(!isFreshOaMiss(fresh, sig + "x", now), "changed identifiers invalidate the miss (re-checked)");
  const old: OaMiss = { at: new Date(now - OA_MISS_TTL_MS - 1).toISOString(), attempts: 3, sig };
  ok(!isFreshOaMiss(old, sig, now), "TTL expiry invalidates the miss (embargoes lapse)");
  ok(!isFreshOaMiss(undefined, sig, now), "no record → not fresh");
  ok(!isFreshOaMiss({ at: "garbage", attempts: 1, sig }, sig, now), "corrupt timestamp → not fresh");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
