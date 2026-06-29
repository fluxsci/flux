// Smoke test: prove the Surface-A verification loop works end to end.
import { launch, gotoApp, clickNew, shot, setDoc, errors, sleep } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page);
await shot(page, "smoke-01-home");

const clickedNew = await clickNew(page);
await shot(page, "smoke-02-workspace");

let hasView = false;
try {
  hasView = await page.evaluate(() => !!window.__fluxView);
} catch {}
if (hasView) {
  await setDoc(page, "# Results\n\nSee @fig-growth and [@smith2021].\n");
  await sleep(600);
  await shot(page, "smoke-03-editor");
}

console.log(JSON.stringify({ clickedNew, hasView, errs: errors(page) }, null, 2));
await browser.close();
