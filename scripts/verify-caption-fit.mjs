// Caption editor sizing contract (owner, 2026-08-03): a caption box NEVER
// scrolls — every block grows to fit all of its text — and scrolling happens
// BETWEEN blocks, in a page that is exactly as tall as its figure so it always
// pairs with the connector brace.
//
// This gate pins: the fit invariant, the two-line floor, the death of the old
// 150px block lock, the page's fixed height, wheel routing into the column
// (Canvas.svelte preventDefaults every wheel, so without its escape hatch the
// column could not scroll at all), the growth paths that fire with no input
// event (undo, font-size change), and zoom invariance of the measurement.
//
//   Run (dev server on :1420 must be up): node scripts/verify-caption-fit.mjs
import { launch, gotoApp, clickMode, shot, realErrors } from "./lib/driver.mjs";
import { waitFor, waitForSelector, waitForFrame } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-caption-fit");
const LONG = Array.from({ length: 24 }, (_, i) => `sentence ${i} of the caption`).join(", ") + ".";
// ~4 lines at the default size in the 600px-wide fixture page — comfortably
// past the two-line floor, so a height difference against a one-liner is real.
const MEDIUM =
  "Dorsal CCF distribution of B6 somata (8,760 cells/215 B), colored by IT, CT, " +
  "and PT (ET/PT-like); every panel states its own n and B so no number is ever " +
  "borrowed across panels, and the AP range is given in CCF millimetres.";
const FIG = "growth"; // demo fixture: 600×300, panel labels el-a / el-b

