// Pure-logic verification of the PDF identification confidence gate — the risk surface of the
// watched-inbox feature. Feeds synthetic PdfSignals + mocked resolveDoi/searchTitle into the
// shared pipeline and asserts the "refuse rather than misassign" contract. Run:
//   npx tsx scripts/verify-pdfidentify.ts
import {
  identify,
  reconcile,
  normDoi,
  findDois,
  piiToDoi,
  looksLikeTitle,
  unresolvedSidecar,
  titleContainment,
  titleSimilarity,
  type PdfSignals,
  type PaperMeta,
  type SearchHit,
  type IdentifyDeps,
} from "../src/lib/references/pdfIdentify";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const sig = (o: Partial<PdfSignals>): PdfSignals => ({ page1Text: "", tailText: "", numPages: 10, ...o });

// A resolver backed by a fixture map DOI→title; a search backed by a fixture list.
const REAL = "10.1126/science.aaw5202";
const REAL_TITLE = "Cortical layer-specific critical dynamics triggering perception";
const CITED = "10.1016/j.neuron.2012.06.029"; // a DOI that appears only in the references
const CITED_TITLE = "Ultrafast optogenetic control of parvalbumin interneurons";
function mkDeps(over: Partial<IdentifyDeps> = {}): IdentifyDeps {
  const table: Record<string, PaperMeta> = {
    [REAL]: { doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" },
    [CITED]: { doi: CITED, title: CITED_TITLE, authors: ["Someone Else"], year: "2012" },
  };
  return {
    resolveDoi: async (d) => table[d] ?? null,
    searchTitle: async () => [],
    ...over,
  };
}

// --- primitives -------------------------------------------------------------------
ok(normDoi("doi: 10.1126/science.aaw5202.") === REAL, "normDoi strips doi: prefix + trailing dot");
ok(normDoi("https://doi.org/10.1126/science.aaw5202") === REAL, "normDoi strips doi.org url");
ok(normDoi("not a doi") === undefined, "normDoi rejects non-DOI");
ok(findDois("see 10.1126/science.aaw5202 for details").length === 1, "findDois pulls a DOI from prose");
ok(titleContainment(REAL_TITLE, `Header. ${REAL_TITLE}. Authors...`) === 1, "titleContainment=1 when title present verbatim");
ok(titleContainment(REAL_TITLE, "an unrelated paper about neurons and cortex") < 0.5, "titleContainment low for unrelated text");
ok(titleSimilarity(REAL_TITLE, REAL_TITLE) === 1, "titleSimilarity=1 for identical titles");

// --- Tier 1: embedded / masthead / body / refs ------------------------------------
{
  const r = await identify(sig({ xmpDoi: REAL, page1Text: "unrelated body text" }), mkDeps());
  ok(r.status === "identified" && r.doi === REAL && r.method === "doi:embedded", "XMP DOI accepted (authoritative, no title match needed)", JSON.stringify(r));
}
{
  // A DOI on page 1 WITH the title present on page 1 (a genuine masthead) → accepted via the
  // title cross-check (method doi:page1).
  const p1 = `Science Reports. ${REAL_TITLE}. J. Marshel et al. 2019. doi:10.1126/science.aaw5202`;
  const r = await identify(sig({ page1Text: p1 }), mkDeps());
  ok(r.status === "identified" && r.doi === REAL && r.method === "doi:page1", "page-1 DOI + title-on-page-1 → accepted", JSON.stringify(r).slice(0, 90));
}
{
  // THE BETZIG CASE (caught in the real dry-run): a short report whose page 1 prints a REFERENCE
  // DOI at a LOW character offset. Position must NOT bypass the title check — the reference DOI's
  // resolved title doesn't match page 1, so it must be REJECTED, not mis-added.
  const p1 = `${REAL_TITLE}. Full article body. References: 24. Foo, Bar, ${CITED} (2012).`;
  const r = await identify(sig({ page1Text: p1 }), mkDeps({ searchTitle: async () => [] }));
  ok(r.status !== "identified" || r.doi !== CITED, "early-offset reference DOI without title match → NOT that paper", JSON.stringify(r).slice(0, 120));
}
{
  // A DOI that appears ONLY in the references (tail). Same rejection via title cross-check.
  const r = await identify(sig({ page1Text: REAL_TITLE + " full article body", tailText: `References [1] ... ${CITED}` }), mkDeps());
  ok(r.status !== "identified" || r.doi !== CITED, "references-tail DOI is NOT accepted as identity", JSON.stringify(r).slice(0, 120));
}
{
  // OCR-typo DOI that resolves to a real-but-WRONG paper (title mismatch) → rejected.
  const r = await identify(sig({ page1Text: `${REAL_TITLE} article body`, tailText: `10.1016/j.neuron.2012.06.029` }), mkDeps());
  ok(r.status === "unresolved", "wrong-paper DOI (title mismatch) rejected", JSON.stringify(r).slice(0, 120));
}

// --- Tier 2: fuzzy title search -----------------------------------------------------
{
  const hits: SearchHit[] = [{ doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" }];
  const r = await identify(
    sig({ xmpTitle: REAL_TITLE, page1Text: "Marshel et al. 2019 — full text with no DOI printed" }),
    mkDeps({ searchTitle: async () => hits }),
  );
  ok(r.status === "identified" && r.doi === REAL && r.method === "search", "title-only paper matched via search (≥0.90 + year/author)", JSON.stringify(r).slice(0, 90));
}
{
  // Near-miss title (below 0.90) → unresolved, never guessed.
  const hits: SearchHit[] = [{ doi: "10.9999/x", title: "Cortical dynamics of something entirely different", authors: ["Nobody"], year: "2019" }];
  const r = await identify(sig({ xmpTitle: REAL_TITLE, page1Text: "2019 body" }), mkDeps({ searchTitle: async () => hits }));
  ok(r.status === "unresolved", "near-miss search hit → unresolved (below SIM)", JSON.stringify(r).slice(0, 90));
}
{
  // Strong title match but NO year/author corroboration on page 1 → unresolved.
  const hits: SearchHit[] = [{ doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" }];
  const r = await identify(sig({ xmpTitle: REAL_TITLE, page1Text: "no corroborating year or author here" }), mkDeps({ searchTitle: async () => hits }));
  ok(r.status === "unresolved", "title match without year/author corroboration → unresolved", JSON.stringify(r).slice(0, 90));
}
{
  // Nothing to go on → unresolved with diagnostics.
  const r = await identify(sig({ page1Text: "scanned image, no text of use" }), mkDeps());
  ok(r.status === "unresolved" && "diagnostics" in r, "empty signals → unresolved + diagnostics");
}

// --- transient-vs-definitive + the candidate cap (assign hardening) -----------------
{
  // Offline: every resolve THROWS (the IdentifyDeps transient contract) → the verdict must be
  // retryable, so the caller leaves the PDF in the inbox instead of quarantining it.
  const r = await identify(
    sig({ xmpDoi: REAL, page1Text: "body" }),
    mkDeps({ resolveDoi: async () => {
      throw new Error("fetch failed");
    } }),
  );
  ok(r.status === "unresolved" && r.retryable === true, "transient resolve failure → unresolved + retryable", JSON.stringify(r).slice(0, 120));
}
{
  // Transient search failure (no DOI candidates at all) → also retryable.
  const r = await identify(
    sig({ xmpTitle: REAL_TITLE, page1Text: "titled body, no DOI" }),
    mkDeps({ searchTitle: async () => {
      throw new Error("OpenAlex 503");
    } }),
  );
  ok(r.status === "unresolved" && r.retryable === true, "transient search failure → unresolved + retryable");
}
{
  // A DEFINITIVE miss (resolver returns null everywhere, search finds nothing) is NOT retryable.
  const r = await identify(sig({ page1Text: `Body citing 10.9999/nope.123` }), mkDeps({ resolveDoi: async () => null }));
  ok(r.status === "unresolved" && !r.retryable, "definitive non-resolution → unresolved, NOT retryable");
}
{
  // Candidate cap: a references-section with many DOIs must not fire unbounded resolutions.
  const many = Array.from({ length: 12 }, (_, i) => `10.5555/ref.${i}`).join(" ");
  let calls = 0;
  const r = await identify(
    sig({ page1Text: "no doi on page 1", tailText: `References: ${many}` }),
    mkDeps({ resolveDoi: async () => {
      calls++;
      return null;
    } }),
  );
  ok(calls === 4 && r.status === "unresolved", `candidate cap limits resolutions to MAX_RESOLVES (made ${calls})`);
  ok(r.status === "unresolved" && r.diagnostics.rejected.some((x) => x.includes("candidate cap")), "capped candidates recorded in diagnostics");
}
{
  // Cap override is honored (engines could tune it).
  let calls = 0;
  await identify(
    sig({ tailText: Array.from({ length: 9 }, (_, i) => `10.5555/x.${i}`).join(" "), page1Text: "p1" }),
    mkDeps({ resolveDoi: async () => {
      calls++;
      return null;
    } }),
    { maxResolves: 2 },
  );
  ok(calls === 2, "maxResolves override honored");
}
{
  // A transient failure must NOT block a later candidate from identifying the paper.
  const p1 = `${REAL_TITLE}. body. doi:10.7777/flaky.1 then 10.1126/science.aaw5202`;
  const r = await identify(
    sig({ page1Text: p1 }),
    mkDeps({ resolveDoi: async (d) => {
      if (d === "10.7777/flaky.1") throw new Error("429");
      return d === REAL ? { doi: REAL, title: REAL_TITLE, authors: [], year: "2019" } : null;
    } }),
  );
  ok(r.status === "identified" && r.doi === REAL, "identification proceeds past a transient candidate");
}

// --- Elsevier PII in the /Title slot (the 2026-08-06 inbox backlog) -----------------
// Old Elsevier scans carry `PII: 0013-4694(81)90225-X` as the PDF's /Title. It is not a title at
// all — it is the article's identifier, and the DOI is literally "10.1016/" + the PII.
ok(piiToDoi("PII: 0013-4694(81)90225-X") === "10.1016/0013-4694(81)90225-x", "old-form PII → DOI", String(piiToDoi("PII: 0013-4694(81)90225-X")));
ok(piiToDoi("PII: S0166-2236(98)01349-6") === "10.1016/s0166-2236(98)01349-6", "new-form (S…) PII → DOI", String(piiToDoi("PII: S0166-2236(98)01349-6")));
ok(piiToDoi("Counting Quanta: Direct Measurements") === undefined, "a real title yields no PII DOI");
ok(piiToDoi("") === undefined && piiToDoi(undefined) === undefined, "empty input yields no PII DOI");
{
  // THE ARAQUE CASE: page 1 of the scan is the PRECEDING article's letters page, so no title
  // cross-check is possible — yet the /Title PII names this article exactly. A PII in the
  // publisher's own metadata slot is as authoritative as an embedded /doi.
  const PII_DOI = "10.1016/s0166-2236(98)01349-6";
  const TITLE = "Tripartite synapses: glia, the unacknowledged partner";
  const r = await identify(
    sig({ infoTitle: "PII: S0166-2236(98)01349-6", page1Text: "LETTERS TO THE EDITOR — components of the stretch-reflex system…" }),
    mkDeps({ resolveDoi: async (d) => (d === PII_DOI ? { doi: d, title: TITLE, authors: ["Alfonso Araque"], year: "1999" } : null) }),
  );
  ok(r.status === "identified" && r.doi === PII_DOI && r.method === "doi:pii", "PII in /Title identifies the paper without a page-1 title match", JSON.stringify(r).slice(0, 110));
}
{
  // A PII is a CANDIDATE, not a verdict: if it doesn't resolve, nothing is guessed.
  const r = await identify(sig({ infoTitle: "PII: S9999-9999(99)99999-9", page1Text: "body" }), mkDeps({ resolveDoi: async () => null }));
  ok(r.status === "unresolved", "an unresolvable PII does not become an identity");
}
{
  // A PII in the page TEXT is NOT used — page text can be a references list (the masthead lesson).
  const r = await identify(sig({ page1Text: "References: 12. Foo et al. PII: S0166-2236(98)01349-6" }), mkDeps({ resolveDoi: async () => ({ doi: "10.1016/s0166-2236(98)01349-6", title: "Some Cited Paper", authors: [], year: "1999" }) }));
  ok(r.status === "unresolved", "a PII in page text is not taken as identity", JSON.stringify(r).slice(0, 110));
}

// --- junk /Title values must not consume Tier 2's only query ------------------------
ok(!looksLikeTitle("PII: 0013-4694(81)90225-X"), "PII is not a title");
ok(!looksLikeTitle("SLEEP.30.12.1631.indd"), "InDesign filename is not a title");
ok(!looksLikeTitle("NSS_A_330939 217..230"), "publisher workflow id is not a title");
ok(!looksLikeTitle("ns030000899p"), "bare production id is not a title");
ok(!looksLikeTitle("CRMETH101179_mmc2 1..1"), "supplement component id is not a title");
ok(looksLikeTitle(REAL_TITLE), "a real title is a title");
ok(looksLikeTitle("Counting quanta: direct measurements of transmitter release"), "another real title is a title");
{
  // THE LI CASE: /Title is "ns030000899p", and the real title is the font-size guess right behind
  // it. The old query rule ("first non-empty title field") searched the junk and stopped.
  const hits: SearchHit[] = [{ doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" }];
  const seen: string[] = [];
  const r = await identify(
    sig({ infoTitle: "ns030000899p", titleGuess: REAL_TITLE, page1Text: "Marshel et al. 2019 body text" }),
    mkDeps({ searchTitle: async (q) => {
      seen.push(q);
      return q === REAL_TITLE ? hits : [];
    } }),
  );
  ok(r.status === "identified" && r.doi === REAL, "junk /Title is skipped so the real title guess is searched", JSON.stringify(r).slice(0, 100));
  ok(!seen.includes("ns030000899p"), `implausible title never queried (queried: ${JSON.stringify(seen)})`);
}
{
  // A junk-but-prose-shaped /Title (Dove Press: "NSS-54036-sleep--recovery-and-…") passes the
  // plausibility check, returns nothing, and Tier 2 FALLS THROUGH to the next query.
  const hits: SearchHit[] = [{ doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" }];
  const seen: string[] = [];
  const r = await identify(
    sig({ infoTitle: "NSS-54036-sleep--recovery-and-metaregulation--explaining-the-benefits-", titleGuess: REAL_TITLE, page1Text: "Marshel 2019 body" }),
    mkDeps({ searchTitle: async (q) => {
      seen.push(q);
      return q === REAL_TITLE ? hits : [];
    } }),
  );
  ok(r.status === "identified" && r.doi === REAL, "Tier 2 falls through a fruitless first query", JSON.stringify(r).slice(0, 100));
  ok(seen.length === 2, `both queries attempted, bounded by MAX_TITLE_QUERIES (made ${seen.length})`);
}
{
  // The query budget is a hard bound — 4 plausible sources, at most 2 searched.
  const seen: string[] = [];
  await identify(
    sig({ xmpTitle: "Alpha beta gamma delta", infoTitle: "Epsilon zeta eta theta", titleGuess: "Iota kappa lambda mu", page1Text: "Nu xi omicron pi" }),
    mkDeps({ searchTitle: async (q) => {
      seen.push(q);
      return [];
    } }),
  );
  ok(seen.length === 2, `title queries capped at MAX_TITLE_QUERIES (made ${seen.length})`);
}

// --- Tier 2 skips UNUSABLE hits, but still judges only the first usable one ----------
{
  // THE STERIADE CASE: the registry returns the same paper twice and the TOP copy carries no DOI.
  // That record is unusable, not unconvincing — look past it to the one we could actually file.
  const hits: SearchHit[] = [
    { title: REAL_TITLE, authors: ["James Marshel"], year: "2019" }, // no DOI
    { doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" },
  ];
  const r = await identify(sig({ titleGuess: REAL_TITLE, page1Text: "Marshel 2019 body" }), mkDeps({ searchTitle: async () => hits }));
  ok(r.status === "identified" && r.doi === REAL, "a DOI-less top hit does not block the identical hit behind it", JSON.stringify(r).slice(0, 100));
}
{
  // THE VIRCHOW CASE (2026-08-06, refused by hand): a 24-page 1861 REVIEW OF a book. Every hit
  // scores sim 1.00 because the review quotes the book's title verbatim in its header, and the
  // book's author is named on page 1 — so a SECOND hit with the right year/author would sail
  // through. The rule that saves the library is that the first usable hit's verdict is final:
  // failing corroboration means "not this paper", not "keep looking for one that agrees".
  const BOOK = "Cellular pathology as based upon physiological and pathological histology";
  const hits: SearchHit[] = [
    { doi: "10.7326/0003-4819-76-1-157_2", title: BOOK + ".", authors: ["Anon Reviewer"], year: "1972" },
    { doi: "10.5962/bhl.title.32770", title: BOOK, authors: ["Rudolf Virchow"], year: "1858" },
  ];
  const p1 = `THE NORTH AMERICAN MEDICO-CHIRURGICAL REVIEW. MAY, 1861. Art. I.— ${BOOK}. By Rudolf Virchow. Translated from the German, by Frank Chance.`;
  const r = await identify(sig({ infoTitle: BOOK, page1Text: p1 }), mkDeps({ searchTitle: async () => hits, resolveDoi: async () => null }));
  ok(r.status === "unresolved", "a review OF a work is not identified AS that work", JSON.stringify(r).slice(0, 140));
}
{
  // Same shape, stated as a rule: a rejected top hit is a verdict, so a corroborated hit BEHIND
  // it is never shopped for.
  const hits: SearchHit[] = [
    { doi: "10.9999/wrong", title: REAL_TITLE, authors: ["Nobody"], year: "1899" }, // sim 1.00, no corroboration
    { doi: REAL, title: REAL_TITLE, authors: ["James Marshel"], year: "2019" }, // would have passed
  ];
  const r = await identify(sig({ titleGuess: REAL_TITLE, page1Text: "Marshel et al. 2019 body" }), mkDeps({ searchTitle: async () => hits }));
  ok(r.status === "unresolved", "an uncorroborated top hit ends the query — no shopping down the list", JSON.stringify(r).slice(0, 120));
}

// --- the sidecar is built once, in the shared core ----------------------------------
{
  const r = await identify(
    sig({ infoTitle: "ns030000899p", titleGuess: "Some plausible looking title here", page1Text: "body" }),
    mkDeps({ searchTitle: async () => [{ doi: "10.9999/x", title: "Unrelated work", authors: ["Nobody"], year: "1911" }] }),
  );
  const txt = unresolvedSidecar("paper.pdf", r.status === "unresolved" ? r.reason : "", r);
  ok(txt.startsWith('Could not identify "paper.pdf" with confidence.'), "sidecar opens with the file it refused");
  ok(txt.includes("Title query: Some plausible looking title here"), "sidecar lists the queries actually attempted", txt);
  ok(!txt.includes("ns030000899p"), "sidecar does not report a query that was never made");
  ok(txt.includes("Top search hits:") && txt.includes("Unrelated work"), "sidecar shows the hits that were rejected");
}

// --- reconcile: the three outcomes -------------------------------------------------
const idOk = { status: "identified" as const, doi: REAL, meta: { doi: REAL, title: REAL_TITLE, authors: [] }, method: "doi:embedded", confidence: "high" as const };
ok(reconcile(idOk, "marshel2019cortical", false).kind === "attach", "exists + no PDF → attach");
ok(reconcile(idOk, "marshel2019cortical", true).kind === "discard", "exists + has PDF → discard");
ok(reconcile(idOk, null, false).kind === "add", "not in library → add");
ok(reconcile({ status: "unresolved", reason: "x", diagnostics: { candidates: [], rejected: [] } }, null, false).kind === "unresolved", "unresolved id → unresolved action");

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
