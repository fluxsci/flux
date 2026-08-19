// Clicking a figure name in the sidebar goes to that figure: it becomes active
// AND the view centres on it, at whatever zoom the user is already working at
// (owner, 2026-08-03 — zoom is the user's choice, the click is "take me there",
// not "reframe everything").
//
// Pins: centring is exact in world→screen terms at several zooms, zoom is
// untouched, a re-click of the already-active figure re-centres (the store's
// same-value set does not notify, so this only works as a direct call), the
// ruler strips are excluded from the centring box, and a figure larger than the
// viewport still centres rather than being zoomed to fit.
//
//   Run (dev server on :1420 must be up): node scripts/verify-figure-center.mjs
import { launch, gotoApp, clickMode, shot, realErrors } from "./lib/driver.mjs";
import { waitFor, waitForFrame } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-figure-center");

const { browser, page } = await launch({ width: 1600, height: 1000 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fig, null, { label: "dev handle" });

  // Two figures far apart on one canvas, so "centred" is unambiguous and the
  // second is nowhere near the first's framing.
  await page.evaluate(() => {
    const F = window.__flux;
    F.fig.commit((p) => {
      const a = p.figures[0];
      a.name = "Alpha";
      a.x = 0;
      a.y = 0;
      a.width = 600;
      a.height = 300;
      p.figures.push({
        ...JSON.parse(JSON.stringify(a)),
        id: "beta",
        name: "Beta",
        x: 2600,
        y: 1800,
        width: 900,
        height: 700,
        elements: [],
        captions: {},
      });
    });
    F.fig.activeFigureId.set(p_id());
    function p_id() {
      return window.__flux.get(window.__flux.fig.project).figures[0].id;
    }
  });
  await waitForFrame(page);

  // Match the row's NAME text node, not its textContent: since figure families
  // landed (2026-08-04) a row also renders a dim nickname span inside the same
  // button ("AlphaGrowth curves"), so an exact textContent match found nothing.
  const clickFigure = (name) =>
    page.evaluate((n) => {
      const btn = [...document.querySelectorAll("button.item")].find(
        (b) => (b.childNodes[0]?.textContent || "").trim() === n,
      );
      if (!btn) throw new Error(`no sidebar row named ${n}`);
      btn.click();
    }, name);

  /** Where does the figure's world-space centre land on screen, and where is the
   *  centre of the canvas's usable box? Equal ⇒ centred. */
  const centreError = () =>
    page.evaluate(() => {
      const F = window.__flux;
      const v = F.get(F.fig.viewport);
      const box = F.get(F.fig.canvasBox);
      const f = F.get(F.fig.project).figures.find((x) => x.id === F.get(F.fig.activeFigureId));
      const screenX = v.panX + (f.x + f.width / 2) * v.zoom;
      const screenY = v.panY + (f.y + f.height / 2) * v.zoom;
      return {
        dx: screenX - (box.x + box.w / 2),
        dy: screenY - (box.y + box.h / 2),
        zoom: v.zoom,
        box,
        figure: f.name,
      };
    });

  h.section("centring at the user's zoom");
  for (const zoom of [0.35, 1, 2.5]) {
    await page.evaluate((z) => {
      const F = window.__flux;
      // park the view somewhere unrelated first, so a pass means it MOVED here
      F.fig.viewport.set({ zoom: z, panX: -4000, panY: -3000 });
    }, zoom);
    await clickFigure("Beta");
    await waitForFrame(page);
    const e = await centreError();
    h.ok(
      Math.abs(e.dx) < 1 && Math.abs(e.dy) < 1,
      `zoom ${zoom}: Beta is centred (off by ${e.dx.toFixed(2)}, ${e.dy.toFixed(2)} px)`,
    );
    h.eq(e.zoom, zoom, `zoom ${zoom}: the user's zoom is untouched`);
  }

  h.section("activation and re-click");
  await clickFigure("Alpha");
  await waitForFrame(page);
  h.eq(
    await page.evaluate(() => window.__flux.get(window.__flux.fig.activeFigureId)),
    await page.evaluate(() => window.__flux.get(window.__flux.fig.project).figures[0].id),
    "clicking a name activates that figure",
  );
  let e = await centreError();
  h.ok(Math.abs(e.dx) < 1 && Math.abs(e.dy) < 1, "…and centres it");

  // Re-clicking the ALREADY-active row must still recentre: activeFigureId is a
  // plain writable, so a same-value set notifies nobody — this passes only if
  // the centring is a direct call rather than a store subscriber.
  await page.evaluate(() => {
    const v = window.__flux.get(window.__flux.fig.viewport);
    window.__flux.fig.viewport.set({ ...v, panX: v.panX - 900, panY: v.panY + 700 });
  });
  await waitForFrame(page);
  const strayed = await centreError();
  h.ok(Math.abs(strayed.dx) > 100, "panning away de-centres it (control)");
  await clickFigure("Alpha");
  await waitForFrame(page);
  e = await centreError();
  h.ok(
    Math.abs(e.dx) < 1 && Math.abs(e.dy) < 1,
    "re-clicking the active row re-centres it (a 'put me back' button)",
  );

  h.section("a figure larger than the viewport still centres");
  await page.evaluate(() => {
    const F = window.__flux;
    F.fig.commit((p) => {
      const f = p.figures.find((x) => x.id === "beta");
      f.width = 6000;
      f.height = 4000;
    });
    F.fig.viewport.set({ zoom: 1, panX: 0, panY: 0 });
  });
  await clickFigure("Beta");
  await waitForFrame(page);
  e = await centreError();
  h.ok(
    Math.abs(e.dx) < 1 && Math.abs(e.dy) < 1,
    "an oversized figure centres (overflowing evenly) instead of zooming to fit",
  );
  h.eq(e.zoom, 1, "…still without changing zoom");

  h.section("rulers shrink the centring box");
  const withRulers = await page.evaluate(async () => {
    const F = window.__flux;
    const before = F.get(F.fig.canvasBox);
    F.settings.update((s) => ({ ...s, showRulers: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { before, after: F.get(F.fig.canvasBox) };
  });
  h.ok(
    withRulers.after.x > withRulers.before.x && withRulers.after.w < withRulers.before.w,
    `the box insets for the ruler strips (x ${withRulers.before.x}→${withRulers.after.x}, w ${withRulers.before.w}→${withRulers.after.w})`,
  );
  await clickFigure("Alpha");
  await waitForFrame(page);
  e = await centreError();
  h.ok(
    Math.abs(e.dx) < 1 && Math.abs(e.dy) < 1,
    "centring stays exact against the inset box with rulers on",
  );
  await page.evaluate(() => window.__flux.settings.update((s) => ({ ...s, showRulers: false })));

  h.section("it is a view move, not an edit");
  const clean = await page.evaluate(async () => {
    const F = window.__flux;
    const before = F.get(F.fig.dirty);
    const btn = [...document.querySelectorAll("button.item")].find(
      (b) => (b.childNodes[0]?.textContent || "").trim() === "Beta",
    );
    btn.click();
    await new Promise((r) => requestAnimationFrame(r));
    return { before, after: F.get(F.fig.dirty) };
  });
  h.eq(clean.after, clean.before, "centring never dirties the project (no model write)");

  await shot(page, "figure-center");
  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean (${errs.length} errors)${errs.length ? `: ${errs[0]}` : ""}`);
} catch (e) {
  h.fail(`threw: ${e.message}`);
}
await h.done(() => browser.close());
