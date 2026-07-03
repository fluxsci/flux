// Color spans — the selection bubble's "Text color" flyout.
// Verifies, against the real editor on :1420:
//   • selecting prose shows the bubble with a Text color button; the flyout
//     opens with 8 Flexoki-600 swatches + Clear;
//   • clicking a swatch wraps the selection as [text]{style="color: #hex"}
//     (Pandoc span — the same markup Preview/exports render via
//     markdown-it-bracketed-spans) and keeps the inner text selected;
//   • live preview: caret elsewhere → the [ ]{…} plumbing is hidden and the
//     inner text is tinted; caret inside → raw syntax is revealed;
//   • clicking the same swatch again toggles the span off; Clear strips any
//     color; both restore the plain text byte-identically;
//   • renderManuscript (Preview + exports) emits the span as a real
//     <span style="color: …"> via markdown-it-bracketed-spans + attrs.
//   Run (dev server on :1420 must be up): node scripts/verify-color-span.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const RED = "#af3029";
const BLUE = "#205ea6";
const PLAIN = "Some prose with a target phrase inside it.";

// mousedown is what the bubble's buttons listen on (keeps editor focus).
const md = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return true;
  }, sel);

// Select `phrase` in the doc and wait for the bubble.
const select = (phrase) =>
  page.evaluate(async (p) => {
    const view = window.__fluxView;
    if (!view) return { error: "no editor view" };
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    view.focus();
    const from = view.state.doc.toString().indexOf(p);
    view.dispatch({ selection: { anchor: from, head: from + p.length } });
    await raf();
    await raf();
    return {
      bubble: !!document.querySelector(".bubble"),
      colorBtn: !!document.querySelector('.bubble button[title="Text color"]'),
    };
  }, phrase);

// ---- seed a small doc --------------------------------------------------------
await page.evaluate((plain) => {
  const view = window.__fluxView;
  if (!view) return;
  const text = `# Color test\n\n${plain}\n\nAnother line of prose here.\n`;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}, PLAIN);

// ---- bubble + flyout ----------------------------------------------------------
const setup = await select("target phrase");
await md('.bubble button[title="Text color"]');
await sleep(150);
const flyout = await page.evaluate(() => ({
  swatches: document.querySelectorAll(".bubble .swatch").length,
  red: !!document.querySelector('.bubble button[title="Red"]'),
  clear: !!document.querySelector('.bubble button[title="Clear color"]'),
}));

// ---- apply red -----------------------------------------------------------------
await md('.bubble button[title="Red"]');
await sleep(150);
const applied = await page.evaluate((RED) => {
  const view = window.__fluxView;
  const sel = view.state.selection.main;
  return {
    wrapped: view.state.doc.toString().includes(`[target phrase]{style="color: ${RED}"}`),
    innerSelected: view.state.sliceDoc(sel.from, sel.to) === "target phrase",
    flyoutClosed: !document.querySelector('.bubble button[title="Red"]'),
  };
}, RED);

// ---- live preview: hidden syntax + tint away, revealed on entry ----------------
const preview = await page.evaluate(async () => {
  const view = window.__fluxView;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const doc = () => view.state.doc.toString();
  const lineEl = () =>
    [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("target phrase"));

  view.dispatch({ selection: { anchor: doc().indexOf("Another line") } });
  await raf();
  await raf();
  const away = lineEl();
  const hidden =
    !!away && !away.textContent.includes("{style=") && !away.textContent.includes("[target");
  // The INNERMOST span is what paints — the highlighter's link tag lands there
  // (a color span parses as a shortcut link) and must not beat the tint.
  const tintEls = away
    ? [...away.querySelectorAll("span")].filter((s) => s.textContent === "target phrase")
    : [];
  const cs = tintEls.length && getComputedStyle(tintEls[tintEls.length - 1]);
  const tinted = !!cs && cs.color === "rgb(175, 48, 41)" && !cs.textDecorationLine.includes("underline");

  view.dispatch({ selection: { anchor: doc().indexOf("target phrase") + 3 } });
  await raf();
  await raf();
  const revealed = !!lineEl() && lineEl().textContent.includes('{style="color:');
  return { hidden, tinted, revealed };
});

// ---- same swatch toggles off ----------------------------------------------------
await select("target phrase");
await md('.bubble button[title="Text color"]');
await sleep(150);
await md('.bubble button[title="Red"]');
await sleep(150);
const toggledOff = await page.evaluate(
  (plain) => window.__fluxView.state.doc.toString().includes(plain),
  PLAIN,
);

// ---- clear strips a different color ----------------------------------------------
await select("target phrase");
await md('.bubble button[title="Text color"]');
await sleep(150);
await md('.bubble button[title="Blue"]');
await sleep(150);
const blueApplied = await page.evaluate(
  (BLUE) => window.__fluxView.state.doc.toString().includes(`{style="color: ${BLUE}"}`),
  BLUE,
);
await md('.bubble button[title="Text color"]');
await sleep(150);
await md('.bubble button[title="Clear color"]');
await sleep(150);
const cleared = await page.evaluate(
  (plain) => {
    const doc = window.__fluxView.state.doc.toString();
    return doc.includes(plain) && !doc.includes("{style=");
  },
  PLAIN,
);

// ---- Preview/export markup: the real renderer emits a styled <span> ---------------
const rendered = await page.evaluate(async (RED) => {
  const { renderManuscript } = await import("/src/shell/modes/paper/render/renderManuscript.ts");
  const r = await renderManuscript(`Prose with [a tinted phrase]{style="color: ${RED}"} inline.`);
  return r.inner.includes(`<span style="color: ${RED}">a tinted phrase</span>`);
}, RED);

const errs = realErrors(page);
await browser.close();

const res = { setup, flyout, applied, preview, toggledOff, blueApplied, cleared, rendered, errs };
console.log(JSON.stringify(res, null, 2));

const ok =
  setup.bubble &&
  setup.colorBtn &&
  flyout.swatches === 9 && // 8 colors + clear
  flyout.red &&
  flyout.clear &&
  applied.wrapped &&
  applied.innerSelected &&
  applied.flyoutClosed &&
  preview.hidden &&
  preview.tinted &&
  preview.revealed &&
  toggledOff &&
  blueApplied &&
  cleared &&
  rendered &&
  errs.length === 0;

if (!ok) {
  console.error("\nCOLOR SPAN VERIFY: FAIL");
  process.exit(1);
}
console.log("\nCOLOR SPAN VERIFY: PASS");
