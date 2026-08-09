// Pure verification of the OPTIONAL GROBID enrichment. Hermetic: parses a fixture TEI and drives
// the enrichment over a temp library, with NO GROBID service running — which is also the point,
// since the overwhelmingly common case is a Flux install that has never heard of GROBID.
//   npx tsx scripts/verify-grobid.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectTei, grobidEnrich, grobidCoverageReport, readGrobidDoc, grobidStatus } from "../flux-core/grobid";
import { GROBID_SCHEMA_VERSION, isCurrent, summarizeGrobid } from "../src/lib/references/grobidDoc";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    console.log(`✗ ${label}`);
    failures++;
  }
}

// A miniature but structurally faithful TEI: header metadata, two body sections with in-text
// citation refs, a figure caption, back matter, and two bibliography entries.
const TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
 <teiHeader>
  <fileDesc>
   <titleStmt><title level="a" type="main">Replay of waking sequences during sleep</title></titleStmt>
   <sourceDesc><biblStruct><analytic>
     <author><persName><forename type="first">Ana</forename><surname>Ruiz</surname></persName>
       <affiliation><orgName type="institution">Institute of Neuroscience</orgName></affiliation></author>
     <author><persName><forename type="first">Bo</forename><surname>Chen</surname></persName></author>
     <idno type="DOI">10.1038/s41593-024-01755-8</idno>
   </analytic></biblStruct></sourceDesc>
  </fileDesc>
  <profileDesc><abstract><p>We show that hippocampal replay is disrupted by sleep deprivation.</p></abstract></profileDesc>
 </teiHeader>
 <text>
  <body>
   <div><head>Introduction</head>
     <p>Replay was first described in rodents <ref type="bibr" target="#b0">[1]</ref> and later in humans.</p>
   </div>
   <div><head>Results</head>
     <p>Deprivation abolished replay <ref type="bibr" target="#b1">[2]</ref>, consistent with earlier work <ref type="bibr">[3]</ref>.</p>
   </div>
   <figure xml:id="fig_0"><head>Figure 1</head><figDesc>Ripple-triggered averages across conditions.</figDesc></figure>
   <figure type="table" xml:id="tab_0"><head>Table 1</head><figDesc>Session counts per animal.</figDesc></figure>
  </body>
  <back>
   <div type="acknowledgement"><p>We thank the vivarium staff.</p></div>
   <div type="annex"><p>Supplementary methods: tetrodes were referenced to corpus callosum.</p></div>
   <div type="references"><listBibl>
     <biblStruct xml:id="b0">
       <analytic><title level="a">Hippocampal ripples and memory consolidation</title>
         <author><persName><forename>G</forename><surname>Girardeau</surname></persName></author>
         <idno type="DOI">10.1016/j.conb.2011.02.005</idno></analytic>
       <monogr><title level="j">Curr Opin Neurobiol</title><imprint><date type="published" when="2011"/></imprint></monogr>
     </biblStruct>
     <biblStruct xml:id="b1">
       <analytic><title level="a">Sleep deprivation and consolidation</title>
         <author><persName><forename>I</forename><surname>Navarro</surname></persName></author></analytic>
       <monogr><title level="j">Nat Neurosci</title><imprint><date type="published" when="2022"/></imprint></monogr>
     </biblStruct>
   </listBibl></div>
  </back>
 </text>
