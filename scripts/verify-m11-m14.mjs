// M11 (no window.prompt) + M14 (figure number badges) — figure-families era.
// A figure's name is DERIVED (family + number, figfamily.ts), so double-click
// opens the Figure Namer (Ctrl+R popup) instead of an inline text field:
//   • dblclick a figure row → .namer appears (never window.prompt)
//   • digits + Enter renumber with insert-and-shift (badges + names follow)
//   • ArrowDown cycles the family (figure → supplementary → …), Enter commits
//   • Escape cancels without touching the model
// Canvas/layer rows keep the old inline rename — not exercised here.
import { launch, gotoApp, clickMode, shot, sleep, errors } from "./lib/driver.mjs";

const FIG = ".sidebar section:nth-of-type(2)";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure").catch(() => {});
await sleep(600);

await page.evaluate(() => {
  window.__promptCalled = false;
  window.prompt = () => {
    window.__promptCalled = true;
    return null;
  };
});

const items = () => page.$$eval(`${FIG} .item`, (els) => els.map((e) => e.textContent.trim()));
const badges = () => page.$$eval(`${FIG} .fnum`, (els) => els.map((e) => e.textContent.trim()));
const namerOpen = () => page.evaluate(() => !!document.querySelector(".namer"));

async function openNamerOnRow(i) {
  await page.evaluate(
    ({ sel, idx }) => {
      document.querySelectorAll(`${sel} li .item`)[idx].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    },
    { sel: FIG, idx: i },
  );
  await sleep(200);
  return namerOpen();
}

// Ensure ≥2 figures (the demo may open with one) — the + button appends.
if ((await items()).length < 2) {
  await page.click(`${FIG} .mini`);
  await sleep(250);
}
const startItems = await items();
const startBadges = await badges();
const n = startItems.length;

// --- renumber: last figure → number 1 (insert-and-shift) -----------------------
const opened1 = await openNamerOnRow(n - 1);
await page.evaluate(() => {
  const el = document.querySelector(".namer .numin");
  el.focus();
  el.select();
});
await page.keyboard.type("1");
await page.keyboard.press("Enter");
await sleep(300);
const afterRenumber = { items: await items(), badges: await badges() };
const renumberOk =
  opened1 &&
  afterRenumber.items[n - 1].startsWith("Figure 1") &&
  afterRenumber.badges[n - 1] === "1" &&
  afterRenumber.items[0].startsWith("Figure 2") &&
  afterRenumber.badges[0] === "2" &&
  !(await namerOpen());

// --- Escape cancels ------------------------------------------------------------
const opened2 = await openNamerOnRow(0);
await page.keyboard.type("7");
await page.keyboard.press("Escape");
await sleep(250);
const afterEsc = { items: await items(), badges: await badges() };
const escOk =
  opened2 &&
  !(await namerOpen()) &&
  JSON.stringify(afterEsc.items) === JSON.stringify(afterRenumber.items) &&
  JSON.stringify(afterEsc.badges) === JSON.stringify(afterRenumber.badges);

// --- family switch: ArrowDown → supplementary, Enter ---------------------------
const opened3 = await openNamerOnRow(n - 1);
await page.keyboard.press("ArrowDown"); // figure → supplementary
await sleep(120);
await page.keyboard.press("Enter");
await sleep(300);
const afterFamily = { items: await items(), badges: await badges() };
const familyOk =
  opened3 &&
  afterFamily.items[n - 1].startsWith("Supplementary Figure 1") &&
  afterFamily.badges[n - 1] === "S1" &&
  afterFamily.items[0].startsWith("Figure 1") && // main family compacted
  afterFamily.badges[0] === "1";

const noNativePrompt = await page.evaluate(() => window.__promptCalled !== true);

await shot(page, "m11-m14-figure-namer");
const errs = errors(page);
const res = { renumberOk, escOk, familyOk, noNativePrompt };
console.log(JSON.stringify({ ...res, startItems, startBadges, afterRenumber, afterFamily, errs }, null, 2));
await browser.close();
if (!Object.values(res).every(Boolean) || errs.length) {
  console.error("\nM11-M14 VERIFY: FAIL");
  process.exit(1);
}
console.log("\nM11-M14 VERIFY: PASS");
