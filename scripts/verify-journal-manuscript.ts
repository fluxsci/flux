#!/usr/bin/env -S npx tsx
// Journal export — the assembled SUBMISSION manuscript, venue by venue and
// stage by stage (style/journalManuscript.ts), the export summary
// (journalSummary.ts) and the shared prep that runs it in both engines
// (exportPrep.ts). Fixture: fixtures/journal-export/. Every expectation is a
// rule from docs/journal_styleguide.md; "never fabricated" checks pin that a
// missing statement is REPORTED rather than written.
//   Run: node scripts/run-verifies.mjs --tier pure --only journal-manuscript
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getCite } from "../src/lib/references/bibtex";
import { resolveJournalStyle, styledFamilyById } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";
import { transformQmdForExport } from "../src/lib/exportQmd";
import { assembleJournalManuscript, readAuthors } from "../src/lib/style/journalManuscript";
import { buildExportSummary, summaryMarkdown } from "../src/lib/style/journalSummary";
import { prepareExport } from "../src/lib/exportPrep";
import { rasterWidthFor, svgFigureEmbeds } from "../src/lib/style/journalFigures";
import { checkCompliance } from "../src/lib/manuscript/compliance";
import { NATURE_ROLE_ALIASES } from "../src/lib/manuscript/sections";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const before = (text: string, a: string, b: string) => text.indexOf(a) >= 0 && text.indexOf(b) >= 0 && text.indexOf(a) < text.indexOf(b);

const dir = "fixtures/journal-export";
const src = readFileSync(`${dir}/manuscript.qmd`, "utf8");
const Cite = await getCite();
const records: Record<string, any> = {};
for (const r of new Cite(readFileSync(`${dir}/library.bib`, "utf8")).data) records[r.id] = r;
const CAPTION = "Sleep raises synaptic APP. Mice were sleep deprived. **a**, Design. **b**, APP blots [@villette2019]. **c**, Quantification.";

function ctxFor(style: ReturnType<typeof resolveJournalStyle>) {
  return {
    captions: new Map([["fig-a", CAPTION]]),
    figures: new Map([
      ["fig-a", { family: styledFamilyById(style, "figure"), number: 1, panels: ["a", "b", "c"] }],
      ["fig-s1", { family: styledFamilyById(style, "supplementary"), number: 1, panels: [] }],
    ]),
    panels: style.figures.panels,
  };
}

async function assemble(id: string, stage: "initial" | "final" = "initial", text = src) {
  const style = resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES);
  const ctx = ctxFor(style);
  const pre = transformQmdForExport(text, { ...ctx, legends: "external" });
  const r = await assembleJournalManuscript(pre, { style, stage, records, ctx, supplementaryFigures: 1, docDir: "paper" });
  return { style, ...r };
}

console.log("Authors from Quarto's schema:");
{
  const { authors, affiliations } = readAuthors({
    author: [{ name: "A B", affiliations: [{ ref: "x" }], corresponding: true, email: "a@b.c" }, { name: { given: "C", family: "D" }, affiliation: "Free Text Uni", attributes: { "equal-contributor": true } }],
    affiliations: [{ id: "x", department: "Dept", name: "Uni", city: "City", country: "Land" }],
  });
  assert(authors.length === 2 && authors[0].corresponding && authors[0].email === "a@b.c", "name / corresponding / email");
  assert(authors[1].name === "C D" && authors[1].equal, "structured names and attributes.equal-contributor");
  assert(affiliations.map((a) => a.text).join("|") === "Dept, Uni, City, Land|Free Text Uni", "affiliations by reference AND as free text, numbered by first appearance");
}

