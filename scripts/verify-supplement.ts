// Pure-logic verification of the Science-supplement fix + the supplements/ filename model.
// (The end-to-end capture — that the proxy engine grabs the MAIN /doi/pdf and never a
//  downloadSupplement — is asserted live by scripts/verify-proxy-capture.cjs's AAAS case,
//  which needs the authenticated proxy. This script pins the building blocks headlessly.)
// Run: npx tsx scripts/verify-supplement.ts
import { createRequire } from "node:module";
import { safeSupplementName } from "../src/lib/references/items";

const require = createRequire(import.meta.url);
const { isSupplementUrl, isAaasDoi, rewriteToProxyHost } = require("../electron/proxyFetch.cjs");

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- 1: isSupplementUrl — the supplement signals every affected publisher uses ------------
const SUPP = [
  "https://www-science-org.ezproxy.library.wisc.edu/action/downloadSupplement?doi=10.1126%2Fscience.aaw5202&file=aaw5202_marshel_sm.pdf",
  "https://www.science.org/doi/suppl/10.1126/science.aap8586/suppl_file/aap8586_sm.pdf",
  "https://ars.els-cdn.com/content/image/1-s2.0-S0896627312005910-mmc1.pdf", // Elsevier multimedia component
  "https://static-content.springer.com/esm/art%3A10.1038%2Fx/MediaObjects/x_MOESM1_ESM.pdf", // Springer ESM
  "https://onlinelibrary.wiley.com/action/downloadSupplement?doi=10.1002/x&file=jnr24370-sup-0001-SupInfo.pdf",
  "https://pubs.acs.org/doi/suppl/10.1021/x/suppl_file/ja_si.pdf", // ACS supporting info
];
for (const u of SUPP) ok(isSupplementUrl(u), "supplement URL flagged", u.slice(0, 70));

// --- 2: isSupplementUrl must NEVER flag a legitimate main-text PDF ------------------------
const MAIN = [
  "https://www.science.org/doi/pdf/10.1126/science.aaw5202",
  "https://www.cell.com/action/showPdf?pii=S0896-6273(21)00495-5",
  "https://www.nature.com/articles/s41586-021-03819-2.pdf",
  "https://www.sciencedirect.com/science/article/pii/S0896627312005910/pdfft?isDTMRedir=true",
  "https://onlinelibrary.wiley.com/doi/pdf/10.1111/ejn.12084",
  "https://academic.oup.com/cercor/article-pdf/25/11/4348/pdf",
];
for (const u of MAIN) ok(!isSupplementUrl(u), "main-text PDF NOT flagged", u.slice(0, 70));

// --- 3: isAaasDoi — only 10.1126/* --------------------------------------------------------
ok(isAaasDoi("10.1126/science.aaw5202"), "science DOI is AAAS");
ok(isAaasDoi("10.1126/sciadv.abc1234"), "sciadv DOI is AAAS");
ok(!isAaasDoi("10.1016/j.neuron.2012.06.029"), "Cell Press DOI is not AAAS");
ok(!isAaasDoi("10.1038/s41586-020-2731-9"), "Nature DOI is not AAAS");

// --- 4: the engine's candidate pipeline — supplement dropped, AAAS main prepended first ---
// Mirror of proxyFetch.cjs's post-scrape logic (filter supplements, unshift the synthesized
// AAAS /doi/pdf/<doi>) so a regression in either helper surfaces here.
function pipeline(doi: string, scraped: { url?: string; sel?: string; kind: string }[], prefixHost: string) {
  let candidates = scraped.filter((c) => !(c.url && isSupplementUrl(c.url)));
  if (isAaasDoi(doi)) {
    const sci = rewriteToProxyHost("https://www.science.org/doi/pdf/" + doi, prefixHost);
    if (!candidates.some((c) => c.url === sci)) candidates.unshift({ url: sci, kind: "aaas-doi-pdf" });
  }
  return candidates;
}
const prefix = "ezproxy.library.wisc.edu";
{
  // A Science article page as scraped: a viewer link + the supplement download.
  const doi = "10.1126/science.aaw5202";
  const scraped = [
    { url: `https://www-science-org.${prefix}/doi/epdf/${doi}`, kind: "anchor-href" },
    { url: `https://www-science-org.${prefix}/action/downloadSupplement?doi=10.1126%2Fscience.aaw5202&file=aaw5202_marshel_sm.pdf`, kind: "anchor-href" },
  ];
  const out = pipeline(doi, scraped, prefix);
  ok(!out.some((c) => c.url && isSupplementUrl(c.url)), "Science: supplement candidate removed");
  ok(out[0]?.kind === "aaas-doi-pdf" && /\/doi\/pdf\//.test(out[0]?.url ?? ""), "Science: synthesized main /doi/pdf is tried first", out[0]?.url);
  ok(out.some((c) => /\/doi\/epdf\//.test(c.url ?? "")), "Science: the viewer affordance is retained as a fallback");
}
{
  // A non-AAAS paper (Wiley) with only a supplement affordance: supplement dropped, no synth.
  const doi = "10.1111/ejn.15412";
  const scraped = [{ url: `https://onlinelibrary-wiley-com.${prefix}/action/downloadSupplement?doi=10.1111/ejn.15412&file=x-supp.pdf`, kind: "anchor-href" }];
  const out = pipeline(doi, scraped, prefix);
  ok(out.length === 0, "Wiley supplement-only page yields no main-PDF candidate (fails cleanly, not a wrong PDF)");
}

// --- 5: safeSupplementName — safe basenames, no traversal, readable labels ----------------
ok(safeSupplementName("aaw5202_marshel_sm.pdf") === "aaw5202_marshel_sm.pdf", "keeps a normal filename");
ok(safeSupplementName("Figure S1.pdf") === "Figure S1.pdf", "keeps spaces");
ok(safeSupplementName("Supp-Data-2.pdf") === "Supp-Data-2.pdf", "keeps hyphens");
ok(safeSupplementName("/abs/path/movie.mov") === "movie.mov", "strips directory part");
ok(safeSupplementName("../../etc/passwd") === "passwd", "defuses path traversal");
ok(safeSupplementName("") === "supplement.pdf", "empty → fallback name");

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
