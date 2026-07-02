// P5 — Shell dirty indicator (SHL-12). Typing in the manuscript marks the app dirty, which the
// autosave controller broadcasts via dirtyPulse; the TitleBar re-evaluates anyDirty() and shows
// a dot (and mirrors it to the OS window via win.setDocumentEdited, a no-op on the web harness).
//   Run (dev server on :1420 must be up): node scripts/verify-p5-shell.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(500);

const res = await page.evaluate(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const projectShown = !!document.querySelector(".titlebar .project");
  const dotBefore = !!document.querySelector(".titlebar .dirtydot");

  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  // A real edit → onChange → autosave.schedule() → dirtyPulse bump → TitleBar re-evaluates.
  view.dispatch({ changes: { from: 0, insert: "Edited. " } });
  await raf();
  await new Promise((r) => setTimeout(r, 60));
  await raf();
  const dotAfter = !!document.querySelector(".titlebar .dirtydot");
  return { projectShown, dotBefore, dotAfter };
});

const errs = realErrors(page);
await browser.close();

if (res.error) {
  console.error("\nP5 SHELL VERIFY: FAIL —", res.error);
  process.exit(1);
}
console.log("SHL-12 — dirty indicator:");
assert(res.projectShown, "the workspace TitleBar shows the project chip (dot lives beside it)");
assert(!res.dotBefore, "no dirty dot before editing (clean state)");
assert(res.dotAfter, "the dirty dot appears after an edit");

if (errs.length) {
  console.error("\nP5 SHELL VERIFY: FAIL — console errors:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
console.log("\nP5 SHELL VERIFY: PASS");
