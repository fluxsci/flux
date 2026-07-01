// W4 (V1 review): autosave-controller wiring smoke — drives the demo fixture.
// Run: node scripts/verify-w4-wiring.mjs   (dev server on :1420 required)
//
// 1. Typing in Paper persists through the controller to the (mem) bridge.
// 2. A failing bridge write surfaces: error dot on the title pill + sticky toast.
// 3. Restoring the bridge + Retry recovers and persists.

import { launch, gotoApp, clickNew, shot, realErrors, setDoc, sleep } from "./lib/driver.mjs";

const fail = (m) => {
  console.error("✗ " + m);
  process.exitCode = 1;
};
const ok = (m) => console.log("✓ " + m);

const { browser, page } = await launch();
await gotoApp(page, { url: process.env.FLUX_URL || "http://127.0.0.1:1420/?fixture=demo" });
await clickNew(page);

const docPath = await page.evaluate(() => {
  const f = window.__flux;
  const pm = f.get(f.shell.projectModel);
  return pm.root + "/" + pm.manifest.manuscript.path;
});

// -- 1. normal autosave persists ---------------------------------------------
await setDoc(page, "# W4\n\nhello autosave controller\n");
await sleep(1000); // 600ms debounce + write
const onDisk = await page.evaluate((p) => window.fig.readText(p), docPath);
if (/hello autosave controller/.test(onDisk)) ok("typing persists through the controller");
else fail("autosave did not persist: " + JSON.stringify(onDisk.slice(0, 80)));

// -- 2. failing write surfaces (silent retry → sticky toast + error dot) ------
await page.evaluate(() => {
  window.__w4realWrite = window.fig.writeText.bind(window.fig);
  window.fig.writeText = () => Promise.reject(new Error("disk full (injected)"));
});
await setDoc(page, "# W4\n\nthis write will fail\n");
await sleep(1200); // first failure (silent)
const toastsEarly = await page.evaluate(() => {
  const f = window.__flux;
  return f.get(f.toast.toasts).length;
});
if (toastsEarly === 0) ok("first failure is silent (retry pending)");
else fail("toast appeared before the silent retry");
await sleep(5300); // silent retry fails → sticky toast
const state = await page.evaluate(() => {
  const f = window.__flux;
  const toasts = f.get(f.toast.toasts).map((t) => t.msg);
  const dot = document.querySelector(".pill .dot.error") != null;
  return { toasts, dot };
});
if (state.toasts.some((m) => /manuscript/i.test(m)) && state.dot)
  ok("second failure: sticky toast + error dot on the title pill");
else fail("failure not surfaced: " + JSON.stringify(state));
await shot(page, "w4-01-save-error");

// -- 3. restore + Retry recovers ----------------------------------------------
await page.evaluate(() => {
  window.fig.writeText = window.__w4realWrite;
});
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".toast .t-act")].find((b) => /retry/i.test(b.textContent));
  btn?.click();
});
await sleep(900);
const after = await page.evaluate(async (p) => {
  const f = window.__flux;
  return {
    toasts: f.get(f.toast.toasts).length,
    disk: await window.fig.readText(p),
    dot: document.querySelector(".pill .dot.error") != null,
  };
}, docPath);
if (after.toasts === 0 && /this write will fail/.test(after.disk) && !after.dot)
  ok("Retry recovered: toast dismissed, error dot cleared, text persisted");
else fail("recovery incomplete: " + JSON.stringify({ toasts: after.toasts, dot: after.dot }));

const errs = realErrors(page).filter((e) => !/disk full \(injected\)/.test(e));
if (errs.length) fail("console errors: " + JSON.stringify(errs));
else ok("no console errors");

await browser.close();
console.log(process.exitCode ? "W4 WIRING: FAIL" : "W4 WIRING: PASS");
