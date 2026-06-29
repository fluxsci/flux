// Verify Figure mode mounts (exercises the renamed FluxFigMenu component, M6).
import { launch, gotoApp, clickNew, clickMode, shot, errors, sleep } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
const switched = await clickMode(page, "Figure");
await sleep(700);
await shot(page, "fig-10-figure-mode");

const info = await page.evaluate(() => ({
  figureLabels: document.querySelectorAll(".figure-label").length,
  toolbarButtons: [...document.querySelectorAll("button[title]")]
    .map((b) => b.getAttribute("title"))
    .filter(Boolean)
    .slice(0, 40),
  hasFluxFigMenuClass: !!document.querySelector(".fluxFigMenu"),
}));

console.log(JSON.stringify({ switched, info, errs: errors(page) }, null, 2));
await browser.close();
