// 2.4 gate (pure) — the bulk-import core: the shared add planner (preview == outcome),
// the RIS→BibTeX converter, and the Zotero Better-BibTeX `file`-field parser. No I/O.
//   Run: npx tsx scripts/verify-import-plan.ts
import { planAdds, appendedBib } from "../src/lib/references/addPlan";
import { risToBibtex, sniffFormat } from "../src/lib/references/ris";
import { parseZoteroFileField, extractBibField, bibPdfAttachments } from "../src/lib/references/zoteroFiles";
import { splitBibEntries, bibtexKey, lightEntry } from "../src/lib/references/bibtex";

let fails = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
  if (!cond) fails++;
};

// --- planner: new / renamed / merged-by-DOI / merged-by-signature -----------------------
{
  const cur = `@article{smith2020, title={Alpha}, author={Smith, J}, year={2020}, doi={10.1/a}}\n`;
  const incoming = [
    // 1) brand-new, keeps its well-formed key
    `@article{jones2021, title={Beta study of things}, author={Jones, K}, year={2021}, doi={10.2/b}}`,
    // 2) DOI collides with smith2020 → merged
    `@article{whatever, title={Alpha reprint}, author={Smith, J}, year={2020}, doi={10.1/a}}`,
    // 3) key collides with existing smith2020 (different paper, no DOI) → renamed
    `@article{smith2020, title={Gamma distinct paper}, author={Smith, J}, year={2020}}`,
  ].join("\n\n");
  const plan = planAdds(cur, incoming, "bibtex");
  ok(plan.counts.new === 2 && plan.counts.merged === 1, `counts: 2 new / 1 merged (${JSON.stringify(plan.counts)})`);
  ok(plan.planned[0].action === "new" && plan.planned[0].key === "jones2021" && !plan.planned[0].renamed, "well-formed new key kept");
  ok(plan.planned[1].action === "merged" && plan.planned[1].mergedInto === "smith2020" && plan.planned[1].reason === "doi", "DOI dup merges onto existing key");
  ok(plan.planned[2].action === "new" && plan.planned[2].renamed && plan.planned[2].key !== "smith2020", `key collision renamed (${plan.planned[2].key})`);
}

// --- planner: signature dedup + intra-batch dedup ---------------------------------------
{
  // Same paper, once WITHOUT a doi then WITH — must collapse to one key (LR-9 signature).
  const incoming = [
    `@article{a, title={Hippocampal replay during sleep}, author={Ng, A}, year={2019}}`,
    `@article{b, title={Hippocampal replay during sleep}, author={Ng, A}, year={2019}, doi={10.9/z}}`,
  ].join("\n\n");
  const plan = planAdds("", incoming, "bibtex");
  ok(plan.counts.new === 1 && plan.counts.merged === 1, `intra-batch signature dedup (${JSON.stringify(plan.counts)})`);
  ok(plan.keys[0] === plan.keys[1], "both incoming rows resolve to the same key");
}

// --- planner ↔ outcome parity: appendedBib re-parses to exactly the planned new keys ----
{
  const cur = `@article{keep1, title={Keep}, author={X}, year={2000}}\n`;
  const incoming = `@article{new1, title={Fresh one about neurons}, author={Y}, year={2020}}\n\n@article{new2, title={Second fresh work}, author={Z}, year={2021}}`;
  const plan = planAdds(cur, incoming, "bibtex");
  const outText = appendedBib(cur, plan);
  const outKeys = splitBibEntries(outText).map(bibtexKey);
  ok(outKeys.includes("keep1") && outKeys.includes("new1") && outKeys.includes("new2"), "written bib contains existing + both new keys", outKeys.join(","));
  ok(plan.added.every((e) => outText.includes(`{${e.key},`)), "every planned-new key is present in the outcome text");
  // Idempotency: re-planning the SAME incoming against the outcome yields 0 new.
  const plan2 = planAdds(outText, incoming, "bibtex");
  ok(plan2.counts.new === 0 && plan2.counts.merged === 2, `re-import is a no-op (${JSON.stringify(plan2.counts)})`);
}

// --- planner: dateadded stamping (sort-by-recency support) ------------------------------
{
  const cur = `@article{old1, title={Old paper about mitochondria}, author={Ames, A}, year={2000}}\n`;
  const incoming = [
    `@article{n1, title={First fresh paper}, author={Boone, C}, year={2020}}`,
    `@article{n2, title={Second fresh paper}, author={Datta, E}, year={2021}, dateadded = {1999-01-01T00:00:00Z}}`,
    `@article{whatever, title={Old paper about mitochondria}, author={Ames, A}, year={2000}}`,
  ].join("\n\n");
  const T = "2026-08-07T12:00:00.000Z";
  const plan = planAdds(cur, incoming, "bibtex", T);
  ok(plan.added.length === 2 && plan.added.every((e) => e.dateAdded === T), "every new entry carries the shared batch stamp");
  const outEntries = splitBibEntries(appendedBib(cur, plan)).map(lightEntry);
  ok(outEntries.find((e) => e.key === "n1")?.dateAdded === T, "stamp round-trips through the written bib");
  ok(outEntries.find((e) => e.key === "n2")?.dateAdded === T, "an incoming dateadded (e.g. a BBT export's own) is replaced with local receipt time");
  ok(outEntries.find((e) => e.key === "old1")?.dateAdded === undefined, "existing entries are never restamped (stamps ride appendText only)");
  ok(plan.deduped.length === 1 && plan.deduped[0].dateAdded === undefined, "a merged entry doesn't claim a fresh stamp");
  const dflt = planAdds("", `@article{x, title={Wholly unrelated title}, author={Quine, W}, year={2022}}`).added[0];
  ok(!!dflt?.dateAdded && !Number.isNaN(Date.parse(dflt.dateAdded)), `default stamp is a parseable ISO timestamp (${dflt?.dateAdded})`);
}

