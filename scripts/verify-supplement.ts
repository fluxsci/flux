// Pure-logic verification of the main-text-vs-supplement rules + the supplements/ model.
//
// This gate exercises the SHIPPED functions from electron/supplementRules.js — the same
// module electron/proxyFetch.cjs and the write-time check import. An earlier version of this
// file re-implemented the engine's candidate pipeline and tested the copy; the copy passed
// while the real engine stored a supplement as paper.pdf for two years' worth of Science
// papers. Never assert against a mirror of the logic under test.
//
// Run: npx tsx scripts/verify-supplement.ts
import { safeSupplementName, parseSupplementManifest } from "../src/lib/references/items";
import { isArticleAsset } from "../src/lib/references/supplementFinder";

import { isSupplementUrl, supplementDocSignal, partitionCandidates, isMainPdfUrl, supplementNameFromUrl } from "../electron/supplementRules.js";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- 1: isSupplementUrl — the shapes every affected publisher actually emits -------------
// NOTE the naming variety. The regression that made this gate necessary was a filter that
// only matched `_sm.pdf` with an UNDERSCORE, while science.org ships `devivo-sm.pdf` and
// `1249098.yang.sm.pdf`. Real-world separators, not tidy ones, belong in this list.
const SUPP = [
  "https://www.science.org/action/downloadSupplement?doi=10.1126%2Fscience.aaw5202&file=aaw5202_marshel_sm.pdf",
  "https://www.science.org/doi/suppl/10.1126/science.aah5982/suppl_file/devivo-sm.pdf", // hyphen
  "https://www.science.org/doi/suppl/10.1126/science.1249098/suppl_file/1249098.yang.sm.pdf", // dots
  "https://www.science.org/doi/suppl/10.1126/science.aap8586/suppl_file/aap8586_sm.pdf", // underscore
  "https://www.science.org/action/downloadSupplement?doi=10.1126%2Fscience.abj9195&file=science.abj9195_mdar_reproducibility_checklist.pdf",
  "https://www.pnas.org/doi/suppl/10.1073/pnas.1402773111/suppl_file/pnas.1402773111.sapp.pdf",
  "https://ars.els-cdn.com/content/image/1-s2.0-S0896627312005910-mmc1.pdf",
  "https://static-content.springer.com/esm/art%3A10.1038%2Fx/MediaObjects/x_MOESM1_ESM.pdf",
  "https://onlinelibrary.wiley.com/action/downloadSupplement?doi=10.1002/x&file=jnr24370-sup-0001-SupInfo.pdf",
  "https://pubs.acs.org/doi/suppl/10.1021/x/suppl_file/ja_si.pdf",
  "https://www.biorxiv.org/content/10.1101/2020.01.01.891234v1.supplementary-material",
];
for (const u of SUPP) ok(isSupplementUrl(u), "supplement URL flagged", u.slice(0, 78));

// --- 2: never flag a legitimate main-text PDF -------------------------------------------
// `Supplement_1` is an OUP journal ISSUE supplement — an ordinary article. A bare /supplement/
// word match would misfile it, which is why the rules enumerate specific shapes.
const MAIN = [
  "https://www.science.org/doi/pdf/10.1126/science.aaw5202",
  "https://www.science.org/doi/pdf/10.1126/science.aah5982?download=true",
  "https://www.cell.com/action/showPdf?pii=S0896-6273(21)00495-5",
  "https://www.nature.com/articles/s41586-021-03819-2.pdf",
  "https://www.sciencedirect.com/science/article/pii/S0896627312005910/pdfft?isDTMRedir=true",
  "https://onlinelibrary.wiley.com/doi/pdf/10.1111/ejn.12084",
  "https://academic.oup.com/cercor/article-pdf/25/11/4348/pdf",
  "https://academic.oup.com/sleep/article-pdf/42/Supplement_1/A1/x.pdf", // issue supplement, NOT SI
  "https://www.nature.com/articles/nrn2356.pdf?error=cookies_not_supported&code=0c27", // "not_supported"
  "https://www-science-org.ezproxy.library.wisc.edu/cms/asset/70654da8/pap.pdf",
];
for (const u of MAIN) ok(!isSupplementUrl(u), "main-text PDF NOT flagged", u.slice(0, 78));

