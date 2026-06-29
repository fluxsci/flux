// F6 regression: atomic hidden-markers must not break ordinary editing. Type a
// heading + bold + a chip, then backspace-delete the chip in one step.
import { launch, gotoApp, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });

// Append a new line with a heading marker, bold, and a cross-ref, then read back.
const typed = await page.evaluate(() => {
  const v = window.__fluxView;
  v.focus();
  const end = v.state.doc.length;
  const text = "\n\n## More results with **emphasis** and @fig-growth here\n";
  v.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length } });
  return v.state.doc.toString().includes("## More results with **emphasis** and @fig-growth here");
});
await sleep(150);

// Put the caret just AFTER the @fig-growth chip on that new line and backspace —
// an atomic chip should delete as one unit (doc loses the ref).
const del = await page.evaluate(() => {
  const v = window.__fluxView;
  const doc = v.state.doc.toString();
  const idx = doc.lastIndexOf("@fig-growth");
  const to = idx + "@fig-growth".length;
  v.focus();
  v.dispatch({ selection: { anchor: to } });
  return { before: v.state.doc.sliceString(idx - 2, to + 6) };
});
await page.keyboard.press("Backspace");
await sleep(80);
const after = await page.evaluate(() => {
  const v = window.__fluxView;
  return {
    stillHasRef: v.state.doc.toString().includes("@fig-growth here"),
    docLen: v.state.doc.length,
  };
});

console.log(JSON.stringify({ typed, del, after, errs: errors(page) }, null, 2));
await browser.close();
