// 2.3 gate (browser) — the Library's full-text mode UI end-to-end against a seeded
// FluxLib. A DEV seam (window.__fluxFulltextHook) stands in for the Electron CLI-spawn
// so the renderer path is exercised without a packaged app: typing `ft:…` switches the
// grid into full-text mode (status bar + hit-only rows + page-numbered snippet strip),
// and clicking a snippet drives openInReader(key,{find}) — the jump-to-reader-with-find
// wiring — verified by reading the reader stores directly (seeded papers have no PDF).
//   Run (dev server on :1420 must be up): node scripts/verify-fulltext-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg, extra = "") => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Library").catch(() => {});
await sleep(800);

// Seed a 6-row synthetic library so full-text mode's filtering is a real 6→1 narrowing.
await page.waitForFunction(() => !!window.__fluxSeedScaleLibrary, { timeout: 15000 });
await page.evaluate(() => window.__fluxSeedScaleLibrary(6));
await page.waitForFunction(() => document.querySelectorAll(".grid .grow:not(.ghead)").length >= 6, { timeout: 15000 }).catch(() => {});
await sleep(400);

const keys = await page.evaluate(() =>
  [...document.querySelectorAll(".grid .grow:not(.ghead) .gsel input")].map((e) => (e.getAttribute("aria-label") || "").replace(/^Select /, "")),
);
const N = keys.length;
ok(N >= 6, `seeded library has ≥6 rows to filter (${N})`);
const target = keys[0];

// DEV hook: one paper matches, 3 total hits but only 2 snippets (→ "+1 more").
await page.evaluate((k) => {
  window.__fluxFulltextHook = (q) => {
    if (/nomatch/.test(q)) return { hits: [], scanned: 6, missingText: [], truncated: false, elapsedMs: 2 };
    return {
      hits: [{ key: k, count: 3, snippets: [{ page: 2, text: "…optogenetic silencing of pyloric neurons on page two…" }, { page: 5, text: "…a second optogenetic manipulation on page five…" }] }],
      scanned: 7,
      missingText: ["scanned2001"],
      truncated: false,
      elapsedMs: 4,
    };
  };
}, target);

// Type a full-text query. 150ms query debounce + async hook → settle.
await page.click(".search");
await page.type(".search", "ft:optogenetic");
await sleep(700);

const snap = await page.evaluate(() => {
  const bar = document.querySelector(".ftbar");
  const rows = [...document.querySelectorAll(".grid .grow:not(.ghead)")].length;
  const snips = [...document.querySelectorAll(".ftsnip")].map((e) => e.textContent?.replace(/\s+/g, " ").trim() || "");
  const pages = [...document.querySelectorAll(".ftsnip .ftpage")].map((e) => e.textContent?.trim() || "");
  const more = document.querySelector(".ftmore")?.textContent?.trim() || "";
  return { barText: bar?.textContent?.replace(/\s+/g, " ").trim() || "", rows, snips, pages, more };
});

ok(!!snap.barText, "full-text status bar renders");
ok(/match/i.test(snap.barText) && /scanned 7/.test(snap.barText), "status bar reports match + scanned count", snap.barText);
ok(/not yet text-extracted/i.test(snap.barText), "status bar surfaces the missing-text backfill note", snap.barText);
ok(snap.rows === 1, `grid narrows 6→1 to the single matched paper (${snap.rows})`);
ok(snap.snips.length === 2, `two snippet rows render (${snap.snips.length})`);
ok(snap.pages.join(",") === "p2,p5", `page badges shown (${snap.pages.join(",")})`);
ok(/optogenetic/i.test(snap.snips[0]), "snippet text is shown");
ok(/\+1 more/.test(snap.more), `"+N more" note reflects count>snippets (${snap.more})`);

// Click the first snippet → openInReader(target, {find:"optogenetic"}). Assert via the
// reader stores (seeded papers have no PDF, so the find bar itself may not mount).
await page.click(".ftsnip");
await sleep(500);
// Read the live stores mirrored onto window by the app's own readerStore instance.
const jump = await page.evaluate(() => ({ key: window.__fluxReaderKey, find: window.__fluxReaderFind }));
ok(jump.key === target, `snippet click opened the reader on the paper (${jump.key})`);
ok(jump.find?.term === "optogenetic", `reader received the find term (${jump.find?.term})`);

// Back to the Library; a query the hook answers with NO hits → empty state, 0 rows.
await clickMode(page, "Library").catch(() => {});
await sleep(400);
await page.evaluate(() => {
  const el = document.querySelector(".search");
  el.value = "ft:nomatchxyz";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(700);
const empty = await page.evaluate(() => ({
  rows: document.querySelectorAll(".grid .grow:not(.ghead)").length,
  none: document.querySelector(".none")?.textContent?.replace(/\s+/g, " ").trim() || "",
}));
ok(empty.rows === 0, `no-hit query shows zero rows (${empty.rows})`);
ok(/No stored PDF text matches/i.test(empty.none), "no-hit query shows the full-text empty state", empty.none);

// Clearing the query returns to the normal metadata grid.
await page.evaluate(() => {
  const el = document.querySelector(".search");
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(500);
const cleared = await page.evaluate(() => ({ bar: !!document.querySelector(".ftbar"), rows: document.querySelectorAll(".grid .grow:not(.ghead)").length }));
ok(!cleared.bar, "clearing the query removes the full-text bar");
ok(cleared.rows === N, `grid restores all ${N} rows after clearing (${cleared.rows})`);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors during full-text flow", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
