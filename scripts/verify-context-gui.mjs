// Principal-agent scheme, GUI half (ui tier — dev server on :1420, demo fixture).
//   node scripts/verify-context-gui.mjs
// Covers: Context docs scaffolded into the fixture + surfaced as first-class
// paper documents (grouped picker), palette routing (shell Ctrl+K → paper
// palette; context command switches the doc; figure mode gets the global
// palette), the feedback capture popover (stamped note → memBridge ledger,
// Send event), and the Agent drawer's graceful no-PTY fallback.
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
    const heads = [...document.querySelectorAll(".docpicker .dp-head")].map((h) => h.textContent?.trim());
    const items = [...document.querySelectorAll(".docpicker .dp-item")].map((b) => b.getAttribute("title"));
    return { heads, items };
  });
  ok(picker.heads.includes("Context"), "picker shows the Context group");
  ok(picker.items.includes("Context/Project/MISSION.qmd"), "mission listed");
  ok(picker.items.includes("Context/NOTEBOOK.md") && picker.items.includes("Context/RULES.md"), "notebook + rules listed (.md docs)");
}

// --- 2. open the mission from the picker ------------------------------------
{
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".docpicker .dp-item")].find(
      (b) => b.getAttribute("title") === "Context/Project/MISSION.qmd",
    );
    btn?.click();
  });
  await waitFor(
    page,
    () => (window.__fluxView?.state.doc.toString() ?? "").includes("## Question"),
    null,
    { timeout: 8000, label: "mission doc loaded in the editor" },
  );
  ok(true, "mission opens in the paper editor");
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

// --- 4. feedback capture: stamped note + send -------------------------------
{
  await key("KeyM", { ctrlKey: true, shiftKey: true });
  await waitFor(page, () => !!document.querySelector(".fc textarea"), null, { timeout: 5000, label: "capture popover open" });
  const stampLine = await page.evaluate(() => document.querySelector(".fc-stamp")?.textContent ?? "");
  ok(/paper/.test(stampLine) && /NOTEBOOK\.md/.test(stampLine), `stamp previews the live context (${stampLine || "EMPTY"})`);
  await page.type(".fc textarea", "tighten this paragraph");
  await page.evaluate(() => {
    const add = [...document.querySelectorAll(".fc button")].find((b) => b.textContent?.trim() === "Add");
    add?.click();
  });
  await waitFor(
    page,
    () => {
      const f = window.fig?._files;
      if (!f) return false;
      for (const k of f.keys()) if (k.endsWith(".meta/feedback.ndjson")) return true;
      return false;
    },
    null,
    { timeout: 8000, label: "ledger written" },
  );
  const ledger = await page.evaluate(() => {
    const f = window.fig._files;
    for (const [k, v] of f.entries()) {
      if (k.endsWith(".meta/feedback.ndjson")) return new TextDecoder().decode(v);
    }
    return "";
  });
  const events = ledger.trim().split("\n").map((l) => JSON.parse(l));
  const note = events.find((e) => e.kind === "note");
  ok(note && note.text === "tighten this paragraph", "note appended to the ledger");
  ok(note?.context?.surface === "paper" && note?.context?.doc?.path === "Context/NOTEBOOK.md", "note carries the paper context stamp (surface + docRel)");

  // Send (the popover stays open after Add? it closes — reopen)
  await key("KeyM", { ctrlKey: true, shiftKey: true });
  await waitFor(page, () => !!document.querySelector(".fc textarea"), null, { timeout: 5000, label: "capture popover reopened" });
  await page.evaluate(() => {
    const send = [...document.querySelectorAll(".fc button")].find((b) => b.textContent?.trim().startsWith("Send"));
    send?.click();
  });
  await waitFor(
    page,
    () => {
      const f = window.fig._files;
      for (const [k, v] of f.entries()) {
        if (k.endsWith(".meta/feedback.ndjson")) return new TextDecoder().decode(v).includes('"kind":"send"');
      }
      return false;
    },
    null,
    { timeout: 8000, label: "send event appended" },
  );
  ok(true, "Send appends the review-pass boundary");
}

// --- 5. the drawer is GONE (terminal-first rework, 2026-07-20) --------------
{
  await key("KeyJ", { ctrlKey: true, shiftKey: true });
  await new Promise((r) => setTimeout(r, 400)); // annotated: give a would-be drawer time to mount
  const drawer = await page.evaluate(() => !!document.querySelector(".pd"));
  ok(!drawer, "Ctrl+Shift+J no longer opens an in-app drawer (flux principal owns sessions)");
}

// --- 6. figure mode gets the GLOBAL palette ---------------------------------
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
  ok(titles.includes("Open mission") && titles.includes("Copy principal prompt"), "global palette carries the context/agent commands");
  ok(!titles.includes("Toggle agent drawer"), "the retired drawer command is gone from the palette");
  await page.keyboard.press("Escape");
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
