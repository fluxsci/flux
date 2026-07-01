// Live GUI verification of W4 Present mode: F5 launch (B22), window-level keys
// (B19), numeric-jump feedback (B17), the presenter panel with a next-slide
// preview (B3), the reduced-motion toggle (B1), and cross-slide nav. Real Chrome
// (WAAPI), dev server on :1420.
import { launch, gotoApp, clickMode, shot, realErrors, sleep, APP_URL } from "./lib/driver.mjs";

const { browser, page } = await launch();
const log = (o) => console.log(JSON.stringify(o, null, 2));

try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  await clickMode(page, "Slide");
  await sleep(1200);

  // Seed a 2-slide deck: slide 1 has 3 beats revealing bullets; slide 2 uses a
  // "slide" transition and distinct text (so the next-preview is recognizable).
  await page.evaluate(() => {
    const F = window.__flux;
    F.slide.commitDeck((d) => {
      d.slides.length = 0;
      const s1 = F.slideOps.addSlide(d, { name: "One", layout: "blank" });
      F.slideOps.addTextBox(d, s1.id, { x: 100, y: 90, width: 900, height: 400, blocks: [
        F.slideOps.makeBlock("Alpha"), F.slideOps.makeBlock("Beta"), F.slideOps.makeBlock("Gamma")] });
      const b1 = F.slideOps.addBeat(d, s1.id, { label: "b1", advance: "click" });
      F.slideOps.addBeat(d, s1.id, { label: "b2", advance: "with-prev" });
      const s2 = F.slideOps.addSlide(d, { name: "Two", layout: "blank" });
      s2.transition = "slide";
      F.slideOps.addTextBox(d, s2.id, { x: 100, y: 90, width: 900, height: 300, blocks: [F.slideOps.makeBlock("SECOND SLIDE")] });
    });
    F.slide.selection.set([]);
    F.slide.activeSlideId.set(F.get(F.slide.deck).slides[0].id);
  });
  await sleep(300);

  // B22: F5 launches Present from the FIRST slide.
  await page.keyboard.press("F5");
  await sleep(700);
  const present0 = await page.evaluate(() => {
    const p = document.querySelector(".present");
    return {
      mounted: !!p,
      mountHasContent: !!document.querySelector(".present .mount .sl-camera .sl-el"),
      hud: document.querySelector(".present .hud span")?.textContent ?? null,
    };
  });

  // B19: window-level keys advance even without clicking into the overlay.
  await page.keyboard.press("ArrowRight"); // beat step (folds with-prev group)
  await sleep(400);
  await page.keyboard.press("ArrowDown"); // → slide 2 (transition "slide")
  await sleep(700);
  const afterNav = await page.evaluate(() => ({
    hud: document.querySelector(".present .hud span")?.textContent ?? null,
    // slide 2's text present in the live mount?
    text: document.querySelector(".present .mount")?.textContent ?? "",
  }));

  // go back to slide 1 so the next-preview (slide 2) is meaningful
  await page.keyboard.press("ArrowUp");
  await sleep(500);

  // B17: numeric jump shows on-screen feedback.
  await page.keyboard.press("Digit2");
  await sleep(200);
  const jump = await page.evaluate(() => document.querySelector(".present .jump")?.textContent ?? null);
  await page.keyboard.press("Escape"); // clear digits (Escape exits? no — Escape closes)
  // NOTE: Escape closes present; re-open for the remaining checks.
  await sleep(300);
  let reopened = await page.evaluate(() => !!document.querySelector(".present"));
  if (!reopened) { await page.keyboard.press("F5"); await sleep(700); }

  // B3: presenter panel (S) shows the next-slide preview.
  await page.keyboard.press("KeyS");
  await sleep(500);
  const panel = await page.evaluate(() => {
    const notes = document.querySelector(".present .notes");
    const nextScaled = document.querySelector(".present .notes .next-scaled");
    return {
      notesOpen: !!notes,
      nextPreviewHasContent: !!nextScaled && nextScaled.children.length > 0,
      hint: document.querySelector(".present .notes-hint")?.textContent ?? "",
    };
  });

  // B1: reduced-motion toggle (M) flips the hint indicator.
  await page.keyboard.press("KeyM");
  await sleep(300);
  const motionHint = await page.evaluate(() => document.querySelector(".present .notes-hint")?.textContent ?? "");

  await shot(page, "w4-present-live");

  const fails = [];
  const chk = (c, m) => { if (!c) fails.push(m); };
  chk(present0.mounted, "F5 (B22) launches the Present overlay");
  chk(present0.mountHasContent, "the player renders slide content into the mount");
  chk(present0.hud === "1 / 2", `Present starts on slide 1 of 2 (got ${present0.hud})`);
  chk(afterNav.hud === "2 / 2", `ArrowDown (B19 window key) advances to slide 2 (got ${afterNav.hud})`);
  chk(/SECOND SLIDE/.test(afterNav.text), "slide 2 content rendered after a directional transition (B6)");
  chk(jump && /→\s*slide\s*2/.test(jump), `numeric jump shows on-screen feedback (B17) (got ${jump})`);
  chk(panel.notesOpen, "S opens the presenter panel");
  chk(panel.nextPreviewHasContent, "the presenter panel renders a next-slide preview (B3)");
  chk(/motion on/.test(panel.hint), `motion defaults ON in present (B1) (hint: ${panel.hint})`);
  chk(/motion off/.test(motionHint), `M toggles reduced-motion (B1) (hint: ${motionHint})`);

  log({ present0, afterNav, jump, panel, motionHint, realErrors: realErrors(page), fails });
  if (fails.length) { console.error("\nW4 PRESENT LIVE FAILED:\n" + fails.join("\n")); process.exitCode = 1; }
  else console.log("\nW4 PRESENT LIVE GUI VERIFICATION PASSED");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
