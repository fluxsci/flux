#!/usr/bin/env -S npx tsx
// Journal export — the pieces a submission is judged on, venue by venue:
// reference entries (journalRefs), citation marks and numbering
// (journalCitations), figure-reference grammar (formatStyledFigureRef) and
// legend form (journalCaptions). Every expected string is a rule from
// docs/journal_styleguide.md (§2 Nature, §3 Science, §4 Cell); the negative
// assertions are the mistakes a naive exporter makes.
//   Run: node scripts/run-verifies.mjs --tier pure --only journal-refs
import { readFileSync } from "node:fs";
import { getCite } from "../src/lib/references/bibtex";
import { formatJournalReference, narrativeAuthors, pageRange, preprintServer } from "../src/lib/style/journalRefs";
import { literalizeCitations, printedMark, parseCiteGroup } from "../src/lib/style/journalCitations";
import { formatLegend, parseComposedCaption, splitTitleSentence } from "../src/lib/style/journalCaptions";
import { formatStyledFigureRef, pluralizeFigureNoun, resolveJournalStyle, styledFamilyById } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";
import { dotAbbreviations } from "../src/lib/references/journalAbbrev";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const eq = (got: string, want: string, msg: string) => assert(got === want, `${msg}${got === want ? "" : `\n      got:  ${got}\n      want: ${want}`}`);

const S = (id: string) => resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES);
const nature = S("nature");
const science = S("science");
const cell = S("cell");

const Cite = await getCite();
const recs: Record<string, any> = {};
for (const r of new Cite(readFileSync("fixtures/journal-export/library.bib", "utf8")).data) recs[r.id] = r;
const R = (key: string, layout: "nature" | "science" | "cell") => formatJournalReference(recs[key], layout);

console.log("Nature reference entries (§2.6):");
{
  eq(R("hanse2013", "nature"), "Hanse, E., Seth, H. & Riebe, I. AMPA-silent synapses in brain development and pathology. *Nat. Rev. Neurosci.* **14**, 839–850 (2013).",
    "≤5 authors all listed, '&' with no comma, title, *italic abbrev.*, **bold volume**, en-dash pages, (year) last");
  assert(!/doi|https/.test(R("hanse2013", "nature")), "an ordinary article carries NO DOI");
  eq(R("bellesi2013", "nature"), "Bellesi, M. et al. Effects of sleep and wake on oligodendrocytes and their precursors. *J. Neurosci.* **33**, 14288–14300 (2013).",
    "≥6 authors → first author + 'et al.'; NLM 'J Neurosci' regains its stops; '14288-300' expands");
  assert(R("pnas2018", "nature").includes("*Proc. Natl Acad. Sci. USA*"), "PNAS in Nature's own form ('Natl' takes no stop)");
  assert(R("guo2020", "nature").includes("Preprint at bioRxiv https://doi.org/10.1101/2020.02.27.967794 (2020)."), "preprint: server named, DOI URL, year");
  eq(R("hao2014", "nature"), "Hao, Z., AghaKouchak, A., Nakhjiri, N. & Farahmand, A. Global Integrated Drought Monitoring and Prediction System (GIDMaPS) data sets. figshare https://doi.org/10.6084/m9.figshare.853801 (2014).",
    "dataset: the repository precedes the DOI URL — Nature's own worked example");
  eq(R("alcock2006", "nature"), "Alcock, J. *An Enthusiasm for Orchids: Sex and Deception in Plant Evolution* (Oxford University Press, Oxford, 2006).",
    "book: italic title, publisher AND city (owner ruling: the documented rule)");
  assert(R("king2003", "nature").includes("In *Molecular Motors* (ed. Schliwa, M.) 45–78 (Wiley-VCH, 2003)."), "chapter: In *Book* (ed. …) pages (publisher, year)");
  assert(R("dueck2009", "nature").includes("PhD thesis, University of Toronto (2009)."), "thesis: 'PhD thesis, University (year)'");
  assert(R("online2026", "nature").includes("*Nat. Neurosci.* https://doi.org/10.1038/s41593-026-02318-9 (2026)."), "online-ahead article (no volume): journal + DOI URL");
  assert(R("wilson2023", "nature").startsWith("Wilson, D. M. 3rd & Cookson"), "PubMed's 'Wilson, D. M., 3rd' is read back as initials + suffix");
  assert(!R("bellesi2013", "nature").includes("*et al.*"), "'et al.' is upright, not italic (164/164 in print)");
}

