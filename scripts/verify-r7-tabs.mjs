// R7 — reader tabs, against :1420. Opens several papers as tabs and pins the tab
// contract: the strip lists every open paper with the active one marked; switching to a
// warm tab is a live activation (state preserved in place, no reload); recently-viewed
// tabs stay mounted up to the live cap and older ones cold-reopen through the
// flux-reader-view restore; Ctrl+Tab / Ctrl+PageDown cycle and Ctrl+W / ✕ / middle-click
// close (right neighbour takes over); the doc-internal Escape chain closes the top layer
// only; re-opening an open paper summons its tab (no duplicate); and the open-tab set
// survives a full page reload. Run: node scripts/verify-r7-tabs.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickNew, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const mainB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

// A minimal one-page PDF carrying `text` on page 1 (uncompressed, core Helvetica) so a
// tab switch is observable in pdf.js's text layer (same generator as r6).
function onePagePdf(text) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = `BT /F1 20 Tf 72 700 Td (${esc(text)}) Tj ET`;
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let out = "%PDF-1.4\n";
  const offs = [0];
  for (let i = 1; i < objs.length; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

const pdfB = onePagePdf("PAPER BETA distinct body text");
const pdfC = onePagePdf("PAPER GAMMA distinct body text");
const pdfD = onePagePdf("PAPER DELTA distinct body text");

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

// Tabs keep recently-viewed papers mounted (hidden) — every content probe scopes to
// the ACTIVE document.
const ACT = '[data-doc-active="true"]';
const waitRendered = () =>
  page.waitForFunction(
    (act) => Number(document.querySelector(`${act} [data-testid="pdf-root"]`)?.dataset.rendered || 0) >= 1,
    { timeout: 20000 },
    ACT,
  );
const tabsState = () => page.evaluate(() => window.__fluxReaderTabs);
const stripKeys = () =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="reader-tabs"] .rtab')].map((t) => t.dataset.key));
const stripActive = () => page.evaluate(() => document.querySelector('[data-testid="reader-tabs"] .rtab.on')?.dataset.key);
const liveDocKeys = () => page.evaluate(() => [...document.querySelectorAll(".rdoc[data-doc-key]")].map((d) => d.dataset.docKey));
const activeText = () => page.evaluate((act) => document.querySelector(`${act} .pdf-page[data-page="1"] .textLayer`)?.textContent || "", ACT);
const clickTab = (key) => page.click(`[data-testid="reader-tabs"] .rtab[data-key="${key}"] .rtab-main`);
const seedAll = () =>
  page.evaluate(
    ({ a, b, c, d }) => {
      window.__fluxSeedReaderItem("r7alpha", a);
      window.__fluxSeedReaderItem("r7beta", b);
      window.__fluxSeedReaderItem("r7gamma", c);
      window.__fluxSeedReaderItem("r7delta", d);
    },
    { a: mainB64, b: pdfB, c: pdfC, d: pdfD },
  );

