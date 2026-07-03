// R2 — FluxReader viewer core on pdf.js PDFViewer (legacy build), against :1420.
// Exercises what the core swap bought: fit-width default, ctrl+wheel zoom anchored at
// the cursor, multiplicative zoom buttons + keyboard, wrapped/2-up/horizontal layouts,
// find via PDFFindController (highlight-all + active match), and live link
// annotations (internal dest click → page 3). Run: node scripts/verify-r2-viewer.mjs
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

const pageBox = (n) =>
  page.$eval(`.pdf-page[data-page="${n}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, top: el.offsetTop };
  });

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });
  await page.evaluate(
    (key, b64) => {
      window.__fluxSeedReaderItem(key, b64, {
        version: 1,
        annotations: [
          {
            id: "seed-hl",
            page: 1,
            color: "yellow",
            createdAt: "2026-01-01T00:00:00Z",
            anchor: { quote: "rich visual world", prefix: "We seem to experience a ", suffix: " as we move" },
          },
        ],
      });
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

  // --- hooks + fit-width default -------------------------------------------------
  const pages = await page.$eval('[data-testid="pdf-root"]', (el) => Number(el.dataset.pages));
  ok("test hooks: data-pages", pages === 3, `got ${pages}`);
  ok("test hooks: .pdf-page[data-page]", !!(await page.$('.pdf-page[data-page="1"]')));
  const scrollW = await page.$eval(".pdf-scroll", (el) => el.clientWidth);
  let p1 = await pageBox(1);
  ok("default zoom is fit-width", Math.abs(p1.w - scrollW) < 45, `page ${p1.w}px vs container ${scrollW}px`);
  const pctBefore = await page.$eval(".zpct", (el) => parseInt(el.textContent));
  ok("scale readout populated", pctBefore > 20 && pctBefore < 400, `${pctBefore}%`);

  // --- ctrl+wheel zoom, anchored at the cursor ------------------------------------
  const anchor = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) =>
      (s.textContent || "").includes("special affinity"),
    );
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // Two spaced wheel ticks (a real pinch interleaves with scroll events; synchronous
  // dispatch would compound against a stale viewer location and skew the anchor).
  const wheelTick = (pt) =>
    page.evaluate((p) => {
      document
        .querySelector(".pdf-scroll")
        .dispatchEvent(
          new WheelEvent("wheel", { ctrlKey: true, deltaY: -160, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }),
        );
    }, pt);
  await wheelTick(anchor);
  await sleep(350);
  await wheelTick(anchor);
  await sleep(1100); // drawingDelay 400 + re-raster settle
  const zoomed = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) =>
      (s.textContent || "").includes("special affinity"),
    );
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  p1 = await pageBox(1);
  ok("ctrl+wheel zooms in", p1.w > scrollW * 1.1, `page now ${p1.w}px`);
  ok(
    "zoom is anchored at the cursor",
    zoomed && Math.abs(zoomed.y - anchor.y) < 100 && Math.abs(zoomed.x - anchor.x) < 160,
    zoomed ? `anchor drift ${(zoomed.x - anchor.x).toFixed(0)},${(zoomed.y - anchor.y).toFixed(0)}px` : "span gone",
  );
  const pctZoomed = await page.$eval(".zpct", (el) => parseInt(el.textContent));
  ok("scale readout tracks zoom", pctZoomed > pctBefore, `${pctBefore}% → ${pctZoomed}%`);
  await shot(page, "r2-01-zoomed");

  // highlight survives zoom re-render (percent boxes + textlayerrendered re-attach)
  await page.waitForFunction(() => !!document.querySelector('.annot-hl[data-id="seed-hl"]'), { timeout: 8000 });
  ok("highlight re-attached after zoom re-render", true);

  // --- keyboard zoom + reset -------------------------------------------------------
  await page.keyboard.press("0"); // zoomReset → fit width
  await sleep(700);
  p1 = await pageBox(1);
  ok("keyboard 0 = fit width", Math.abs(p1.w - scrollW) < 45, `page ${p1.w}px`);
  await page.keyboard.press("+");
  await sleep(500);
  const pctPlus = await page.$eval(".zpct", (el) => parseInt(el.textContent));
  ok("keyboard + zooms", pctPlus > Math.round((100 * (p1.w - 32)) / p1.w) && pctPlus > 0, `${pctPlus}%`);
  await page.keyboard.press("0");
  await sleep(600);

  // --- layouts ----------------------------------------------------------------------
  // Wrapped only puts two pages on a row once they're narrow enough — zoom well out first.
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("-");
    await sleep(60);
  }
  await sleep(600);
  await page.select(".zsel", "wrapped");
  await sleep(900);
  let [t1, t2] = [(await pageBox(1)).top, (await pageBox(2)).top];
  ok("wrapped layout: pages 1+2 share a row", t1 === t2, `tops ${t1} vs ${t2}`);
  await shot(page, "r2-02-wrapped");
  await page.keyboard.press("0");
  await sleep(500);

  await page.select(".zsel", "two-up");
  await sleep(900);
  const spread = await page.$(".pdfViewer .spread");
  [t1, t2] = [(await pageBox(1)).top, (await pageBox(2)).top];
  ok("2-up spread layout", !!spread && t1 === t2, `spread=${!!spread} tops ${t1}/${t2}`);
  await shot(page, "r2-03-twoup");

  await page.select(".zsel", "horizontal");
  await sleep(900);
  const hscroll = await page.$eval(".pdf-scroll", (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  [t1, t2] = [(await pageBox(1)).top, (await pageBox(2)).top];
  ok("horizontal layout scrolls sideways", t1 === t2 && hscroll.sw > hscroll.cw, JSON.stringify({ t1, t2, ...hscroll }));

  await page.select(".zsel", "vertical");
  await sleep(700);

  // --- find via PDFFindController ---------------------------------------------------
  await page.click('button[title*="Find in document"]');
  await page.waitForSelector(".rfind-in", { timeout: 4000 });
  await page.type(".rfind-in", "conscious");
  await sleep(700); // 200ms debounce + controller pass
  const count = await page.$eval(".rfind-count", (el) => el.textContent.trim());
  ok("find reports a match count", /^[1-9]\d*\/[1-9]\d*$/.test(count), count);
  const hlAll = await page.$$eval(".textLayer .highlight", (els) => els.length);
  ok("highlight-all paints matches in the text layer", hlAll >= 2, `${hlAll} painted`);
  ok("active match styled", !!(await page.$(".textLayer .highlight.selected")));
  await page.keyboard.press("Enter"); // next
  await sleep(500);
  const count2 = await page.$eval(".rfind-count", (el) => el.textContent.trim());
  ok("Enter steps to the next match", count2 !== count, `${count} → ${count2}`);
  await shot(page, "r2-04-find");
  await page.keyboard.press("Escape");
  await sleep(300);

  // --- link annotations live ----------------------------------------------------------
  await page.evaluate(() => document.querySelector('.pdf-page[data-page="1"]')?.scrollIntoView());
  await sleep(600);
  const link = await page.$(".annotationLayer a");
  ok("internal link annotation rendered", !!link);
  if (link) {
    await link.click();
    await sleep(900);
    const cur = await page.$eval(".pgin", (el) => el.value);
    ok("clicking the citation link jumps to page 3", cur === "3", `page ${cur}`);
  }
  await shot(page, "r2-05-linked");

  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|highlight|devSeed/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  fails++;
  console.log("FAIL exception:", e.message);
  await shot(page, "r2-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
