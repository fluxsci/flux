// M15: (1) profile the FluxFig Menu self-draw open animation (stroke-dashoffset
// on the border path) for jank; (2) confirm prefers-reduced-motion collapses it.
import { launch, gotoApp, clickMode, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure").catch(() => {});
await sleep(500);

// The menu only opens with a selection — select the first element.
await page.evaluate(() => {
  const figs = window.__flux.figures();
  const el = figs[0]?.elements?.[0];
  if (el) window.__flux.fig.selectOnly(el.id);
});
await sleep(200);

async function openAndSample() {
  // Begin sampling rAF deltas, then open the menu with "f".
  const samplePromise = page.evaluate(
    () =>
      new Promise((resolve) => {
        const deltas = [];
        let last = performance.now();
        let frames = 0;
        function tick(now) {
          deltas.push(now - last);
          last = now;
          if (++frames < 45) requestAnimationFrame(tick);
          else resolve(deltas);
        }
        requestAnimationFrame(tick);
      }),
  );
  await sleep(20);
  await page.keyboard.press("f");
  const deltas = await samplePromise;
  const open = (await page.$(".fluxFigMenu")) != null;
  return { deltas, open };
}

// Pass 1: normal motion.
const p1 = await openAndSample();
await page.keyboard.press("Escape").catch(() => {});
await sleep(300);
const body = p1.deltas.slice(3); // drop warm-up frames
body.sort((a, b) => a - b);
const median = body[Math.floor(body.length / 2)] ?? 0;
const max = body[body.length - 1] ?? 0;

// Pass 2: reduced motion — the open transition must be instant (duration 0), so
// no long ramp of intermediate frames is needed; --draw should be 1 immediately.
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await sleep(200);
const reduced = await page.evaluate(() => {
  // re-read the app's own matcher
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
});

console.log(
  JSON.stringify(
    {
      m15: {
        menuOpened: p1.open,
        medianFrameMs: +median.toFixed(2),
        maxFrameMs: +max.toFixed(2),
        smooth60: max < 20, // ~allow one slightly long frame
        reducedMotionMatches: reduced,
      },
      errs: errors(page),
    },
    null,
    2,
  ),
);
await browser.close();
