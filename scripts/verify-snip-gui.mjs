// Paper snips — ctrl+alt+drag capture → naming popover → PNG + sidecar into
// <project>/plots/paper_snips/, against :1420 (memBridge demo fixture provides
// window.fig, so the writes are observable in-page). Also regression-guards the
// R5 pop-out: plain alt+drag still opens a FigurePanel, ctrl+alt does NOT.
// Run: node scripts/verify-snip-gui.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

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
const waitRendered = () =>
  page.waitForFunction(() => Number(document.querySelector('[data-testid="pdf-root"]')?.dataset.rendered || 0) >= 1, {
    timeout: 20000,
  });

/** Drag a marquee over page 1; mods = array of puppeteer key names held during it. */
async function dragRegion(mods, dx = 350, dy = 170) {
  const pr = await page.$eval('.pdf-page[data-page="1"]', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(pr.left + 70, pr.top + 90);
  await page.mouse.down();
  await page.mouse.move(pr.left + 70 + dx, pr.top + 90 + dy, { steps: 8 });
  await page.mouse.up();
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
}

const snipFile = (root, name) => `${root}/plots/paper_snips/${name}.png`;

try {
  // ?fixture=demo backs window.fig with the in-memory bridge + a real opened
  // project (currentProject.path set) — required: the snip save writes files.
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });

  // Seed the paper's PDF bytes AND a bib entry (through the real bridge) so the
  // citation composes fully: 3 authors → "et al.", journal → ISO-4 abbreviation.
  await page.evaluate(async (b64, key) => {
    const { ensureFluxLib } = await import("/src/lib/references/fluxlibBridge.ts");
    const { fileBridge, joinPath } = await import("/src/lib/project/types.ts");
    const { bumpFluxLib } = await import("/src/lib/references/revision.ts");
    const lib = await ensureFluxLib();
    const fb = fileBridge();
    await fb.writeText(
      joinPath(lib, "library.bib"),
      `@article{${key},\n  title = {Snip fixtures at scale},\n  author = {Driessen, Kort and Kim, A. and Zhou, B.},\n  year = {2026},\n  journal = {Nature Neuroscience},\n}\n`,
    );
    bumpFluxLib();
    window.__fluxSeedReaderItem(key, b64);
    window.__fluxOpenReader(key);
  }, pdfB64, KEY);
  const root = ROOT;
  ok("demo project scaffolded (project.json exists)", await page.evaluate((r) => window.fig.exists(`${r}/project.json`), root));
  await page.waitForSelector('[data-testid="pdf-root"]', { timeout: 15000 });
  await waitRendered();
  await sleep(600);

  // --- ctrl+alt+drag → naming popover ---------------------------------------------
  await dragRegion(["Control", "Alt"]);
  const popShown = await page
    .waitForSelector('[data-testid="snip-popover"]', { timeout: 6000 })
    .then(() => true, () => false);
  ok("ctrl+alt+drag opens the snip popover", popShown);
  ok("ctrl+alt+drag does NOT open a figure panel", !(await page.$('[data-testid="figure-panel"]')));
  if (popShown) {
    const autoName = await page.$eval('[data-testid="snip-name"]', (el) => el.value);
    ok("auto-name is <citekey>-p<page>", autoName === `${KEY}-p1`, autoName);
    const cite = await page.$eval(".scite", (el) => el.textContent.trim());
    ok("popover shows the composed citation", cite === CITATION, cite);
    await shot(page, "snip-01-popover");

    // Esc cancels without writing.
    await page.keyboard.press("Escape");
    await sleep(200);
    ok("Esc closes the popover", !(await page.$('[data-testid="snip-popover"]')));
    const wroteOnEsc = await page.evaluate((p) => window.fig.exists(p), snipFile(root, `${KEY}-p1`));
    ok("Esc writes nothing", !wroteOnEsc);
  }

  // --- Enter saves: PNG (288dpi pHYs + tEXt provenance) + sidecar -------------------
  await dragRegion(["Control", "Alt"]);
  await page.waitForSelector('[data-testid="snip-name"]', { timeout: 6000 });
  await page.keyboard.press("Enter");
  const saved = await page
    .waitForFunction(
      (p) => window.fig.exists(p),
      { timeout: 10000 },
      snipFile(root, `${KEY}-p1`),
    )
    .then(() => true, () => false);
  ok("Enter saves the PNG to plots/paper_snips/", saved);
  if (saved) {
    const png = await page.evaluate(async (p, keyword) => {
      const { readPngDpi, readPngText } = await import("/src/lib/figure/pngDpi.ts");
      const { decodeSnipMeta } = await import("/src/lib/references/snips.ts");
      const buf = new Uint8Array(await window.fig.readFile(p));
      const sig = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const meta = decodeSnipMeta(readPngText(buf, keyword));
      // Dark-pixel ratio via decode → canvas (real page content, not a blank box).
      const blob = new Blob([buf], { type: "image/png" });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 120) dark++;
      return { sig, dpi: Math.round(readPngDpi(buf) ?? 0), meta, w: bmp.width, h: bmp.height, darkRatio: dark / (d.length / 4) };
    }, snipFile(root, `${KEY}-p1`), "flux-snip");
    ok("PNG signature", png.sig);
    ok("pHYs stamps 288 dpi", png.dpi === 288, `${png.dpi}`);
    ok("tEXt provenance: citekey", png.meta?.citekey === KEY, JSON.stringify(png.meta));
    ok("tEXt provenance: page + citation", png.meta?.page === 1 && png.meta?.citation === CITATION);
    ok("tEXt provenance: main pdf", png.meta?.sourcePdf === "main");
    ok("snip has real page content", png.darkRatio > 0.005, `dark ratio ${png.darkRatio.toFixed(4)}`);
    ok("snip rendered at 4× (wider than the ~350px marquee)", png.w > 800, `${png.w}×${png.h}`);
    const sidecar = await page.evaluate(async (p) => JSON.parse(await window.fig.readText(p)), `${root}/plots/paper_snips/${KEY}-p1.snip.json`);
    ok("sidecar written with matching citekey", sidecar?.citekey === KEY);
    ok("sidecar carries the citation", sidecar?.citation === CITATION);
  }

  // --- rename: typing replaces the auto-name ----------------------------------------
  await dragRegion(["Control", "Alt"]);
  await page.waitForSelector('[data-testid="snip-name"]', { timeout: 6000 });
  const dedupName = await page.$eval('[data-testid="snip-name"]', (el) => el.value);
  ok("second snip auto-dedups to -2", dedupName === `${KEY}-p1-2`, dedupName);
  // The input auto-focuses with select-all — typing straight away replaces the
  // auto-name wholesale (page.type would click first and clear the selection).
  await page.keyboard.type("cortex panel B");
  await page.keyboard.press("Enter");
  const renamed = await page
    .waitForFunction((p) => window.fig.exists(p), { timeout: 10000 }, snipFile(root, "cortex-panel-b"))
    .then(() => true, () => false);
  ok("typed name saves (sanitized) under the custom name", renamed);
  await shot(page, "snip-02-saved");

  // --- R5 regression: plain alt+drag still pops the figure panel --------------------
  await dragRegion(["Alt"]);
  const panelShown = await page
    .waitForSelector('[data-testid="figure-panel"] img', { timeout: 6000 })
    .then(() => true, () => false);
  ok("plain alt+drag still opens a figure panel", panelShown);
  ok("plain alt+drag does not open the snip popover", !(await page.$('[data-testid="snip-popover"]')));

  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|snip|figure|devSeed/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  fails++;
  console.log("FAIL exception:", e.message);
  await shot(page, "snip-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
