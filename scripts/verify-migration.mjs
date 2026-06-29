// M6: legacy "forgery*" settings keys must migrate to "fluxFigMenu*" on load.
import { launch, gotoApp, sleep } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page);
await page.evaluate(() =>
  localStorage.setItem(
    "flux.settings",
    JSON.stringify({
      forgerySize: "lg",
      forgeryPos: "left",
      forgeryAnim: "fade",
      forgeryOpacity: 0.7,
      flexokiDefault: true,
    })
  )
);
await page.reload({ waitUntil: "networkidle0" });
await sleep(800);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.settings") || "{}"));
const ok =
  after.fluxFigMenuSize === "lg" &&
  after.fluxFigMenuPos === "left" &&
  after.fluxFigMenuAnim === "fade" &&
  after.fluxFigMenuOpacity === 0.7 &&
  !("forgerySize" in after);
console.log(JSON.stringify({ migratedOK: ok, after }, null, 2));
await browser.close();
