// R2 — FluxReader viewer core on pdf.js PDFViewer (legacy build), against :1420.
// Exercises what the core swap bought: fit-width default, ctrl+wheel zoom anchored at
// the cursor, multiplicative zoom buttons + keyboard, wrapped/2-up/horizontal layouts,
// find via PDFFindController (highlight-all + active match), and live link
// annotations (internal dest click → page 3). Run: node scripts/verify-r2-viewer.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, waitFor } from "./lib/driver.mjs";

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
  await waitFor(
    page,
    () => {
      const pct = parseInt(document.querySelector(".zpct")?.textContent ?? "");
      return !!document.querySelector('.pdf-page[data-page="1"]') && Number.isFinite(pct) && pct > 0;
    },
    null,
    { timeout: 8000, label: "viewer ready (page 1 box + scale readout)" },
  );

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
  const renderedBefore = await page.$eval('[data-testid="pdf-root"]', (el) => Number(el.dataset.rendered));
  await wheelTick(anchor);
  // spaced ticks: the second must see the viewer's post-first-tick location — scale readout
  // moved AND the anchor scroll correction landed (scroll stable across two polls)
  await waitFor(
    page,
    (p0) => {
      const pct = parseInt(document.querySelector(".zpct")?.textContent ?? "");
      if (!(pct > p0)) return false;
      const sc = document.querySelector(".pdf-scroll");
      const k = `${sc.scrollLeft},${sc.scrollTop}`;
      const same = window.__r2ScrollKey === k;
      window.__r2ScrollKey = k;
      return same;
    },
    pctBefore,
    { interval: 80, label: "first wheel tick applied + scroll settled" },
  );
  await wheelTick(anchor);
  // re-raster settled (drawingDelay 400 is inside this): page grew past fit-width, a new
  // page render landed, and the anchor span's measured box is STABLE across two polls
  // (the text layer re-attach + scroll correction are done — the old 1100ms in conditions)
  await waitFor(
    page,
    ({ minW, r0 }) => {
      const root = document.querySelector('[data-testid="pdf-root"]');
      const pg = document.querySelector('.pdf-page[data-page="1"]');
      if (!root || !pg || Number(root.dataset.rendered) <= r0) return false;
      if (pg.getBoundingClientRect().width <= minW) return false;
      const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) =>
        (s.textContent || "").includes("special affinity"),
      );
      // during the CSS-zoom phase the text layer is hidden (span box collapses to 0):
      // the anchor is only measurable once the re-rastered layer is back with real boxes
      const r = span?.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) {
        window.__r2SpanKey = null;
        return false;
      }
      const k = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`;
      const same = window.__r2SpanKey === k;
      window.__r2SpanKey = k;
      return same;
    },
    { minW: scrollW * 1.1, r0: renderedBefore },
    { interval: 120, timeout: 10000, label: "ctrl+wheel zoom re-rendered (raster + stable text layer)" },
  );
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
  const waitFitWidth = () =>
    waitFor(
      page,
      (sw) => {
        const w = document.querySelector('.pdf-page[data-page="1"]')?.getBoundingClientRect().width ?? 0;
        return Math.abs(w - sw) < 45;
      },
      scrollW,
      { timeout: 8000, label: "fit-width restored" },
    );
  await page.keyboard.press("0"); // zoomReset → fit width
  await waitFitWidth();
  p1 = await pageBox(1);
  ok("keyboard 0 = fit width", Math.abs(p1.w - scrollW) < 45, `page ${p1.w}px`);
  const pctFit = await page.$eval(".zpct", (el) => parseInt(el.textContent));
  await page.keyboard.press("+");
  await waitFor(page, (p0) => parseInt(document.querySelector(".zpct")?.textContent ?? "") > p0, pctFit, {
    label: "keyboard + raised the scale readout",
  });
  const pctPlus = await page.$eval(".zpct", (el) => parseInt(el.textContent));
  ok("keyboard + zooms", pctPlus > Math.round((100 * (p1.w - 32)) / p1.w) && pctPlus > 0, `${pctPlus}%`);
  await page.keyboard.press("0");
  await waitFitWidth();

  // --- layouts ----------------------------------------------------------------------
  // Wrapped only puts two pages on a row once they're narrow enough — zoom well out first.
  for (let i = 0; i < 9; i++) {
    const zPrev = await page.$eval(".zpct", (el) => parseInt(el.textContent));
    await page.keyboard.press("-");
    await waitFor(page, (p0) => parseInt(document.querySelector(".zpct")?.textContent ?? "") < p0, zPrev, {
      label: `zoom-out step ${i + 1} applied`,
    });
  }
  await waitFor(
    page,
    () => {
      const scroll = document.querySelector(".pdf-scroll");
      const w = document.querySelector('.pdf-page[data-page="1"]')?.getBoundingClientRect().width ?? Infinity;
      return !!scroll && 2 * w + 24 < scroll.clientWidth;
    },
    null,
    { timeout: 8000, label: "pages narrow enough for two per row" },
  );
  // in-page pred: pages 1+2 share a row (serialized into the page by waitFor)
  const sameRow = () => {
    const pa = document.querySelector('.pdf-page[data-page="1"]');
    const pb = document.querySelector('.pdf-page[data-page="2"]');
    return !!pa && !!pb && pa.offsetTop === pb.offsetTop;
  };
  await page.select(".zsel", "wrapped");
  await waitFor(page, sameRow, null, { timeout: 8000, label: "wrapped: pages 1+2 share a row" }).catch(() => {});
  let [t1, t2] = [(await pageBox(1)).top, (await pageBox(2)).top];
  ok("wrapped layout: pages 1+2 share a row", t1 === t2, `tops ${t1} vs ${t2}`);
  await shot(page, "r2-02-wrapped");
  const zWrapped = await page.$eval(".zpct", (el) => parseInt(el.textContent));
  await page.keyboard.press("0");
  await waitFor(page, (p0) => parseInt(document.querySelector(".zpct")?.textContent ?? "") !== p0, zWrapped, {
    label: "zoom reset applied in wrapped layout",
  });

  await page.select(".zsel", "two-up");
  await waitFor(page, () => !!document.querySelector(".pdfViewer .spread"), null, {
    timeout: 8000,
    label: "2-up spread mounted",
  }).catch(() => {});
  await waitFor(page, sameRow, null, { timeout: 8000, label: "2-up: pages 1+2 share a row" }).catch(() => {});
  const spread = await page.$(".pdfViewer .spread");
  [t1, t2] = [(await pageBox(1)).top, (await pageBox(2)).top];
  ok("2-up spread layout", !!spread && t1 === t2, `spread=${!!spread} tops ${t1}/${t2}`);
  await shot(page, "r2-03-twoup");

  await page.select(".zsel", "horizontal");
  await waitFor(
    page,
    () => {
      const el = document.querySelector(".pdf-scroll");
      const pa = document.querySelector('.pdf-page[data-page="1"]');
      const pb = document.querySelector('.pdf-page[data-page="2"]');
      return !!el && !!pa && !!pb && pa.offsetTop === pb.offsetTop && el.scrollWidth > el.clientWidth;
    },
    null,
    { timeout: 8000, label: "horizontal layout scrolls sideways" },
  ).catch(() => {});
  const hscroll = await page.$eval(".pdf-scroll", (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  [t1, t2] = [(await pageBox(1)).top, (await pageBox(2)).top];
  ok("horizontal layout scrolls sideways", t1 === t2 && hscroll.sw > hscroll.cw, JSON.stringify({ t1, t2, ...hscroll }));

  await page.select(".zsel", "vertical");
  await waitFor(
    page,
    () => {
      const pa = document.querySelector('.pdf-page[data-page="1"]');
      const pb = document.querySelector('.pdf-page[data-page="2"]');
      return !!pa && !!pb && pb.offsetTop > pa.offsetTop;
    },
    null,
    { timeout: 8000, label: "vertical layout restored (pages stacked)" },
  );

  // --- find via PDFFindController (now driven from the left rail's Search pane) ------
  await page.keyboard.down("Control");
  await page.keyboard.press("f");
  await page.keyboard.up("Control");
  await page.waitForSelector(".srchin", { timeout: 4000 });
  await page.type(".srchin", "conscious");
  // 200ms input debounce + controller pass end in a painted count + highlights
  await waitFor(
    page,
    () => {
      const c = document.querySelector(".srchcount")?.textContent?.trim() ?? "";
      return (
        /^\d+ of [1-9]\d*$/.test(c) &&
        document.querySelectorAll(".textLayer .highlight").length >= 2 &&
        !!document.querySelector(".textLayer .highlight.selected")
      );
    },
    null,
    { timeout: 8000, label: "find results painted (count + highlights + active)" },
  ).catch(() => {});
  const count = await page.$eval(".srchcount", (el) => el.textContent.trim());
  ok("find reports a match count", /^\d+ of [1-9]\d*$/.test(count), count);
  const hlAll = await page.$$eval(".textLayer .highlight", (els) => els.length);
  ok("highlight-all paints matches in the text layer", hlAll >= 2, `${hlAll} painted`);
  ok("active match styled", !!(await page.$(".textLayer .highlight.selected")));
  const rows = await page.$$eval(".hit", (els) => els.length);
  ok("the pane lists every match as a result row", rows >= 2, `${rows} rows`);
  await page.keyboard.press("Enter"); // next
  await waitFor(page, (c0) => (document.querySelector(".srchcount")?.textContent?.trim() ?? "") !== c0, count, {
    label: "find stepped to the next match",
  }).catch(() => {});
  const count2 = await page.$eval(".srchcount", (el) => el.textContent.trim());
  ok("Enter steps to the next match", count2 !== count, `${count} → ${count2}`);
  await shot(page, "r2-04-find");
  await page.keyboard.press("Escape"); // clears the query, keeps the pane
  await waitFor(page, () => (document.querySelector(".srchin")?.value ?? "x") === "", null, {
    timeout: 4000,
    label: "Escape clears the search",
  }).catch(() => {});
  ok("Escape clears the query but keeps the Search pane", !!(await page.$(".srchin")));

  // --- link annotations live ----------------------------------------------------------
  await page.evaluate(() => document.querySelector('.pdf-page[data-page="1"]')?.scrollIntoView());
  await waitFor(page, () => !!document.querySelector(".annotationLayer a"), null, {
    timeout: 8000,
    label: "link annotation rendered",
  }).catch(() => {});
  const link = await page.$(".annotationLayer a");
  ok("internal link annotation rendered", !!link);
  if (link) {
    await link.click();
    await waitFor(page, () => document.querySelector(".pgin")?.value === "3", null, {
      timeout: 8000,
      label: "jumped to page 3",
    }).catch(() => {});
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
