// Live GUI verification of the W2 multi-select editor: keyboard shortcuts
// (⌘/Ctrl+D duplicate, C/V copy-paste, G group, ]/[ z-order) dispatched as REAL
// DOM key events through SlideStage.onKey, plus the Inspector Arrange buttons.
// Confirms the full path GUI → ops → deck, not just the pure ops (that's
// verify-slide-arrange.ts). Run with the dev server up on :1420.
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const { browser, page } = await launch();
const log = (o) => console.log(JSON.stringify(o, null, 2));

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Slide");
  await sleep(900);

  // Seed a clean slide with three text boxes at known positions via the ops core,
  // then select all three. (commitDeck drives the same write path the GUI uses.)
  const seed = await page.evaluate(() => {
    const F = window.__flux;
    if (!F?.slide) return { err: "no __flux.slide" };
    const deck = F.get(F.slide.deck);
    if (!deck) return { err: "no deck loaded" };
    const sid = F.get(F.slide.activeSlideId);
    const ids = [];
    F.slide.commitDeck((d) => {
      // clear any existing elements on the active slide for a clean count
      const s = F.slideOps.slideById(d, sid);
      s.elements = [];
      for (const [i, [x, y]] of [[0, 0], [200, 100], [400, 300]].entries()) {
        const id = F.slideOps.addTextBox(d, sid, {
          x, y, width: 100, height: 40, blocks: [F.slideOps.makeBlock("T" + i)],
        });
        ids.push(id);
      }
    });
    F.slide.selection.set(ids);
    return { sid, ids, count: F.slideOps.slideById(F.get(F.slide.deck), sid).elements.length };
  });
  if (seed.err) throw new Error("seed failed: " + seed.err);

  const readState = () =>
    page.evaluate(() => {
      const F = window.__flux;
      const d = F.get(F.slide.deck);
      const sid = F.get(F.slide.activeSlideId);
      const s = F.slideOps.slideById(d, sid);
      return {
        count: s.elements.length,
        order: s.elements.map((e) => e.id),
        groups: s.elements.map((e) => e.groupId ?? null),
        sel: F.get(F.slide.selection),
        canUndo: F.get(F.slide.canUndo),
      };
    });

  // Make sure the stage window-key handler is live (click the stage surface).
  await page.evaluate(() => {
    const el = document.querySelector(".stage-wrap .stage") || document.querySelector(".stage-wrap");
    el?.scrollIntoView();
  });
  await sleep(150);

  const results = {};
  const MOD = process.platform === "darwin" ? "Meta" : "Control";

  // helper: keep selection on the seeded three (some ops clear it)
  const reselect = (ids) => page.evaluate((x) => window.__flux.slide.selection.set(x), ids);

  // 1. Cmd/Ctrl+D duplicate → count 3 → 6, selection becomes the new clones
  await reselect(seed.ids);
  await page.keyboard.down(MOD); await page.keyboard.press("KeyD"); await page.keyboard.up(MOD);
  await sleep(200);
  results.duplicate = await readState();

  // undo the duplicate to get back to 3
  await page.keyboard.down(MOD); await page.keyboard.press("KeyZ"); await page.keyboard.up(MOD);
  await sleep(200);
  results.afterUndo = await readState();

  // 2. copy + paste (Cmd+C then Cmd+V) → 3 → 6
  await reselect(seed.ids);
  await page.keyboard.down(MOD); await page.keyboard.press("KeyC"); await page.keyboard.up(MOD);
  await sleep(120);
  await page.keyboard.down(MOD); await page.keyboard.press("KeyV"); await page.keyboard.up(MOD);
  await sleep(200);
  results.paste = await readState();
  // undo paste
  await page.keyboard.down(MOD); await page.keyboard.press("KeyZ"); await page.keyboard.up(MOD);
  await sleep(150);

  // 3. group (Cmd+G) → the three share one non-null groupId
  await reselect(seed.ids);
  await page.keyboard.down(MOD); await page.keyboard.press("KeyG"); await page.keyboard.up(MOD);
  await sleep(200);
  results.group = await readState();

  // 4. z-order: send-to-back the LAST element (Shift+Cmd+[) → it moves to index 0
  await page.evaluate((last) => window.__flux.slide.selection.set([last]), seed.ids[2]);
  await page.keyboard.down(MOD); await page.keyboard.down("Shift");
  await page.keyboard.press("BracketLeft");
  await page.keyboard.up("Shift"); await page.keyboard.up(MOD);
  await sleep(200);
  results.sendToBack = await readState();

  // 5. Inspector Arrange buttons: align-left via the ⇤ button
  await reselect(seed.ids);
  await sleep(100);
  const alignBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".inspector button")].find(
      (e) => (e.getAttribute("title") || "") === "Align left"
    );
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(200);
  results.alignLeftButton = { clicked: alignBtn, ...(await readState()) };
  results.alignLeftXs = await page.evaluate(() => {
    const F = window.__flux, d = F.get(F.slide.deck), sid = F.get(F.slide.activeSlideId);
    return F.slideOps.slideById(d, sid).elements.map((e) => e.x);
  });

  await shot(page, "w2-arrange-live");

  // ---- assertions ----
  const fails = [];
  const chk = (c, m) => { if (!c) fails.push(m); };
  chk(seed.count === 3, `seed count 3 (got ${seed.count})`);
  chk(results.duplicate.count === 6, `duplicate → 6 (got ${results.duplicate.count})`);
  chk(results.duplicate.sel.length === 3 && results.duplicate.sel.every((id) => !seed.ids.includes(id)),
    "duplicate selects the new clones");
  chk(results.afterUndo.count === 3, `undo duplicate → 3 (got ${results.afterUndo.count})`);
  chk(results.paste.count === 6, `copy+paste → 6 (got ${results.paste.count})`);
  chk(results.group.groups.filter((g) => g).length === 3 &&
      new Set(results.group.groups.filter((g) => g)).size === 1,
    "group → 3 elements share one groupId");
  chk(results.sendToBack.order[0] === seed.ids[2], "send-to-back moves the element to index 0");
  chk(results.alignLeftButton.clicked, "Align-left button exists + clickable");
  chk(results.alignLeftXs.length && new Set(results.alignLeftXs).size === 1,
    `align-left button → all x equal (got ${JSON.stringify(results.alignLeftXs)})`);

  log({ seed, results, realErrors: realErrors(page), fails });
  if (fails.length) { console.error("\nW2 LIVE FAILED:\n" + fails.join("\n")); process.exitCode = 1; }
  else console.log("\nW2 ARRANGE LIVE GUI VERIFICATION PASSED");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
