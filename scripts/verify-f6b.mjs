// F6 part 2: doc.toString() invariant under caret moves, smooth arrow-nav across
// a (collapsed) chip with no stall, and a visual capture of the reveal.
import { launch, gotoApp, shot, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });

const docBefore = await page.evaluate(() => window.__fluxView.state.doc.toString());

// Place caret at the start of the line that begins with "(@fig-growth-a)".
await page.evaluate(() => {
  const v = window.__fluxView;
  v.focus();
  const l3 = v.state.doc.lineAt(v.state.doc.toString().indexOf("@fig-growth-a")).from;
  v.dispatch({ selection: { anchor: l3 } });
});

// Arrow right across the chip; record head positions — expect strictly increasing
// (no stall on hidden positions, no snap backwards).
const heads = [];
for (let i = 0; i < 8; i++) {
  heads.push(await page.evaluate(() => window.__fluxView.state.selection.main.head));
  await page.keyboard.press("ArrowRight");
  await sleep(35);
}
heads.push(await page.evaluate(() => window.__fluxView.state.selection.main.head));

// Visual: caret inside @fig-growth-a → only it reveals; smith chip stays.
await page.evaluate(() => {
  const v = window.__fluxView;
  v.focus();
  v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("@fig-growth-a") + 4 } });
});
await sleep(200);
await shot(page, "f6-caret-in-chip");

const docAfter = await page.evaluate(() => window.__fluxView.state.doc.toString());
const strictlyIncreasing = heads.every((h, i) => i === 0 || h > heads[i - 1]);

console.log(
  JSON.stringify(
    {
      docInvariant: docBefore === docAfter,
      heads,
      strictlyIncreasing,
      maxStep: Math.max(...heads.slice(1).map((h, i) => h - heads[i])),
      errs: errors(page),
    },
    null,
    2
  )
);
await browser.close();
