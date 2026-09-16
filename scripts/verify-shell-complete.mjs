// Phase 4.2 gate (browser) — shell completeness: the global keyboard-shortcut
// reference (all five modes, `?` + title-bar button, Esc, typing-guard), the
// global Settings panel (title-bar gear, FluxLib-folder + update-check
// sections, Esc), the title-bar mode strip (top-bar rework 2026-07: the left
// activity strip moved into the title bar; Ctrl+1–5 switch modes), and the
// Home recents remove/clear actions.
//   Run (dev server on :1420 must be up): node scripts/verify-shell-complete.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, shot } from "./lib/driver.mjs";

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

// --- the title-bar mode strip (top-bar rework) ------------------------------
ok(!(await page.$("nav.rail")), "the left activity strip is gone (modes live in the title bar)");
const stripLabels = await page.$$eval(".titlebar .modestrip button", (els) => els.map((e) => e.getAttribute("aria-label")));
ok(
  JSON.stringify(stripLabels) === JSON.stringify(["Figure", "Paper", "Slide", "Library", "Reader"]),
  "the title bar lists all five modes in order",
  stripLabels.join(","),
);
const pressCtrlDigit = async (d) => {
  await page.keyboard.down("Control");
  await page.keyboard.press(`Digit${d}`);
  await page.keyboard.up("Control");
  await sleep(400);
};
const activeMode = () => page.$eval(".titlebar .modestrip button.active", (e) => e.getAttribute("aria-label")).catch(() => "");
await pressCtrlDigit(2);
const afterTwo = await activeMode();
await pressCtrlDigit(4);
const afterFour = await activeMode();
ok(afterTwo === "Paper" && afterFour === "Library", `Ctrl+2/Ctrl+4 switch modes (→ ${afterTwo} → ${afterFour})`);
await clickMode(page, "Paper").catch(() => {});
await sleep(300);

// --- global Help + Settings via the title bar --------------------------------
const tbHelp = '.titlebar button[aria-label="Keyboard shortcuts"]';
const tbGear = '.titlebar button[aria-label="Settings"]';
ok(await page.$eval(tbHelp, (e) => !!e).catch(() => false), "the title bar has a keyboard-shortcuts button");
ok(await page.$eval(tbGear, (e) => !!e).catch(() => false), "the title bar has a Settings gear");

// --- Lighttable launcher ----------------------------------------------------
// The fixture bridge stubs the launch with an error result, so a click must
// surface the "unavailable" toast — proving the button→bridge wiring end to end.
const tbLt = '.titlebar button[aria-label="Lighttable"]';
ok(await page.$eval(tbLt, (e) => !!e).catch(() => false), "the title bar has a Lighttable launcher");
await page.click(tbLt).catch(() => {});
await sleep(300);
const ltToast = await page.$eval(".toasts .toast .t-msg", (e) => e.textContent || "").catch(() => "");
ok(/Lighttable/.test(ltToast), "clicking it in the fixture surfaces the launch-result toast", JSON.stringify(ltToast));
await page.click(".toasts .toast .t-x").catch(() => {});
await sleep(150);

await page.click(tbHelp);
await sleep(200);
ok(await helpOpen(), "the title-bar help button opens the reference");
await page.keyboard.press("Escape");
await sleep(150);

await page.click(tbGear);
await sleep(250);
ok(await setOpen(), "the title-bar gear opens Settings (reachable from every mode)");
const setText = await page.$eval(setSel, (el) => el.textContent || "").catch(() => "");
ok(/FluxConfig folder/.test(setText), "Settings shows the FluxConfig folder section (renamed from Library folder in the FluxConfig refactor)");
ok(/Updates|newer version/.test(setText), "Settings shows the update-check toggle");
const libPath = await page.$eval(`${setSel} .libpath`, (el) => el.textContent?.trim()).catch(() => "");
ok(!!libPath && libPath !== "—", `the resolved library path is displayed (${libPath})`);

// The tabbed settings surface owns focus and each pane's scrolling. A backwards
// Tab from the dialog previously escaped into the obscured Paper status bar.
await page.keyboard.down("Shift");
await page.keyboard.press("Tab");
await page.keyboard.up("Shift");
ok(await page.$eval(`${setSel} .close`, el => document.activeElement === el), "Shift+Tab from Settings wraps to Done");
await page.keyboard.press("Tab");
ok(await page.$eval(`${setSel} .x`, el => document.activeElement === el), "Tab from Done wraps to Close inside Settings");
await page.click("#settings-tab-figure");
const collectionRows = await page.$$eval("#settings-pane-figure .row", rows => rows.map(row => {
  const select = row.querySelector("select"), box = select.getBoundingClientRect();
  return { x: box.x, y: box.y, height: box.height, font: getComputedStyle(select).fontSize };
}));
ok(collectionRows.length === 2 && collectionRows[0].x === collectionRows[1].x && collectionRows[1].y >= collectionRows[0].y + collectionRows[0].height,
  "palette and colormap defaults have aligned, separate control rows");
ok(collectionRows.every(r => r.height === 24 && r.font === "12px"), "collection defaults use the shared compact control sizing");
await page.setViewport({ width: 1024, height: 620 });
await page.click("#settings-tab-corrections");
await page.$eval("#settings-pane-corrections", el => { el.scrollTop = 220; });
const correctionScroll = await page.$eval("#settings-pane-corrections", el => el.scrollTop);
await page.click("#settings-tab-figure");
ok(await page.$eval("#settings-pane-figure", el => el.scrollTop === 0), "Figure opens at its own top after scrolling Corrections");
await page.click("#settings-tab-corrections");
ok(correctionScroll > 0 && await page.$eval("#settings-pane-corrections", (el, y) => el.scrollTop === y, correctionScroll),
  "returning to Corrections preserves its scroll position");
await page.keyboard.press("Home");
ok(await page.$eval("#settings-tab-general", el => document.activeElement === el && el.getAttribute("aria-selected") === "true"), "Home selects and focuses the first settings tab");
await page.click("#settings-tab-figure");
await page.setViewport({ width: 1440, height: 900 });
await shot(page, "settings-refined");
await page.keyboard.press("Escape");
await sleep(200);
ok(!(await setOpen()), "Esc closes Settings");
await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Settings", null, { label: "Settings focus returned" });
ok(await page.$eval(tbGear, el => document.activeElement === el), "closing Settings returns focus to its invoking control");

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
await page.click(".titlebar .brand").catch(() => {});
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