// --- RIS → BibTeX -----------------------------------------------------------------------
{
  const ris = [
    "TY  - JOUR",
    "AU  - Watson, James",
    "AU  - Crick, Francis",
    "TI  - Molecular structure of nucleic acids",
    "PY  - 1953",
    "JO  - Nature",
    "VL  - 171",
    "IS  - 4356",
    "SP  - 737",
    "EP  - 738",
    "DO  - https://doi.org/10.1038/171737a0",
    "ER  - ",
  ].join("\n");
  ok(sniffFormat(ris) === "ris", "sniffFormat detects RIS");
  ok(sniffFormat("@article{k, title={x}}") === "bibtex", "sniffFormat detects BibTeX");
  const bib = risToBibtex(ris);
  ok(/^@article\{watsonMolecularStructureNucleic1953/m.test(bib), "RIS→BibTeX: article type + BBT-style key", bib.split("\n")[0]);
  const e = lightEntry(splitBibEntries(bib)[0]);
  ok(e.doi === "10.1038/171737a0", `DOI cleaned of the URL prefix (${e.doi})`);
  ok(e.authors.join(",") === "Watson,Crick", `both authors parsed (${e.authors.join(",")})`);
  ok(e.year === "1953" && /Nature/.test(e.container ?? ""), "year + journal mapped");
  ok(bib.includes("pages = {737--738}"), "SP/EP → page range");
  // And it flows through the planner unchanged.
  const plan = planAdds("", bib, "bibtex");
  ok(plan.counts.new === 1, "converted RIS adds via the normal planner");
}

// --- RIS: chapter maps T2 → booktitle, blank records skipped -----------------------------
{
  const ris = ["TY  - CHAP", "TI  - A chapter", "T2  - The Big Book", "AU  - Author, A", "PY  - 2010", "ER  -", "TY  - JOUR", "ER  -"].join("\n");
  const bib = risToBibtex(ris);
  ok(bib.includes("booktitle = {The Big Book}"), "chapter T2 → booktitle");
  ok(splitBibEntries(bib).length === 1, "empty RIS record (no title/author) skipped");
}

// --- Zotero file-field parser -----------------------------------------------------------
{
  const triple = parseZoteroFileField("Full Text PDF:files/42/Smith - 2020.pdf:application/pdf");
  ok(triple.length === 1 && triple[0].path === "files/42/Smith - 2020.pdf" && triple[0].mime === "application/pdf", "desc:path:mime triple", JSON.stringify(triple[0]));
  const multi = parseZoteroFileField("PDF:a/one.pdf:application/pdf;Snapshot:b/two.html:text/html");
  ok(multi.length === 2 && multi[1].path === "b/two.html", "multi-attachment split on ;");
  const win = parseZoteroFileField("Full Text:C\\:\\Users\\me\\lib\\paper.pdf:application/pdf");
  ok(win[0].path === "C:\\Users\\me\\lib\\paper.pdf", `Windows drive path un-escaped (${win[0].path})`);
  const bare = parseZoteroFileField("storage/ABCD/paper.pdf");
  ok(bare.length === 1 && bare[0].path === "storage/ABCD/paper.pdf", "bare path (no desc/mime)");
}

// --- extract `file` field from an entry; don't match `profile` --------------------------
{
  const raw = `@article{k,\n  title = {A study},\n  file = {PDF:x/y.pdf:application/pdf},\n  note = {see profile = {nope}},\n}`;
  ok(extractBibField(raw, "file") === "PDF:x/y.pdf:application/pdf", "extractBibField pulls the file value, not `profile`");
  const atts = bibPdfAttachments(raw);
  ok(atts.length === 1 && atts[0].path === "x/y.pdf", "bibPdfAttachments returns the PDF");
  ok(bibPdfAttachments(`@article{k, title={t}}`).length === 0, "no file field → no attachments");
  // A .bib with a Windows-absolute file and a non-PDF sibling → only the PDF is returned.
  const two = bibPdfAttachments(`@book{b, file = {PDF:D\\:\\z\\a.pdf:application/pdf;Snap:D\\:\\z\\a.html:text/html}}`);
  ok(two.length === 1 && two[0].path === "D:\\z\\a.pdf", "non-PDF attachment filtered out");
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
