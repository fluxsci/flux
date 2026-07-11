// Phase 4.2 gate (browser) — shell completeness: the global keyboard-shortcut
// reference (all five modes, `?` + rail button, Esc, typing-guard), the global
// Settings panel (rail gear, FluxLib-folder + update-check sections, Esc), and
// the Home recents remove/clear actions.
//   Run (dev server on :1420 must be up): node scripts/verify-shell-complete.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const URL = "http://127.0.0.1:1420/?fixture=demo";
const { browser, page } = await launch();
await gotoApp(page, { url: URL, settle: 3000 });
await clickMode(page, "Paper").catch(() => {});
await sleep(400);

const helpSel = '.modal[aria-label="Keyboard shortcuts"]';
const setSel = '.modal[aria-label="Settings"]';
const helpOpen = () => page.$eval(helpSel, (el) => !!el).catch(() => false);
const setOpen = () => page.$eval(setSel, (el) => !!el).catch(() => false);

async function pressQuestion() {
  await page.keyboard.down("Shift");
  await page.keyboard.press("Slash");
  await page.keyboard.up("Shift");
}

// --- global Help via "?" ----------------------------------------------------
await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
await pressQuestion();
await sleep(250);
ok(await helpOpen(), "“?” opens the global keyboard reference");
const tabs = await page.$$eval(`${helpSel} .tab`, (els) => els.map((e) => e.textContent?.trim()));
ok(tabs.length === 6, `all modes are tabbed (${tabs.join(", ")})`, String(tabs.length));
ok(["Global", "Paper", "Figure", "Reader", "Library", "Slide"].every((m) => tabs.includes(m)), "tabs cover Global + the five modes");

// switch to the Paper tab → its groups render
const paperIdx = tabs.indexOf("Paper");
await page.$$eval(`${helpSel} .tab`, (els, i) => els[i].click(), paperIdx);
await sleep(150);
const paperGroups = await page.$$eval(`${helpSel} .grp h3`, (els) => els.map((e) => e.textContent));
ok(paperGroups.some((g) => /Editing & view/.test(g || "")), "the Paper tab shows Paper shortcut groups");

// Esc closes
await page.keyboard.press("Escape");
await sleep(200);
ok(!(await helpOpen()), "Esc closes the reference");

// --- typing-guard: "?" in a text field must NOT open Help -------------------
await clickMode(page, "Library").catch(() => {});
await sleep(400);
await page.click(".search").catch(() => {});
await pressQuestion();
await sleep(200);
ok(!(await helpOpen()), "“?” typed into the search box does not open Help (typing-guard)");
const searchVal = await page.$eval(".search", (el) => el.value).catch(() => "");
ok(searchVal.includes("?"), "the “?” lands in the field as text instead", JSON.stringify(searchVal));
await page.$eval(".search", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }).catch(() => {});

// --- global Help + Settings via the rail ------------------------------------
const railHelp = 'nav.rail button[aria-label="Keyboard shortcuts"]';
const railGear = 'nav.rail button[aria-label="Settings"]';
ok(await page.$eval(railHelp, (e) => !!e).catch(() => false), "the rail has a keyboard-shortcuts button");
ok(await page.$eval(railGear, (e) => !!e).catch(() => false), "the rail has a Settings gear");

await page.click(railHelp);
await sleep(200);
ok(await helpOpen(), "the rail help button opens the reference");
await page.keyboard.press("Escape");
await sleep(150);

await page.click(railGear);
await sleep(250);
ok(await setOpen(), "the rail gear opens Settings (reachable from every mode)");
const setText = await page.$eval(setSel, (el) => el.textContent || "").catch(() => "");
ok(/FluxConfig folder/.test(setText), "Settings shows the FluxConfig folder section (renamed from Library folder in the FluxConfig refactor)");
ok(/Updates|newer version/.test(setText), "Settings shows the update-check toggle");
const libPath = await page.$eval(`${setSel} .libpath`, (el) => el.textContent?.trim()).catch(() => "");
ok(!!libPath && libPath !== "—", `the resolved library path is displayed (${libPath})`);
await page.keyboard.press("Escape");
await sleep(200);
ok(!(await setOpen()), "Esc closes Settings");

// --- Home recents remove / clear --------------------------------------------
await page.evaluate(() => {
  localStorage.setItem(
    "flux.recents",
    JSON.stringify([
      { name: "Alpha Study", path: "/tmp/alpha", openedAt: 1 },
      { name: "Beta Paper", path: "/tmp/beta", openedAt: 2 },
    ]),
  );
});
await gotoApp(page, { url: URL, settle: 2800 });
await page.click("nav.rail .item.home").catch(() => {});
await sleep(500);
const rows0 = await page.$$eval(".recent-row", (els) => els.length).catch(() => -1);
const names0 = await page.$$eval(".recent-row .rname", (els) => els.map((e) => e.textContent)).catch(() => []);
// (the demo fixture may also push its own recent, so assert >= the two we seeded)
ok(rows0 >= 2, `Home lists the recents (${rows0})`);
ok(names0.includes("Alpha Study") && names0.includes("Beta Paper"), "both seeded recents are shown");
// remove the first via its × button
await page.$eval(".recent-row .forget", (el) => el.click()).catch(() => {});
await sleep(300);
const rows1 = await page.$$eval(".recent-row", (els) => els.length).catch(() => -1);
ok(rows1 === rows0 - 1, `the × button removes exactly one recent (${rows0} → ${rows1})`);
// clear all
await page.$eval(".clear-recents", (el) => el.click()).catch(() => {});
await sleep(300);
const rows2 = await page.$$eval(".recent-row", (els) => els.length).catch(() => 0);
const stored = await page.evaluate(() => localStorage.getItem("flux.recents"));
ok(rows2 === 0 && stored === "[]", "Clear empties the recents list and persists it", `rows=${rows2} stored=${stored}`);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors during the shell flow", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
