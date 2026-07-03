// PaperExtras — the 2026-07 follow-up batch end-to-end.
// Verifies: flux-ViM flavor (jj in insert mode → normal, and switching to
// plain vim removes the mapping); the reference hover card never overflows
// its own edge even with a long citekey, and its "References" pill opens the
// bibliography pane with the row untwirled; the pomodoro timer is gone from
// the margin; Alt+D hides/shows the dynamic margin (never stealing focus from
// the editor — the dynamic-margin contract); the margin can be dragged wider
// than the old 620px cap.
//   Run (dev server on :1420 must be up): node scripts/verify-paper-extras.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
// Seed the flux flavor BEFORE the app loads (persisted-pref path).
await page.evaluateOnNewDocument(() => localStorage.setItem("flux.paper.vimFlavor", "flux"));
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const setup = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  window.__fluxSeedBib([
    {
      key: "suzuki2020generalanesthesia-0a2",
      title: "General Anesthesia Decouples Cortical Pyramidal Neurons",
      authors: ["Suzuki", "Larkum"],
      year: "2020",
      container: "Cell",
      doi: "10.1016/j.cell.2020.01.024",
    },
    { key: "refb", title: "B study", authors: ["Authorb"], year: "2016" },
  ]);
  const text = [
    "# Intro",
    "",
    "A reference to [@suzuki2020generalanesthesia-0a2] here.",
    "",
    "More prose about [@refb] too.",
    "",
  ].join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
  await new Promise((r) => requestAnimationFrame(r));
  view.focus();
  return { ok: true, panel: !!document.querySelector(".cm-vim-panel") };
});
if (setup.error) {
  console.error(JSON.stringify(setup));
  process.exit(1);
}

// --- pomodoro is gone -----------------------------------------------------------
const pomodoroGone = await page.evaluate(() => {
  const rail = [...document.querySelectorAll("button, [role=tab]")].map(
    (b) => (b.getAttribute("aria-label") ?? "") + " " + (b.title ?? "") + " " + (b.textContent ?? ""),
  );
  return !rail.some((s) => /pomodoro|timer/i.test(s));
});

// --- flux-ViM: jj leaves insert mode -------------------------------------------
const vimPanelText = () =>
  page.evaluate(() => document.querySelector(".cm-vim-panel")?.textContent ?? "");
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: view.state.doc.line(1).to }, scrollIntoView: true });
  view.focus();
});
await page.keyboard.press("i");
await sleep(120);
const inInsert = /INSERT/i.test(await vimPanelText());
const docBeforeJJ = await page.evaluate(() => window.__fluxView.state.doc.line(1).text);
await page.keyboard.press("j");
await page.keyboard.press("j"); // rapid: within the insert-map timeout
await sleep(250);
const afterJJ = await vimPanelText();
const docAfterJJ = await page.evaluate(() => window.__fluxView.state.doc.line(1).text);
const jjOk = inInsert && !/INSERT/i.test(afterJJ) && docAfterJJ === docBeforeJJ;

// --- switch to plain vim via palette → jj types normally ------------------------
await page.keyboard.down("Control");
await page.keyboard.press("KeyK");
await page.keyboard.up("Control");
await sleep(300);
await page.keyboard.type("flux");
await sleep(200);
await page.keyboard.press("Enter"); // "Switch to plain Vim"
await sleep(400);
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: view.state.doc.line(1).to }, scrollIntoView: true });
  view.focus();
});
await page.keyboard.press("i");
await sleep(120);
await page.keyboard.press("j");
await page.keyboard.press("j");
await sleep(350); // let any (wrongly) pending mapping timeout flush
const plainVim = await page.evaluate(() => ({
  line1: window.__fluxView.state.doc.line(1).text,
  panel: document.querySelector(".cm-vim-panel")?.textContent ?? "",
}));
const plainJJOk = /INSERT/i.test(plainVim.panel) && plainVim.line1.endsWith("jj");
await page.keyboard.press("Escape"); // leave insert
// clean the typed "jj" back out (keeps later line numbers stable)
await page.evaluate(() => {
  const view = window.__fluxView;
  const l1 = view.state.doc.line(1);
  view.dispatch({ changes: { from: l1.to - 2, to: l1.to } });
});

