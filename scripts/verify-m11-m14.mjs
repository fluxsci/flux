// M11 (inline rename, no window.prompt) + M14 (order-derived figure numbers).
// Drives the real handlers via synthetic DOM events (dblclick→startRename,
// input→editVal binding, Enter/Escape→commit/cancel) to avoid puppeteer's
// multi-mouseup focus race on the appearing input.
import { launch, gotoApp, clickMode, shot, sleep, errors } from "./lib/driver.mjs";

const FIG = ".sidebar section:nth-of-type(2)";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure").catch(() => {});
await sleep(600);

await page.evaluate(() => {
  window.__promptCalled = false;
  window.prompt = () => {
    window.__promptCalled = true;
    return null;
  };
});

const items = () => page.$$eval(`${FIG} .item`, (els) => els.map((e) => e.textContent.trim()));
async function rename(value, commitKey) {
  await page.evaluate((sel) => {
    document.querySelector(sel).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }, `${FIG} li .item`);
  await sleep(150);
  const appeared = (await page.$(".sidebar .rename")) != null;
  await page.evaluate(
    ({ v, k }) => {
      const el = document.querySelector(".sidebar .rename");
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    },
    { v: value, k: commitKey },
  );
  await sleep(250);
  return appeared;
}

const badges = await page.$$eval(`${FIG} .fnum`, (els) => els.map((e) => e.textContent.trim()));
const before = await items();
const inputAppeared = await rename("Renamed Inline", "Enter");
const after = await items();
const nameBefore = (await items())[0];
await rename("SHOULD NOT STICK", "Escape");
const nameAfter = (await items())[0];

await shot(page, "m11-m14-inline-rename");
console.log(
  JSON.stringify(
    {
      m14_numberBadges: badges,
      m11_inputAppeared: inputAppeared,
      m11_before: before,
      m11_after: after,
      m11_renameStuck: after.includes("Renamed Inline"),
      m11_escCancelled: nameBefore === nameAfter && !nameAfter.includes("SHOULD NOT STICK"),
      m11_noNativePrompt: await page.evaluate(() => window.__promptCalled !== true),
      errs: errors(page),
    },
    null,
    2,
  ),
);
await browser.close();