const { browser, page } = await launch({ width: 1600, height: 1000 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fig, null, { label: "dev handle" });

  /** Seed captions and (re)open the editor. captionOpen bypasses Alt+C's
   *  selection guard — CaptionEditor itself only needs an active figure. */
  const open = (caps) =>
    page.evaluate(
      ({ id, caps }) => {
        const F = window.__flux;
        F.fig.commit((p) => {
          const f = p.figures.find((x) => x.id === id);
          f.captions = caps;
        });
        F.fig.activeFigureId.set(id);
        F.fig.captionOpen.set(true);
        F.fig.viewport.set({ zoom: 1, panX: 40, panY: 40 });
      },
      { id: FIG, caps },
    );

  const measure = () =>
    page.evaluate(() => {
      const pg = document.querySelector(".cap-page");
      const col = document.querySelector(".cap-scroll");
      const texts = [...document.querySelectorAll(".cap-text")];
      return {
        blocks: texts.length,
        pageH: pg?.offsetHeight ?? 0,
        colScrollH: col?.scrollHeight ?? 0,
        colClientH: col?.clientHeight ?? 0,
        colOverflow: col ? getComputedStyle(col).overflowY : "",
        fontSize: texts[0] ? parseFloat(getComputedStyle(texts[0]).fontSize) : 0,
        legendSize: parseFloat(getComputedStyle(document.querySelector(".cap-block legend")).fontSize),
        heights: texts.map((t) => t.clientHeight),
        // the invariant: content never exceeds the box
        allFit: texts.every((t) => t.scrollHeight <= t.clientHeight + 1),
        allHidden: texts.every((t) => getComputedStyle(t).overflowY === "hidden"),
        blockMinHeights: [...document.querySelectorAll(".cap-block")].map(
          (b) => getComputedStyle(b).minHeight,
        ),
      };
    });

  // ── the fit invariant ──────────────────────────────────────────────────────
  h.section("captions fit their text");
  await open({ __figure__: MEDIUM, "el-a": "One short line.", "el-b": "" });
  await waitForSelector(page, ".cap-scroll");
  await waitFor(page, () => document.querySelectorAll(".cap-text").length === 3, null, {
    label: "three caption blocks",
  });
  await waitForFrame(page);
  let m = await measure();

  h.ok(m.allFit, "no caption box overflows its own height");
  h.ok(m.allHidden, "every caption box has overflow-y: hidden (no inner scrollbar)");
  h.ok(
    m.heights[0] > m.heights[1] && m.heights[1] >= m.heights[2],
    `block heights track content length (${m.heights.join(" / ")})`,
  );
  const floor = 2.9 * m.fontSize;
  h.ok(
    Math.abs(m.heights[2] - floor) <= 3,
    `an empty block sits at the two-line floor (${m.heights[2]}px vs ${floor.toFixed(1)}px)`,
  );
  h.ok(
    m.blockMinHeights.every((v) => v === "auto" || parseFloat(v) === 0),
    `the old 150px block lock is gone (min-height: ${[...new Set(m.blockMinHeights)].join(", ")})`,
  );

  // ── the page is the figure's height, and scrolls inside it ─────────────────
  h.section("the page is figure-sized and scrolls between blocks");
  const figH = await page.evaluate(
    (id) => window.__flux.get(window.__flux.fig.project).figures.find((f) => f.id === id).height,
    FIG,
  );
  h.eq(m.pageH, figH, `page height equals the figure height (${figH}px) with short captions`);
  // The regression this whole change exists to kill: blocks used to be pinned at
  // 150px each regardless of content, so a one-liner burned the same space as a
  // paragraph. Content-sized blocks must come in well under that old lock.
  const blockTotal = await page.evaluate(() =>
    [...document.querySelectorAll(".cap-block")].reduce((s, b) => s + b.offsetHeight, 0),
  );
  h.ok(
    blockTotal < 3 * 150,
    `three mostly-short blocks cost ${blockTotal}px, not the old 450px lock`,
  );

  await open({ __figure__: LONG, "el-a": LONG, "el-b": "short one." });
  await waitForFrame(page);
  m = await measure();
  h.eq(m.pageH, figH, "page height still equals the figure height with long captions (it never grows)");
  h.ok(m.colScrollH > m.colClientH, "long captions make the column scrollable");
  h.eq(m.colOverflow, "auto", "the column is the scroll container");
  h.ok(m.allFit, "every caption still fits its own box when the column overflows");

  const fades = await page.evaluate(() => ({
    top: !!document.querySelector(".cap-fade.top.on"),
    bottom: !!document.querySelector(".cap-fade.bottom.on"),
  }));
  h.ok(!fades.top && fades.bottom, "at the top of the column only the bottom fade shows");

  // ── the wheel scrolls the column, then chains to a canvas pan ──────────────
  h.section("wheel routing");
  const wheeled = await page.evaluate(() => {
    const F = window.__flux;
    const col = document.querySelector(".cap-scroll");
    const panBefore = F.get(F.fig.viewport).panY;
    col.querySelector(".cap-text").dispatchEvent(
      new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }),
    );
    return { scrollTop: col.scrollTop, panBefore, panAfter: F.get(F.fig.viewport).panY };
  });
  h.ok(wheeled.scrollTop > 0, `a wheel over the column scrolls it (scrollTop ${wheeled.scrollTop})`);
  h.eq(wheeled.panAfter, wheeled.panBefore, "…and does not pan the canvas");

  await waitForFrame(page);
  h.ok(
    await page.evaluate(() => !!document.querySelector(".cap-fade.top.on")),
    "the top fade appears once the column is scrolled",
  );

  const chained = await page.evaluate(() => {
    const F = window.__flux;
    const col = document.querySelector(".cap-scroll");
    col.scrollTop = col.scrollHeight; // clamps to the end
    const panBefore = F.get(F.fig.viewport).panY;
    col.querySelector(".cap-text").dispatchEvent(
      new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }),
    );
    return { panBefore, panAfter: F.get(F.fig.viewport).panY };
  });
  h.ok(chained.panAfter !== chained.panBefore, "a wheel past the end of the column pans the canvas");

  // ── growth paths ──────────────────────────────────────────────────────────
  h.section("growth");
  const typed = await page.evaluate(() => {
    const tas = [...document.querySelectorAll(".cap-text")];
    const t = tas[tas.length - 1];
    t.focus();
    const before = t.clientHeight;
    t.value = "a much longer caption ".repeat(30);
    t.dispatchEvent(new Event("input", { bubbles: true }));
    const grown = t.clientHeight;
    t.value += "\n";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    const withNewline = t.clientHeight;
    t.value = "back to short.";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return { before, grown, withNewline, shrunk: t.clientHeight, fits: t.scrollHeight <= t.clientHeight + 1 };
  });
  h.ok(typed.grown > typed.before, `typing grows the box (${typed.before} → ${typed.grown}px)`);
  h.ok(typed.withNewline > typed.grown, "a trailing newline counts as a line");
  h.ok(typed.shrunk < typed.grown, `deleting shrinks it back (${typed.shrunk}px)`);
  h.ok(typed.fits, "the box still fits after shrinking");

  // The undo/verb path: a model change with NO input event must still refit.
  const external = await page.evaluate(
    ({ id, cap }) => {
      const F = window.__flux;
      const el = document.querySelectorAll(".cap-text")[2];
      const before = el.clientHeight;
      F.fig.commit((p) => {
        p.figures.find((f) => f.id === id).captions["el-b"] = cap;
      });
      return new Promise((r) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            r({ before, after: el.clientHeight, fits: el.scrollHeight <= el.clientHeight + 1 }),
          ),
        ),
      );
    },
    { id: FIG, cap: LONG },
  );
  h.ok(
    external.after > external.before,
    `a store change with no input event refits (${external.before} → ${external.after}px)`,
  );
  h.ok(external.fits, "…and the refit result fits");

  // ── the font-size setting ─────────────────────────────────────────────────
  h.section("caption font size setting");
  h.eq(
    await page.evaluate(() => window.__flux.get(window.__flux.settings).captionFontSize),
    13,
    "captionFontSize defaults to 13",
  );
  await page.evaluate(() =>
    window.__flux.settings.update((s) => ({ ...s, captionFontSize: 22 })),
  );
  await waitForFrame(page);
  const big = await measure();
  h.eq(big.fontSize, 22, "the setting drives the caption font size");
  h.ok(
    Math.abs(big.legendSize - 22 * 1.27) <= 1,
    `the block letter scales with it (${big.legendSize}px)`,
  );
  h.ok(big.allFit, "every caption refits after a font-size change (no box resizes, so nothing else would)");

  await page.evaluate(() =>
    window.__flux.settings.update((s) => ({ ...s, captionFontSize: 13 })),
  );
  await waitForFrame(page);

  // ── zoom invariance ───────────────────────────────────────────────────────
  h.section("zoom invariance");
  const zoomed = await page.evaluate(() => {
    const F = window.__flux;
    const el = document.querySelector(".cap-text");
    const before = el.clientHeight;
    const v = F.get(F.fig.viewport);
    F.fig.viewport.set({ ...v, zoom: 2 });
    return new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r({ before, after: el.clientHeight }))),
    );
  });
  h.eq(zoomed.after, zoomed.before, "zooming does not change the measured height (layout px, not gBCR)");

  await shot(page, "caption-fit");
  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean (${errs.length} errors)${errs.length ? `: ${errs[0]}` : ""}`);
} catch (e) {
  h.fail(`threw: ${e.message}`);
}
await h.done(() => browser.close());
