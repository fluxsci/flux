// F7 caption pipeline + auto panel labels. Proves: (A) the manuscript reads the
// caption from fig/captions/<id>.md (index caption is ""), with panel letters;
// (C) the resolver validates sub-panels (@fig-growth-a ok, -z unresolved);
// (D) auto-letter assigns a,b by reading order; (B) editing a caption in Figure
// mode + save round-trips to fig/captions/<id>.md and back into the manuscript.
import { launch, gotoApp, clickMode, sleep, errors } from "./lib/driver.mjs";

const ROOT = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper");
await sleep(1200);

// (A) Read path: caption sourced from the .md (index caption is empty), + panels.
const read = await page.evaluate(() => {
  const refs = window.__fluxFigures.refs();
  const g = refs.find((r) => r.label === "fig-growth");
  return { caption: g?.caption, panels: g?.panels, number: g?.number };
});

// (C) Resolver: sub-panel validation against real panel letters.
const resolve = await page.evaluate(() => {
  const R = window.__fluxFigures.resolve;
  const num = (l) => { const r = R(l); return r ? r.number : null; };
  return {
    base: num("fig-growth"),
    a: num("fig-growth-a"),
    b: num("fig-growth-b"),
    range: num("fig-growth-a-b"),
    bogus: num("fig-growth-z"),
  };
});

// (D) Auto-letter: swap the labels, then auto-letter → a (left) , b (right).
await clickMode(page, "Figure");
await sleep(900);
const autoLetter = await page.evaluate(() => {
  const F = window.__flux.fig;
  F.commit((p) => {
    const f = p.figures.find((x) => x.id === "growth");
    f.elements.find((e) => e.id === "el-a").text = "b"; // x=20 (left) mislabelled
    f.elements.find((e) => e.id === "el-b").text = "a"; // x=320 (right) mislabelled
  });
  F.autoLetterPanels("growth");
  const f = window.__flux.figures().find((x) => x.id === "growth");
  return {
    left: f.elements.find((e) => e.id === "el-a").text,
    right: f.elements.find((e) => e.id === "el-b").text,
  };
});

// (B) Save round-trip: edit a caption, save, read the .md + index, reload refs.
const roundTrip = await page.evaluate(async () => {
  const F = window.__flux;
  F.fig.commit((p) => {
    const f = p.figures.find((x) => x.id === "growth");
    f.captions["el-a"] = "EDITED extension.";
  });
  const composed = F.caps.composeCaption(F.figures().find((x) => x.id === "growth"));
  await F.bridge.saveFigFrom("/demo/myc-growth-paper");
  const md = (await window.fig.readText("/demo/myc-growth-paper/fig/captions/growth.md")).trim();
  const index = JSON.parse(await window.fig.readText("/demo/myc-growth-paper/fig/index.json"));
  await window.__fluxFigures.reload("/demo/myc-growth-paper");
  const ref = window.__fluxFigures.refs().find((r) => r.label === "fig-growth");
  return {
    composed,
    mdMatchesComposed: md === composed,
    mdHasEdit: md.includes("EDITED extension."),
    mdHasLeadIn: md.startsWith("Mycelial growth under nutrient stress"),
    indexCaptionCached: (index.figures[0].caption || "").includes("EDITED extension."),
    refAfterReload: ref?.caption,
  };
});

console.log(JSON.stringify({ read, resolve, autoLetter, roundTrip, errs: errors(page) }, null, 2));
await browser.close();
