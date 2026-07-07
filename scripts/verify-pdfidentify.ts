// Pure-logic verification of the PDF identification confidence gate — the risk surface of the
// watched-inbox feature. Feeds synthetic PdfSignals + mocked resolveDoi/searchTitle into the
// shared pipeline and asserts the "refuse rather than misassign" contract. Run:
//   npx tsx scripts/verify-pdfidentify.ts
import {
  identify,
  reconcile,
  normDoi,
  findDois,
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

// --- reconcile: the three outcomes -------------------------------------------------
const idOk = { status: "identified" as const, doi: REAL, meta: { doi: REAL, title: REAL_TITLE, authors: [] }, method: "doi:embedded", confidence: "high" as const };
ok(reconcile(idOk, "marshel2019cortical", false).kind === "attach", "exists + no PDF → attach");
ok(reconcile(idOk, "marshel2019cortical", true).kind === "discard", "exists + has PDF → discard");
ok(reconcile(idOk, null, false).kind === "add", "not in library → add");
ok(reconcile({ status: "unresolved", reason: "x", diagnostics: { candidates: [], rejected: [] } }, null, false).kind === "unresolved", "unresolved id → unresolved action");

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
