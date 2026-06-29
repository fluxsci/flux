// §1.4: the ?fixture=demo memBridge loads a real project on Surface A —
// manuscript with @fig/@cite, a figure with panels, a library.bib.
import { launch, gotoApp, clickMode, shot, errors, sleep } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await shot(page, "fixture-01-paper");

const paper = await page.evaluate(() => {
  const doc = window.__fluxView?.state.doc.toString() || "";
  const content = document.querySelector(".cm-content")?.textContent || "";
  const body = document.body.innerText;
  return {
    docLoaded: doc.includes("@fig-growth") && doc.includes("smith2021"),
    // Resolved chips render their label as text inside the editor content.
    contentSnippet: content.replace(/\s+/g, " ").trim().slice(0, 260),
    figuresPaneListsGrowth: body.includes("Growth curves"),
    noFiguresMsgGone: !body.includes("No figures in this project yet"),
  };
});

// Switch to Figure mode: the seeded "Growth curves" figure should be present.
await clickMode(page, "Figure");
await sleep(900);
await shot(page, "fixture-02-figure");
const figure = await page.evaluate(() => {
  const figs = window.__flux?.figures() || [];
  return {
    count: figs.length,
    names: figs.map((f) => f.name),
    elementCounts: figs.map((f) => (f.elements || []).length),
  };
});

console.log(JSON.stringify({ paper, figure, errs: errors(page) }, null, 2));
await browser.close();
