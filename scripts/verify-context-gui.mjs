// Context layer, GUI half (ui tier): first-class Context documents, palette
// routing and context-stamped feedback capture into the memBridge ledger.
import { launch, gotoApp, clickMode, realErrors, waitFor } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Paper").catch(() => {});
await waitFor(page, () => !!(window.__fluxView || (window.__flux?.editors ?? [])[0]), null, {
  timeout: 15000,
  label: "paper editor mounted",
});

const checks = [];
const ok = (cond, msg) => {
  checks.push([!!cond, msg]);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

const key = (code, opts = {}) =>
  page.evaluate(
    ({ code, opts }) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...opts }));
    },
    { code, opts },
  );

// --- 1. Context docs are first-class documents ------------------------------
{
  const picker = await page.evaluate(() => {
    // Read the folder's LABEL, not the whole head row: since b6a741b (the file
    // browser upgrade, 2026-09-06) the row also carries the "+ New document"
    // and "New folder" actions, so its textContent is "Context +".
    const heads = [...document.querySelectorAll(".docpicker .dp-head .folder-label span")].map((h) => h.textContent?.trim());
    const items = [...document.querySelectorAll(".docpicker .dp-item")].map((b) => b.getAttribute("title"));
    const labels = [...document.querySelectorAll(".docpicker .dp-title")].map(b => b.textContent);
    return { heads, items, labels };
  });
  ok(picker.heads.includes("Context"), "picker shows the Context group");
  ok(picker.items.includes("Context/ProjectContext.qmd"), "project context listed");
  ok(picker.labels.some(s => s.startsWith("Project context — ")), "picker uses the ProjectContext title");
  ok(picker.items.includes("Context/NOTEBOOK.md") && picker.items.includes("Context/RULES.md"), "notebook + rules listed (.md docs)");
}

// --- 2. open the project context from the picker ------------------------------------
{
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".docpicker .dp-item")].find(
      (b) => b.getAttribute("title") === "Context/ProjectContext.qmd",
    );
    btn?.click();
  });
  await waitFor(
    page,
    () => (window.__fluxView?.state.doc.toString() ?? "").includes("## Background"),
    null,
    { timeout: 8000, label: "project context doc loaded in the editor" },
  );
  ok(true, "project context opens in the paper editor");
}

// --- 3. shell Ctrl+K routes to the PAPER palette; command switches docs -----
{
  await key("KeyK", { ctrlKey: true });
  await waitFor(page, () => !!document.querySelector(".cp input"), null, { timeout: 5000, label: "paper palette open" });
  await page.type(".cp input", "open notebook");
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    () => (window.__fluxView?.state.doc.toString() ?? "").includes("# Project notebook"),
    null,
    { timeout: 8000, label: "notebook loaded via palette" },
  );
  ok(true, "Ctrl+K → paper palette → Open notebook switches the doc");
}

// Annotation interaction coverage lives in verify-annotation-surface-gui.mjs.

// --- 5. figure mode gets the GLOBAL palette ---------------------------------
{
  await clickMode(page, "Figure");
  await new Promise((r) => setTimeout(r, 600)); // mode mount settle (keep-alive swap)
  await key("KeyK", { ctrlKey: true });
  await waitFor(page, () => !!document.querySelector(".global-palette .cp input"), null, {
    timeout: 5000,
    label: "global palette open in figure mode",
  });
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll(".global-palette .cp li .ct")].map((n) => n.textContent?.trim()),
  );
  ok(titles.includes("Open project context") && titles.includes("Annotate…"), "global palette carries the context/agent commands");  await page.keyboard.press("Escape");
}

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);

await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(
  `##VERIFY## ${JSON.stringify({ script: "verify-context-gui", ok: failed === 0, checks: checks.length, failed })}`,
);
console.log(failed ? `verify-context-gui: FAIL (${failed}/${checks.length})` : `verify-context-gui: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
