// M6 runtime check: draw an element, select it, press F → FluxFig Menu opens.
import { launch, gotoApp, clickNew, clickMode, shot, errors, sleep } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await clickMode(page, "Figure");
await sleep(500);

// Pick the Rect tool, then drag a rectangle inside Figure 1 (~x400-888, y185-820).
await page.evaluate(() =>
  [...document.querySelectorAll("button[title]")]
    .find((b) => /^Rect/.test(b.getAttribute("title") || ""))
    ?.click()
);
await sleep(200);
await page.mouse.move(520, 320);
await page.mouse.down();
await page.mouse.move(700, 480, { steps: 12 });
await page.mouse.up();
await sleep(400);
await shot(page, "menu-01-rect");

const afterDraw = await page.evaluate(() => ({
  selBox: !!document.querySelector(".sel-box"),
  elementsText: (document.querySelector('[class*="layer"]')?.closest("aside,div")?.textContent || "").includes("No elements yet")
    ? "No elements yet"
    : "has elements",
}));

// Press F to open the FluxFig Menu (formerly "Forgery").
await page.keyboard.press("f");
await sleep(500);
await shot(page, "menu-02-fkey");
const menu = await page.evaluate(() => {
  const el = document.querySelector(".fluxFigMenu");
  return { hasMenu: !!el, menuText: (el?.textContent || "").trim().slice(0, 80) };
});

console.log(JSON.stringify({ afterDraw, menu, errs: errors(page) }, null, 2));
await browser.close();