// --- 3: the CONTENT layer — the backstop when a URL looks innocent ----------------------
// Every string below is real text from a real file: the supplements this library actually
// stored as paper.pdf, and the main texts that replaced them.
//
// A SUPPLEMENT must be recognised…
ok(supplementDocSignal({ page1Text: "www.sciencemag.org/content/355/6324/507/suppl/DC1\n\nSupplementary Material for\n\nUltrastructural evidence for synaptic scaling" }) !== null, "content: 'Supplementary Material for' banner");
ok(supplementDocSignal({ page1Text: "Supplementary Materials for\nHippocampal ripples down-regulate synapses\nHiroaki Norimoto, Kenichi Makino" }) !== null, "content: banner where 'for' ENDS the line (AAAS layout)");
ok(supplementDocSignal({ page1Text: "Supporting Online Material for\nActive cortical dendrites modulate perception" }) !== null, "content: 'Supporting Online Material for'");
ok(supplementDocSignal({ title: "Microsoft Word - deVivo-Science-Supplementary Material - for NIH.docx" }) !== null, "content: supplement named in the embedded Title");
ok(supplementDocSignal({ page1Text: "Materials Design Analysis Reporting (MDAR) Checklist for Authors\nThe MDAR framework establishes" }) !== null, "content: MDAR checklist");
ok(supplementDocSignal({ finalUrl: "https://x/action/downloadSupplement?file=y-sm.pdf" }) !== null, "content: supplement finalUrl (post-redirect catch)");

// …and an ARTICLE must survive every way it legitimately talks about its own supplement.
// The first case is the one that matters most: Science's print layout carries the PREVIOUS
// article's tail onto page 1 of the next, bare "SUPPLEMENTARY MATERIALS" heading and all.
// That condemned a perfectly good Takahashi 2016 main text during this fix.
ok(
  supplementDocSignal({
    title: "Active cortical dendrites modulate perception",
    page1Text:
      "RE S EAR CH | R E P O R T S\n22. J. F. Kelly, K. G. Horton, Glob. Ecol. Biogeogr. 25, 1159 (2016).\nTables S1 to S8\nReferences (23–49)\nACKN OW LEDG MEN TS\nWe acknowledge the support provided by COST.\nSUPPLEMENTARY MATERIALS\nwww.sciencemag.org/content/354/6319/1584/suppl/DC1\nMaterials and Methods\nFigs. S1 to S8\nBRAIN RESEARCH\nActive cortical dendrites\nmodulate perception",
  }) === null,
  "content: previous article's SI heading on page 1 does NOT condemn the main text",
);
ok(supplementDocSignal({ page1Text: "Supplementary material for this article is available at http://dx.doi.org/10.1234/x" }) === null, "content: 'for this article' pointer is not a supplement");
ok(supplementDocSignal({ page1Text: "Supplementary Information for the online version of this paper" }) === null, "content: 'for the online version' pointer is not a supplement");
ok(supplementDocSignal({ title: "Ultrastructural evidence for synaptic scaling across the wake/sleep cycle", page1Text: "RESEARCH | REPORT\nUltrastructural evidence for synaptic scaling\nLuisa de Vivo, Michele Bellesi\n(see Supplementary Materials for methods and Supplementary Fig. S3)" }) === null, "content: mid-body SI mention is not a supplement");
ok(supplementDocSignal({ title: "Sleep promotes branch-specific formation of dendritic spines after learning", page1Text: "RE S EAR CH | R E P O R T S New Zealand; INRA and Agence Nationale de la Recherche project" }) === null, "content: ordinary article not flagged");

