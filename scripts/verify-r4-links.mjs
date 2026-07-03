// R4 — citation hover preview + outline + back-navigation, against :1420.
// Hover the fixture's "[1]" citation link → the preview card shows the extracted
// bibliography entry (Ward 2018, from page 3) without leaving page 1; click →
// jump + ← back-navigation; outline tab lists the fixture's real outline and
// navigates. (Brief-matching against OpenAlex refs is unit-tested in
// verify-r4-cite.ts — the sidebar has no network refs headlessly.)
//   Run: node scripts/verify-r4-links.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const KEY = "fixture2026reader";
const pdfB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });
  await page.evaluate(
    (key, b64) => {
      window.__fluxSeedReaderItem(key, b64);
      window.__fluxOpenReader(key);
    },
    KEY,
    pdfB64,
  );
  await page.waitForSelector('[data-testid="pdf-root"]', { timeout: 15000 });
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.rendered || 0) >= 1,
    { timeout: 20000 },
  );
  await sleep(600);

  // --- hover the citation link → preview card -------------------------------------
  await page.waitForSelector(".annotationLayer a", { timeout: 8000 });
  const linkC = await page.$eval(".annotationLayer a", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(linkC.x, linkC.y);
  const cardShown = await page
    .waitForSelector('[data-testid="cite-preview"]', { timeout: 5000 })
    .then(() => true, () => false);
  ok("hovering a citation link opens the preview card", cardShown);
  if (cardShown) {
    const cardText = await page.$eval('[data-testid="cite-preview"]', (el) => el.textContent);
    ok("card shows the extracted bibliography entry", /Ward/.test(cardText) && /Downgraded phenomenology/.test(cardText), cardText.slice(0, 90));
    ok("card names the bibliography page", /p\.3/.test(cardText), cardText.slice(-60));
    ok("card stops before the next entry", !/Block/.test(cardText));
    await shot(page, "r4-01-hovercard");
    await page.mouse.move(40, 400); // leave the link
    await sleep(800);
    ok("card hides after the pointer leaves", !(await page.$('[data-testid="cite-preview"]')));
  }

  // --- click the link → jump; ← comes back ------------------------------------------
  const backDisabled = await page.$eval('button[title^="Back"]', (el) => el.disabled);
  ok("back button disabled before any jump", backDisabled === true);
  await page.mouse.click(linkC.x, linkC.y);
  await sleep(900);
  let cur = await page.$eval(".pgin", (el) => el.value);
  ok("link click jumps to the bibliography", cur === "3", `page ${cur}`);
  ok("back button enabled after the jump", (await page.$eval('button[title^="Back"]', (el) => el.disabled)) === false);
  await page.click('button[title^="Back"]');
  await sleep(1000);
  cur = await page.$eval(".pgin", (el) => el.value);
  ok("← returns to where you were", cur === "1", `page ${cur}`);

  // --- outline tab --------------------------------------------------------------------
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".stab")].find((e) => /outline/i.test(e.textContent || ""));
    b?.click();
  });
  await sleep(600);
  const items = await page.$$eval(".outitem", (els) => els.map((e) => e.textContent.trim()));
  ok("outline lists the document's real outline", items.join(",") === "Introduction,References", items.join(","));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".outitem")].find((e) => /References/.test(e.textContent || ""));
    b?.click();
  });
  await sleep(900);
  cur = await page.$eval(".pgin", (el) => el.value);
  ok("outline click navigates (References → p3)", cur === "3", `page ${cur}`);
  ok("outline jump feeds the back stack", (await page.$eval('button[title^="Back"]', (el) => el.disabled)) === false);
  await shot(page, "r4-02-outline");

  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|highlight|devSeed|cite/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  fails++;
  console.log("FAIL exception:", e.message);
  await shot(page, "r4-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
