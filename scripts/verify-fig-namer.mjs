// Figure Namer (Ctrl+R) + rail toggles — the keyboard-first paths that
// verify-m11-m14.mjs (dblclick entry) doesn't cover:
//   • Ctrl+R opens the namer for the active figure; Ctrl+R again commits
//     (the open → digits → Ctrl+R rhythm)
//   • "+ New family…" stages a custom family ("Movie" → "Mov. {num}{panel}"),
//     commit persists it and the badge shows the initials ("M1")
//   • nickname typed in the namer lands on the figure (dim span in the row)
//   • Ctrl+B toggles the left sidebar (no text selected), Ctrl+Shift+B the
//     right rail; both restore
//   Run (dev server on :1420 must be up): node scripts/verify-fig-namer.mjs
import { launch, gotoApp, clickMode, shot, sleep, errors } from "./lib/driver.mjs";

const FIG = ".sidebar section:nth-of-type(2)";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure").catch(() => {});
await sleep(600);

const namerOpen = () => page.evaluate(() => !!document.querySelector(".namer"));
const rowTexts = () => page.$$eval(`${FIG} li`, (els) => els.map((e) => e.textContent.trim()));

// Focus the canvas so keyboard.ts owns the keys.
await page.click(".canvas-wrap").catch(() => {});
await sleep(200);

// --- Ctrl+R opens; Ctrl+R commits ----------------------------------------------
await page.keyboard.down("Control");
await page.keyboard.press("KeyR");
await page.keyboard.up("Control");
await sleep(250);
const openedByKey = await namerOpen();
// number input is focused + selected; type a number then commit via Ctrl+R
await page.keyboard.type("1");
await page.keyboard.down("Control");
await page.keyboard.press("KeyR");
await page.keyboard.up("Control");
await sleep(300);
const committedByKey = !(await namerOpen());

// --- Ctrl+R is inert while typing in an input -----------------------------------
await page.evaluate(() => {
  const el = document.createElement("input");
  el.id = "namer-typing-probe";
  document.body.appendChild(el);
  el.focus();
});
await page.keyboard.down("Control");
await page.keyboard.press("KeyR");
await page.keyboard.up("Control");
await sleep(200);
const inertWhileTyping = !(await namerOpen());
await page.evaluate(() => {
  document.getElementById("namer-typing-probe")?.remove();
});
await page.click(".canvas-wrap").catch(() => {});
await sleep(150);

// --- custom family + nickname through the namer ---------------------------------
await page.keyboard.down("Control");
await page.keyboard.press("KeyR");
await page.keyboard.up("Control");
await sleep(250);
await page.click(".namer .fam.add");
await sleep(150);
await page.keyboard.type("Movie"); // display name (templates auto-suggest)
await page.keyboard.press("Enter"); // accept → back to main view, family staged
await sleep(150);
await page.click(".namer .nick");
await page.keyboard.type("teaser clip");
await page.keyboard.press("Enter"); // commit
await sleep(350);
const rows = await rowTexts();
const badgesNow = await page.$$eval(`${FIG} .fnum`, (els) => els.map((e) => e.textContent.trim()));
const movieOk = rows.some((t) => t.includes("Movie 1") && t.includes("teaser clip"));
const movieBadgeOk = badgesNow.includes("M1");

// --- Ctrl+B / Ctrl+Shift+B rail toggles ------------------------------------------
const hasSidebar = () => page.evaluate(() => !!document.querySelector(".sidebar"));
const hasInspector = () => page.evaluate(() => !!document.querySelector(".inspector"));
const chord = async (shift) => {
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyB");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(250);
};
const sb0 = await hasSidebar();
await chord(false);
const sbHidden = !(await hasSidebar());
await chord(false);
const sbBack = await hasSidebar();
const insp0 = await hasInspector();
await chord(true);
const inspToggled = (await hasInspector()) !== insp0;
await chord(true);
const inspBack = (await hasInspector()) === insp0;
const railsOk = sb0 && sbHidden && sbBack && inspToggled && inspBack;

await shot(page, "fig-namer");
const errs = errors(page);
const res = { openedByKey, committedByKey, inertWhileTyping, movieOk, movieBadgeOk, railsOk };
console.log(JSON.stringify({ ...res, rows, badgesNow, errs }, null, 2));
await browser.close();
if (!Object.values(res).every(Boolean) || errs.length) {
  console.error("\nFIG-NAMER VERIFY: FAIL");
  process.exit(1);
}
console.log("\nFIG-NAMER VERIFY: PASS");
