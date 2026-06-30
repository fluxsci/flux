#!/usr/bin/env -S npx tsx
// Headless unit test for the pure OpenAlex layer (src/lib/references/openalex.ts)
// + the enrichment merge (src/lib/references/enrich.ts). No network. Run:
//   npx tsx scripts/verify-openalex.ts
import {
  reconstructAbstract,
  workToEnrich,
  workToBrief,
  batchByDoiUrl,
  worldSearchUrl,
  authorWorksUrl,
  citingWorksUrl,
  worksByIdsUrl,
} from "../src/lib/references/openalex";
import { mergeEnrich, enrichCoverage, topicProfile } from "../src/lib/references/enrich";
import type { RefEntry } from "../src/lib/references/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dec = (u: string) => decodeURIComponent(u);

// --- reconstructAbstract -----------------------------------------------------
assert(reconstructAbstract({ a: [2], b: [0], c: [1] }) === "b c a", "abstract reconstructed in position order");
assert(reconstructAbstract(null) === undefined, "null inverted index → undefined");
assert(reconstructAbstract({}) === undefined, "empty inverted index → undefined");

// --- workToEnrich (realistic OpenAlex work shape) ----------------------------
const work = {
  id: "https://openalex.org/W2741809807",
  doi: "https://doi.org/10.1038/NATURE14539",
  title: "Deep learning",
  display_name: "Deep learning",
  publication_year: 2015,
  cited_by_count: 80000,
  abstract_inverted_index: { Deep: [0], learning: [1], rocks: [2] },
  primary_topic: {
    id: "https://openalex.org/T10994",
    display_name: "Neural Networks",
    score: 0.99,
    subfield: { id: "s1", display_name: "Artificial Intelligence" },
    field: { id: "f1", display_name: "Computer Science" },
    domain: { id: "d1", display_name: "Physical Sciences" },
  },
  topics: [
    { id: "https://openalex.org/T10994", display_name: "Neural Networks", score: 0.99 },
    { id: "https://openalex.org/T2", display_name: "Machine Learning", score: 0.8 },
  ],
  keywords: [
    { id: "k1", display_name: "deep learning", score: 0.7 },
    { id: "k2", display_name: "neural networks", score: 0.6 },
  ],
  mesh: [{ descriptor_ui: "D1", descriptor_name: "Neural Networks (Computer)", is_major_topic: true }],
  counts_by_year: [
    { year: 2020, cited_by_count: 5000 },
    { year: 2021, cited_by_count: 6000 },
  ],
  referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2"],
  related_works: ["https://openalex.org/W9"],
  open_access: { is_oa: true, oa_status: "green", oa_url: "https://example.com/pdf" },
  authorships: [
    {
      author_position: "first",
      author: { id: "https://openalex.org/A1", display_name: "Yann LeCun", orcid: "https://orcid.org/0000-0001" },
      institutions: [{ id: "I1", display_name: "NYU" }],
    },
    {
      author_position: "middle",
      author: { id: "https://openalex.org/A2", display_name: "Yoshua Bengio", orcid: null },
      institutions: [],
    },
  ],
  ids: {
    openalex: "https://openalex.org/W2741809807",
    doi: "https://doi.org/10.1038/nature14539",
    mag: "2741809807",
    pmid: "https://pubmed.ncbi.nlm.nih.gov/26017442",
  },
};

