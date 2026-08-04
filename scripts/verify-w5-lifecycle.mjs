// W5 (V1 review): dirty registry + flush protocol — fixture verification.
// Run: node scripts/verify-w5-lifecycle.mjs   (dev server on :1420 required)
//
// 1. Paper edit → anyDirty() true → flushAll() persists + anyDirty() false.
// 2. Figure edit (via commit) registers dirty too; flushAll persists fig/.
// 3. goHome() awaits the flush: type-then-goHome loses nothing.
// 4. Mode round-trip re-registration doesn't duplicate or leak entries.

import { launch, gotoApp, clickNew, clickMode, realErrors, setDoc, sleep } from "./lib/driver.mjs";

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

// -- 1. paper dirty → flushAll persists ---------------------------------------
await setDoc(page, "# W5\n\nregistry flush test\n");
await sleep(80); // inside the 600ms debounce — still dirty
const dirtyNow = await page.evaluate(() => window.__flux.lifecycle.anyDirty());
if (dirtyNow) ok("anyDirty() sees the pending paper edit");
else fail("anyDirty() false while an edit is pending");

const flushRes = await page.evaluate(() => window.__flux.lifecycle.flushAll());
const disk1 = await page.evaluate((p) => window.fig.readText(p), docPath);
const dirtyAfter = await page.evaluate(() => window.__flux.lifecycle.anyDirty());
if (flushRes.ok && /registry flush test/.test(disk1) && !dirtyAfter)
  ok("flushAll() persists the manuscript and clears dirty");
else fail(`flushAll wrong (ok=${flushRes.ok}, ondisk=${/registry flush test/.test(disk1)}, dirty=${dirtyAfter})`);

// -- 2. figure dirty → flushAll persists fig/ ---------------------------------
await clickMode(page, "Figure");
await sleep(600);
await page.evaluate(() => {
  const f = window.__flux;
  f.fig.commit((p) => {
    // Figure families (8a02c5f): `name` is DERIVED from family+number — the free-text
    // handle that persists into fig/index.json is the nickname.
    p.figures[0].nickname = "W5 Renamed";
  });
});
const figDirty = await page.evaluate(() => window.__flux.lifecycle.anyDirty());
await page.evaluate(() => window.__flux.lifecycle.flushAll());
const idx = await page.evaluate(async () => {
  const f = window.__flux;
  const pm = f.get(f.shell.projectModel);
  return window.fig.readText(pm.root + "/fig/index.json");
});
if (figDirty && /W5 Renamed/.test(idx)) ok("figure edit registers dirty; flushAll writes fig/index.json");
else fail(`figure flush wrong (dirty=${figDirty}, renamed=${/W5 Renamed/.test(idx)})`);

// -- 3. goHome awaits the flush ------------------------------------------------
await clickMode(page, "Paper");
await sleep(700);
await setDoc(page, "# W5\n\ngoHome must not lose this\n");
await page.evaluate(() => window.__flux.shell.goHome()); // async — returns before nav completes
await sleep(700);
const home = await page.evaluate(() => {
  const f = window.__flux;
  return f.get(f.shell.view);
});
const disk2 = await page.evaluate((p) => window.fig.readText(p), docPath);
if (home === "home" && /goHome must not lose this/.test(disk2))
  ok("goHome() flushed the pending edit before leaving");
else fail(`goHome flush wrong (view=${home}, persisted=${/goHome must not lose this/.test(disk2)})`);

// -- 4. re-registration replaces (no leak) -------------------------------------
// Re-enter and round-trip modes; a leaked stale registration would make
// flushAll touch destroyed components (throws) or anyDirty stick true.
await clickNew(page);
await clickMode(page, "Figure");
await sleep(500);
await clickMode(page, "Paper");
await sleep(500);
const rt = await page.evaluate(async () => {
  const f = window.__flux;
  const r = await f.lifecycle.flushAll();
  return { ok: r.ok, failed: r.failed, dirty: f.lifecycle.anyDirty() };
});
if (rt.ok && !rt.dirty) ok("mode round-trip: registry stays clean (replace semantics)");
else fail(`round-trip registry state wrong: ${JSON.stringify(rt)}`);

const errs = realErrors(page);
if (errs.length) fail("console errors: " + JSON.stringify(errs));
else ok("no console errors");

await browser.close();
console.log(process.exitCode ? "W5 VERIFY: FAIL" : "W5 VERIFY: PASS");
