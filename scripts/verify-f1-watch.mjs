// F1 file-watch live reload (renderer half, via the memBridge fixture which can
// simulate external fs changes). Proves: an external write to fig/ reloads figures
// live; to references/ reloads the bibliography; to the active manuscript reloads
// the editor when clean, and NEVER clobbers unsaved work when dirty.
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const R = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: (process.env.FLUX_URL || "http://127.0.0.1:1420/") + "?fixture=demo", settle: 3500 });
await clickMode(page, "Paper");
await sleep(1400);

// 1) external fig/ write → figures reload (figRevision path).
await page.evaluate(async (R) => {
  await window.fig.writeText(R + "/fig/captions/growth.md", "WATCH RELOADED (a) one. (b) two.");
  window.__fluxEmitFsChange({ subsystem: "fig", path: R + "/fig/captions/growth.md" });
}, R);
await sleep(500);
const figCap = await page.evaluate(
  () => window.__fluxFigures.refs().find((r) => r.label === "fig-growth")?.caption,
);

// 2) external references/ write → bibliography reload (bibRevision path).
await page.evaluate(async (R) => {
  const cur = await window.fig.readText(R + "/references/library.bib");
  await window.fig.writeText(
    R + "/references/library.bib",
    cur + "\n@article{watch2099, title={Watched live}, author={Zed, A}, year={2099}}\n",
  );
  window.__fluxEmitFsChange({ subsystem: "references", path: R + "/references/library.bib" });
}, R);
await sleep(600);
const bibKeys = await page.evaluate(() => window.__fluxBib.keys());

// 3) external manuscript write while clean → editor reloads.
await page.evaluate(async (R) => {
  await window.fig.writeText(
    R + "/manuscript/main.qmd",
    '---\ntitle: "Mycelial growth under nutrient stress"\n---\n\n# Results\n\nAGENT REWROTE THIS BODY.\n',
  );
  window.__fluxEmitFsChange({ subsystem: "manuscript", path: R + "/manuscript/main.qmd" });
}, R);
await sleep(500);
const cleanReload = await page.evaluate(() =>
  window.__fluxView.state.doc.toString().includes("AGENT REWROTE THIS BODY"),
);

// 4) external manuscript write while dirty → keep unsaved work (no clobber).
await page.evaluate(() => {
  const v = window.__fluxView;
  v.focus();
  v.dispatch({ changes: { from: v.state.doc.length, insert: "\n\nMY UNSAVED EDIT.\n" } });
});
await page.evaluate(async (R) => {
  await window.fig.writeText(R + "/manuscript/main.qmd", '---\ntitle: "x"\n---\n\nA DIFFERENT AGENT VERSION.\n');
  window.__fluxEmitFsChange({ subsystem: "manuscript", path: R + "/manuscript/main.qmd" });
}, R);
await sleep(250);
const dirtyGuard = await page.evaluate(() => ({
  keptUnsaved: window.__fluxView.state.doc.toString().includes("MY UNSAVED EDIT"),
  notClobbered: !window.__fluxView.state.doc.toString().includes("A DIFFERENT AGENT VERSION"),
  bannerShown: !!document.querySelector(".disk-toast"),
}));

// 5) W7 conflict guard: with the editor dirty and disk holding the agent's
// version, forcing a flush must NOT clobber disk with the editor's text — the
// autosave detects the divergence and refuses (the banner offers reload/overwrite).
await page.evaluate(() => window.__flux.lifecycle.flushAll());
await sleep(300);
const w7 = await page.evaluate(async (R) => {
  const disk = await window.fig.readText(R + "/manuscript/main.qmd");
  return {
    diskKeptAgentVersion: disk.includes("A DIFFERENT AGENT VERSION"),
    diskNotClobberedByEditor: !disk.includes("MY UNSAVED EDIT"),
  };
}, R);

const out = {
  figReloaded: (figCap || "").includes("WATCH RELOADED"),
  bibReloaded: bibKeys.includes("watch2099"),
  cleanReload,
  dirtyGuard,
  w7ConflictGuard: w7,
  errs: realErrors(page),
};
console.log(JSON.stringify(out, null, 2));
await browser.close();

const pass =
  out.figReloaded &&
  out.bibReloaded &&
  out.cleanReload &&
  dirtyGuard.keptUnsaved &&
  dirtyGuard.notClobbered &&
  dirtyGuard.bannerShown &&
  w7.diskKeptAgentVersion &&
  w7.diskNotClobberedByEditor &&
  out.errs.length === 0;
console.log(pass ? "F1+W7 VERIFY: PASS" : "F1+W7 VERIFY: FAIL");
process.exit(pass ? 0 : 1);
