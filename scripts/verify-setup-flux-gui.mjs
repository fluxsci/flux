#!/usr/bin/env node
// "Set up Flux…" (2026-10-03) in the real GUI against the browser fixture's controllable machine
// (memBridge window.__fluxSetupFixture): the window opens by itself only on a first run, every row
// renders its detection state, each action is wired (Add to terminal; Install Quarto with live
// progress, Cancel and a failure message; Add PDF support gated on Quarto; fluxplot copy lines;
// agent detection gating Connect), Done records the pref, and the window reopens from the
// command palette, Settings, and the Word-export dead end ("Install Quarto…").
import { launch, gotoApp, clickMode, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-setup-flux-gui");
const { browser, page } = await launch({ width: 1400, height: 1000 });
const base = `${APP_URL.replace(/\/$/, "")}/?fixture=demo`;
const dialog = "[data-setup-flux]";
const row = (name) => `${dialog} [data-setup-row="${name}"]`;
const status = (name) => page.$eval(`${row(name)} [data-status]`, (n) => n.getAttribute("data-status")).catch(() => null);
const click = (sel) => page.$eval(sel, (b) => b.click());
const fixture = (fn, arg) => page.evaluate(fn, arg);

try {
  // --- not a first run: nothing opens by itself -------------------------------------------------
  await gotoApp(page, { url: base, settle: 1500 });
  await new Promise((r) => setTimeout(r, 800)); // the startup check's bridge retry window (no condition to wait on: absence)
  h.eq(await page.$(dialog), null, "an ordinary launch does not open the window");

  // --- first run: opens by itself, every row reports "missing" -------------------------------------
  await page.evaluate(() => localStorage.setItem("flux.fixture.setupFirstRun", "1"));
  await gotoApp(page, { url: base, settle: 300 });
  await waitFor(page, (sel) => !!document.querySelector(sel), dialog, { timeout: 8000, label: "first-run window opens" });
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [data-setup-row="agents"]`), dialog, { label: "rows render after detection" });
  const rows = await page.$$eval(`${dialog} [data-setup-row]`, (ns) => ns.map((n) => n.getAttribute("data-setup-row")));
  h.eq(rows, ["terminal", "quarto", "tinytex", "fluxplot", "agents"], "five rows: terminal, Quarto, TinyTeX, fluxplot, agents");
  h.eq([await status("terminal"), await status("quarto"), await status("tinytex")], ["missing", "missing", "missing"], "a fresh machine reads 'missing' on the three installable rows");
  h.ok(await page.$eval(`${row("tinytex")} [data-action="tinytex"]`, (b) => b.disabled), "Add PDF support waits for Quarto");
  h.ok(await page.$eval(`${row("agents")} [data-action="connect"]`, (b) => b.disabled), "Connect is disabled with no agent installed");
  h.ok(await page.evaluate(() => document.activeElement?.closest("[data-setup-flux]") != null), "focus moves into the window");

  // --- the flux command ------------------------------------------------------------------------------
  await click(`${row("terminal")} [data-action="terminal"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} [data-status]`)?.getAttribute("data-status") === "ready", row("terminal"), { label: "terminal row ready" });
  h.ok(/new terminal/i.test(await page.$eval(`${row("terminal")} [data-status]`, (n) => n.textContent)), "Add to terminal → 'Ready — works in new terminal windows'");

  // --- Quarto: progress, Cancel, failure, success ---------------------------------------------------
  await fixture(() => { window.__fluxSetupFixture.state.hold = true; });
  await click(`${row("quarto")} [data-action="quarto"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} [data-status]`)?.getAttribute("data-status") === "installing", row("quarto"), { label: "quarto installing" });
  h.ok(/Downloading… 50%/.test(await page.$eval(`${row("quarto")} .progress`, (n) => n.textContent)), "installing shows live download progress (50 %)");
  await click(`${row("quarto")} [data-action="cancel-quarto"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} [data-status]`)?.getAttribute("data-status") === "missing", row("quarto"), { label: "cancel returns to missing" });
  h.eq(await page.$(`${row("quarto")} [role=alert]`), null, "Cancel returns to 'not installed' with no error");
  await fixture(() => { const s = window.__fluxSetupFixture.state; s.hold = false; s.fail = "Quarto download failed its checksum"; });
  await click(`${row("quarto")} [data-action="quarto"]`);
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [role=alert]`), row("quarto"), { label: "failure surfaces" });
  h.ok(/checksum/.test(await page.$eval(`${row("quarto")} [role=alert]`, (n) => n.textContent)), "a failed install says why, in the row");
  await click(`${row("quarto")} [data-action="quarto"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} [data-status]`)?.getAttribute("data-status") === "ready", row("quarto"), { label: "quarto ready" });
  h.ok(/Quarto 1\.7\.32 — installed by Flux/.test(await page.$eval(`${row("quarto")} [data-status]`, (n) => n.textContent)), "success → 'Quarto 1.7.32 — installed by Flux', error cleared");
  h.eq(await page.$eval(`${row("tinytex")} [data-action="tinytex"]`, (b) => b.disabled), false, "Add PDF support unlocks once Quarto is there");

  // --- TinyTeX ---------------------------------------------------------------------------------------
  await click(`${row("tinytex")} [data-action="tinytex"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} [data-status]`)?.getAttribute("data-status") === "ready", row("tinytex"), { label: "tinytex ready" });
  h.ok(/TinyTeX installed/.test(await page.$eval(`${row("tinytex")} [data-status]`, (n) => n.textContent)), "Add PDF support → 'TinyTeX installed'");

  // --- fluxplot copy lines ---------------------------------------------------------------------------
  h.eq(await page.$$eval(`${row("fluxplot")} [data-copy]`, (ns) => ns.map((n) => n.getAttribute("data-copy"))), ["uv add fluxplot", "pip install fluxplot"], "fluxplot offers the two install lines to copy");

  // --- Done records the pref; the palette reopens; agents detected on reopen -------------------------
  await click(`${dialog} [data-action="done"]`);
  await waitFor(page, (sel) => !document.querySelector(sel), dialog, { label: "Done closes" });
  const prefs = await page.evaluate(() => window.fig.prefsGet());
  h.eq(prefs.onboardingCompleted, true, "Done records onboardingCompleted (never opens by itself again)");
  await fixture(() => { window.__fluxSetupFixture.state.agents.claude = true; });
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  await waitFor(page, () => !!document.querySelector("input"), null, { label: "palette open" });
  await page.keyboard.type("Set up Flux");
  await page.keyboard.press("Enter");
  await waitFor(page, (sel) => !!document.querySelector(`${sel} [data-agent="claude"] [data-status="ready"]`), dialog, { label: "palette reopens with fresh detection" });
  h.ok(true, "the command palette's 'Set up Flux…' reopens the window, re-detecting (Claude Code found)");
  h.eq(await page.$eval(`${row("agents")} [data-action="connect"]`, (b) => b.disabled), false, "a detected agent enables Connect");
  await page.keyboard.press("Escape");
  await waitFor(page, (sel) => !document.querySelector(sel), dialog, { label: "Escape closes" });

  // --- Settings → Set up Flux… --------------------------------------------------------------------------
  await page.evaluate(() => document.querySelector('button[aria-label="Settings"]')?.click());
  await waitFor(page, () => !!document.querySelector("[data-open-setup]"), null, { label: "Settings shows the Setup button" });
  await click("[data-open-setup]");
  await waitFor(page, (sel) => !!document.querySelector(sel), dialog, { label: "Settings opens the window" });
  h.ok(true, "Settings → General → 'Set up Flux…' opens the window");
  await click(`${dialog} [data-action="done"]`);
  await waitFor(page, (sel) => !document.querySelector(sel), dialog, { label: "closed again" });

  // --- the Word-export dead end offers the install ---------------------------------------------------
  await page.evaluate(() => localStorage.removeItem("flux.fixture.setupFirstRun"));
  await gotoApp(page, { url: base, settle: 1500 }); // a fresh fixture machine: no Quarto
  await clickMode(page, "Paper").catch(() => {});
  await waitFor(page, () => [...document.querySelectorAll(".statusbar .seg")].some((b) => /export/i.test(b.textContent || "")), null, { timeout: 8000, label: "Paper status bar" });
  await page.evaluate(() => [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""))?.click());
  await waitFor(page, () => !!document.querySelector(".export-dialog"), null, { label: "export dialog" });
  await page.evaluate(() => [...document.querySelectorAll(".export-dialog .seg")].find((b) => /word/i.test(b.textContent || ""))?.click());
  await waitFor(page, () => !!document.querySelector(".export-dialog [data-install-quarto]"), null, { label: "Install Quarto offered" });
  h.ok(/can install/.test(await page.$$eval(".export-dialog .hint.warn", (ns) => ns.map((n) => n.textContent).join(" "))), "Word without Quarto explains Flux can install it");
  await click(".export-dialog [data-install-quarto]");
  await waitFor(page, (sel) => !!document.querySelector(sel) && !document.querySelector(".export-dialog"), dialog, { label: "export → setup" });
  h.ok(true, "'Install Quarto…' swaps the export dialog for the setup window");
  await click(`${row("quarto")} [data-action="quarto"]`);
  await waitFor(page, (sel) => document.querySelector(`${sel} [data-status]`)?.getAttribute("data-status") === "ready", row("quarto"), { label: "installed from export" });
  await click(`${dialog} [data-action="done"]`);
  await page.evaluate(() => [...document.querySelectorAll(".statusbar .seg")].find((b) => /export/i.test(b.textContent || ""))?.click());
  await waitFor(page, () => !!document.querySelector(".export-dialog"), null, { label: "export dialog again" });
  await page.evaluate(() => [...document.querySelectorAll(".export-dialog .seg")].find((b) => /word/i.test(b.textContent || ""))?.click());
  await waitFor(page, () => !!document.querySelector(".export-dialog") && !document.querySelector(".export-dialog [data-install-quarto]"), null, { label: "Word unblocked" });
  h.eq(await page.$(".export-dialog .hint.warn"), null, "after installing, Word export is no longer blocked (no reload)");

  h.eq(realErrors(page), [], "clean console throughout");
} catch (e) {
  h.fail(String(e?.stack ?? e));
} finally {
  await browser.close();
}
await h.done();
