// V1-readiness 1.2 gate — Reader with a 400-page document (the standing scale budget).
// Builds a synthetic 400-page text PDF in-script (same PDF-1.4 technique as the committed
// fixtures), seeds it through the real reader path, and asserts:
//   • open → first page rendered within budget;
//   • virtualization stays BOUNDED while scrolling (live canvases capped — the reason a
//     400-page document doesn't eat the renderer);
//   • a far page-jump paints within budget;
//   • find-in-document over the whole doc reports matches within budget.
//   Run (dev server on :1420): node scripts/verify-scale-reader.mjs
import { launch, gotoApp, clickNew, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const PAGES = 400;
const BUDGET = {
  openMs: 10000, // seed → first rendered page
  jumpMs: 2500, // jump to page 390 → that page rendered
  findMs: 6000, // whole-doc find → counter shows matches
  maxLiveCanvases: 24, // virtualization bound while scrolling (MAX_LIVE + settle slack)
};

const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
function makePdf(pages) {
  const objs = [];
  const kids = [];
  const first = 3; // pages start at obj 3 (1=catalog, 2=pages)
  for (let p = 0; p < pages; p++) {
    const pageObj = first + p * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const lines = [
      `Page ${p + 1} of the scale fixture document.`,
      `The quick brown fox jumps over the lazy dog on page ${p + 1}.`,
      p % 37 === 0 ? "NEEDLE term appears here for find." : "Plain filler prose continues here.",
      "Cortical dynamics were probed under standard conditions.",
    ];
    const parts = [`BT`, `/F1 12 Tf`, `16 TL`, `72 720 Td`];
    lines.forEach((l, i) => parts.push(`${i ? "T* " : ""}(${esc(l)}) Tj`));
    parts.push(`ET`);
    const stream = parts.join("\n");
    objs[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${first + pages * 2} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objs[contentObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  objs[first + pages * 2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const fails = [];
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails.push(msg), console.log("  ✗ " + msg)));

const pdfB64 = makePdf(PAGES).toString("base64");
const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await clickMode(page, "Reader");
await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });

const t0 = Date.now();
await page.evaluate(
  (key, b64) => {
    window.__fluxSeedReaderItem(key, b64);
    window.__fluxOpenReader(key);
  },
  "scale2026reader",
  pdfB64,
);
await page.waitForFunction(
  () => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.rendered || 0) >= 1,
  { timeout: BUDGET.openMs },
);
const openMs = Date.now() - t0;
// data-pages populates a beat after the first render — poll it.
await page
  .waitForFunction(
    (n) => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.pages || 0) === n,
    { timeout: 5000 },
    PAGES,
  )
  .catch(() => {});
const pages = await page.$eval('[data-testid="pdf-root"]', (el) => Number(el.dataset.pages));
ok(pages === PAGES, `document opens with ${pages} pages`);
ok(openMs <= BUDGET.openMs, `open → first render in ${openMs}ms (≤ ${BUDGET.openMs})`);

// --- virtualization stays bounded while scrolling ------------------------------------------
const canv = await page.evaluate(async () => {
  const scroll = document.querySelector(".pdf-scroll");
  if (!scroll) return { error: "no .pdf-scroll" };
  let maxCanvases = 0;
  for (let i = 0; i < 24; i++) {
    scroll.scrollTop += scroll.clientHeight * 2;
    await new Promise((r) => setTimeout(r, 120));
    maxCanvases = Math.max(maxCanvases, document.querySelectorAll(".pdf-page canvas").length);
  }
  return { maxCanvases, scrolledTo: scroll.scrollTop };
});
ok(!canv.error && canv.maxCanvases <= BUDGET.maxLiveCanvases, `live canvases stay bounded while scrolling (max ${canv.maxCanvases} ≤ ${BUDGET.maxLiveCanvases})`, JSON.stringify(canv));

// --- far page jump ---------------------------------------------------------------------------
const jump = await page.evaluate(async (target) => {
  const input = document.querySelector('input[aria-label="Jump to page"]');
  if (!input) return { error: "no page-jump input" };
  const t0 = performance.now();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, String(target));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const el = document.querySelector(`.pdf-page[data-page="${target}"] canvas`);
    if (el) return { ms: performance.now() - t0 };
  }
  return { error: "target page never rendered" };
}, PAGES - 10);
ok(!jump.error && jump.ms <= BUDGET.jumpMs, `jump to page ${PAGES - 10} rendered in ${Math.round(jump.ms ?? -1)}ms (≤ ${BUDGET.jumpMs})`, JSON.stringify(jump));

// --- whole-document find ------------------------------------------------------------------------
const find = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll("button")].find((b) => /find|search/i.test(b.title || b.getAttribute("aria-label") || ""));
  // The find bar opens via ⌘/Ctrl-F — dispatch the keybinding.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const input = [...document.querySelectorAll("input")].find((i) => /find|search/i.test(i.placeholder || i.getAttribute("aria-label") || ""));
  if (!input) return { error: "no find input (⌘F did not open the bar)", btnSeen: !!btn };
  const t0 = performance.now();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "NEEDLE");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const counter = [...document.querySelectorAll("span,div")].map((e) => e.textContent || "").find((t) => /\d+\s*\/\s*\d+/.test(t) && t.length < 24);
    const m = counter && /(\d+)\s*\/\s*(\d+)/.exec(counter);
    if (m && Number(m[2]) >= 2) return { ms: performance.now() - t0, total: Number(m[2]) };
  }
  return { error: "find never reported matches" };
});
ok(!find.error && find.ms <= BUDGET.findMs, `whole-doc find reported ${find.total ?? "?"} matches in ${Math.round(find.ms ?? -1)}ms (≤ ${BUDGET.findMs})`, JSON.stringify(find));

const errs = realErrors(page);
ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 300)}` : "zero console errors");
await browser.close();

console.log(fails.length ? `\nSCALE-READER VERIFY: FAIL — ${fails.length}` : "\nSCALE-READER VERIFY: PASS");
process.exit(fails.length ? 1 : 0);