const e = workToEnrich(work, "lecun2015deep");
assert(e.key === "lecun2015deep", "carries the citekey");
assert(e.doi === "10.1038/nature14539", "doi normalized to bare lowercase");
assert(e.openalexId === "W2741809807", "openalexId shortened");
assert(e.abstract === "Deep learning rocks", "abstract reconstructed");
assert(e.primaryTopic?.name === "Neural Networks" && e.primaryTopic?.field === "Computer Science" && e.primaryTopic?.subfield === "Artificial Intelligence" && e.primaryTopic?.domain === "Physical Sciences", "primaryTopic flattened");
assert(e.topics?.length === 2 && e.topics?.[1].name === "Machine Learning", "topics mapped");
assert(eq(e.keywords, ["deep learning", "neural networks"]), "keywords → display names");
assert(eq(e.mesh, ["Neural Networks (Computer)"]), "mesh → descriptor names");
assert(e.citedByCount === 80000, "citedByCount mapped");
assert(eq(e.countsByYear?.[0], { year: 2020, cited: 5000 }), "counts_by_year → {year,cited}");
assert(eq(e.referencedWorks, ["W1", "W2"]), "referenced_works shortened");
assert(eq(e.relatedWorks, ["W9"]), "related_works shortened");
assert(eq(e.openAccess, { isOa: true, status: "green", url: "https://example.com/pdf" }), "open_access mapped");
assert(eq(e.authors?.[0], { name: "Yann LeCun", openalexId: "A1", orcid: "https://orcid.org/0000-0001" }), "author[0] mapped");
assert(e.authors?.[1].orcid === undefined, "null orcid → undefined");
assert(e.ids?.pmid === "26017442" && e.ids?.mag === "2741809807" && e.ids?.pmcid === undefined, "external ids stripped");
assert(e.fetchedAt === "" && eq(e.sources, ["openalex"]), "fetchedAt left for caller; sources defaulted");

// --- workToBrief -------------------------------------------------------------
const b = workToBrief(work);
assert(b.title === "Deep learning" && b.year === "2015" && b.citedByCount === 80000, "brief core fields");
assert(eq(b.authors, ["Yann LeCun", "Yoshua Bengio"]) && b.openalexId === "W2741809807", "brief authors + id");
assert(b.oaUrl === "https://example.com/pdf" && b.topic === "Neural Networks", "brief oaUrl + topic");

// --- URL builders ------------------------------------------------------------
const dois = Array.from({ length: 120 }, (_, i) => "10.1234/x" + i);
const urls = batchByDoiUrl(dois, { mailto: "me@x.io" });
assert(urls.length === 3, "120 DOIs → 3 batches (50/50/20)");
assert(dec(urls[0]).includes("filter=doi:10.1234/x0|10.1234/x1"), "DOI OR-filter joined by |");
assert(dec(urls[0]).includes("per-page=50") && dec(urls[2]).includes("per-page=20"), "per-page reflects chunk size");
assert(dec(urls[0]).includes("mailto=me@x.io") && dec(urls[0]).includes("abstract_inverted_index"), "mailto + select present");

const ws = dec(worldSearchUrl("dopamine reward", { sort: "cited_by_count:desc", perPage: 10, mailto: "me@x.io" }));
assert(ws.includes("search=dopamine reward") && ws.includes("sort=cited_by_count:desc") && ws.includes("per-page=10"), "worldSearchUrl: search+sort+per-page");

assert(dec(authorWorksUrl("https://openalex.org/A5023888391", { mailto: "me@x.io" })).includes("filter=author.id:A5023888391"), "authorWorksUrl filter");
assert(dec(authorWorksUrl("A1")).includes("sort=cited_by_count:desc"), "authorWorksUrl default sort");
assert(dec(citingWorksUrl("W2741809807")).includes("filter=cites:W2741809807"), "citingWorksUrl filter");
assert(dec(worksByIdsUrl(["https://openalex.org/W1", "W2"])[0]).includes("filter=openalex_id:W1|W2"), "worksByIdsUrl filter");

// --- mergeEnrich / coverage / profile ---------------------------------------
const entries: RefEntry[] = [
  { key: "lecun2015deep", title: "Deep learning", authors: ["LeCun"], year: "2015" },
  { key: "smith2021", title: "Other", authors: ["Smith"], year: "2021" },
];
const map = { lecun2015deep: e };
const merged = mergeEnrich(entries, map);
assert(merged[0].enrich?.abstract === "Deep learning rocks" && merged[1].enrich === undefined, "mergeEnrich joins by key");
assert(mergeEnrich(entries, null) === entries, "mergeEnrich with no map returns entries as-is");
assert(eq(enrichCoverage(2, map), { total: 2, hydrated: 1, withAbstract: 1 }), "enrichCoverage counts hydrated + abstracts");
assert(topicProfile(map)[0].name === "Neural Networks", "topicProfile aggregates topic names");

console.log("\nALL OPENALEX TESTS PASSED");
