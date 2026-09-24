// Slide Export offers HTML and PDF; Content scale says when it cannot act
// (2026-09-24, owner requests) — the GUI half of verify-slide-pdf.
//
//   • Slide mode's Export button opens a menu with the interactive HTML and the
//     two PDF plans (one page per slide, one per build step); Escape and an
//     outside click close it. (Printing needs the desktop app's print worker, so
//     the PDF itself is checked by verify-slide-pdf and the native probe.)
//   • A placed graphic with no text or strokes (a PNG wrapped in SVG, like the
//     owner's poster icons) shows why content scale does nothing and offers to
//     clear an unused value, instead of a field that silently has no effect; a
//     real plot keeps the Content scale field.
import { launch, gotoApp, clickMode, realErrors, sleep, waitFor } from "./lib/driver.mjs";
import { readFileSync } from "node:fs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const PLOT_SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const PLOT_MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PICTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="84" height="56" viewBox="0 0 84 56"><image width="84" height="56" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="/></svg>`;

const { browser, page } = await launch({ width: 1600, height: 1000 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });

  // ---- content scale applicability (Figure mode) ------------------------------
  await clickMode(page, "Figure", { settle: 800 });
  await page.evaluate((plotSvg, manifest, pictureSvg) => {
    const F = window.__flux.fig;
    window.__flux.io.reimportPlot("cs-plot", plotSvg, manifest);
    window.__flux.io.reimportPlot("cs-picture", pictureSvg);
    F.commit((p) => {
      p.assets.push({ id: "cs-plot", name: "plot.svg", kind: "svg", path: "assets/cs-plot.svg", naturalWidth: 672, naturalHeight: 480 },
        { id: "cs-picture", name: "picture.svg", kind: "svg", path: "assets/cs-picture.svg", naturalWidth: 84, naturalHeight: 56 });
      p.figures[0].elements.push(
        { type: "plot", id: "real-plot", x: 40, y: 40, width: 336, height: 240, rotation: 0, assetId: "cs-plot", overrides: {} },
        { type: "plot", id: "picture", x: 420, y: 40, width: 84, height: 56, rotation: 0, assetId: "cs-picture", overrides: {}, contentScale: 3 });
    });
    F.selectOnly("picture");
  }, PLOT_SVG, PLOT_MANIFEST, PICTURE_SVG);
  await sleep(500);
  const scaleUi = () => page.evaluate(() => ({
    field: [...document.querySelectorAll(".inspector input")].some((i) => (i.closest("div")?.textContent ?? "").includes("Content scale")),
    note: document.querySelector("[data-content-scale-na]")?.textContent.trim() ?? null,
  }));
  let ui = await scaleUi();
  assert(!ui.field && /No text or strokes to scale/.test(ui.note ?? ""), `a picture-only graphic explains that content scale cannot act (${JSON.stringify(ui)})`);
  assert(/Clear 3×/.test(ui.note ?? ""), "...and offers to clear the unused value it carries");
  await page.evaluate(() => [...document.querySelectorAll("[data-content-scale-na] button")][0]?.click());
  await sleep(250);
  assert(await page.evaluate(() => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "picture")?.contentScale === undefined),
    "Clear removes the unused content scale");
  await page.evaluate(() => window.__flux.fig.selectOnly("real-plot"));
  await sleep(300);
  ui = await scaleUi();
  assert(ui.field && ui.note === null, `a real plot keeps the Content scale field (${JSON.stringify(ui)})`);

  // ---- Slide mode: the Export menu --------------------------------------------
  await clickMode(page, "Slide", { settle: 800 });
  await waitFor(page, () => !!window.__flux?.slide.currentDeck(), null, { label: "slide editor" });
  await waitFor(page, () => !!document.querySelector(".export-btn"), null, { label: "export button" });
  const enabled = await page.evaluate(() => !document.querySelector(".export-btn").disabled);
  if (enabled) {
    await page.click(".export-btn");
    await sleep(150);
    const items = await page.evaluate(() => [...document.querySelectorAll(".export-menu [data-export]")].map((b) => b.getAttribute("data-export")));
    assert(JSON.stringify(items) === JSON.stringify(["html", "pdf", "pdf-steps", "pptx"]), `Export offers HTML, PDF, PDF per step and PowerPoint (${JSON.stringify(items)})`);
    await page.keyboard.press("Escape");
    await page.focus(".export-menu").catch(() => {});
    await page.evaluate(() => document.querySelector(".export-menu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await sleep(150);
    assert(await page.evaluate(() => !document.querySelector(".export-menu")), "Escape closes the menu");
    await page.click(".export-btn");
    await sleep(150);
    await page.mouse.click(700, 500);
    await sleep(150);
    assert(await page.evaluate(() => !document.querySelector(".export-menu")), "a click elsewhere closes the menu");
  } else {
    // A browser fixture has no desktop print or export bridge: the button says so.
    const title = await page.evaluate(() => document.querySelector(".export-btn").getAttribute("title"));
    assert(/desktop app/.test(title ?? ""), `without the desktop bridges Export is disabled and says why (${title})`);
  }

  const errs = realErrors(page);
  assert(errs.length === 0, `no renderer errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}
console.log(fails === 0 ? "\nSLIDE EXPORT MENU: ALL PASS" : `\nSLIDE EXPORT MENU: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
