// slide-migration §7.2 item 7 — present mode over the composed live deck:
// enter (Present ▶ / F5), advance beats + slides with the clicker keymap,
// exit on Escape. Also re-homes verify-slide-polish.mjs's dangerous-keys
// coverage: while presenting, Delete/arrows must NOT edit the deck (the
// overlay owns the keyboard). Run: node scripts/verify-slide-present-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // two slides, an element + a beat on slide 1
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push({ type: "rect", id: "pr-rect", x: 100, y: 100, width: 120, height: 80, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
    });
    f.slide.commitDeckLive((d) => {
      const b = f.slideOps.addBeat(d, sid, { label: "b1" });
      f.slideOps.setAnimation(d, sid, b.id, { target: "pr-rect", preset: "fade", duration: 200 });
      const s2 = f.slideOps.addSlide(d, { name: "Last", layout: "blank" });
      f.slideOps.addSlideText(d, s2.id, { text: "THE END", x: 200, y: 150, fontSize: 30 });
    });
    f.slide.selectSlide(f.get(f.slide.deckOverlay).slides[0].id);
  });
  await sleep(500);

  const elCount = () =>
    page.evaluate(() => {
      const f = window.__flux;
      const sid = f.get(f.slide.deckOverlay).slides[0].id;
      return f.get(f.fig.project).figures.find((x) => x.id === sid).elements.length;
    });
  const before = await elCount();

  // enter present from the current slide
  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Present/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".present"), null, { timeout: 6000, label: "present overlay" });
  ok(true, "Present ▶ opens the fullscreen overlay (the ONE player)");

  const state = () =>
    page.evaluate(() => {
      const hud = document.querySelector(".present .hud span")?.textContent ?? "";
      return { hud, dots: document.querySelectorAll(".present .hud .dot").length, on: document.querySelectorAll(".present .hud .dot.on").length };
    });
  const s0 = await state();
  ok(/1 \/ 2/.test(s0.hud), `opens on slide 1 of 2 (hud "${s0.hud}")`);
  ok(s0.dots === 2 && s0.on === 1, "beat dots show the resting beat");

  // dangerous keys while presenting must not edit (polish re-home): select an
  // element first, then press Delete inside the overlay.
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight"); // advance the beat instead of nudging
  await sleep(500);
  const s1 = await state();
  ok(s1.on === 2, "ArrowRight advanced the build beat");
  ok((await elCount()) === before, "Delete during a presentation did NOT edit the deck (the overlay owns the keyboard)");

  await page.keyboard.press("ArrowRight"); // past the last beat → next slide
  await sleep(600);
  const s2 = await state();
  ok(/2 \/ 2/.test(s2.hud), `advancing past the last beat moves to slide 2 (hud "${s2.hud}")`);
  const endText = await page.evaluate(() => (document.querySelector(".present .mount")?.textContent ?? "").includes("THE END"));
  ok(endText, "slide 2 presents its content (one renderer)");

  await page.keyboard.press("ArrowLeft");
  await sleep(400);
  ok(/1 \/ 2/.test((await state()).hud), "ArrowLeft steps back");

  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".present"), null, { timeout: 5000, label: "present closed" });
  ok(true, "Escape exits present mode back to the editor");
  const editorBack = await page.evaluate(() => !!document.querySelector(".canvas-host.frame"));
  ok(editorBack, "the static editor is back at rest");

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE PRESENT GUI: FAIL (${fails})` : "\nSLIDE PRESENT GUI: PASS");
process.exit(fails ? 1 : 0);