console.log("Science reference entries (§3.6):");
{
  eq(R("hanse2013", "science"), "E. Hanse, H. Seth, I. Riebe, AMPA-silent synapses in brain development and pathology. *Nat. Rev. Neurosci.* **14**, 839–850 (2013). doi:10.1038/nrn3642",
    "initials first, commas and NO 'and', title, *journal* **volume**, pages (year); DOI appended (owner ruling)");
  const v = R("villette2019", "science");
  assert(v.startsWith("V. Villette, M. Chavarha,") && v.includes("A. Ayon,") && !v.includes("et al."), "EVERY author at submission — never 'et al.'");
  assert(!/, \*\*|\*, \*\*/.test(R("hanse2013", "science")), "no comma before the volume");
  assert(R("pnas2018", "science").includes("*Proc. Natl. Acad. Sci. U.S.A.*"), "PNAS in Science's form");
  eq(R("kapoor2022", "science"), "S. Kapoor, A. Narayanan, Leakage and the reproducibility crisis in ML-based science. arXiv:2207.07048 (2022).",
    "arXiv: 'arXiv:<id>' with NO '[Preprint]'");
  eq(R("guo2020", "science"), "W. Guo, J. J. Zhang, J. P. Newman, M. A. Wilson, Latent learning drives sleep-dependent plasticity. bioRxiv 2020.02.27.967794 [Preprint] (2020). https://doi.org/10.1101/2020.02.27.967794.",
    "bioRxiv: '<server> <id> [Preprint] (year). https://doi.org/…' — the official example");
  assert(R("hao2014", "science").endsWith("figshare (2014); https://doi.org/10.6084/m9.figshare.853801."), "dataset: '…, Repository (year); https://doi.org/….'");
  eq(R("king2003", "science"), 'S. M. King, "Dynein motors: Structure, mechanochemistry and regulation" in *Molecular Motors*, M. Schliwa, Ed. (Wiley-VCH, 2003), pp. 45–78.',
    'chapter: "Title" in *Book*, Editor, Ed. (Publisher, year), pp. x–y');
  assert(R("alcock2006", "science") === "J. Alcock, *An Enthusiasm for Orchids: Sex and Deception in Plant Evolution* (Oxford University Press, 2006).", "book: (Publisher, year) — Science prints no city");
  assert(R("dueck2009", "science").includes('"Affinity Propagation: Clustering Data by Passing Messages," thesis, University of Toronto (2009).'), "thesis: names the university, not the degree");
  assert(R("online2026", "science").includes("*Nat. Neurosci.* 10.1038/s41593-026-02318-9 (2026)."), "early online: the DOI takes the place of volume and pages");
}

console.log("Cell reference entries (§4.7):");
{
  eq(R("hanse2013", "cell"), "Hanse, E., Seth, H., and Riebe, I. (2013). AMPA-silent synapses in brain development and pathology. Nat. Rev. Neurosci. *14*, 839–850. https://doi.org/10.1038/nrn3642.",
    "(Year). after the authors, serial ', and', journal abbreviated (roman), *italic volume*, https://doi.org DOI");
  const v = R("villette2019", "cell");
  assert(/Yang, R\., et al\. \(2019\)\./.test(v) && !v.includes("Kim, B.B."), "≥11 authors → the first 10 then ', et al.'");
  assert(R("bellesi2013", "cell").includes("Cirelli, C. (2013)."), "≤10 authors are all listed");
  assert(R("bellesi2013", "cell").includes("14288–14300"), "full page ranges ('801–806', never '801–6')");
  assert(R("guo2020", "cell").includes("(2020). Latent learning drives sleep-dependent plasticity. Preprint at bioRxiv. https://doi.org/10.1101/2020.02.27.967794."), "preprint: 'Preprint at bioRxiv. https://doi.org/….'");
  assert(R("alcock2006", "cell") === "Alcock, J. (2006). An Enthusiasm for Orchids: Sex and Deception in Plant Evolution (Oxford University Press).", "book: Title (Publisher) — no city");
  assert(R("king2003", "cell").includes("In Molecular Motors, M. Schliwa, ed. (Wiley-VCH), pp. 45–78."), "chapter: 'In Book, M. Editor, ed. (Publisher), pp. x–y.'");
  assert(R("hanse2013", "cell").startsWith("Hanse, E., Seth"), "Cell initials run together ('Dimov, I.K.') and surname first");
  assert(R("villette2019", "cell").includes("Dimov, I.K."), "…no space between initials");
}

