// Paper snips — provenance → "copy citation", end-to-end against :1420
// (?fixture=demo): capture a snip in the reader, import it in FIGURE mode via
// the Alt+I Plot Importer (which now lists .png with a "snip" badge), press F
// → the FluxFig menu offers "copy citation" (from the PNG's flux-snip tEXt
// chunk via the buildIncoming seam), activate it → the citation reaches the
// clipboard. Then SLIDE mode: paste the same PNG bytes (window paste event →
// importDroppedFiles) → the shared menu offers the same field. Also proves the
// fig-save keeps the tEXt chunk byte-verbatim (what the load seam re-reads).
//   Run (dev server on :1420 must be up): node scripts/verify-snip-cite-gui.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, sleep, waitFor } from "./lib/driver.mjs";

const pdfB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");
const KEY = "sniptest2026";
const CITATION = "Driessen et al., 2026, Nat. Neurosci.";
const ROOT = "/demo/myc-growth-paper"; // the fixture's project root (verify-importer-multi convention)

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });

  // --- 1. capture a snip in the reader (the phase-2 flow, compact) ------------------
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });
  await page.evaluate(async (b64, key) => {
    const { ensureFluxLib } = await import("/src/lib/references/fluxlibBridge.ts");
    const { fileBridge, joinPath } = await import("/src/lib/project/types.ts");
    const { bumpFluxLib } = await import("/src/lib/references/revision.ts");
    const lib = await ensureFluxLib();
    await fileBridge().writeText(
      joinPath(lib, "library.bib"),
      `@article{${key},\n  title = {Snip fixtures at scale},\n  author = {Driessen, Kort and Kim, A. and Zhou, B.},\n  year = {2026},\n  journal = {Nature Neuroscience},\n}\n`,
    );
    bumpFluxLib();
    window.__fluxSeedReaderItem(key, b64);
    window.__fluxOpenReader(key);
  }, pdfB64, KEY);
  const root = ROOT;
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.rendered || 0) >= 1, {
    timeout: 20000,
  });
  await sleep(600);
  const pr = await page.$eval('.pdf-page[data-page="1"]', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  for (const m of ["Control", "Alt"]) await page.keyboard.down(m);
  await page.mouse.move(pr.left + 70, pr.top + 90);
  await page.mouse.down();
  await page.mouse.move(pr.left + 420, pr.top + 260, { steps: 8 });
  await page.mouse.up();
  for (const m of ["Alt", "Control"]) await page.keyboard.up(m);
  await page.waitForSelector('[data-testid="snip-name"]', { timeout: 6000 });
  await page.keyboard.press("Enter");
  const snipPath = `${root}/plots/paper_snips/${KEY}-p1.png`;
  const saved = await page
    .waitForFunction((p) => window.fig.exists(p), { timeout: 10000 }, snipPath)
    .then(() => true, () => false);
  ok("snip captured and saved from the reader", saved);

  // --- 2. figure mode: Alt+I lists the snip, imports it -----------------------------
  await clickMode(page, "Figure", { settle: 1200 });
  // Clipboard spy: records what the copy-citation field writes while still
  // calling through — headless-Chrome clipboard permissions are flaky, the API
  // CALL is what we're gating. The real read is attempted below as INFO.
  await page.evaluate(() => {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__copied = null;
    navigator.clipboard.writeText = (t) => {
      window.__copied = t;
      return orig(t).catch(() => {});
    };
  });
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyI");
  await page.keyboard.up("Alt");
  await sleep(600); // open + rAF focus + background scan
  ok("Alt+I opens the importer", !!(await page.$(".importer")));
  await page.keyboard.type(KEY); // search across plots/ finds paper_snips/<key>-p1.png
  await sleep(400);
  const row = await page.evaluate(() => {
    const r = document.querySelector(".row[data-i]");
    return r ? { name: r.querySelector(".nm")?.textContent, badges: [...r.querySelectorAll(".badge")].map((b) => b.textContent) } : null;
  });
  ok("search lists the snip PNG", row?.name === `${KEY}-p1`, JSON.stringify(row));
  ok("row carries the snip badge", !!row?.badges?.includes("snip"), JSON.stringify(row?.badges));
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await sleep(700);
  const fig = await page.evaluate(() => {
    const F = window.__flux;
    const f = F.figures()[0];
    const img = f.elements.find((e) => e.type === "image");
    return { img: !!img, selected: img ? F.get(F.fig.selection).has(img.id) : false };
  });
  ok("snip imported as an image element", fig.img);
  ok("imported element is selected", fig.selected);

  // --- 3. F menu → copy citation -----------------------------------------------------
  await page.keyboard.press("f");
  await sleep(500);
  const menu = await page.evaluate(() => document.querySelector(".fluxFigMenu")?.textContent ?? "");
  ok("F menu opens on the snip", menu.length > 0);
  ok("menu offers copy citation with the composed text", menu.includes(`copy citation — ${CITATION}`), menu.slice(0, 200));
  await page.keyboard.press("n");
  await sleep(300);
  const copied = await page.evaluate(() => window.__copied);
  ok("activating the field writes the citation to the clipboard", copied === CITATION, String(copied));
  const realClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  if (realClip !== null) ok("real clipboard readback matches", realClip === CITATION, String(realClip));
  else console.log("INFO real clipboard read unavailable in this headless run (spy assertion covers the call)");
  await page.keyboard.press("Escape");
  await sleep(300);
  await shot(page, "snipcite-01-figmenu");

  // --- 4. fig save keeps the tEXt chunk byte-verbatim (the load seam's source) ------
  const roundTrip = await page.evaluate(async (root) => {
    const { saveFigFrom } = await import("/src/lib/project/figbridge.ts");
    const { readPngText } = await import("/src/lib/figure/pngDpi.ts");
    const { decodeSnipMeta } = await import("/src/lib/references/snips.ts");
    const F = window.__flux;
    await saveFigFrom(root, F.get(F.fig.project));
    const f = F.figures()[0];
    const img = f.elements.find((e) => e.type === "image");
    const bytes = new Uint8Array(await window.fig.readFile(`${root}/fig/assets/${img.assetId}.png`));
    return decodeSnipMeta(readPngText(bytes, "flux-snip"));
  }, root);
  ok("fig-save writes the asset with tEXt intact (load seam re-derives from it)", roundTrip?.citekey === KEY && roundTrip?.citation === CITATION, JSON.stringify(roundTrip));

  // --- 5. slide mode: paste the snip → same field ------------------------------------
  const slideOk = await clickMode(page, "Slide", { settle: 2600 });
  ok("entered Slide mode", slideOk);
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  await page.evaluate(async (p) => {
    const bytes = new Uint8Array(await window.fig.readFile(p));
    const file = new File([bytes], "pasted-snip.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt }));
  }, snipPath);
  const pasted = await waitFor(
    page,
    () => {
      const F = window.__flux;
      const f = F.figures().find((x) => x.id === F.get(F.fig.activeFigureId)) ?? F.figures()[0];
      return f.elements.some((e) => e.type === "image");
    },
    null,
    { timeout: 8000, label: "pasted image element" },
  ).then(() => true, () => false);
  ok("paste lands an image element on the slide", pasted);
  if (pasted) {
    await page.evaluate(() => {
      const F = window.__flux;
      const f = F.figures().find((x) => x.id === F.get(F.fig.activeFigureId)) ?? F.figures()[0];
      const img = f.elements.find((e) => e.type === "image");
      F.fig.selection.set(new Set([img.id]));
    });
    await page.evaluate(() => (window.__copied = null));
    await page.keyboard.press("f");
    await sleep(500);
    const slideMenu = await page.evaluate(() => document.querySelector(".fluxFigMenu")?.textContent ?? "");
    ok("slide-mode menu offers copy citation (shared menu, paste path)", slideMenu.includes(`copy citation — ${CITATION}`), slideMenu.slice(0, 200));
    await page.keyboard.press("n");
    await sleep(300);
    const slideCopied = await page.evaluate(() => window.__copied);
    ok("slide copy writes the citation", slideCopied === CITATION, String(slideCopied));
    await page.keyboard.press("Escape");
  }
  await shot(page, "snipcite-02-slide");

  const errs = realErrors(page);
  const relevant = errs.filter((e) => /Reader|PdfView|pdf|snip|figure|import|slide|menu/i.test(e));
  const foreign = errs.filter((e) => !relevant.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} unrelated page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no relevant page errors", relevant.length === 0, relevant.slice(0, 3).join(" ;; "));
} catch (e) {
  fails++;
  console.log("FAIL exception:", e.message);
  await shot(page, "snipcite-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
