// F6: reveal is per-construct, not per-line. On a line with two chips, placing the
// caret at the line end must NOT expand either chip (the old bug); placing it
// inside one chip reveals only that one. Headings reveal "#" only on their line.
import { launch, gotoApp, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });

const setSel = (pos) =>
  page.evaluate((p) => {
    const v = window.__fluxView;
    v.focus();
    v.dispatch({ selection: { anchor: p } });
  }, pos);
const readContent = () =>
  page.evaluate(
    () => document.querySelector(".cm-content")?.innerText.replace(/\s+/g, " ").trim() || ""
  );

const positions = await page.evaluate(() => {
  const v = window.__fluxView;
  const doc = v.state.doc.toString();
  const smith = doc.indexOf("[@smith2021]");
  const figA = doc.indexOf("@fig-growth-a");
  return {
    smith,
    figA,
    lineEndOfSmith: v.state.doc.lineAt(smith).to,
    results: doc.indexOf("Results"),
  };
});

await setSel(positions.lineEndOfSmith);
await sleep(150);
const atLineEnd = await readContent();

await setSel(positions.figA + 3);
await sleep(150);
const inFigA = await readContent();

await setSel(positions.results);
await sleep(150);
const inHeading = await readContent();

const result = {
  // Caret at end of the two-chip line: both chips stay rendered, no raw leak.
  atLineEnd: {
    showsFig1aChip: atLineEnd.includes("Fig. 1a"),
    showsSmithChip: atLineEnd.includes("Smith & Doe, 2021"),
    leakedRawFigA: atLineEnd.includes("@fig-growth-a"),
    leakedRawSmith: atLineEnd.includes("[@smith2021]"),
    headingHashHidden: !atLineEnd.includes("# Results"),
  },
  // Caret inside @fig-growth-a: only it reveals; smith stays a chip.
  inFigA: {
    revealsRawFigA: inFigA.includes("@fig-growth-a"),
    smithStillChip: inFigA.includes("Smith & Doe, 2021"),
  },
  // Caret in the heading: "#" reveals on that line.
  inHeading: { revealsHashResults: inHeading.includes("# Results") },
  errs: errors(page),
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
