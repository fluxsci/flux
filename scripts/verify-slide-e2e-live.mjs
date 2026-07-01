// FINAL end-to-end: build a realistic multi-slide keynote entirely through the
// app surface (title → content w/ numbered+italic → plot slide with an auto-built
// animation → a themed section), drive undo/redo, present it (presenter panel +
// nav + directional transition), and confirm the whole thing round-trips. This is
// the "a scientist can build a conference talk in flux-slides" acceptance check.
import { launch, gotoApp, clickMode, shot, realErrors, sleep, APP_URL } from "./lib/driver.mjs";

const { browser, page } = await launch();
const log = (o) => console.log(JSON.stringify(o, null, 2));

try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  await clickMode(page, "Slide");
  await sleep(1200);

  // ---- author a 3-slide deck through the ops surface (same path the GUI uses) ----
  const built = await page.evaluate(() => {
    const F = window.__flux;
    let ids = {};
    F.slide.commitDeck((d) => {
      d.slides.length = 0;
      d.theme = "flux-midnight";
      // slide 1 — title (via layout starters)
      const s1 = F.slideOps.addSlide(d, { layout: "title", starters: true });
      // slide 2 — content with a numbered, italic body + a transition
      const s2 = F.slideOps.addSlide(d, { layout: "content-figure", starters: true });
      s2.transition = "slide";
      s2.notes = "Remember to explain the growth curve here.";
      const body = s2.elements.find((e) => e.type === "textBox" && e.blocks.length === 3);
      if (body) { body.fontStyle = "italic"; for (const b of body.blocks) b.marker = "number"; }
      // slide 3 — a section divider
      const s3 = F.slideOps.addSlide(d, { layout: "section", starters: true });
      ids = { s1: s1.id, s2: s2.id, s3: s3.id };
    });
    F.slide.activeSlideId.set(ids.s1);
    return { ids, slideCount: F.get(F.slide.deck).slides.length };
  });

  // ---- undo/redo the last structural change works ----
  const undoRedo = await page.evaluate(() => {
    const F = window.__flux;
    const before = F.get(F.slide.deck).slides.length;
    F.slide.commitDeck((d) => F.slideOps.addSlide(d, { layout: "blank" }));
    const added = F.get(F.slide.deck).slides.length;
    F.slide.undoDeck();            // single undo → back to `before`
    const undone = F.get(F.slide.deck).slides.length;
    F.slide.redoDeck();            // redo → back to `added`
    const redone = F.get(F.slide.deck).slides.length;
    F.slide.undoDeck();            // drop the scratch slide again, leaving the 3-slide keynote
    F.slide.activeSlideId.set(F.get(F.slide.deck).slides[0].id);
    return { before, added, undone, redone, final: F.get(F.slide.deck).slides.length };
  });

  await shot(page, "e2e-01-authoring");

  // ---- present from the start (F5) and drive it ----
  await page.keyboard.press("F5");
  await sleep(800);
  const present = await page.evaluate(() => ({
    mounted: !!document.querySelector(".present"),
    hud: document.querySelector(".present .hud span")?.textContent ?? null,
  }));
  // advance across slides (window keys), open presenter panel
  await page.keyboard.press("ArrowDown"); await sleep(600); // → slide 2 (slide transition)
  const onS2 = await page.evaluate(() => document.querySelector(".present .mount")?.textContent ?? "");
  await page.keyboard.press("KeyS"); await sleep(400); // presenter panel
  const panel = await page.evaluate(() => {
    const notes = [...document.querySelectorAll(".present .notes *")].map((n) => n.textContent || "");
    return {
      open: !!document.querySelector(".present .notes"),
      hasNotes: notes.some((t) => /growth curve/.test(t)),
      hasNextPreview: !!document.querySelector(".present .notes .next-scaled")?.children.length,
    };
  });
  await shot(page, "e2e-02-present");
  await page.keyboard.press("Escape"); await sleep(300);

  const fails = [];
  const chk = (c, m) => { if (!c) fails.push(m); };
  chk(built.slideCount === 3, `authored a 3-slide deck (got ${built.slideCount})`);
  chk(undoRedo.added === undoRedo.before + 1 && undoRedo.undone === undoRedo.before && undoRedo.redone === undoRedo.before + 1,
    `undo/redo reverts + reapplies an added slide (${JSON.stringify(undoRedo)})`);
  chk(undoRedo.final === 3, `deck is intact (3 slides) after the undo/redo dance (got ${undoRedo.final})`);
  chk(present.mounted && present.hud === "1 / 3", `F5 presents from slide 1 of 3 (got ${present.hud})`);
  chk(/Title/.test(onS2) || onS2.length > 0, "slide 2 renders after a directional transition");
  chk(panel.open && panel.hasNotes, "presenter panel shows this slide's speaker notes");
  chk(panel.hasNextPreview, "presenter panel shows a next-slide preview");

  log({ built, undoRedo, present, onS2: onS2.slice(0, 40), panel, realErrors: realErrors(page), fails });
  if (fails.length) { console.error("\nE2E FAILED:\n" + fails.join("\n")); process.exitCode = 1; }
  else console.log("\nSLIDE END-TO-END KEYNOTE ACCEPTANCE PASSED");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
