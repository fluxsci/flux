// M10: measure the embeds/tables decoration scan cost on a large doc. Tables'
// numbering needs a full-doc scan (appearance-order @tbl numbers), so the
// question is whether the cheap leading-char bailout already holds 60fps.
import { launch, gotoApp, clickMode, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const res = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };

  // ~5k-line doc: a table block + an embed every ~50 lines, prose filler between.
  const block = [
    "| Gene | Δ | p |",
    "| --- | ---: | ---: |",
    "| Foo | 1.2 | 0.01 |",
    "| Bar | 3.4 | 0.02 |",
    "",
    ": A measured table {#tbl-blk}",
    "",
    "![Growth](../fig/renders/growth.svg){#fig-growth}",
    "",
  ];
  const lines = [];
  let i = 0;
  while (lines.length < 5000) {
    if (i % 50 === 0) lines.push(...block);
    else lines.push(`Prose line ${i} with some words to scan but no pipe or bang markers.`);
    i++;
  }
  const text = lines.join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  await new Promise((r) => requestAnimationFrame(r));

  const lineCount = view.state.doc.lines;
  const tableCount = Math.floor(5000 / 50);

  // Time keystroke transactions (each triggers a full rebuild of both fields).
  const samples = [];
  for (let k = 0; k < 40; k++) {
    const end = view.state.doc.length;
    const t0 = performance.now();
    view.dispatch({ changes: { from: end, insert: "x" } });
    void view.contentHeight; // force layout read
    samples.push(performance.now() - t0);
    await new Promise((r) => requestAnimationFrame(r));
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const max = samples[samples.length - 1];
  return {
    lineCount,
    approxTables: tableCount,
    medianMs: +median.toFixed(2),
    p95Ms: +p95.toFixed(2),
    maxMs: +max.toFixed(2),
    under16fps: max < 16.6,
    embedsRendered: document.querySelectorAll(".flux-embed").length,
    tablesRendered: document.querySelectorAll(".flux-table").length,
  };
});

console.log(JSON.stringify({ m10: res, errs: errors(page) }, null, 2));
await browser.close();