// --- 4: candidate ranking — the ACTUAL engine function ----------------------------------
// This is the exact affordance list scraped from science.org for 10.1126/science.aah5982 on
// 2026-08-04, in the DOM order the page served it. The supplement came SECOND and won,
// because consumption was first-come. The article must now outrank it.
{
  const P = "www-science-org.ezproxy.library.wisc.edu";
  const doi = "10.1126/science.aah5982";
  const scraped = [
    { url: `https://${P}/doi/reader/${doi}`, kind: "anchor-text" },
    { url: `https://${P}/doi/suppl/${doi}/suppl_file/devivo-sm.pdf`, kind: "anchor-href" },
    { url: `https://${P}/doi/pdf/${doi}?download=true`, kind: "anchor-href" },
    { url: `https://${P}/doi/pdf/${doi}`, kind: "anchor-href" },
  ];
  const { main, supplements } = partitionCandidates(scraped, doi);
  ok(supplements.length === 1 && /suppl_file/.test(supplements[0].url), "Science: the supplement is partitioned OUT of the main list");
  ok(!main.some((c: { url?: string }) => isSupplementUrl(c.url)), "Science: no supplement survives in the main list");
  ok(/\/doi\/pdf\//.test(main[0]?.url ?? ""), "Science: a main /doi/pdf candidate is tried FIRST", main[0]?.url);
  ok(/\/doi\/reader\//.test(main[main.length - 1]?.url ?? ""), "Science: the HTML viewer sorts LAST", main[main.length - 1]?.url);
}
{
  // The regression that hid the bug: when the page ALREADY links /doi/pdf/<doi>, the old
  // "insert only if absent" AAAS guard did nothing and left the supplement ahead of it.
  // Ranking must not depend on the synthesized URL being missing.
  const doi = "10.1126/science.1249098";
  const scraped = [
    { url: `https://x/doi/suppl/${doi}/suppl_file/1249098.yang.sm.pdf`, kind: "anchor-href" },
    { url: `https://x/doi/pdf/${doi}`, kind: "anchor-href" },
  ];
  const { main } = partitionCandidates(scraped, doi);
  ok(main.length === 1 && isMainPdfUrl(main[0].url, doi), "Science: main PDF wins even when the page already lists it");
}
{
  // citation_pdf_url is the publisher's own declaration — it outranks a generic anchor.
  const { main } = partitionCandidates(
    [
      { url: "https://x/some/other.pdf", kind: "anchor-href" },
      { url: "https://x/declared.pdf", kind: "citation_pdf_url" },
    ],
    "10.1234/abc",
  );
  ok(main[0]?.kind === "citation_pdf_url", "citation_pdf_url outranks a generic .pdf anchor");
}
{
  // Wiley page offering ONLY a supplement: fail cleanly rather than store the wrong file.
  const { main, supplements } = partitionCandidates([{ url: "https://onlinelibrary-wiley-com.x/action/downloadSupplement?doi=10.1111/ejn.15412&file=x-supp.pdf", kind: "anchor-href" }], "10.1111/ejn.15412");
  ok(main.length === 0 && supplements.length === 1, "supplement-only page yields no main candidate (fails cleanly, not a wrong PDF)");
}

// --- 5: naming ---------------------------------------------------------------------------
ok(supplementNameFromUrl("https://x/action/downloadSupplement?doi=10.1126%2Fscience.aah5982&file=devivo-sm.pdf") === "devivo-sm.pdf", "name from ?file= param");
ok(supplementNameFromUrl("https://x/doi/suppl/10.1126/science.x/suppl_file/1249098.yang.sm.pdf") === "1249098.yang.sm.pdf", "name from the path");
ok(safeSupplementName("aaw5202_marshel_sm.pdf") === "aaw5202_marshel_sm.pdf", "keeps a normal filename");
ok(safeSupplementName("Figure S1.pdf") === "Figure S1.pdf", "keeps spaces");
ok(safeSupplementName("Supp-Data-2.pdf") === "Supp-Data-2.pdf", "keeps hyphens");
ok(safeSupplementName("/abs/path/movie.mov") === "movie.mov", "strips directory part");
ok(safeSupplementName("../../etc/passwd") === "passwd", "defuses path traversal");
ok(safeSupplementName("") === "supplement.pdf", "empty → fallback name");

// --- 6: Europe PMC archive filtering ------------------------------------------------------
// The archive mixes the article's own artwork in with the supplements — every figure as both
// .jpg and .gif. Keep non-images; keep an image only if it's named as a supplement.
for (const n of ["ajc-30-5-297_f001.jpg", "TRA-27-e70038-g004.gif", "41592_2023_1863_Fig11_ESM.jpg", "41592_2023_1863_Tab1_ESM.gif", "41592_2023_1863_Fig1_HTML.jpg", "88x31.jpg"])
  ok(isArticleAsset(n), "article artwork dropped", n);
for (const n of ["supplementary_material.pdf", "TRA-27-e70038-s001.avi", "APPY-18-e70029-s002.docx", "41592_2023_1863_MOESM1_ESM.pdf", "41592_2023_1863_MOESM3_ESM.mp4"])
  ok(!isArticleAsset(n), "real supplement kept", n);

// --- 7: manifest parsing is never fatal ---------------------------------------------------
ok(parseSupplementManifest(null).items.length === 0, "missing manifest → empty");
ok(parseSupplementManifest("{ not json").items.length === 0, "corrupt manifest → empty");
ok(parseSupplementManifest(JSON.stringify({ version: 1, items: [{ name: "a.pdf", bytes: 1, fetchedAt: "x" }, { nope: true }] })).items.length === 1, "manifest drops malformed rows");

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
