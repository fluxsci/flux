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
            // Saved before line ends counted as a space: its two lines meet with nothing between.
            id: "seed-join",
            page: 1,
            color: "pink",
            createdAt: "2026-01-02T00:00:00Z",
            anchor: { quote: "blindness are failures ofawareness that any serious theory", prefix: "inattentional ", suffix: " must accommodate" },
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
  ok("sidebar shows both live highlights", sidebarRows >= 2, `rows: ${sidebarRows}`);
  // A passage across a line end is quoted with the space a reader sees there.
  const quotes = await page.$$eval(".annlist .aquote", (els) => els.map((e) => e.textContent));
  ok("a two-line passage is quoted with a space at the line end", quotes.some((q) => /phenomenologically convincing/.test(q)) && !quotes.some((q) => /phenomenologicallyconvincing/.test(q)),
    quotes.join(" | ").slice(0, 160));
  // …and a highlight saved without that space still finds its place.
  const joined = await page.evaluate(() => ({
    boxes: document.querySelectorAll('.annot-hl[data-id="seed-join"]').length,
    detached: !!document.querySelector('.annlist .ann[data-id="seed-join"].orphan'),
  }));
  ok("a highlight saved before line ends had spaces still paints on both its lines", joined.boxes === 2 && !joined.detached, JSON.stringify(joined));
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

  // --- the menu after a search, from a REAL drag (owner, 2026-11-18: "sometimes when you
  //     highlight some text, the highlight menu does not appear"). A search rewrites the text
  //     layer's nodes (pdf.js wraps each hit), which used to leave the reader holding a map of
  //     nodes that were no longer in the page: every selection on that page then found nothing.
  await page.keyboard.down("Control");
  await page.keyboard.press("f");
  await page.keyboard.up("Control");
  await page.waitForSelector(".srchin", { timeout: 4000 });
  await page.type(".srchin", "vision");
  await page.waitForFunction(() => /of [1-9]/.test(document.querySelector(".srchcount")?.textContent ?? ""), { timeout: 8000 });
  await page.waitForFunction(() => !!document.querySelector('.pdf-page[data-page="1"] .textLayer .highlight'), { timeout: 8000 });
  await sleep(300);
  const lineOf = (needle, which = "first") => page.evaluate((needle, which) => {
    const spans = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer > span')].filter((el) => {
      const r = el.getBoundingClientRect();
      return (el.textContent || "").trim().length > 20 && r.width > 150 && r.top > 120 && r.bottom < innerHeight - 40 && (!needle || el.textContent.toLowerCase().includes(needle));
    });
    spans.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const el = which === "last" ? spans[spans.length - 1] : spans[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x0: r.left + 3, x1: r.right - 3, y: r.top + r.height / 2, text: el.textContent };
  }, needle, which);
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await sleep(250);
  };
  const menuBox = () => page.evaluate(() => {
    const m = document.querySelector(".hl-menu"), host = document.querySelector('[data-testid="pdf-root"]');
    if (!m || !host) return null;
    const r = m.getBoundingClientRect(), v = host.getBoundingClientRect();
    return { inside: r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1, r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], v: [Math.round(v.left), Math.round(v.top), Math.round(v.right), Math.round(v.bottom)] };
  });
  const hitLine = await lineOf("vision");
  ok("a line holding a search hit is on screen", !!hitLine, hitLine?.text?.slice(0, 40));
  if (hitLine) {
    await drag({ x: hitLine.x0, y: hitLine.y }, { x: hitLine.x1, y: hitLine.y });
    const box = await menuBox();
    ok("a real drag across a search hit brings the menu", !!box);
    ok("…inside the page area", !!box?.inside, JSON.stringify(box));
    ok("…with five colours, Annotate and Ask", (await page.$$eval(".hl-menu .dot", (e) => e.length)) === 5
      && !!(await page.$('.hl-menu [aria-label="Annotate this passage"]')) && !!(await page.$('.hl-menu [aria-label="Ask about this passage"]')));
    await shot(page, "r1-06-menu-after-search");
    await page.keyboard.press("Escape");
    await sleep(150);
    ok("Escape closes the menu", !(await page.$(".hl-menu")));
    ok("…and leaves the search as it was", (await page.$eval(".srchin", (el) => el.value)) === "vision");

    // A drag that ends outside the page (over the right sidebar) is still a selection.
    const side = await page.$eval(".side.annots", (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200 }; });
    await drag({ x: hitLine.x0, y: hitLine.y }, { x: side.x, y: hitLine.y });
    const sideBox = await menuBox();
    ok("a drag released over the sidebar still brings the menu", !!sideBox);
    ok("…kept inside the page area", !!sideBox?.inside, JSON.stringify(sideBox));
    await page.keyboard.press("Escape");
    await sleep(150);
  }

  // A long selection running to the bottom of what is on screen: the menu stays on screen.
  const topLine = await lineOf("", "first"), lastLine = await lineOf("", "last");
  if (topLine && lastLine && lastLine.y - topLine.y > 150) {
    await drag({ x: lastLine.x0, y: lastLine.y }, { x: topLine.x1, y: topLine.y }); // dragged upwards
    const longBox = await menuBox();
    ok("a selection made bottom-up brings the menu, on screen", !!longBox?.inside, JSON.stringify(longBox));
    await page.keyboard.press("Escape");
    await sleep(150);
  } else ok("two lines far enough apart for the long selection", false, JSON.stringify([topLine?.y, lastLine?.y]));

  // --- the list reads in the page's order, not the order the highlights were made -----
  // A line with no highlight on it yet, above one that has: highlighting it LAST must still
  // list it before the older one below it.
  const freeLine = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.pdf-page[data-page="1"] .annot-hl')].map((el) => el.getBoundingClientRect());
    const lowest = Math.max(...boxes.map((b) => b.top));
    const el = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer > span')]
      .filter((span) => {
        const r = span.getBoundingClientRect();
        return (span.textContent || "").trim().length > 20 && r.width > 150 && r.top > 120 && r.bottom < lowest - 4
          && !boxes.some((b) => b.bottom > r.top - 2 && b.top < r.bottom + 2);
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x0: r.left + 3, x1: r.right - 3, y: r.top + r.height / 2 };
  });
  ok("a free line above an older highlight is on screen", !!freeLine);
  if (freeLine) {
    const before = await page.$$eval(".annlist .ann", (els) => els.map((el) => el.dataset.id));
    await drag({ x: freeLine.x0, y: freeLine.y }, { x: freeLine.x1, y: freeLine.y });
    await page.waitForSelector(".hl-menu", { timeout: 3000 });
    await page.click(".hl-menu .dot:nth-child(5)"); // orange
    await sleep(500);
    const order = await page.evaluate(() => {
      const listed = [...document.querySelectorAll(".annlist .ann")].map((el) => el.dataset.id);
      const onPage = [...new Set([...document.querySelectorAll('.pdf-page[data-page="1"] .annot-hl')]
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map((el) => el.dataset.id))];
      return { listed, onPage };
    });
    const made = order.listed.find((id) => !before.includes(id));
    ok("the highlight made last is listed before an older one below it", !!made && order.listed.indexOf(made) < order.onPage.length - 1 && order.onPage.indexOf(made) < order.onPage.length - 1,
      `made ${made}; list ${order.listed.join(",")}`);
    ok("the Highlights list follows the page's reading order", order.listed.slice(0, order.onPage.length).join(",") === order.onPage.join(","),
      `list ${order.listed.join(",")} / page ${order.onPage.join(",")}`);
    ok("the tab counts them", (await page.$eval(".side.annots .stab.on", (el) => el.dataset.n)) === String(order.listed.length));
    ok("the pane says how many, and how many carry a note", /^\d+ highlights · 1 note$/.test(await page.$eval(".annbar span", (el) => el.textContent.trim())),
      await page.$eval(".annbar span", (el) => el.textContent.trim()));
  }
  // Leave the search so the rest of the run sees the page as it was.
  await page.click(".srchx");
  await sleep(300);

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
