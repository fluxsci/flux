// Cold mode completion must remain usable after the user switches away before
// its import resolves. Hold the real Paper module request, let Figure fully
// mount, then release Paper while hidden: returning to Paper must mount it.
import assert from "node:assert/strict";
import { launch, APP_URL, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
let heldPaper, registryUrl;
let onPaperHeld = () => {};
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`  ok: ${label}`); };
const clickMode = (label) => page.evaluate((label) => {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing ${label} button`);
  button.click();
}, label);
const visible = (selector) => page.waitForFunction((selector) => {
  const node = document.querySelector(selector);
  return node && getComputedStyle(node).visibility === "visible";
}, { timeout: 8000 }, selector);

try {
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/src/shell/modeRegistry.ts") registryUrl = request.url();
    if (!heldPaper && request.resourceType() === "script" && new URL(request.url()).pathname === "/src/shell/modes/paper/PaperMode.svelte") { heldPaper = request; onPaperHeld(); }
    else void request.continue();
  });
  const url = new URL(APP_URL); url.searchParams.set("fixture", "demo");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label="Figure"]');
  await page.waitForFunction(() => !!window.__flux);
  if (!heldPaper) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Paper module request was not observed")), 8000);
    onPaperHeld = () => { clearTimeout(timer); resolve(); };
  });
  check(!!heldPaper, "Paper's real cold import is held while the mode bar is usable");
  check(await page.$(".paper") === null, "Paper has not mounted before its import completes");
  await clickMode("Figure");
  await visible(".figure-mode");
  await page.waitForFunction(() => window.__flux.tenancy.storeTenant() === "figure");
  check(true, "Figure is usable while the earlier Paper import is pending");
  await heldPaper.continue();
  // Use the module URL observed in this renderer, including Vite's current HMR
  // version; importing an unversioned URL would create an unrelated empty cache.
  await page.waitForFunction(async (url) => !!(await import(url)).cachedMode("paper"), { timeout: 8000 }, registryUrl);
  // The import and its cancelled activation callback have both settled.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(await page.$(".paper") === null, "a stale completion does not mount a hidden cold mode");
  await clickMode("Paper");
  await visible(".paper .cm-editor");
  check(true, "returning to the now-cached Paper mounts a visible editor");
  await page.evaluate(() => {
    const editor = window.__flux.editors.at(-1);
    window.__coldSwitchEditor = editor;
    editor.dispatch({ selection: { anchor: Math.min(15, editor.state.doc.length) } });
    window.__coldSwitchCursor = editor.state.selection.main.head;
    document.querySelector(".figure-mode").dataset.coldSwitchTag = "same-figure";
  });
  await clickMode("Figure");
  await visible(".figure-mode");
  check(await page.evaluate(() => document.querySelector(".figure-mode").dataset.coldSwitchTag === "same-figure"), "returning to Figure preserves its mounted instance");
  await clickMode("Paper");
  await visible(".paper .cm-editor");
  check(await page.evaluate(() => window.__flux.editors.at(-1) === window.__coldSwitchEditor && window.__coldSwitchEditor.state.selection.main.head === window.__coldSwitchCursor), "Paper keeps its editor instance and cursor after the cold-load recovery");
  check(realErrors(page).length === 0, `no renderer errors: ${realErrors(page).join("; ")}`);
  console.log(`MODE COLD SWITCH VERIFY: PASS (${checks} checks)`);
} catch (error) {
  console.error("MODE COLD SWITCH VERIFY: FAIL", error);
  console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-1500), paper: !!document.querySelector(".paper"), errors: window.__flux?.editors?.length })));
  process.exitCode = 1;
} finally {
  await browser.close();
}