</TEI>`;

const doc = await projectTei(TEI, "0.9.1");

ok(doc.schemaVersion === GROBID_SCHEMA_VERSION, "projection carries the schema version");
ok(doc.grobidVersion === "0.9.1", "…and the producing GROBID version");
ok(doc.title === "Replay of waking sequences during sleep", "title parsed as a field, not guessed");
ok(doc.authors.length === 2 && doc.authors[0].name === "Ana Ruiz", "authors parsed");
ok(doc.authors[0].affiliation === "Institute of Neuroscience", "…with affiliation");
ok(doc.doi === "10.1038/s41593-024-01755-8", "document DOI parsed");
ok((doc.abstract ?? "").startsWith("We show that hippocampal replay"), "abstract parsed");

ok(doc.sections.length === 2, "two body sections");
ok(doc.sections[0].heading === "Introduction" && doc.sections[1].heading === "Results", "section headings");
ok(doc.body.includes("Replay was first described"), "body carries paragraph text");
ok(doc.body.includes("Ripple-triggered averages"), "…and figure captions");
ok(doc.body.includes("Supplementary methods"), "…and the supplementary annex from <back>");
ok(doc.body.includes("thank the vivarium"), "…and the acknowledgement statement");
ok(!doc.body.includes("Girardeau"), "the bibliography is NOT in the body — GROBID separates it");

ok(doc.references.length === 2, "both references parsed");
ok(doc.references[0].title === "Hippocampal ripples and memory consolidation", "reference title");
ok(doc.references[0].journal === "Curr Opin Neurobiol", "reference journal");
ok(doc.references[0].year === "2011", "reference year");
ok(doc.references[0].doi === "10.1016/j.conb.2011.02.005", "reference DOI");
ok(doc.references[0].authors[0] === "G Girardeau", "reference author");
ok(doc.references[1].doi === undefined, "a reference without a DOI is left undefined, not invented");

ok(doc.citations.length === 3, "all in-text citations found");
ok(doc.citations.filter((c) => c.ref !== undefined).length === 2, "…two of which resolve to an entry");
ok(doc.citations[0].ref === 1, "citation resolves to the 1-based reference index");
ok(doc.citations[2].ref === undefined, "an unresolvable citation stays unlinked rather than guessing");
ok(doc.counts.references === 2 && doc.counts.referencesWithDoi === 1, "reference counts");
ok(doc.counts.figures === 2 && doc.counts.tables === 1, "figure/table counts");
ok(summarizeGrobid(doc).includes("2 references"), "summary line renders");

// Every section offset must address real text in the assembled body.
ok(
  doc.sections.every((s) => s.start >= 0 && s.end <= doc.body.length && s.start < s.end),
  "section offsets are inside the body",
);
ok(doc.body.slice(doc.sections[1].start, doc.sections[1].end).includes("Deprivation abolished"), "…and point at the right section");
// The separator belongs BEFORE a part, not after it. Counting it after drifted every offset by two
// characters per part and pushed the last section's end past the end of the body.
ok(doc.body.slice(doc.sections[0].start).startsWith("Replay was first described"), "a section offset is exact, not off by the separator");
ok(doc.sections.every((s) => s.end <= doc.body.length), "no section ends past the end of the body");
ok(doc.citations.every((c) => c.at >= 0 && c.at <= doc.body.length), "citation offsets stay inside the body");
ok(doc.citations.every((c) => c.ref === undefined || (c.ref >= 1 && c.ref <= doc.references.length)),
  "a linked citation always points at a real bibliography entry");

// --- the default install: no service, no artifacts, no failure ---------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-grobid-"));
await fs.mkdir(path.join(tmp, "items", "ruiz2024replay"), { recursive: true });
await fs.mkdir(path.join(tmp, ".fluxlib"), { recursive: true });
await fs.writeFile(path.join(tmp, "items", "ruiz2024replay", "paper.pdf"), "%PDF-1.4 not a real pdf");

ok((await readGrobidDoc("ruiz2024replay", tmp)) === null, "readGrobidDoc returns null when never enriched");
const cold = await grobidCoverageReport({ libPath: tmp, url: "http://127.0.0.1:9" });
ok(cold.reachable === false, "coverage report survives an unreachable service");
ok(cold.totalWithPdf === 1 && cold.never === 1 && cold.enriched === 0, "…and reports the library honestly");

const st = await grobidStatus("http://127.0.0.1:9");
ok(st.reachable === false && !!st.error, "grobidStatus reports unreachable rather than throwing");

const run = await grobidEnrich({ libPath: tmp, url: "http://127.0.0.1:9" });
ok(!!run.unavailable, "a run with no service reports unavailable");
ok(run.processed.length === 0 && run.failed.length === 0, "…and writes nothing");
ok(!(await fs.readdir(path.join(tmp, "items", "ruiz2024replay"))).some((f) => f.startsWith("grobid")),
  "…leaving the item folder untouched");

// --- reproject: rebuild the JSON from stored TEI, no service ------------------------------------
await fs.writeFile(path.join(tmp, "items", "ruiz2024replay", "grobid.tei.xml"), TEI);
const re = await grobidEnrich({ libPath: tmp, reproject: true });
ok(re.processed.length === 1, "reproject rebuilds from stored TEI with no service");
const loaded = await readGrobidDoc("ruiz2024replay", tmp);
ok(loaded?.references.length === 2, "…and the projection round-trips through disk");
const after = await grobidCoverageReport({ libPath: tmp, url: "http://127.0.0.1:9" });
ok(after.enriched === 1 && after.never === 0, "coverage ledger reflects the enrichment");
ok(after.references === 2, "…including reference counts");

const mtime = (await fs.stat(path.join(tmp, "items", "ruiz2024replay", "paper.pdf"))).mtimeMs;
ok(isCurrent({ ok: true, schemaVersion: GROBID_SCHEMA_VERSION, grobidVersion: "0.9.1",
  extractedAt: "", pdfMtimeMs: mtime }, mtime), "an unchanged PDF stays current");
ok(!isCurrent({ ok: true, schemaVersion: GROBID_SCHEMA_VERSION, grobidVersion: "0.9.1",
  extractedAt: "", pdfMtimeMs: mtime }, mtime + 1), "a re-fetched PDF invalidates the enrichment");
ok(!isCurrent({ ok: true, schemaVersion: GROBID_SCHEMA_VERSION + 1, grobidVersion: "0.9.1",
  extractedAt: "", pdfMtimeMs: mtime }, mtime), "a projection-version bump invalidates it too");

await fs.rm(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall green" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