console.log("Helpers:");
{
  eq(pageRange("801-6"), "801–806", "page ranges expand by default");
  eq(pageRange("E3131-E3140"), "E3131–E3140", "alphanumeric endpoints");
  eq(dotAbbreviations("J Neurosci"), "J. Neurosci.", "NLM titles regain their full stops");
  eq(dotAbbreviations("Nature Neuroscience"), "Nature Neuroscience", "…and full titles pass through");
  assert(preprintServer(recs.guo2020) === "bioRxiv" && preprintServer(recs.kapoor2022) === "arXiv" && preprintServer(recs.hanse2013) === null, "preprint servers detected from the DOI/container");
  eq(narrativeAuthors(recs.hanse2013), "Hanse et al.", "narrative label: 3+ authors → 'Surname et al.'");
  eq(narrativeAuthors(recs.pnas2018), "Smith and Jones", "…two authors → 'A and B'");
}

console.log("Citation marks (presentation, ranges, punctuation):");
{
  eq(printedMark([1, 2], nature.citations.numeric), "^1,2^", "Nature: superscript, comma, no space");
  eq(printedMark([3, 1, 2, 5], nature.citations.numeric), "^1–3,5^", "runs of ≥3 collapse with an en dash; ordinals sort");
  eq(printedMark([12, 13], science.citations.numeric), "(*12*, *13*)", "Science: two consecutive numbers stay listed, italic in roman parentheses");
  eq(printedMark([12, 13, 14], science.citations.numeric), "(*12*–*14*)", "Science: three or more → italic en-dash range");
  eq(printedMark([1, 2], cell.citations.numeric), "^1,2^", "Cell: superscript, comma, no space");
  const items = parseCiteGroup("see @a, p. 3; -@b");
  assert(items?.[0].prefix === "see" && items?.[0].suffix === "p. 3" && items?.[1].suppressAuthor, "pandoc citation-group grammar (prefix, locator, suppress-author)");

  const records = { a: { id: "a", author: [{ family: "Smith" }, { family: "Lee" }, { family: "Kim" }] }, b: { id: "b", author: [{ family: "Jones" }] }, c: { id: "c" } } as any;
  const text = "One [@a]. Two [@b; @a], end. Narrative @a showed. After.[@c] Map @fig-1. Mail x@y.org. `code [@a]` $[@a]$";
  const N = literalizeCitations(text, { spec: nature.citations.numeric, records });
  assert(N.text.startsWith("One^1^. Two^1,2^, end. Narrative Smith et al.^1^ showed. After^3^."), `Nature: marks hug the word, sit BEFORE the stop, and move back across one ("After.[@c]" → "After³.")`);
  assert(N.text.includes("Map @fig-1") && N.text.includes("x@y.org") && N.text.includes("`code [@a]`") && N.text.includes("$[@a]$"), "crossrefs, e-mails, code and math are untouched");
  const C = literalizeCitations(text, { spec: cell.citations.numeric, records });
  assert(C.text.startsWith("One.^1^ Two,^1,2^ end."), "Cell: the stop moves IN FRONT of the mark ('One.¹', 'Two,¹,²')");
  const Sc = literalizeCitations("Claim [@a].^[A note [@b].] Next [@c].", { spec: science.citations.numeric, records, notesInReferences: true });
  assert(Sc.text === "Claim (*1*) (*2*). Next (*4*).", `Science: the note takes the next number IN SEQUENCE, before the stop like any mark, and numbering continues (got ${Sc.text})`);
  assert(Sc.notes.get(2) === "A note (*3*).", "…and the note's own citation numbers after it");
  const M = literalizeCitations("Gone [@missing].", { spec: nature.citations.numeric, records });
  assert(M.missing.includes("missing") && M.text.includes("\\[?missing\\]"), "an unknown key is reported and left VISIBLE as [?key], never silently dropped");
  const L = literalizeCitations("Shown [see @a, p. 4].", { spec: nature.citations.numeric, records });
  assert(L.text === "Shown (see ref. 1, p. 4).", "a prefixed/located citation is written out: '(see ref. 1, p. 4)'");
}

