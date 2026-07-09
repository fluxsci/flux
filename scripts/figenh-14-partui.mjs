// figure-v1 Phase 2 — part properties GUI: a drilled plot part gets the
// kind-aware FluxFig Menu ('f' on a selected tick label shows TEXT fields), a
// colour change drills to the live <text> drawable AND persists as an id-keyed
// override, and the Inspector's Plot-part section is label + breadcrumb +
// "Show properties" (the dead Colour input is gone).
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PART = "axis.x.ticklabel.2";

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed a semantic plot: cache the fluxplot fixture, place it at viewBox size
  // (1 client px == 1 plot unit at zoom 1) and select it.
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("part-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 900;
        g.height = 620;
        g.elements = [];
        g.elements.push({
          type: "plot",
          id: "plot1",
          x: 40,
          y: 40,
          width: 504,
          height: 360,
          rotation: 0,
          assetId: "part-asset",
          overrides: {},
        });
      });
      F.selectOnly("plot1");
      F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
    },
    SVG,
    MANIFEST,
  );
  await sleep(400);

  assert(
    await page.evaluate((part) => !!document.getElementById(`plot1__${part}`), PART),
    "plot mounted inline (prefixed part ids live in the DOM)",
  );

  // Drill the tick label via the store (the real-click path is figenh-15's job).
  await page.evaluate((part) => window.__flux.fig.partSelection.set({ elementId: "plot1", partId: part }), PART);
  await sleep(250);

  // ---- Inspector: label + breadcrumb + Show properties, NO colour input ----
  const insp = await page.evaluate(() => {
    const sec = document.querySelector(".inspector section.part");
    if (!sec) return null;
    return {
      text: sec.textContent ?? "",
      colorInputs: sec.querySelectorAll('input[type="color"]').length,
      inputs: sec.querySelectorAll("input").length,
      showProps: [...sec.querySelectorAll("button")].some((b) => /show properties/i.test(b.textContent ?? "")),
    };
  });
  assert(insp, "Inspector shows the Plot part section");
  assert(insp && /Tick label 2/.test(insp.text), `part LABEL is humanized (${insp?.text.slice(0, 60)}…)`);
  assert(insp && /X axis\s*›\s*Tick labels/.test(insp.text), "hierarchy BREADCRUMB present (… › X axis › Tick labels › …)");
  assert(insp && insp.showProps, "Show properties button present");
  assert(insp && insp.colorInputs === 0 && insp.inputs === 0, "NO colour (or any) input in the plot-part section");
  await shot(page, "figenh14-01-inspector");

  // The button opens the FluxFig Menu
  await page.evaluate(() => {
    const sec = document.querySelector(".inspector section.part");
    const b = [...sec.querySelectorAll("button")].find((x) => /show properties/i.test(x.textContent ?? ""));
    b.click();
  });
  await sleep(350);
  assert(await page.evaluate(() => !!document.querySelector(".fluxFigMenu")), "Show properties opens the FluxFig Menu");
  await page.keyboard.press("Escape");
  await sleep(250);

  // ---- 'f' → TEXT-kind part fields ----
  await page.keyboard.press("f");
  await sleep(400);
  const menu = await page.evaluate(() => {
    const m = document.querySelector(".fluxFigMenu");
    if (!m) return null;
    const labels = [...m.querySelectorAll(".field .label")].map((l) => (l.textContent ?? "").trim());
    return { labels };
  });
  assert(menu, "'f' opens the FluxFig Menu with a part drilled");
  const has = (s) => menu && menu.labels.some((l) => l === s);
  assert(has("size") && has("weight") && has("font"), `TEXT-kind fields shown (${menu?.labels.join(", ")})`);
  assert(has("text colour") && has("visible") && has("dx (plot units)") && has("dy (plot units)") && has("opacity"), "colour/visible/dx/dy/opacity part fields shown");
  assert(menu && !menu.labels.includes("x position"), "element geometry fields are NOT shown for a part");
  await shot(page, "figenh14-02-menu");

  // ---- colour change through the menu's ColorSearch (retargets to the part) ----
  await page.keyboard.press("c");
  await sleep(300);
  assert(await page.evaluate(() => !!document.querySelector(".fluxFigMenu .cs")), "colour field opens ColorSearch");
  // expand the full picker and type a hex (liveHex applies immediately)
  await page.evaluate(() => document.querySelector(".fluxFigMenu .cs .exp").click());
  await sleep(200);
  await page.evaluate(() => {
    const hexIn = document.querySelector(".fluxFigMenu .cs input.hex");
    hexIn.value = "#cc0000";
    hexIn.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(300);

  const colored = await page.evaluate((part) => {
    const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1");
    const node = document.getElementById(`plot1__${part}`);
    const text = node?.querySelector("text");
    return {
      override: el?.overrides?.[part]?.fill ?? null,
      liveStyle: text?.getAttribute("style") ?? "",
      wrapperStyle: node?.getAttribute("style") ?? "",
    };
  }, PART);
  assert(colored.override === "#cc0000", `override recorded in the model ({fill: ${colored.override}})`);
  assert(
    /(#cc0000|rgb\(\s*204,\s*0,\s*0\s*\))/i.test(colored.liveStyle),
    `fill DRILLED to the live <text> drawable (style="${colored.liveStyle.slice(0, 80)}")`,
  );
  await shot(page, "figenh14-03-colored");

  // close ColorSearch + menu
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(250);
  assert(await page.evaluate(() => !document.querySelector(".fluxFigMenu")), "menu closes");

  // one undo reverts the colour
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(200);
  const afterUndo = await page.evaluate(
    (part) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[part]?.fill ?? null,
    PART,
  );
  assert(afterUndo === null, "one undo reverts the colour override");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nFIGENH-14 PART UI ALL PASS" : `\nFIGENH-14 PART UI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
