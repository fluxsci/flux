// Verify the renderer half of the pdfs_to_assign feature: that the app's real pdf.js
// signal-extraction path (src/lib/pdf/pdfSignals.ts extractPdfSignals) produces sound
// identification signals IN THE ACTUAL BROWSER. The Node CLI run already validated the
// shared identify()/reconcile() core end-to-end over the 6 real inbox PDFs; the pure
// scripts/verify-pdfidentify.ts covers identify()'s confidence gate. This closes the loop
// on the one browser-only piece: getMetadata()/getTextContent() shape handling.
//
// Drives the DEV-only window.__fluxExtractSignals hook (devSeed.ts) with a hermetic two-page scientific PDF.
// Run: node scripts/verify-assign.mjs   (needs `npm run dev` on :1420)
import { launch, gotoApp, clickNew, realErrors, shot, sleep } from "./lib/driver.mjs";

// An actual two-page PDF, generated here so this gate never reads personal FluxLib.
const TITLE = "Controlled cortical dynamics in a hermetic identification fixture";
const DOI = "10.5555/flux.assign.fixture";
const esc = s => s.replace(/[\\()]/g, c => "\\" + c);
const pages = [
  [TITLE, "A. Researcher and B. Researcher, 2026.", `doi:${DOI}`,
   "Scientific measurements preserve trial identity and valid observation intervals.",
   "The fixture contains enough first-page prose to exercise browser text extraction.",
   "Repeated observations quantify neural activity without changing source evidence."],
  ["Tail-page evidence: independent replication and exact scientific provenance.", "References and methodological notes remain available after the first page."]
];
const objects = [null, "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"];
for(let p=0;p<pages.length;p++) {
  const stream = ["BT", "/F1 12 Tf", "16 TL", "72 720 Td", ...pages[p].map((s,i)=>`${i?"T* ":""}(${esc(s)}) Tj`), "ET"].join("\n");
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4+p*2} 0 R >>`);
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
}
objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Title (${esc(TITLE)}) /Subject (doi:${DOI}) >>`);
let pdf="%PDF-1.4\n";const offsets=[0];
for(let i=1;i<objects.length;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
const xref=pdf.length;pdf+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
for(let i=1;i<objects.length;i++)pdf+=`${String(offsets[i]).padStart(10,"0")} 00000 n \n`;
pdf+=`trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const b64=Buffer.from(pdf,"latin1").toString("base64");

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

const { browser, page } = await launch();
try {
  await gotoApp(page);
  await clickNew(page); // fully boot the app so devSeed's hook registers

  // Wait for the DEV hook to appear.
  let hookReady = false;
  for (let i = 0; i < 40; i++) {
    hookReady = await page.evaluate(() => typeof window.__fluxExtractSignals === "function");
    if (hookReady) break;
    await sleep(150);
  }
  ok(hookReady, "window.__fluxExtractSignals dev hook is present");

  if (hookReady) {
    const sig = await page.evaluate((b) => window.__fluxExtractSignals(b), b64);
    console.log("  signals:", JSON.stringify({ ...sig, page1Head: (sig.page1Head || "").slice(0, 80) + "…" }, null, 0));

    ok(sig && typeof sig === "object", "extractPdfSignals returned an object (browser pdf.js OK)");
    ok(sig.numPages === 2, "exact two-page fixture decoded");
    ok(sig.infoTitle === TITLE && sig.infoDoi === DOI, "exact embedded scientific title and DOI extracted");
    ok(sig.numPages > 0, `numPages > 0 (got ${sig?.numPages})`);
    ok(sig.page1Len > 200, `page-1 text extracted (${sig?.page1Len} chars)`);
    ok(sig.tailLen > 0, `tail text extracted (${sig?.tailLen} chars)`);
    // A real paper must surface SOMETHING to identify on: an embedded DOI, a DOI/arXiv id in
    // text, or a plausible title guess. (identify()'s gating itself is covered by the pure test.)
    const anchor = sig.xmpDoi || sig.infoDoi || sig.arxivId || (sig.titleGuess && sig.titleGuess.length > 8) || (sig.xmpTitle || sig.infoTitle);
    ok(!!anchor, `has an identification anchor (doi/arxiv/title): ${sig.xmpDoi || sig.infoDoi || sig.arxivId || sig.titleGuess || sig.xmpTitle || sig.infoTitle || "—"}`);
  }

  ok(realErrors(page).length === 0, "no console/page errors during extraction: " + JSON.stringify(realErrors(page).slice(0, 3)));
  await shot(page, "assign-signals");
} finally {
  await browser.close();
}

console.log(fails.length ? `\nFAIL — ${fails.length} assertion(s) failed` : "\nPASS — renderer signal extraction verified in-browser");
process.exit(fails.length ? 1 : 0);