console.log("Figure-reference grammar (§2.7, §3.7, §4.8):");
{
  const ref = (st: ReturnType<typeof S>, fam: string, n: number, spec: string) => formatStyledFigureRef(styledFamilyById(st, fam), n, spec, st.figures.panels);
  eq(ref(nature, "figure", 1, "a,b"), "Fig. 1a,b", "Nature: 'Fig. 1a,b'");
  eq(ref(nature, "figure", 1, "a-c"), "Fig. 1a–c", "Nature: 'Fig. 1a–c'");
  eq(ref(nature, "supplementary", 2, ""), "Supplementary Fig. 2", "Nature: 'Supplementary Fig. 2'");
  eq(ref(science, "figure", 1, "a"), "Fig. 1A", "Science: one panel 'Fig. 1A'");
  eq(ref(science, "figure", 1, "a,b"), "Fig. 1, A and B", "Science: 'Fig. 1, A and B'");
  eq(ref(science, "figure", 1, "a-c"), "Fig. 1, A to C", "Science: ranges use the word 'to' ('Fig. 1A–C' appears 0× in print)");
  eq(ref(science, "figure", 1, "a,c,e"), "Fig. 1, A, C, and E", "Science: serial comma");
  eq(ref(science, "supplementary", 3, "b"), "fig. S3B", "Science: supplementary figures are lowercase 'fig. S3B'");
  eq(ref(cell, "figure", 1, "a"), "Figure 1A", "Cell: never 'Fig.'");
  eq(ref(cell, "figure", 1, "a,b"), "Figures 1A and 1B", "Cell: plural noun, the number REPEATED");
  eq(ref(cell, "figure", 4, "c-e"), "Figures 4C–4E", "Cell: 'Figures 4C–4E' ('4C–E' appears 0× in print)");
  eq(ref(cell, "supplementary", 3, "a-c"), "Figures S3A–S3C", "Cell: 'Figures S3A–S3C'");
  eq(ref(cell, "figure", 5, "f,h-l"), "Figures 5F and 5H–5L", "Cell: mixed list");
  eq(pluralizeFigureNoun("Extended Data Fig."), "Extended Data Figs.", "plural of a multi-word noun");
}

console.log("Legends (§2.8, §3.8, §4.9):");
{
  const cap = "Sleep raises synaptic APP. Mice were deprived. **a**, Design. **b**, Blots.";
  const p = parseComposedCaption(cap);
  assert(p.lead === "Sleep raises synaptic APP. Mice were deprived." && p.panels.length === 2, "the composed caption splits into lead + panels on its **a**, markers");
  eq(splitTitleSentence("Effects (e.g. sleep) on APP. More.").title, "Effects (e.g. sleep) on APP.", "the title sentence does not end at 'e.g.'");
  eq(formatLegend("Fig. 1 |", cap, nature.manuscript!.legend, nature.figures.panels),
    "**Fig. 1 | Sleep raises synaptic APP.** Mice were deprived. **a**, Design. **b**, Blots.", "Nature: '**Fig. 1 | Title.**' then '**a**, …'");
  eq(formatLegend("Fig. 1.", cap, science.manuscript!.legend, science.figures.panels),
    "**Fig. 1. Sleep raises synaptic APP.** Mice were deprived. (**A**) Design. (**B**) Blots.", "Science: '**Fig. 1. Title.**' then '(**A**) …'");
  eq(formatLegend("Figure 1.", cap, cell.manuscript!.legend, cell.figures.panels),
    "**Figure 1. Sleep raises synaptic APP**\\\nMice were deprived.\\\n(A) Design.\\\n(B) Blots.", "Cell: the title WITHOUT a full stop, then each panel on its own line");
}

console.log("\nJOURNAL-REFS VERIFY: PASS");
