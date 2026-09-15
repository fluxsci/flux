// M6: retired property-menu layout keys are DROPPED on load. The legacy
// "forgery*" spellings and the later "fluxFigMenu*" / "xrayPos" (+ xrayDx/Dy)
// keys are all deleted by settings.migrate() (2026-09-15 surface redesign: the
// property menu and the X-ray anchor themselves beside the selection, so none
// of those preferences exist any more) while an unrelated key written
// alongside them survives untouched.
import { launch, gotoApp, sleep } from "./lib/driver.mjs";

const RETIRED = [
  "forgerySize", "forgeryPos", "forgeryAnim", "forgeryOpacity",
  "fluxFigMenuSize", "fluxFigMenuPos", "fluxFigMenuDx", "fluxFigMenuDy",
  "fluxFigMenuAnim", "fluxFigMenuOpacity", "xrayPos", "xrayDx", "xrayDy",
];

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
      fluxFigMenuSize: "lg",
      fluxFigMenuPos: "left",
      fluxFigMenuDx: 12,
      fluxFigMenuDy: -4,
      fluxFigMenuAnim: "fade",
      fluxFigMenuOpacity: 0.7,
      xrayPos: "below",
      xrayDx: 3,
      xrayDy: -3,
      gridSize: 12,
      flexokiDefault: true,
    })
  )
);
await page.reload({ waitUntil: "networkidle0" });
await sleep(800);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.settings") || "{}"));
const leaked = RETIRED.filter((k) => k in after);
const ok = leaked.length === 0 && after.gridSize === 12 && after.flexokiDefault === true;
console.log(JSON.stringify({ migratedOK: ok, leaked, after }, null, 2));
await browser.close();
process.exitCode = ok ? 0 : 1;
