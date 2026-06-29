// M1: new figures land directly below the active one, left-aligned, consistent size.
import { launch, gotoApp, clickNew, clickMode, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await clickMode(page, "Figure");
await sleep(500);

const read = () =>
  page.evaluate(() =>
    (window.__flux?.figures() || []).map((f) => ({
      name: f.name,
      x: f.x,
      y: f.y,
      w: f.width,
      h: f.height,
    }))
  );

const hasHandle = await page.evaluate(() => !!window.__flux);
const before = await read();

const addFigure = () =>
  page.evaluate(() =>
    document.querySelector('button[title="Add figure"]')?.click()
  );
await addFigure();
await sleep(200);
await addFigure();
await sleep(200);
const after = await read();

// Assertions: all same size; each subsequent figure strictly below the prior; x aligned.
const allSameSize = after.every((f) => f.w === 816 && f.h === 1056);
const stackedBelow = after.every((f, i) => i === 0 || f.y > after[i - 1].y + after[i - 1].h - 1);
const leftAligned = after.every((f) => f.x === after[0].x);

console.log(
  JSON.stringify(
    { hasHandle, before, after, allSameSize, stackedBelow, leftAligned, errs: errors(page) },
    null,
    2
  )
);
await browser.close();
