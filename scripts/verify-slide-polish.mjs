// Phase 4.1 (Slide polish) — locks in the two dangerous fixes surfaced by the audit:
//  (1) the Present overlay must own the keyboard — with an element selected,
//      Backspace/Delete/arrows during a presentation must NOT delete or nudge it
//      (SlideStage focused is gated on !presentOpen; SlideMode onKey early-returns);
//  (2) Present on a slideless deck must not latch (button disabled; F5 is a no-op).
//   Run (dev server on :1420 must be up): node scripts/verify-slide-polish.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  await clickMode(page, "Slide");
  await sleep(1200);

  // Seed a 1-slide deck with a single text element, and SELECT it (the audit's
  // exact precondition — a selection carried into Present).
  const before = await page.evaluate(() => {
    const F = window.__flux;
    F.slide.commitDeck((d) => {
      d.slides.length = 0;
      const s1 = F.slideOps.addSlide(d, { name: "One", layout: "blank" });
      F.slideOps.addTextBox(d, s1.id, { x: 220, y: 160, width: 400, height: 100, blocks: [F.slideOps.makeBlock("Keep me")] });
    });
    const d = F.get(F.slide.deck);
    const s = d.slides[0];
    F.slide.activeSlideId.set(s.id);
    F.slide.selection.set([s.elements[0].id]);
    return { count: s.elements.length, x: s.elements[0].x, y: s.elements[0].y };
  });
  await sleep(300);
  ok(before.count === 1, "seeded one element and selected it");

  // Launch Present, then hammer the destructive keys the stage would otherwise honor.
  await page.keyboard.press("F5");
  await sleep(700);
  ok(await page.evaluate(() => !!document.querySelector(".present")), "F5 launches the presenter (deck has a slide)");
  await page.keyboard.press("Backspace");
  await sleep(120);
  await page.keyboard.press("Delete");
  await sleep(120);
  await page.keyboard.press("ArrowLeft");
  await sleep(120);
  await page.keyboard.press("ArrowUp");
  await sleep(120);
  await page.keyboard.press("Escape"); // close the presenter
  await sleep(400);

  const after = await page.evaluate(() => {
    const F = window.__flux;
    const s = F.get(F.slide.deck).slides[0];
    return { present: !!document.querySelector(".present"), count: s?.elements.length ?? -1, x: s?.elements[0]?.x, y: s?.elements[0]?.y };
  });
  ok(!after.present, "Escape closed the presenter");
  ok(after.count === before.count, `the selected element survived the presentation (${before.count} → ${after.count})`);
  ok(after.x === before.x && after.y === before.y, `the element was not nudged (was ${before.x},${before.y}; now ${after.x},${after.y})`);

  // --- slideless deck: Present must not latch ---------------------------------
  await page.evaluate(() => {
    const F = window.__flux;
    F.slide.commitDeck((d) => { d.slides.length = 0; });
    F.slide.activeSlideId.set(null);
    F.slide.selection.set([]);
  });
  await sleep(300);
  const presentBtnDisabled = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".deckbar button")].find((b) => /Present/.test(b.textContent || ""));
    return btn ? btn.disabled : null;
  });
  ok(presentBtnDisabled === true, "the Present button is disabled on a slideless deck", String(presentBtnDisabled));
  await page.keyboard.press("F5");
  await sleep(400);
  const latched = await page.evaluate(() => !!document.querySelector(".present"));
  ok(!latched, "F5 on a slideless deck does not open (and cannot latch) the presenter");

  const errs = realErrors(page);
  ok(errs.length === 0, "no console/page errors during the slide-polish flow", errs.join(" | "));
} catch (e) {
  console.error("ERROR", e);
  fails++;
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