console.log("Nature — initial submission:");
{
  const { text, report } = await assemble("nature");
  assert(text.includes('::: {custom-style="Title"}\nSleep-like OFF periods lower synaptic APP and tau\n:::'), "the title page is set from the front matter");
  assert(text.includes("Ada Lovelace^1,†^, Grace Hopper^1,2,†^, Rosalind Franklin^1,\\*^"), "superscript affiliation numbers; † equal contribution; * corresponding");
  assert(text.includes("\\*e-mail: rfranklin\\@example.org") && text.includes("†These authors contributed equally to this work."), "correspondence + equal-contribution lines (e-mail escaped so pandoc reads no citation)");
  assert(text.includes("**Sleep loss raises the risk of neurodegeneration^1^. Here we show"), "the summary paragraph: unheaded, BOLD, and it cites (required ≥1 reference)");
  assert(!/^# (Introduction|Results)\b/m.test(text), "no Introduction or Results heading (0/61 papers print one)");
  assert(/^# Sleep raises APP$/m.test(text), "…the Results subheading is promoted to a main-text subheading");
  assert(text.includes('::: {custom-style="Figure"}\n![](fig-a.svg){width=60%}\n:::') && text.includes("**Fig. 1 | Sleep raises synaptic APP.** Mice were sleep deprived. **a**, Design. **b**, APP blots^2^."),
    "initial stage: the figure, then its legend directly below ('**Fig. 1 | Title.**', '**a**, …')");
  assert(text.includes("Panels (Fig. 1b,c) and a range (Fig. 1a–c)") && text.includes("(Supplementary Fig. 1)"), "figure references in Nature's grammar");
  assert(before(text, "# Discussion", "# Limitations of the study") && before(text, "# Limitations of the study", "# References") && before(text, "# References", "# Methods"), "order: main text → References → Methods");
  assert(before(text, "# Data availability", "# Code availability") && before(text, "# Code availability", "9.`<w:r>"), "Data/Code availability precede the Methods references (FG order, owner ruling)");
  assert(/^8\.`<w:r>/m.test(text) && /^9\.`<w:r>.*Dueck/m.test(text) && before(text, "# Methods", "9.`<w:r>"), "references first cited in the Methods continue the numbering in a SECOND list after the Methods");
  assert(report.citations.mainList === 8 && report.citations.secondList === 4, `main list 8, Methods list 4 (got ${report.citations.mainList}/${report.citations.secondList})`);
  assert(before(text, "# Acknowledgements", "# Funding") && before(text, "# Competing interests", "# Additional information"), "back matter in Nature's order");
  assert(text.includes("Correspondence and requests for materials should be addressed to Rosalind Franklin."), "Additional information written from the front matter (owned data)");
  assert(report.problems.some((p) => /footnote/i.test(p)), "a footnote is REPORTED (Nature uses none), not deleted");
  assert(report.problems.some((p) => /nosuchkey/.test(p)) && text.includes("\\[?nosuchkey\\]"), "an unknown citation key is reported and stays visible");
  const fm = text.slice(0, text.indexOf("\n---", 3));
  assert(/citeproc: false/.test(fm) && !/^bibliography:/m.test(fm), "front matter: citeproc off, no bibliography (Flux wrote the list)");
  assert(fm.includes("reference-doc: ../styles/journal/nature/reference.docx") && fm.includes("pdf-engine: lualatex"), "front matter carries the venue's render settings, document-relative");
  assert(!/^(title|author|abstract|highlights):/m.test(fm), "title/author/abstract leave the metadata (no second title block from pandoc)");
}

console.log("Nature — revision files:");
{
  const { text, report } = await assemble("nature", "final");
  assert(!text.includes("fig-a.svg"), "figures are NOT in the revision text (uploaded as files)");
  assert(before(text, "# References", "# Figure legends") && before(text, "# Figure legends", "# Methods"), "legends listed after the main references, before the Methods");
  assert(report.actions.some((a) => /legend/i.test(a)), "the move is reported");
}

console.log("Science — initial submission:");
{
  const { text, report } = await assemble("science");
  assert(text.includes('::: {custom-style="Head"}') && text.includes('::: {custom-style="AbstractSummary"}'), "blocks carry the Science template's own style names");
  assert(text.includes("Ada Lovelace^1^†, Grace Hopper^1,2^†, Rosalind Franklin^1^\\*"), "superscript numbers, NON-superscript symbols");
  assert(text.includes("Department of Psychiatry, University of Wisconsin-Madison; Madison, USA."), "affiliation: institution; city, country — ending with a period");
  assert(text.includes("\\*Corresponding author. Email: rfranklin\\@example.org"), "'*Corresponding author. Email: …'");
  assert(text.includes("**Abstract:** Sleep loss raises the risk of neurodegeneration (*1*)."), "'Abstract:' key word (metadata extraction)");
  assert(text.includes("**One-Sentence Summary:** Sleep-like OFF periods"), "'One-Sentence Summary:' from the front matter");
  assert(text.includes("**Main Text:**") && !/^# Introduction/m.test(text), "'Main Text:' and no heading before the first paragraph");
  assert(text.includes("Two studies agree (*1*, *2*)") && text.includes("(Fig. 1, B and C)") && text.includes("(Fig. 1, A to C)") && text.includes("(fig. S1)"), "italic numbered citations; 'Fig. 1, B and C', 'Fig. 1, A to C', 'fig. S1'");
  assert(before(text, "# Limitations of the study", "# Materials and Methods") && before(text, "# Materials and Methods", "# References and Notes"), "Materials and Methods run after the main text (extended format), before References and Notes");
  assert(/^\d+\.`<w:r>[^\n]*Measured in synaptosomes \(\*\d+\*\)\./m.test(text), "the footnote became a numbered note in References and Notes");
  assert(text.includes("**Acknowledgments:** We thank the lab.") && text.includes("**Funding:** NIH grant R01") && text.includes("**Data, code, and materials availability:** Data are on figshare."),
    "run-in Acknowledgments with the 2026 data heading (owner ruling)");
  assert(before(text, "References and Notes", "**Acknowledgments:**") && before(text, "**Acknowledgments:**", "# Supplementary Materials"), "Acknowledgments directly after the reference list, then the SM list");
  assert(text.includes('::: {custom-style="SOMContent"}\nFig. S1\n:::'), "Supplementary Materials list from the figure model");
  assert(!report.problems.some((p) => /Funding/.test(p)), "present statements are not reported missing");
}

console.log("Cell — revision files:");
{
  const { text, report } = await assemble("cell", "final");
  assert(text.includes("Ada Lovelace^1,3^, Grace Hopper^1,2,3^, and Rosalind Franklin^1,4,\\*^"), "Cell authors: numbered notes incl. equal contribution and LEAD CONTACT, '*' corresponding, serial 'and'");
  assert(text.includes("^4^Lead contact") && text.includes("\\*Correspondence: rfranklin\\@example.org"), "'Lead contact' is the last numbered note; '*Correspondence:'");
  assert(/^# SUMMARY \{\.unnumbered\}/m.test(text) && /^# KEYWORDS$/m.test(text) && /^# INTRODUCTION$/m.test(text), "ALL-CAPS section heads: SUMMARY, KEYWORDS, INTRODUCTION");
  assert(text.includes("(Figures 1B and 1C)") && text.includes("(Figures 1A–1C)") && text.includes("disease.^1^"), "'Figures 1B and 1C', 'Figures 1A–1C'; superscript AFTER the stop");
  assert(/# DISCUSSION[\s\S]*## Limitations of the study[\s\S]*# RESOURCE AVAILABILITY/.test(text), "Limitations of the study closes the Discussion");
  assert(text.includes("Requests for further information and resources should be directed to and will be fulfilled by the lead contact, Rosalind Franklin (rfranklin\\@example.org)."), "Lead contact sentence (Cell's wording, from the front matter)");
  assert(/## Data and code availability\n\nData are on figshare\.\n\nCode is on Zenodo/.test(text), "Data and code availability merges both statements");
  assert(report.problems.some((p) => /Materials availability/.test(p)) && !/## Materials availability/.test(text), "a missing Materials availability statement is REPORTED, never fabricated");
  assert(/# ACKNOWLEDGMENTS\n\nWe thank the lab\.\n\nNIH grant R01/.test(text) && !/^# FUNDING/m.test(text), "Funding folds into ACKNOWLEDGMENTS");
  assert(/^# DECLARATION OF INTERESTS$/m.test(text) && text.includes("Document S1. Figure S1"), "DECLARATION OF INTERESTS; SUPPLEMENTAL INFORMATION index");
  assert(before(text, "# MAIN FIGURE TITLES AND LEGENDS", "# REFERENCES") && before(text, "# REFERENCES", "# STAR METHODS"), "legends → REFERENCES → STAR METHODS");
  assert(text.includes("**Figure 1. Sleep raises synaptic APP**\\\nMice were sleep deprived.\\\n(A) Design.\\\n(B) APP blots.^2^"), "Cell legend: title without stop, panels on their own lines");
  assert(/## EXPERIMENTAL MODEL AND STUDY PARTICIPANT DETAILS[\s\S]*Mice were housed[\s\S]*## QUANTIFICATION AND STATISTICAL ANALYSIS[\s\S]*ANOVA/.test(text), "STAR Methods subsections by their titles");
  assert(/Hanse, E\., Seth, H\., and Riebe, I\. \(2013\)\./.test(text), "Cell reference entries");
}

console.log("bioRxiv — preprint:");
{
  const { text, report } = await assemble("biorxiv");
  assert(text.includes("[@hanse2013]") && /^bibliography: library\.bib$/m.test(text) && text.includes("::: {#refs}"), "citations stay with the document's own CSL (bioRxiv has no style); the list lands at References");
  assert(/^# Abstract \{\.unnumbered\}/m.test(text) && /^# Introduction$/m.test(text), "an 'Abstract' heading; the author's headings and order are kept");
  assert(before(text, "# Discussion", "# Limitations of the study") && before(text, "# Methods", "# Data availability"), "no reordering");
  assert(text.includes("**Figure 1. Sleep raises synaptic APP.**") && text.includes("fig-a.svg"), "figures inline beside 'Figure 1.' legends");
  assert(text.includes("Rosalind Franklin^1,\\*^") && text.includes("\\*Corresponding author: rfranklin\\@example.org"), "a title page bioRxiv can extract metadata from");
  assert(report.citations.cited === 0, "no literal citation pass for a citeproc venue");
}

console.log("Hand-written title blocks are kept, not duplicated:");
{
  const manual = src.replace("# Introduction", "**Sleep-like OFF periods lower synaptic APP and tau**\n\nAda Lovelace^1^\n\n# Introduction");
  const { text, report } = await assemble("nature", "initial", manual);
  assert(!text.includes('custom-style="Title"') && text.includes("**Sleep-like OFF periods lower synaptic APP and tau**"), "the author's own block stays; Flux adds no second one");
  assert(report.actions.some((a) => /own title block/.test(a)), "…and says so");
}

console.log("Export summary (advisory, never blocking):");
{
  const long = src.replace(/abstract: \|\n  [^\n]*\n/, `abstract: |\n  ${"word ".repeat(260)}\n`);
  const { style, report } = await assemble("nature", "initial", long);
  const s = buildExportSummary({ style, stage: "initial", format: "docx", report, output: "/x/paper.nature.docx" });
  assert(s.subtitle === "Nature · initial submission · Word · paper.nature.docx", "subtitle names venue, stage, format, file");
  assert(s.sections[0].heading === "Needs attention" && s.sections[0].items.some((i) => /Summary paragraph is ~26\d words; Nature's limit is 230/.test(i.text)), "an over-long summary is a WARNING against the 2026 ceiling");
  assert(s.sections.some((x) => x.heading === "Still to do outside Flux" && x.items.some((i) => /Reporting Summary/.test(i.text))), "the outside-Flux list (Reporting Summary…)");
  assert(s.warnings > 0 && s.todos > 0, "badge counts");
  const md = summaryMarkdown(s);
  assert(md.startsWith("# Nature export") && md.includes("## What Flux did") && md.includes("- ⚠ "), "the .submission.md rendering");
  const cellR = await assemble("cell", "initial", src.replace(/highlights:[\s\S]*?etoc:/, "etoc:"));
  const cs = buildExportSummary({ style: cellR.style, stage: "final", format: "docx", report: cellR.report });
  assert(cs.sections[0].items.some((i) => /No Highlights/.test(i.text)), "Cell: missing Highlights flagged");
}

console.log("Figure rasters for the PDF path:");
{
  assert(rasterWidthFor('<svg width="610" height="400" viewBox="0 0 610 400">', 300) === 1906, "CSS-px width → 300 dpi pixels");
  assert(rasterWidthFor('<svg width="89mm" height="60mm">', 300) === 1051, "physical units honoured (89 mm → 1051 px)");
  const e = svgFigureEmbeds("![](../fig/renders/fig-a.svg){#fig-a}\n\n```\n![](x.svg){#fig-z}\n```", "/p/paper/main.qmd");
  assert(e.length === 1 && e[0].svgPath === "/p/fig/renders/fig-a.svg", "embeds resolved against the document; code ignored");
}

console.log("Shared prep (both engines): includes spliced, sources restored byte-for-byte:");
{
  const tmp = mkdtempSync(path.join(tmpdir(), "flux-journal-prep-"));
  try {
    for (const f of ["library.bib", "fig-a.svg"]) copyFileSync(`${dir}/${f}`, path.join(tmp, f));
    const main = src.replace("# Discussion", "{{< include extra.qmd >}}\n\n# Discussion");
    writeFileSync(path.join(tmp, "main.qmd"), main);
    writeFileSync(path.join(tmp, "extra.qmd"), "Included claim [@alcock2006].\n");
    const io = {
      readText: async (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
      writeText: async (p: string, t: string) => writeFileSync(p, t),
    };
    const style = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);
    const prep = await prepareExport(io, { entry: path.join(tmp, "main.qmd"), ctx: ctxFor(style), journal: { style, stage: "initial", records, supplementaryFigures: 1 } });
    const prepared = readFileSync(path.join(tmp, "main.qmd"), "utf8");
    assert(prepared.includes("Included claim^") && !prepared.includes("{{< include"), "the include is spliced in and its citation numbered with the rest");
    assert(prep.journal && prep.journal.citations.cited > 0, "the prep returns the assembly report");
    assert(readFileSync(path.join(tmp, "extra.qmd"), "utf8") === "Included claim [@alcock2006].\n", "the included fragment itself is untouched");
    await prep.restore();
    assert(readFileSync(path.join(tmp, "main.qmd"), "utf8") === main, "restore puts the entry back byte-for-byte");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("Journal Check advice follows each venue's grammar:");
{
  const doc = "---\ntitle: t\n---\n\nSee Figure 2 and Fig. 3a-c.\n";
  const advice = (id: string) => checkCompliance({ doc, style: resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES), aliases: NATURE_ROLE_ALIASES, figureCount: 5 }).filter((f) => f.ruleId === "fig.literal-house-style");
  assert(!advice("nature").some((f) => /Figure 2 a/.test(f.excerpt ?? "")), "'Figure 2 and' is not read as panel 'a'");
  assert(advice("nature").find((f) => f.excerpt === "Fig. 3a-c")?.suggestion === "Fig. 3a–c", "Nature suggests 'Fig. 3a–c'");
  assert(advice("science").find((f) => f.excerpt === "Fig. 3a-c")?.suggestion === "Fig. 3, A to C", "Science suggests 'Fig. 3, A to C'");
  assert(advice("cell").find((f) => f.excerpt === "Fig. 3a-c")?.suggestion === "Figures 3A–3C", "Cell suggests 'Figures 3A–3C'");
  assert(!advice("cell").some((f) => f.excerpt === "Figure 2"), "Cell does not flag its own spelled-out 'Figure'");
}

console.log("\nJOURNAL-MANUSCRIPT VERIFY: PASS");
