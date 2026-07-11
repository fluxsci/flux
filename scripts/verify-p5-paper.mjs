// P5 — Paper UX completeness. Drives the real editor: Cmd/Ctrl-F opens the find/replace panel
// (PAP-10) and the content DOM carries native spellcheck (PAP-11). Chip hint (PAP-22) is a
// static title attribute, asserted present.
//   Run (dev server on :1420 must be up): node scripts/verify-p5-paper.mjs
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const res = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  const spellcheck = view.contentDOM.getAttribute("spellcheck");

  // Ctrl-F → the search panel (searchKeymap → openSearchPanel). Mod = Ctrl on Linux headless,
  // so send ONLY ctrlKey — ctrl+meta together reads as "Ctrl-Cmd-f" and matches nothing.
  view.contentDOM.focus();
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true }),
  );
  await raf();
  await raf();
  const panel = view.dom.querySelector(".cm-search");
  const hasInput = !!panel?.querySelector("input");

  return { spellcheck, searchPanel: !!panel, hasInput };
});

// WS-7.5 (PAP-22 behavioral): read the LIVE chip title attributes while the
// page is still open — replaces the old widgets.ts regex presence check.
const hints = await page.evaluate(() => {
  const fig = document.querySelector(".cm-content .flux-figref:not(.unresolved)");
  const cite = document.querySelector(".cm-content .flux-cite:not(.unresolved)");
  return { fig: fig?.title ?? "(no figref chip)", cite: cite?.title ?? "(no cite chip)" };
});
const errs = realErrors(page);
await browser.close();

if (res.error) {
  console.error("\nP5 PAPER VERIFY: FAIL —", res.error);
  process.exit(1);
}
console.log("PAP-11 — native spellcheck on the content DOM:");
assert(res.spellcheck === "true", "the editor content DOM has spellcheck=\"true\"");
console.log("PAP-10 — find/replace panel opens on Cmd/Ctrl-F:");
assert(res.searchPanel, "the .cm-search panel is present after Cmd/Ctrl-F");
assert(res.hasInput, "the search panel has a query input");

console.log("PAP-22 — chip double-click hint (behavioral, WS-7.5):");
assert(/Double-click to jump/.test(hints.fig), `figref chip title hints double-click ("${hints.fig.slice(0, 40)}")`);
assert(/Double-click to edit/.test(hints.cite), `cite chip title hints double-click ("${hints.cite.slice(0, 40)}")`);

if (errs.length) {
  console.error("\nP5 PAPER VERIFY: FAIL — console errors:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
console.log("\nP5 PAPER VERIFY: PASS");
