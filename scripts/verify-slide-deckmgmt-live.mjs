// Live GUI verification of W7 deck management (C6): duplicate a deck (assets +
// " copy" title) and soft-delete a deck (leaves the project registry). Uses
// ?fixture=demo for a real project + file bridge. Dialogs are auto-accepted.
import { launch, gotoApp, clickMode, shot, realErrors, sleep, APP_URL } from "./lib/driver.mjs";

const { browser, page } = await launch();
page.on("dialog", (d) => d.accept()); // auto-accept the delete confirm
const log = (o) => console.log(JSON.stringify(o, null, 2));

const deckTitles = () =>
  page.evaluate(() => [...document.querySelectorAll(".deckpicker .dp-item .dp-title")].map((n) => n.textContent));
const clickAct = (deckIndex, sel) =>
  page.evaluate((i, s) => {
    const li = document.querySelectorAll(".deckpicker li")[i];
    const b = li?.querySelector(s);
    if (b) { b.click(); return true; }
    return false;
  }, deckIndex, sel);

try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  await clickMode(page, "Slide");
  // wait until the deck picker has rendered its first deck (robust under load)
  for (let i = 0; i < 40 && (await deckTitles()).length === 0; i++) await sleep(200);

  // ensure at least 2 decks: click "+ New deck"
  await page.evaluate(() => document.querySelector(".deckpicker .dp-new")?.click());
  await sleep(900);
  const start = await deckTitles();

  // duplicate the FIRST deck (its ⧉ button — JS-click works even while hover-hidden)
  await clickAct(0, ".dp-act:not(.dp-del)");
  await sleep(1100);
  const afterDup = await deckTitles();

  // delete the LAST deck (a ✕ button); dialog auto-accepts
  const beforeDel = (await deckTitles()).length;
  await clickAct(afterDup.length - 1, ".dp-del");
  await sleep(1000);
  const afterDel = await deckTitles();

  await shot(page, "w7-deckmgmt-live");

  const fails = [];
  const chk = (c, m) => { if (!c) fails.push(m); };
  chk(start.length >= 2, `"+ New deck" creates a second deck (got ${start.length})`);
  chk(afterDup.length === start.length + 1, `duplicate adds a deck (${start.length} → ${afterDup.length})`);
  chk(afterDup.some((t) => /copy/i.test(t || "")), `the duplicate is titled "… copy" (titles: ${JSON.stringify(afterDup)})`);
  chk(afterDel.length === beforeDel - 1, `delete removes a deck from the list (${beforeDel} → ${afterDel.length})`);

  log({ start, afterDup, afterDel, realErrors: realErrors(page), fails });
  if (fails.length) { console.error("\nW7 DECKMGMT LIVE FAILED:\n" + fails.join("\n")); process.exitCode = 1; }
  else console.log("\nW7 DECK MANAGEMENT LIVE GUI VERIFICATION PASSED");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