try {
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });
  await seedAll();

  // --- opening papers accumulates tabs; the strip mirrors the store --------------------
  await page.evaluate(() => window.__fluxOpenReader("r7alpha"));
  await waitRendered();
  await sleep(400);
  ok("single tab renders a strip", (await stripKeys()).join(",") === "r7alpha", (await stripKeys()).join(","));
  await page.evaluate(() => window.__fluxOpenReader("r7beta"));
  await waitRendered();
  await page.evaluate(() => window.__fluxOpenReader("r7gamma"));
  await waitRendered();
  await sleep(400);
  ok("three opens → three tabs in open order", (await stripKeys()).join(",") === "r7alpha,r7beta,r7gamma");
  ok("last opened is active (store)", (await tabsState()).active === "r7gamma");
  ok("last opened is active (strip)", (await stripActive()) === "r7gamma");
  ok("active doc shows the right paper", (await activeText()).includes("PAPER GAMMA"));
  ok("recently-viewed docs stay mounted", (await liveDocKeys()).length === 3, (await liveDocKeys()).join(","));
  await shot(page, "r7-01-three-tabs");

  // --- warm switch: live activation, state preserved in place --------------------------
  await clickTab("r7alpha");
  await sleep(250); // no reload: a visibility flip must be enough
  ok("clicking a tab activates it", (await tabsState()).active === "r7alpha");
  ok("warm switch keeps every live doc mounted", (await liveDocKeys()).length === 3);
  ok("warm switch shows the paper immediately", (await activeText()).includes("FluxReader Fixture"));
  // Give alpha a distinctive view (zoom + page 2) for the cold-reopen leg later.
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await sleep(400);
  const savedPct = await page.$eval(`${ACT} .zpct`, (el) => parseInt(el.textContent));
  await page.$eval(`${ACT} .pgin`, (el) => {
    el.value = "2";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(900); // save debounce (400) + settle

  // --- summon semantics: re-opening an open paper focuses its tab, no duplicate --------
  await page.evaluate(() => window.__fluxOpenReader("r7beta"));
  await sleep(250);
  await page.evaluate(() => window.__fluxOpenReader("r7alpha"));
  await sleep(250);
  ok("re-open summons, never duplicates", (await stripKeys()).join(",") === "r7alpha,r7beta,r7gamma");
  ok("summoned tab is active with state intact", parseInt(await page.$eval(`${ACT} .zpct`, (el) => el.textContent)) === savedPct);

  // --- find state is per-tab -----------------------------------------------------------
  await page.keyboard.down("Control");
  await page.keyboard.press("f");
  await page.keyboard.up("Control");
  await sleep(200);
  await page.type(`${ACT} .rfind-in`, "the");
  await sleep(400);
  ok("find bar opens on the active doc", !!(await page.$(`${ACT} .rfind-in`)));
  await clickTab("r7beta");
  await sleep(250);
  ok("switching tabs hides the other doc's find bar", !(await page.$(`${ACT} .rfind-in`)));
  await clickTab("r7alpha");
  await sleep(250);
  const findVal = await page.$eval(`${ACT} .rfind-in`, (el) => el.value).catch(() => null);
  ok("returning restores the tab's find bar + query", findVal === "the", String(findVal));

  // --- Escape peels the doc's top layer only -------------------------------------------
  await page.click(`${ACT} [data-testid="pdf-switch"]`);
  await sleep(150);
  ok("switch menu open above the find bar", !!(await page.$(`${ACT} [data-testid="pdf-menu"]`)));
  await page.keyboard.press("Escape");
  await sleep(150);
  ok("Escape closes the menu, keeps find", !(await page.$(`${ACT} [data-testid="pdf-menu"]`)) && !!(await page.$(`${ACT} .rfind-in`)));
  await page.keyboard.press("Escape");
  await sleep(150);
  ok("second Escape closes find", !(await page.$(`${ACT} .rfind-in`)));

  // --- keyboard: Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageDown cycle in strip order --------
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await sleep(200);
  ok("Ctrl+Tab cycles forward", (await tabsState()).active === "r7beta");
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(200);
  ok("Ctrl+Shift+Tab cycles back", (await tabsState()).active === "r7alpha");
  await page.keyboard.down("Control");
  await page.keyboard.press("PageDown");
  await page.keyboard.up("Control");
  await sleep(200);
  ok("Ctrl+PageDown cycles forward too", (await tabsState()).active === "r7beta");

  // --- closing: Ctrl+W (right neighbour takes over), middle-click, ✕ -------------------
  await page.keyboard.down("Control");
  await page.keyboard.press("w");
  await page.keyboard.up("Control");
  await sleep(300);
  ok("Ctrl+W closes the active tab", (await stripKeys()).join(",") === "r7alpha,r7gamma");
  ok("right neighbour takes over", (await tabsState()).active === "r7gamma");
  await page.click('[data-testid="reader-tabs"] .rtab[data-key="r7gamma"] .rtab-main', { button: "middle" });
  await sleep(300);
  ok("middle-click closes a tab", (await stripKeys()).join(",") === "r7alpha");
  ok("last neighbour falls back left", (await tabsState()).active === "r7alpha");
  await page.evaluate(() => window.__fluxOpenReader("r7beta"));
  await waitRendered();
  await sleep(200);
  await page.click('[data-testid="reader-tabs"] .rtab[data-key="r7beta"] .rtab-x');
  await sleep(300);
  ok("✕ closes a tab", (await stripKeys()).join(",") === "r7alpha" && (await tabsState()).active === "r7alpha");

  // --- live cap: a 4th open evicts the LRU doc; reopening cold-restores the view -------
  await page.evaluate(() => window.__fluxOpenReader("r7beta"));
  await waitRendered();
  await page.evaluate(() => window.__fluxOpenReader("r7gamma"));
  await waitRendered();
  await page.evaluate(() => window.__fluxOpenReader("r7delta"));
  await waitRendered();
  await sleep(400);
  ok("four tabs open", (await stripKeys()).length === 4);
  const live = await liveDocKeys();
  ok("live instances capped at 3", live.length === 3, live.join(","));
  ok("the LRU doc (alpha) was evicted", !live.includes("r7alpha"), live.join(","));
  await shot(page, "r7-02-four-tabs-capped");
  await clickTab("r7alpha");
  await waitRendered();
  // Condition-based: the saved view applies at pagesloaded — wait for it rather than
  // racing a fixed settle (the restore lands late under load).
  await page
    .waitForFunction(
      (act) => document.querySelector(`${act} .pgin`)?.value === "2",
      { timeout: 5000 },
      ACT,
    )
    .catch(() => {});
  const coldPct = await page.$eval(`${ACT} .zpct`, (el) => parseInt(el.textContent));
  const coldPage = await page.$eval(`${ACT} .pgin`, (el) => el.value);
  ok("cold reopen restores zoom from flux-reader-view", Math.abs(coldPct - savedPct) <= 2, `${coldPct}% vs saved ${savedPct}%`);
  ok("cold reopen restores the page", coldPage === "2", `page ${coldPage}`);

  // --- the open-tab set survives a reload (session restore) ----------------------------
  const beforeReload = await tabsState();
  await gotoApp(page);
  await clickNew(page);
  await clickMode(page, "Reader");
  await page.waitForFunction(() => window.__fluxOpenReader && window.__fluxSeedReaderItem, { timeout: 15000 });
  await seedAll();
  await sleep(400);
  const afterReload = await tabsState();
  ok(
    "tabs restore after reload",
    afterReload.tabs.join(",") === beforeReload.tabs.join(","),
    `${afterReload.tabs.join(",")} vs ${beforeReload.tabs.join(",")}`,
  );
  ok("active tab restores after reload", afterReload.active === beforeReload.active, String(afterReload.active));
  // Restore is lazy: tabs are just citekeys until viewed. (The boot-active tab mounted
  // before this run's seeds landed — a dev-fixture artifact; on a real machine it reads
  // items/<key>/paper.pdf from disk.) Activating a restored tab loads it on demand:
  await clickTab("r7beta");
  await waitRendered();
  await sleep(300);
  ok("a restored tab loads on activation", (await activeText()).includes("PAPER BETA"));
  await shot(page, "r7-03-restored-after-reload");

  // --- split: two reader panes, different papers ---------------------------------------
  // NOTE every pane sits in its own .slot wrapper, so `.pane:first/last-child` matches
  // BOTH panes — scope by index and click by coordinates (real pointer events, so the
  // pane's pointerdown-capture focus handler fires like a user click).
  const clickIn = async (paneIdx, sel, button = "left") => {
    const box = await page.evaluate(
      ({ i, s }) => {
        const el = document.querySelectorAll(".pane")[i]?.querySelector(s);
        if (!el) return null;
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      { i: paneIdx, s: sel },
    );
    if (!box) throw new Error(`clickIn(${paneIdx}, ${sel}): not found`);
    await page.mouse.click(box.x, box.y, { button });
  };
  const paneDocs = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".pane")].map(
        (p) => p.querySelector('.rdoc[data-doc-active="true"]')?.dataset.docKey ?? null,
      ),
    );

  // Refresh alpha first — its restored instance mounted before this run's seeds landed.
  await page.click('[data-testid="reader-tabs"] .rtab[data-key="r7alpha"] .rtab-x');
  await sleep(250);
  await page.evaluate(() => window.__fluxOpenReader("r7alpha"));
  await waitRendered();
  await sleep(300);
  await page.evaluate(() => window.__fluxOpenReaderSplit("r7gamma"));
  await sleep(700);
  ok("split opens a second reader pane", (await page.$$eval(".pane .reader", (els) => els.length)) === 2);
  let docs = await paneDocs();
  ok("left keeps its paper, right shows the split one", docs[0] === "r7alpha" && docs[1] === "r7gamma", docs.join(" | "));
  ok("readerKey follows the focused pane", (await page.evaluate(() => window.__fluxReaderKey)) === "r7gamma");
  await shot(page, "r7-04-split");

  // Chords act on the FOCUSED pane only (the new right pane is focused after the split).
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await sleep(300);
  docs = await paneDocs();
  ok("Ctrl+Tab cycles only the focused pane", docs[0] === "r7alpha" && docs[1] === "r7delta", docs.join(" | "));

  // --- same paper in both panes: a highlight made in one view lands in the other -------
  await clickIn(1, '[data-testid="reader-tabs"] .rtab[data-key="r7alpha"] .rtab-main');
  await sleep(500);
  docs = await paneDocs();
  ok("both panes can show the same paper", docs[0] === "r7alpha" && docs[1] === "r7alpha", docs.join(" | "));
  // The view restored to page 2 — bring page 1 (the selection target) into view first,
  // or the colour menu anchors to an off-screen selection rect.
  await page.keyboard.press("Home");
  await sleep(500);
  const selMade = await page.evaluate(() => {
    const pane = document.querySelectorAll(".pane")[1];
    const layer = pane?.querySelector('[data-doc-active="true"] .pdf-page[data-page="1"] .textLayer');
    if (!layer) return "no layer";
    const spans = [...layer.querySelectorAll("span")].filter((s) => (s.textContent || "").trim());
    const s1 = spans.find((s) => s.textContent.includes("special affinity"));
    if (!s1) return "span not found: " + spans.slice(0, 8).map((s) => s.textContent).join(" | ");
    const r = document.createRange();
    // Text-node containers, not the span element — charOffset resolves those (r1's recipe).
    r.setStart(s1.firstChild, 0);
    r.setEnd(s1.firstChild, s1.firstChild.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    // The ACTIVE doc's viewer — a bare .pdf-scroll would hit a hidden kept-alive tab's.
    pane.querySelector('[data-doc-active="true"] .pdf-scroll').dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return "ok";
  });
  ok("selection in the right pane", selMade === "ok", selMade);
  const hlMenu = await page
    .waitForFunction(() => !!document.querySelectorAll(".pane")[1]?.querySelector(".hl-menu"), { timeout: 4000 })
    .then(() => true, () => false);
  ok("colour menu appears", hlMenu);
  if (hlMenu) {
    await clickIn(1, ".hl-menu .dot:nth-child(2)");
    await sleep(700);
  }
  const annRows = await page.evaluate(() =>
    [...document.querySelectorAll(".pane")].map(
      (p) => p.querySelectorAll('[data-doc-active="true"] .annlist .ann').length,
    ),
  );
  ok("highlight lands in BOTH views of the paper", annRows[0] === 1 && annRows[1] === 1, annRows.join(" | "));
  await shot(page, "r7-05-split-annotation-sync");

  // --- the shared terminal lives in exactly one pane at a time -------------------------
  await page.keyboard.down("Control");
  await page.keyboard.press("j");
  await page.keyboard.up("Control");
  await sleep(300);
  const agentPaneCounts = () =>
    page.evaluate(() => [...document.querySelectorAll(".pane")].map((p) => p.querySelectorAll(".agentpane").length));
  let agentPanes = await agentPaneCounts();
  ok("terminal opens in the focused pane only", agentPanes[0] === 0 && agentPanes[1] === 1, agentPanes.join(" | "));
  await clickIn(0, ".phead .label");
  await sleep(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("j");
  await page.keyboard.up("Control");
  await sleep(300);
  agentPanes = await agentPaneCounts();
  ok("summoning it from the other pane MOVES it", agentPanes[0] === 1 && agentPanes[1] === 0, agentPanes.join(" | "));

  // --- closing the split falls back to one pane ----------------------------------------
  await clickIn(1, '.pbtn[title="Close pane"]');
  await sleep(400);
  ok("closing the pane leaves one reader", (await page.$$eval(".pane .reader", (els) => els.length)) === 1);
  docs = await paneDocs();
  ok("the surviving pane keeps its paper", docs[0] === "r7alpha", docs.join(" | "));

  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|tab|devSeed/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  ok(`run threw: ${String((e && e.message) || e)}`, false);
  await shot(page, "r7-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
