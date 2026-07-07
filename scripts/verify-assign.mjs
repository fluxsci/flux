// Verify the renderer half of the pdfs_to_assign feature: that the app's real pdf.js
// signal-extraction path (src/lib/pdf/pdfSignals.ts extractPdfSignals) produces sound
// identification signals IN THE ACTUAL BROWSER. The Node CLI run already validated the
// shared identify()/reconcile() core end-to-end over the 6 real inbox PDFs; the pure
// scripts/verify-pdfidentify.ts covers identify()'s confidence gate. This closes the loop
// on the one browser-only piece: getMetadata()/getTextContent() shape handling.
//
// Drives the DEV-only window.__fluxExtractSignals hook (devSeed.ts) with a real filed PDF.
// Run: node scripts/verify-assign.mjs   (needs `npm run dev` on :1420)
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launch, gotoApp, clickNew, realErrors, shot, sleep } from "./lib/driver.mjs";

const KEYS = [
  "betzig2006imaging-586",
  "berridge2013psychostimulants-c51",
  "frank2014sleep-875",
  "bockaert2021complex-2f9",
  "cecchetto2021simultaneous-a97",
  "riedemann2019diversity-adf",
];
const LIB = join(homedir(), "FluxLib", "items");

function pickPdf() {
  for (const k of KEYS) {
    const p = join(LIB, k, "paper.pdf");
    if (existsSync(p)) return { key: k, path: p };
  }
  return null;
}

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

const found = pickPdf();
if (!found) {
  console.error("No filed PDF found among the known keys — run `flux assign-pdfs` first.");
  process.exit(2);
}
const b64 = readFileSync(found.path).toString("base64");
console.log(`Using ${found.key}/paper.pdf (${(b64.length / 1.37 / 1024).toFixed(0)} KB)`);

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
