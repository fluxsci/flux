// R1 — FluxReader highlight rendering + interaction, end-to-end against :1420.
// Seeds the committed fixture PDF (scripts/fixtures/reader-sample.pdf) through the
// DEV hook __fluxSeedReaderItem (devSeed.ts), opens it with __fluxOpenReader, then
// exercises: legacy-format anchor location, merged one-div-per-line painting with
// mix-blend-mode multiply, transparent text-layer glyphs (the "corrupted selection"
// fix), selection → colour menu → create, click-highlight → popover, note round-trip,
// recolor, delete, and orphan flagging. Run: node scripts/verify-r1-highlights.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const KEY = "fixture2026reader";
const pdfB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });

  // Seed: one good legacy-format highlight on p1 + one unlocatable (orphan) on p2.
  await page.evaluate(
    (key, b64) => {
      window.__fluxSeedReaderItem(key, b64, {
        version: 1,
        annotations: [
          {
            id: "seed-hl",
            page: 1,
            color: "yellow",
            createdAt: "2026-01-01T00:00:00Z",
            anchor: { quote: "rich visual world", prefix: "We seem to experience a ", suffix: " as we move" },
          },
          {
            id: "seed-orphan",
            page: 2,
            color: "green",
            createdAt: "2026-01-01T00:00:00Z",
            anchor: { quote: "THIS QUOTE EXISTS NOWHERE IN THE FIXTURE", prefix: "", suffix: "" },
          },
        ],
      });
      window.__fluxOpenReader(key);
    },
    KEY,
    pdfB64,
  );

  await page.waitForSelector('[data-testid="pdf-root"]', { timeout: 15000 });
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.rendered || 0) >= 1,
    { timeout: 20000 },
  );
  await sleep(500);
  await shot(page, "r1-01-open");

  // --- painted highlight: located, one merged box, multiply blend ---------------
  const seedBoxes = await page.$$eval('.annot-hl[data-id="seed-hl"]', (els) =>
    els.map((el) => ({
      layerBlend: getComputedStyle(el.closest(".hl-layer")).mixBlendMode,
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
    })),
  );
  ok("seeded legacy anchor locates and paints", seedBoxes.length >= 1, `boxes: ${seedBoxes.length}`);
  ok("single-line quote → exactly one merged box", seedBoxes.length === 1, `got ${seedBoxes.length}`);
  ok("highlight layer uses mix-blend-mode multiply", seedBoxes.every((b) => b.layerBlend === "multiply"));
  ok("box has sane line height", seedBoxes.every((b) => b.h > 6 && b.h < 40), JSON.stringify(seedBoxes));

  // Pixel-level: the canvas text must stay visible THROUGH the highlight (the blend
  // actually compositing — a computed-style check alone missed a stacking-context bug
  // where bars painted opaque and hid the text).
  const hlEl = await page.$('.annot-hl[data-id="seed-hl"]');
  const hlShot = await hlEl.screenshot({ encoding: "base64" });
  const darkRatio = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 120) dark++;
    }
    return dark / (d.length / 4);
  }, hlShot);
  ok("text visible through highlight (blend composites)", darkRatio > 0.02, `dark-pixel ratio ${darkRatio.toFixed(3)}`);

  // --- the "corrupted selection" fix: text-layer glyphs are transparent ---------
  const glyphColor = await page.$eval('.pdf-page[data-page="1"] .textLayer span', (el) => getComputedStyle(el).color);
  ok("text-layer glyphs transparent", glyphColor === "rgba(0, 0, 0, 0)", glyphColor);

  // --- selection → colour menu → create (two-line selection → two merged boxes) --
  const selMade = await page.evaluate(() => {
    const layer = document.querySelector('.pdf-page[data-page="1"] .textLayer');
    if (!layer) return "no layer";
    const spans = [...layer.querySelectorAll("span")].filter((s) => (s.textContent || "").trim());
    const s1 = spans.find((s) => s.textContent.includes("special affinity"));
    const s2 = spans.find((s) => s.textContent.includes("convincing demonstrations"));
    if (!s1 || !s2) return "spans not found: " + spans.slice(0, 12).map((s) => s.textContent).join(" | ");
    const r = document.createRange();
    r.setStart(s1.firstChild, 0);
    r.setEnd(s2.firstChild, s2.firstChild.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.querySelector(".pdf-scroll").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return "ok";
  });
  ok("programmatic two-line selection", selMade === "ok", selMade);
  const menuVisible = await page.waitForSelector(".hl-menu", { timeout: 4000 }).then(() => true, () => false);
  ok("colour menu appears on selection", menuVisible);
  await shot(page, "r1-02-menu");
  if (menuVisible) {
    await page.click(".hl-menu .dot:nth-child(2)"); // green
    await sleep(400);
  }
  const ids = await page.$$eval(".annot-hl", (els) => [...new Set(els.map((e) => e.dataset.id))]);
  const newId = ids.find((id) => id !== "seed-hl" && id !== "seed-orphan");
  ok("new highlight created", !!newId, `ids: ${ids.join(",")}`);
  if (newId) {
    const n = await page.$$eval(`.annot-hl[data-id="${newId}"]`, (els) => els.length);
    ok("two-line highlight → two merged boxes", n === 2, `got ${n}`);
  }
  const sidebarRows = await page.$$eval(".annlist .ann", (els) => els.length);
  ok("sidebar shows both live annotations", sidebarRows >= 2, `rows: ${sidebarRows}`);
  await shot(page, "r1-03-created");

  // --- click highlight → popover; note round-trip; recolor ----------------------
  const c = await page.$eval('.annot-hl[data-id="seed-hl"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(c.x, c.y);
  const popVisible = await page.waitForSelector('[data-testid="hl-popover"]', { timeout: 4000 }).then(() => true, () => false);
  ok("clicking a highlight opens the popover", popVisible);
  if (popVisible) {
    await page.click('[data-testid="hl-popover"] textarea');
    await page.type('[data-testid="hl-popover"] textarea', "Key claim - revisit for the review");
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await sleep(350);
    const noteShown = await page.$$eval(".annlist .anote", (els) => els.map((e) => e.textContent));
    ok("note saved + shown in sidebar", noteShown.some((t) => t.includes("Key claim")), JSON.stringify(noteShown));

    await page.click('[data-testid="hl-popover"] .pdot:nth-child(3)'); // blue
    await sleep(300);
    const bg = await page.$eval('.annot-hl[data-id="seed-hl"]', (el) => getComputedStyle(el).backgroundColor);
    ok("recolor repaints the highlight", bg === "rgb(181, 211, 242)", bg);

    await page.click('[data-testid="hl-popover"] .pactions .pbtn'); // Copy text
    await sleep(200);
    const copied = await page.$eval('[data-testid="hl-popover"] .pactions .pbtn', (el) => el.textContent);
    ok("copy gives feedback", /Copied/.test(copied), copied);
    await shot(page, "r1-04-popover");

    await page.keyboard.press("Escape");
    await sleep(200);
    ok("Escape closes popover", !(await page.$('[data-testid="hl-popover"]')));
  }

  // --- orphan flag on page 2 -----------------------------------------------------
  await page.evaluate(() => document.querySelector('.pdf-page[data-page="2"]')?.scrollIntoView());
  await sleep(1200);
  const orphanPill = await page.$$eval(".annlist .odot", (els) => els.length);
  ok("unlocatable annotation flagged as detached", orphanPill === 1, `pills: ${orphanPill}`);

  // --- delete via popover ---------------------------------------------------------
  await page.evaluate(() => document.querySelector('.pdf-page[data-page="1"]')?.scrollIntoView());
  await sleep(800);
  const c2 = await page.$eval('.annot-hl[data-id="seed-hl"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(c2.x, c2.y);
  await page.waitForSelector('[data-testid="hl-popover"]', { timeout: 4000 });
  await page.click('[data-testid="hl-popover"] .pbtn.danger');
  await sleep(400);
  ok("delete removes on-page boxes", !(await page.$('.annot-hl[data-id="seed-hl"]')));
  await shot(page, "r1-05-final");

  // Scope the error gate to the reader: this tree hosts parallel agent sessions
  // (paper/slide work in flight), whose in-progress modules may throw on load.
  // Reader-module errors still fail loudly; foreign ones are reported as INFO.
  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|highlight|devSeed/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  fails++;
  console.log("FAIL exception:", e.message);
  await shot(page, "r1-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
