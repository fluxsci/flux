// 3.3 gate (browser) — library organization in the real Library UI against a seeded lib:
// the per-row reading-status cycle, tag add in the detail editor, tag: filtering, the
// facet filter bar, and bulk-tagging the multiselect — each persisted through the real
// organizeBridge → .fluxlib/organize.json (memBridge) and re-read into the grid.
//   Run (dev server on :1420 must be up): node scripts/verify-lib-organize.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
await gotoApp(page, { url: (process.env.FLUX_URL || "http://127.0.0.1:1420/") + "?fixture=demo", settle: 3000 });
await clickMode(page, "Library").catch(() => {});
await sleep(600);
await page.waitForFunction(() => !!window.__fluxSeedScaleLibrary, { timeout: 15000 });
await page.evaluate(() => window.__fluxSeedScaleLibrary(6));
await page.waitForFunction(() => document.querySelectorAll(".grid .grow:not(.ghead)").length >= 6, { timeout: 15000 }).catch(() => {});
await sleep(300);
const N = await page.evaluate(() => document.querySelectorAll(".grid .grow:not(.ghead)").length);
ok(N >= 6, `seeded ${N} rows`);

const firstRow = ".grid .grow:not(.ghead)";

// --- reading-status cycle (unread → reading) --------------------------------------------
const st0 = await page.evaluate((sel) => document.querySelector(`${sel} .statusdot`)?.className || "", firstRow);
ok(/s-unread/.test(st0), "row starts unread");
await page.click(`${firstRow} .statusdot`);
await sleep(400);
const st1 = await page.evaluate((sel) => document.querySelector(`${sel} .statusdot`)?.className || "", firstRow);
ok(/s-reading/.test(st1), "status dot cycles unread → reading", st1);

// --- add a tag via the detail editor ----------------------------------------------------
// open the first row's detail (the ▸ toggle button).
await page.evaluate((sel) => {
  const row = document.querySelector(sel);
  const btn = row ? [...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === "▸") : null;
  btn?.click();
}, firstRow);
await sleep(300);
await page.type(".detail .taginput", "cpg");
await page.keyboard.press("Enter");
await sleep(400);
const tagged = await page.evaluate(() => ({
  chip: [...document.querySelectorAll(".detail .chip.tag")].some((c) => /cpg/.test(c.textContent || "")),
  rowtag: [...document.querySelectorAll(".grid .grow .rtag")].some((c) => /cpg/.test(c.textContent || "")),
}));
ok(tagged.chip, "tag chip appears in the detail editor");
ok(tagged.rowtag, "tag shows on the row title");

// --- tag: filtering ---------------------------------------------------------------------
await page.evaluate(() => {
  const el = document.querySelector(".search");
  el.value = "tag:cpg";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(400);
const filtered = await page.evaluate(() => document.querySelectorAll(".grid .grow:not(.ghead)").length);
ok(filtered === 1, `tag:cpg narrows the grid to the tagged paper (${filtered})`);

// --- facet bar --------------------------------------------------------------------------
await page.evaluate(() => {
  const el = document.querySelector(".search");
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(300);
const facet = await page.evaluate(() => {
  const toggle = document.querySelector(".facettoggle");
  toggle?.click();
  return { hasBar: !!toggle };
});
ok(facet.hasBar, "the Filters facet bar is present once tags exist");
await sleep(200);
const clickedFacet = await page.evaluate(() => {
  const f = [...document.querySelectorAll(".facet")].find((b) => (b.textContent || "").trim() === "cpg");
  f?.click();
  return !!f;
});
await sleep(400);
const afterFacet = await page.evaluate(() => ({
  q: document.querySelector(".search")?.value || "",
  rows: document.querySelectorAll(".grid .grow:not(.ghead)").length,
}));
ok(clickedFacet && /tag:cpg/.test(afterFacet.q), `clicking the tag facet sets the query (${afterFacet.q})`);
ok(afterFacet.rows === 1, "facet filter narrows the grid");

// --- facet boundary: a prefix-overlapping value must not falsely activate (D1) ---
// "status:reading" must NOT light up the "read" facet (its clause is a substring).
await page.evaluate(() => {
  const el = document.querySelector(".search");
  el.value = "status:reading";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(250);
const readFacetOn = await page.evaluate(() =>
  [...document.querySelectorAll(".facet")].some((b) => (b.textContent || "").trim() === "read" && b.classList.contains("on")),
);
ok(!readFacetOn, "the ‘read’ facet is not falsely active while status:reading is set (prefix-overlap)");

// clear the facet
await page.evaluate(() => {
  const el = document.querySelector(".search");
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(300);

// --- bulk tag ---------------------------------------------------------------------------
// select two rows, type a bulk tag, Enter.
await page.evaluate(() => {
  const boxes = document.querySelectorAll(".grid .grow:not(.ghead) .gsel input");
  boxes[1]?.click();
  boxes[2]?.click();
});
await sleep(200);
await page.type(".bulktag", "batch");
await page.keyboard.press("Enter");
await sleep(500);
const bulk = await page.evaluate(() => [...document.querySelectorAll(".grid .grow .rtag")].filter((c) => /batch/.test(c.textContent || "")).length);
ok(bulk === 2, `bulk-tag applied to both selected rows (${bulk})`);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors during organize flow", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