// --- hover card: no overflow + pills --------------------------------------------
// Hover the long-key citation chip (rendered as an author-year chip).
const chipBox = await page.evaluate(() => {
  const chip = [...document.querySelectorAll(".cm-content .flux-cite, .cm-content .cm-flux-cite, .cm-content [class*=cite]")].find(
    (el) => /Suzuki/i.test(el.textContent ?? ""),
  );
  if (!chip) return null;
  const r = chip.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
let hoverOk = false;
let hoverOverflowOk = false;
let pillRefs = false;
let pdfPillAbsent = false;
if (chipBox) {
  await page.mouse.move(chipBox.x, chipBox.y);
  for (let i = 0; i < 20 && !hoverOk; i++) {
    await sleep(150);
    hoverOk = await page.evaluate(() => !!document.querySelector(".hovercard.ready"));
  }
  if (hoverOk) {
    const hc = await page.evaluate(() => {
      const card = document.querySelector(".hovercard");
      const r = card.getBoundingClientRect();
      // Any descendant leaking past the card's border box = the reported bug.
      let leak = 0;
      for (const el of card.querySelectorAll("*")) {
        const b = el.getBoundingClientRect();
        leak = Math.max(leak, b.right - r.right, r.left - b.left);
      }
      return {
        leak,
        scrollLeak: card.scrollWidth - card.clientWidth,
        pills: [...card.querySelectorAll(".hc-pill")].map((p) => p.textContent?.trim()),
      };
    });
    hoverOverflowOk = hc.leak <= 1 && hc.scrollLeak <= 0;
    pillRefs = hc.pills.includes("References");
    // demo fixture has no FluxLib PDFs — the PDF pill must NOT render.
    pdfPillAbsent = !hc.pills.some((p) => /pdf/i.test(p ?? ""));
  }
}
await shot(page, "paper-extras-hovercard");

// --- "References" pill → bibliography view, row untwirled + flashed -------------
let revealOk = false;
if (hoverOk && pillRefs) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".hovercard .hc-pill")].find(
      (p) => p.textContent?.trim() === "References",
    );
    btn?.click();
  });
  await sleep(700); // margin opens + smooth scroll
  revealOk = await page.evaluate(() => {
    const key = "suzuki2020generalanesthesia-0a2";
    const row = document.querySelector(`[data-refkey="${key}"]`);
    if (!row) return false;
    const expanded = row.querySelector('.t[aria-expanded="true"]');
    const detailKey = row.querySelector(".d-key")?.textContent?.includes(key);
    const visible = row.getBoundingClientRect().height > 0;
    return !!expanded && !!detailKey && visible;
  });
}
await shot(page, "paper-extras-reveal");

// --- Alt+O hides/shows the whole left panel -------------------------------------
await page.evaluate(() => window.__fluxView.focus());
const leftBefore = await page.evaluate(() => !!document.querySelector(".leftrail"));
await page.keyboard.down("Alt");
await page.keyboard.press("KeyO");
await page.keyboard.up("Alt");
await sleep(300);
const leftHidden = await page.evaluate(() => !document.querySelector(".leftrail"));
await page.keyboard.down("Alt");
await page.keyboard.press("KeyO");
await page.keyboard.up("Alt");
await sleep(300);
const leftBack = await page.evaluate(() => !!document.querySelector(".leftrail"));
const altOOk = leftBefore && leftHidden && leftBack;

// --- Alt+D round-trip: hide + show, editor keeps focus both ways -----------------
await page.evaluate(() => window.__fluxView.focus());
const altDBefore = await page.evaluate(() => !!document.querySelector(".dynmargin"));
await page.keyboard.down("Alt");
await page.keyboard.press("KeyD");
await page.keyboard.up("Alt");
await sleep(350);
const altDClosed = await page.evaluate(() => ({
  margin: !!document.querySelector(".dynmargin"),
  editorFocused: !!document.activeElement?.closest(".cm-content"),
}));
await page.keyboard.down("Alt");
await page.keyboard.press("KeyD");
await page.keyboard.up("Alt");
await sleep(350);
const altDOpen = await page.evaluate(() => ({
  margin: !!document.querySelector(".dynmargin"),
  editorFocused: !!document.activeElement?.closest(".cm-content"),
}));
const altDOk =
  altDBefore &&
  !altDClosed.margin &&
  altDClosed.editorFocused &&
  altDOpen.margin &&
  altDOpen.editorFocused;

// --- margin drags wider than the old 620px cap -----------------------------------
const grip = await page.evaluate(() => {
  const g = document.querySelector(".dm-grip");
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
let dragOk = false;
if (grip) {
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let x = grip.x; x > grip.x - 560; x -= 40) {
    await page.mouse.move(x, grip.y);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(200);
  const w = await page.evaluate(
    () => document.querySelector(".dm-wrap")?.getBoundingClientRect().width ?? 0,
  );
  // 1440px window: max = 1440-ish workspace − 420 ≈ 990+; old cap was 620.
  dragOk = w > 700;
}
await shot(page, "paper-extras-wide-margin");

const errs = realErrors(page);
await browser.close();

const res = {
  fluxPanelOnLoad: setup.panel,
  pomodoroGone,
  jjOk,
  plainJJOk,
  hoverOk,
  hoverOverflowOk,
  pillRefs,
  pdfPillAbsent,
  revealOk,
  altOOk,
  altDOk,
  dragOk,
};
console.log(JSON.stringify({ extras: res, errs }, null, 2));
const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nPAPER EXTRAS VERIFY: FAIL");
  process.exit(1);
}
console.log("\nPAPER EXTRAS VERIFY: PASS");
