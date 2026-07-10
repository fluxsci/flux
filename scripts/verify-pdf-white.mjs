// PDF export must be WHITE — the cream "paper" sheet + sepia tints are a
// screen-preview look only. printToPDF runs with printBackground:true under
// print media emulation, so whatever @media print leaves tinted lands in the
// exported PDF (the moma sepia-PDF bug). Verifies, on renderManuscript's
// self-contained export HTML:
//   screen media: .sheet keeps the cream --paper (#fdfcf9) — preview look intact
//   print media:  .sheet/.page/body are pure white; .abstract/th/code/pre are
//                 neutral (r==g==b) — zero sepia channel skew anywhere.
//   Run (dev server on :1420 must be up): node scripts/verify-pdf-white.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(400);

// Build the export HTML in the app context (vite-served module), assert in a
// clean page under both media types.
const full = await page.evaluate(async () => {
  const { renderManuscript } = await import("/src/shell/modes/paper/render/renderManuscript.ts");
  const src = [
    "---",
    "title: White export test",
    "author: Verify",
    "abstract: Abstract body for the tint check.",
    "---",
    "",
    "# Intro",
    "",
    "Prose with `inline code` in it.",
    "",
    "| Head | Col |",
    "|------|-----|",
    "| a    | b   |",
    "",
    "```",
    "code block",
    "```",
    "",
  ].join("\n");
  return (await renderManuscript(src, { paginated: false })).full;
});

const doc = await browser.newPage();
await doc.setContent(full, { waitUntil: "load" });

const sample = () =>
  doc.evaluate(() => {
    const bg = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const m = getComputedStyle(el).backgroundColor.match(/\d+/g) ?? [];
      return m.slice(0, 3).map(Number);
    };
    return {
      body: bg("body"),
      sheet: bg(".sheet"),
      abstract: bg(".abstract"),
      th: bg("th"),
      code: bg("code"),
      pre: bg("pre"),
    };
  });

await doc.emulateMediaType("screen");
const screen = await sample();
await doc.emulateMediaType("print");
const print = await sample();

const isWhite = (c) => Array.isArray(c) && c.every((v) => v === 255);
const isNeutral = (c) => Array.isArray(c) && Math.max(...c) - Math.min(...c) === 0 && Math.min(...c) >= 230;

const res = {
  // preview keeps the cream paper look
  screenSheetCream: JSON.stringify(screen.sheet) === JSON.stringify([253, 252, 249]),
  // export: paper is pure white…
  printBodyWhite: isWhite(print.body),
  printSheetWhite: isWhite(print.sheet),
  // …and the tinted boxes carry zero sepia skew (perfectly neutral grays)
  printAbstractNeutral: isNeutral(print.abstract),
  printThNeutral: isNeutral(print.th),
  printCodeNeutral: isNeutral(print.code),
  printPreNeutral: isNeutral(print.pre),
};

const errs = realErrors(page);
await browser.close();

console.log(JSON.stringify({ pdfWhite: res, screen, print, errs }, null, 2));
const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nPDF WHITE VERIFY: FAIL");
  process.exit(1);
}
console.log("\nPDF WHITE VERIFY: PASS");
