// W1 (V1 review): app-wide toast/error system — visual + behavioral verification.
// Run: node scripts/verify-w1-toast.mjs   (dev server on :1420 required)
//
// Asserts: pushToast renders each level at the shell layer; identical (level,msg)
// dedupes instead of stacking; info/success auto-dismiss on ttl while errors are
// sticky; the error ✕ dismisses; the action button runs; no console errors.

import { launch, gotoApp, clickNew, shot, realErrors, sleep } from "./lib/driver.mjs";

const OUT = process.env.FLUX_OUT || ".";
const fail = (msg) => {
  console.error("✗ " + msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log("✓ " + msg);

const { browser, page } = await launch();
await gotoApp(page, { url: process.env.FLUX_URL || "http://127.0.0.1:1420/?fixture=demo" });
await clickNew(page);

const toastCount = () =>
  page.evaluate(() => {
    const f = window.__flux;
    return f?.toast ? f.get(f.toast.toasts).length : -1;
  });

// -- push one of each level + an action ------------------------------------
await page.evaluate(() => {
  const { pushToast } = window.__flux.toast;
  pushToast("info", "Info toast — auto-dismisses");
  pushToast("success", "Exported growth.png");
  pushToast("error", "Couldn't save manuscript", {
    detail: "EACCES: permission denied — /tmp/x.qmd",
    action: { label: "Retry", run: () => ((window.__w1retried = true), undefined) },
  });
});
await sleep(400);
if ((await toastCount()) !== 3) fail(`expected 3 toasts, got ${await toastCount()}`);
else ok("3 toasts pushed (info, success, error+action)");
await shot(page, "w1-01-three-toasts");

// -- action button runs, then dismisses (before dedupe, which replaces action) --
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".toast .t-act")].find((b) => /retry/i.test(b.textContent));
  btn?.click();
});
await sleep(300);
const retried = await page.evaluate(() => window.__w1retried === true);
if (retried && (await toastCount()) === 2) ok("action ran and its toast dismissed");
else fail(`action/dismiss failed (retried=${retried}, count=${await toastCount()})`);

// -- dedupe: same (level,msg) refreshes, not stacks -------------------------
await page.evaluate(() => {
  window.__flux.toast.pushToast("error", "Couldn't save manuscript");
  window.__flux.toast.pushToast("error", "Couldn't save manuscript");
});
if ((await toastCount()) !== 3) fail("dedupe failed — duplicate error stacked");
else ok("duplicate (level,msg) dedupes");

// -- ttl expiry: info/success gone, error sticky ----------------------------
await sleep(3800);
const after = await page.evaluate(() => {
  const f = window.__flux;
  return f.get(f.toast.toasts).map((x) => x.level);
});
if (after.length === 1 && after[0] === "error") ok("info/success expired; error sticky");
else fail(`expected only sticky error after ttl, got [${after}]`);
await shot(page, "w1-02-sticky-error");

// -- ✕ dismiss on the remaining sticky error --------------------------------
await page.evaluate(() => document.querySelector(".toast .t-x")?.click());
await sleep(300);
if ((await toastCount()) === 0) ok("✕ dismisses a sticky error");
else fail("✕ did not dismiss");

// -- overflow cap: >5 drops oldest non-error --------------------------------
await page.evaluate(() => {
  const { pushToast } = window.__flux.toast;
  pushToast("error", "E1");
  for (let i = 0; i < 6; i++) pushToast("info", "I" + i);
});
const capped = await page.evaluate(() => {
  const f = window.__flux;
  return f.get(f.toast.toasts).map((x) => x.msg);
});
if (capped.length === 5 && capped.includes("E1")) ok(`cap holds at 5, error survives ([${capped}])`);
else fail(`cap broken: [${capped}]`);

const errs = realErrors(page);
if (errs.length) fail("console errors: " + JSON.stringify(errs));
else ok("no console errors");

await browser.close();
console.log(process.exitCode ? "W1 VERIFY: FAIL" : "W1 VERIFY: PASS");
