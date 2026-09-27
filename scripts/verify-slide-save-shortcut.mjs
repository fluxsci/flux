// Ctrl+S in Slide mode saves the deck (2026-09-24).
//
// Owner report: "I cannot save the slides" — every Ctrl+S in a deck raised
// "Save failed: fig/ save refused: the editing store is owned by slide mode
// (expected figure)". io.saveProject always called saveFigFrom when a project
// was open; Slide mode loads the deck into the same shared editing store, so
// the tenancy guard refused the figure write. The shortcut now saves whichever
// mode owns the store, Slide mode through its own autosave controller.
//
// Checked in the real editor:
//   • after a deck edit, Ctrl+S raises no "Save failed" toast, leaves the
//     editor clean, and the edit is in the deck file on disk;
//   • Ctrl+Shift+S (which routes the same way) is quiet in Slide mode too;
//   • Figure mode's Ctrl+S still saves fig/ (no regression on the old path).
import { launch, gotoApp, clickMode, realErrors, sleep, waitFor } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Slide", { settle: 800 });
  await waitFor(page, () => !!window.__flux?.slide.currentDeck(), null, { label: "slide editor" });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent.trim()).join(" | "));
  const clearToasts = () => page.$$eval(".toast .t-x", (buttons) => buttons.forEach((b) => b.click()));
  const chord = async (shift) => {
    await page.mouse.click(8, 450); // focus the app, away from any field
    await page.keyboard.down("Control");
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press("KeyS");
    if (shift) await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
  };
  const deckOnDisk = () => page.evaluate(async () => {
    const f = window.__flux, root = f.get(f.shell.projectModel).root, id = f.slide.currentDeck().id;
    const listed = await f.slideBridge.listProjectDecks(root);
    const rel = listed.find((d) => d.id === id)?.path ?? `slides/${id}/deck.json`;
    return window.fig.readText(`${root}/${rel}`);
  });

  await clearToasts();
  const marker = `saved-by-ctrl-s-${Date.now()}`;
  await page.evaluate((marker) => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => { d.slides[0].name = marker; });
  }, marker);
  await chord(false);
  await waitFor(page, () => !window.__flux.get(window.__flux.fig.dirty), null, { timeout: 8000, label: "deck saved" });
  await sleep(300);
  const after = await toasts();
  assert(!/Save failed|refused/i.test(after), `Ctrl+S in Slide mode raises no save error (${after || "no toasts"})`);
  assert((await deckOnDisk()).includes(marker), "the deck edit is in the deck file on disk");

  await clearToasts();
  await chord(true);
  await sleep(600);
  const afterAs = await toasts();
  assert(!/Save failed|refused/i.test(afterAs), `Ctrl+Shift+S in Slide mode raises no save error (${afterAs || "no toasts"})`);

  // Figure mode keeps its own path: Ctrl+S writes fig/.
  await clickMode(page, "Figure", { settle: 800 });
  await clearToasts();
  const figMarker = `fig-ctrl-s-${Date.now()}`;
  await page.evaluate((m) => window.__flux.fig.commit((p) => { p.figures[0].elements.push({ id: m, type: "rect", x: 5, y: 5, width: 20, height: 20, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 }); }), figMarker);
  await chord(false);
  await waitFor(page, () => !window.__flux.get(window.__flux.fig.dirty), null, { timeout: 8000, label: "figure saved" });
  await sleep(300);
  const figToasts = await toasts();
  assert(!/Save failed|refused/i.test(figToasts), `Ctrl+S in Figure mode still saves without error (${figToasts || "no toasts"})`);
  const figIndex = await page.evaluate(async () => { const f = window.__flux, root = f.get(f.shell.projectModel).root; const fb = window.fig; const dir = `${root}/fig`; const names = await fb.readdir(dir).catch(() => []); const texts = []; for (const n of names) if (!n.dir && n.name.endsWith(".json")) texts.push(await fb.readText(`${dir}/${n.name}`)); for (const n of names) if (n.dir) { for (const m of await fb.readdir(`${dir}/${n.name}`).catch(() => [])) if (!m.dir && m.name.endsWith(".json")) texts.push(await fb.readText(`${dir}/${n.name}/${m.name}`)); } return texts.join("\n"); });
  assert(figIndex.includes(figMarker), "the figure edit is in fig/ on disk");

  const errs = realErrors(page);
  assert(errs.length === 0, `no renderer errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}

console.log(fails === 0 ? "\nSLIDE SAVE SHORTCUT: ALL PASS" : `\nSLIDE SAVE SHORTCUT: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
