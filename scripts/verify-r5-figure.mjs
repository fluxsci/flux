// R5 — figure pop-out + per-paper view persistence, against :1420.
// Alt+drag a region of page 1 → a floating panel renders that region (pixel-checked
// for real content), drags by its header, jumps and closes; zoom/page state saved
// per paper round-trips through a paper switch. Run: node scripts/verify-r5-figure.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const pdfB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};
// Reader tabs keep recently-viewed papers mounted (hidden), so probes must scope to
// the ACTIVE document — a bare selector can land on a background tab's toolbar.
const ACT = '[data-doc-active="true"]';
const waitRendered = () =>
  page.waitForFunction(
    (act) => Number(document.querySelector(`${act} [data-testid="pdf-root"]`)?.dataset.rendered || 0) >= 1,
    { timeout: 20000 },
    ACT,
  );

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });
  await page.evaluate((b64) => {
    window.__fluxSeedReaderItem("r5paperA", b64);
    window.__fluxSeedReaderItem("r5paperB", b64);
    window.__fluxOpenReader("r5paperA");
  }, pdfB64);
  await page.waitForSelector('[data-testid="pdf-root"]', { timeout: 15000 });
  await waitRendered();
  await sleep(600);

  // --- alt+drag → figure panel ------------------------------------------------------
  const pr = await page.$eval('.pdf-page[data-page="1"]', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.keyboard.down("Alt");
  await page.mouse.move(pr.left + 70, pr.top + 90);
  await page.mouse.down();
  await page.mouse.move(pr.left + 420, pr.top + 260, { steps: 8 });
  const marqueeVisible = !!(await page.$(".marquee"));
  await page.mouse.up();
  await page.keyboard.up("Alt");
  ok("marquee visible during alt+drag", marqueeVisible);
  const panelShown = await page
    .waitForSelector('[data-testid="figure-panel"] img', { timeout: 6000 })
    .then(() => true, () => false);
  ok("alt+drag pops a figure panel", panelShown);
  if (panelShown) {
    await sleep(300);
    const img = await page.$eval('[data-testid="figure-panel"] img', (el) => ({
      w: el.naturalWidth,
      h: el.naturalHeight,
      src: el.src.slice(0, 30),
    }));
    ok("panel image rendered at 2×", img.w > 500, JSON.stringify(img));
    const darkRatio = await page.$eval('[data-testid="figure-panel"] img', (el) => {
      const c = document.createElement("canvas");
      c.width = el.naturalWidth;
      c.height = el.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(el, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 120) dark++;
      return dark / (d.length / 4);
    });
    ok("panel shows real page content (text pixels)", darkRatio > 0.005, `dark ratio ${darkRatio.toFixed(4)}`);
    await shot(page, "r5-01-figpanel");

    // drag by the header
    const head = await page.$eval('[data-testid="figure-panel"] .fhead', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const before = await page.$eval('[data-testid="figure-panel"]', (el) => el.getBoundingClientRect().left);
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(head.x + 130, head.y + 40, { steps: 5 });
    await page.mouse.up();
    const after = await page.$eval('[data-testid="figure-panel"]', (el) => el.getBoundingClientRect().left);
    ok("panel drags by its header", Math.abs(after - before - 130) < 10, `${before} → ${after}`);

    await page.click('[data-testid="figure-panel"] .fb[title^="Close"]');
    await sleep(200);
    ok("panel closes", !(await page.$('[data-testid="figure-panel"]')));
  }

  // --- per-paper view persistence ------------------------------------------------------
  // With tabs, "reopen" summons the still-live instance (state preserved in place);
  // the cold-reopen localStorage path is r7-tabs' live-cap leg.
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await sleep(500);
  const savedPct = await page.$eval(`${ACT} .zpct`, (el) => parseInt(el.textContent));
  await page.$eval(`${ACT} .pgin`, (el) => {
    el.value = "2";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(900); // save debounce (400) + settle
  await page.evaluate(() => window.__fluxOpenReader("r5paperB"));
  await waitRendered();
  await sleep(500);
  const freshPct = await page.$eval(`${ACT} .zpct`, (el) => parseInt(el.textContent));
  ok("a fresh paper opens at its own default (fit width)", Math.abs(freshPct - savedPct) > 2, `${freshPct}% vs ${savedPct}%`);
  await page.evaluate(() => window.__fluxOpenReader("r5paperA"));
  await waitRendered();
  await sleep(700);
  const restoredPct = await page.$eval(`${ACT} .zpct`, (el) => parseInt(el.textContent));
  const restoredPage = await page.$eval(`${ACT} .pgin`, (el) => el.value);
  ok("zoom restored on reopen", Math.abs(restoredPct - savedPct) <= 2, `${restoredPct}% vs saved ${savedPct}%`);
  ok("page restored on reopen", restoredPage === "2", `page ${restoredPage}`);
  await shot(page, "r5-02-restored");

  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|highlight|devSeed|figure/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  fails++;
  console.log("FAIL exception:", e.message);
  await shot(page, "r5-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
