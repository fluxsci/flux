// R6 — multiple PDFs per paper: the "Switch PDF" dropdown, against :1420.
// Seeds a main paper + two supplement PDFs (distinguishable text), opens the reader, and
// drives the switcher: the button shows the PDF count, the menu lists Main + each supplement
// + "Add supplement…", picking a supplement swaps the rendered document (text layer changes),
// and picking "Main paper" switches back. Run: node scripts/verify-r6-supplement.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const mainB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

// A minimal one-page PDF carrying `text` on page 1 (uncompressed, core Helvetica) so a switch
// is observable in pdf.js's text layer.
function onePagePdf(text) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = `BT /F1 20 Tf 72 700 Td (${esc(text)}) Tj ET`;
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let out = "%PDF-1.4\n";
  const offs = [0];
  for (let i = 1; i < objs.length; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

const suppAlpha = onePagePdf("SUPPLEMENT ALPHA supporting information");
const suppBeta = onePagePdf("SUPPLEMENT BETA extra figures");

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};
const waitRendered = () =>
  page.waitForFunction(() => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.rendered || 0) >= 1, {
    timeout: 20000,
  });
const page1Text = () =>
  page.evaluate(() => document.querySelector('.pdf-page[data-page="1"] .textLayer')?.textContent || "");
const switchLabel = () => page.evaluate(() => document.querySelector('[data-testid="pdf-switch"]')?.textContent?.trim() || "");
const menuItems = () =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="pdf-menu"] .pdfitem')].map((b) => b.textContent.trim()));
async function clickMenuItem(match) {
  const clicked = await page.evaluate((m) => {
    const b = [...document.querySelectorAll('[data-testid="pdf-menu"] .pdfitem')].find((x) => x.textContent.includes(m));
    if (b) b.click();
    return !!b;
  }, match);
  return clicked;
}

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(
    () => window.__fluxOpenReader && window.__fluxSeedReaderItem && window.__fluxSeedReaderSupplement,
    { timeout: 15000 },
  );
  await page.evaluate(
    ({ main, a, b }) => {
      window.__fluxSeedReaderItem("r6paper", main);
      window.__fluxSeedReaderSupplement("r6paper", "supplement-one.pdf", a);
      window.__fluxSeedReaderSupplement("r6paper", "figures.pdf", b);
      window.__fluxOpenReader("r6paper");
    },
    { main: mainB64, a: suppAlpha, b: suppBeta },
  );
  await page.waitForSelector('[data-testid="pdf-root"]', { timeout: 15000 });
  await waitRendered();
  await sleep(500);

  // --- switcher button present, shows total PDF count (main + 2 supplements = 3) ----------
  const hasBtn = !!(await page.$('[data-testid="pdf-switch"]'));
  ok("Switch PDF button present when supplements exist", hasBtn);
  ok("button shows the total PDF count", (await switchLabel()).includes("Paper (3)"), await switchLabel());
  ok("main paper text renders first", (await page1Text()).includes("FluxReader Fixture"));

  // --- open the menu → lists Main + both supplements + Add ---------------------------------
  await page.click('[data-testid="pdf-switch"]');
  await sleep(150);
  const menuOpen = !!(await page.$('[data-testid="pdf-menu"]'));
  ok("clicking opens the dropdown", menuOpen);
  const items = await menuItems();
  ok("menu lists Main paper", items.some((t) => t.includes("Main paper")));
  ok("menu lists supplement-one (extension stripped)", items.some((t) => t.includes("supplement-one") && !t.includes(".pdf")));
  ok("menu lists figures", items.some((t) => t.includes("figures")));
  ok("menu offers Add supplement…", items.some((t) => t.includes("Add supplement")));
  await shot(page, "r6-menu-open");

  // --- pick supplement-one → the rendered document changes --------------------------------
  ok("clicked supplement-one", await clickMenuItem("supplement-one"));
  await waitRendered();
  await sleep(400);
  ok("supplement content now rendered", (await page1Text()).includes("SUPPLEMENT ALPHA"), (await page1Text()).slice(0, 40));
  ok("main text no longer shown", !(await page1Text()).includes("FluxReader Fixture"));
  ok("button label reflects the active supplement", (await switchLabel()).includes("supplement-one"), await switchLabel());
  ok("menu auto-closed after selection", !(await page.$('[data-testid="pdf-menu"]')));
  await shot(page, "r6-on-supplement");

  // --- switch to the other supplement, then back to Main ----------------------------------
  await page.click('[data-testid="pdf-switch"]');
  await sleep(120);
  await clickMenuItem("figures");
  await waitRendered();
  await sleep(400);
  ok("second supplement renders", (await page1Text()).includes("SUPPLEMENT BETA"), (await page1Text()).slice(0, 40));

  await page.click('[data-testid="pdf-switch"]');
  await sleep(120);
  await clickMenuItem("Main paper");
  await waitRendered();
  await sleep(400);
  ok("switching back restores the main paper", (await page1Text()).includes("FluxReader Fixture"));
  ok("button back to Paper label", (await switchLabel()).includes("Paper (3)"), await switchLabel());

  const errs = realErrors(page);
  ok("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));
} catch (e) {
  ok(`run threw: ${String((e && e.message) || e)}`, false);
} finally {
  await browser.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
