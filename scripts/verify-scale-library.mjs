// V1-readiness 1.2 gate — Library at 5,000 papers (the polish mandate's standing scale
// budget). Seeds a synthetic 5k library.bib + enrichment sidecar through the REAL bridge
// (__fluxSeedScaleLibrary → real parse/query/render paths) and asserts:
//   • the grid lists all 5k (coverage of the load path at scale);
//   • search keystroke → filtered results within budget (median over queries);
//   • scrolling the results holds frame budget (rAF-sampled p95);
//   • a subsequent revision bump re-lists within budget (steady-state reload).
// Budgets are DELIBERATE ceilings — tighten as the numbers improve; never loosen to pass.
//   Run (dev server on :1420): node scripts/verify-scale-library.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const N = 5000;
const BUDGET = {
  seedAndFirstListMs: 15000, // includes generating + writing ~8MB into the mem fs
  searchMs: 600, // keystroke → filtered grid (incl. the 150ms debounce)
  scrollP95Ms: 24, // rAF frame p95 while scrolling the grid
  relistMs: 3000, // revision bump → re-listed
  maxRenderedRows: 60, // WS-8.2: the windowed grid's rendered-row bound
};

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 2500 });
await clickMode(page, "Library").catch(() => {});
await sleep(1000);
await page.waitForFunction(() => window.__fluxSeedScaleLibrary, { timeout: 15000 });

console.log(`seeding ${N} entries…`);
const rowCount = () => page.evaluate(() => document.querySelectorAll(".grid .grow:not(.ghead)").length);
// WS-8.2: the grid is WINDOWED — the logical total lives on data-total, and the
// rendered row count must stay bounded regardless of N.
const gridTotal = () => page.evaluate(() => Number(document.querySelector(".grid")?.dataset.total ?? 0));

const t0 = Date.now();
const seeded = await page.evaluate((n) => window.__fluxSeedScaleLibrary(n), N);
ok(seeded.entries === N, `seeded ${seeded.entries} entries into ${seeded.lib}`);
let total = 0;
while (Date.now() - t0 < BUDGET.seedAndFirstListMs) {
  total = await gridTotal();
  if (total >= N) break;
  await sleep(250);
}
const listMs = Date.now() - t0;
ok(total >= N, `grid lists all ${N} rows logically (data-total=${total})`);
const rendered0 = await rowCount();
ok(rendered0 <= BUDGET.maxRenderedRows, `rendered window stays bounded (${rendered0} rows ≤ ${BUDGET.maxRenderedRows})`);
ok(listMs <= BUDGET.seedAndFirstListMs, `seed→listed in ${listMs}ms (≤ ${BUDGET.seedAndFirstListMs})`);

// --- search latency: type a query, time until the grid shrinks to matches --------------
async function timeSearch(q, expectFewer) {
  return page.evaluate(
    async (query, N_) => {
      const input = document.querySelector('input[type="search"], .searchbox input, input[placeholder*="earch"]');
      if (!input) return { error: "no search input" };
      const t0 = performance.now();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 25));
        // WS-8.2: the grid windows its rows — the logical count is data-total.
        const n = Number(document.querySelector(".grid")?.dataset.total ?? 0);
        if (query ? n > 0 && n < N_ : n >= N_) return { ms: performance.now() - t0, n };
      }
      return { error: "timed out", n: Number(document.querySelector(".grid")?.dataset.total ?? -1) };
    },
    q,
    expectFewer ? N : N - 1,
  );
}
const s1 = await timeSearch("sleep", true);
const s2 = await timeSearch("author:author42", true);
const s3 = await timeSearch("", false); // clear back to all
ok(!s1.error && s1.ms <= BUDGET.searchMs, `free-text search filtered in ${Math.round(s1.ms ?? -1)}ms → ${s1.n} rows (≤ ${BUDGET.searchMs})`, JSON.stringify(s1));
// WS-8.2/8.1: first-keystroke budget at 5k (incl. the 150ms debounce).
ok(!s1.error && s1.ms <= 400, `first keystroke → filtered in ${Math.round(s1.ms ?? -1)}ms (≤ 400 at ${N})`);
ok(!s2.error && s2.ms <= BUDGET.searchMs, `structured author: search in ${Math.round(s2.ms ?? -1)}ms → ${s2.n} rows`);
ok(!s3.error, `clearing restores the full list (${s3.n} rows)`);

// --- scroll frame budget -----------------------------------------------------------------
const scroll = await page.evaluate(async () => {
  const el = document.querySelector(".grid")?.closest("[class*=scroll]") || document.querySelector(".results") || document.querySelector(".grid")?.parentElement;
  if (!el) return { error: "no scroll container" };
  const frames = [];
  let last = performance.now();
  let raf = 0;
  const tick = (now) => {
    frames.push(now - last);
    last = now;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  let maxRendered = 0;
  for (let i = 0; i < 30; i++) {
    el.scrollTop += 900;
    await new Promise((r) => setTimeout(r, 50));
    maxRendered = Math.max(maxRendered, document.querySelectorAll(".grid .grow:not(.ghead)").length);
  }
  cancelAnimationFrame(raf);
  frames.sort((a, b) => a - b);
  const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
  const median = frames[Math.floor(frames.length / 2)] ?? 0;
  return { median: +median.toFixed(1), p95: +p95.toFixed(1), scrolled: el.scrollTop, maxRendered };
});
ok(!scroll.error && scroll.p95 <= BUDGET.scrollP95Ms, `scroll frames median ${scroll.median}ms · p95 ${scroll.p95}ms (≤ ${BUDGET.scrollP95Ms})`, JSON.stringify(scroll));
ok(!scroll.error && scroll.maxRendered <= BUDGET.maxRenderedRows, `window stays bounded WHILE scrolling (max ${scroll.maxRendered} ≤ ${BUDGET.maxRenderedRows})`);

// --- steady-state re-list on a revision bump ---------------------------------------------
const relist = await page.evaluate(async (N_) => {
  const { bumpFluxLib } = await import("/src/lib/references/revision.ts");
  const t0 = performance.now();
  bumpFluxLib();
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (Number(document.querySelector(".grid")?.dataset.total ?? 0) >= N_) return { ms: performance.now() - t0 };
  }
  return { error: "timed out" };
}, N);
ok(!relist.error && relist.ms <= BUDGET.relistMs, `revision bump re-listed in ${Math.round(relist.ms ?? -1)}ms (≤ ${BUDGET.relistMs})`);

const errs = realErrors(page);
ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 300)}` : "zero console errors");
await browser.close();

console.log(fails.length ? `\nSCALE-LIBRARY VERIFY: FAIL — ${fails.length}` : "\nSCALE-LIBRARY VERIFY: PASS");
process.exit(fails.length ? 1 : 0);
