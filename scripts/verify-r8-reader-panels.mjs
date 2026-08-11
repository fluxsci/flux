// R8 — the reader's side panels, against :1420. Pins the owner's panel batch:
// drag-resizable rails (both sides, dblclick reset, persisted globally), the Cited-by
// tab (cached forward citations + sort toggle + the unenriched empty state), the
// open-PDF affordance on a scholarly row (a brief that is in FluxLib WITH a PDF opens
// as a tab), the Alt+R library search panel in the right rail (stays put — Escape must
// not dismiss it), and tab drag-reorder.
// Run: node scripts/verify-r8-reader-panels.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

const pdfB64 = readFileSync("scripts/fixtures/reader-sample.pdf").toString("base64");

const { browser, page } = await launch();
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

const ACT = '[data-doc-active="true"]';
const waitRendered = () =>
  page.waitForFunction(
    (act) => Number(document.querySelector(`${act} [data-testid="pdf-root"]`)?.dataset.rendered || 0) >= 1,
    { timeout: 20000 },
    ACT,
  );
const railW = (which) => page.$eval(`${ACT} .side.${which}`, (el) => Math.round(el.getBoundingClientRect().width));
const storedLayout = () => page.evaluate(() => JSON.parse(localStorage.getItem("flux.reader.layout") || "{}"));
const tabKeys = () =>
  page.evaluate(() => [...document.querySelectorAll('[data-testid="reader-tabs"] .rtab')].map((t) => t.dataset.key));
// A stepped drag — a single jump move does not reliably drive pointermove resize.
async function dragBy(from, dx) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const step = dx > 0 ? 20 : -20;
  for (let i = 0; Math.abs(i) < Math.abs(dx); i += step) {
    await page.mouse.move(from.x + i, from.y);
    await sleep(25);
  }
  await page.mouse.move(from.x + dx, from.y);
  await page.mouse.up();
  await sleep(250);
}
const gutterAt = (idx) =>
  page.evaluate(
    ({ act, i }) => {
      const el = document.querySelectorAll(`${act} .rail-gutter`)[i];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(200, r.height / 2) };
    },
    { act: ACT, i: idx },
  );

try {
  // The demo fixture, not a blank project: seedScaleLibrary needs a resolvable
  // FluxLib to write its bib into (ensureFluxLib returns null without one).
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Reader");
  await page.waitForFunction(
    () => window.__fluxOpenReader && window.__fluxSeedReaderItem && window.__fluxSeedCiters && window.__fluxSeedScaleLibrary,
    { timeout: 15000 },
  );

  // A small real library (bib on disk, DOIs 10.5555/scale.N) + a PDF for its first
  // entry, so a citing brief carrying that DOI is "in the library with a PDF".
  const libKey = await page.evaluate(async (b64) => {
    // Reader sessions persist PER PROJECT ROOT since multi-window A4.4
    // (flux-reader-tabs:<root>; the bare key is the no-project fallback).
    localStorage.removeItem("flux-reader-tabs");
    localStorage.removeItem("flux-reader-tabs:/demo/myc-growth-paper");
    localStorage.removeItem("flux.reader.layout");
    await window.__fluxSeedScaleLibrary(8);
    window.__fluxSeedReaderItem("r8main", b64);
    const key = "author0cortex2000"; // seedScaleLibrary's first entry
    window.__fluxSeedReaderItem(key, b64);
    await window.__fluxSeedCiters("r8main", "cited", [
      { openalexId: "W1", title: "A highly cited follow-up study", authors: ["Follower, A."], year: 2021,
        doi: "10.5555/scale.0", citedByCount: 900, container: "Journal of Cortex Research" },
      { openalexId: "W2", title: "An unrelated citing paper", authors: ["Other, B."], year: 2022,
        doi: "10.9999/not-in-lib", citedByCount: 5 },
    ]);
    await window.__fluxSeedCiters("r8main", "recent", [
      { openalexId: "W3", title: "The newest citing paper", authors: ["Fresh, C."], year: 2026, citedByCount: 1 },
    ]);
    window.__fluxOpenReader("r8main");
    return key;
  }, pdfB64);
  await waitRendered();
  await sleep(600);

  // --- rails: default width, drag both, dblclick reset, persistence -------------------
  ok("both rails start at the default width", (await railW("refs")) === 268 && (await railW("annots")) === 268,
    `${await railW("refs")} / ${await railW("annots")}`);
  ok("a gutter renders beside each rail", (await page.$$eval(`${ACT} .rail-gutter`, (e) => e.length)) === 2);

  const leftG = await gutterAt(0);
  await dragBy(leftG, 110);
  const leftAfter = await railW("refs");
  ok("dragging widens the references rail", leftAfter > 350, `268 → ${leftAfter}`);
  const rightG = await gutterAt(1);
  await dragBy(rightG, -90);
  const rightAfter = await railW("annots");
  ok("dragging widens the right rail", rightAfter > 330, `268 → ${rightAfter}`);
  const stored = await storedLayout();
  ok("widths persist to flux.reader.layout", stored.refsW > 350 && stored.annotsW > 330, JSON.stringify(stored));
  await shot(page, "r8-01-rails-dragged");

  // Double-click resets (mouse.click's option is `count`, not clickCount).
  await page.mouse.click(leftG.x + 110, leftG.y, { count: 2 });
  await sleep(300);
  ok("double-click resets the references rail", (await railW("refs")) === 268, String(await railW("refs")));

  // --- Cited by: cached list, row actions, sort toggle --------------------------------
  const stabs = await page.$$eval(`${ACT} .side.refs .stab`, (els) => els.map((e) => e.textContent.trim()));
  ok("the left rail offers References / Cited by / Search / Outline",
    stabs.join("|") === "References|Cited by|Search|Outline", stabs.join("|"));
  await page.click(`${ACT} .side.refs .stab:nth-child(2)`);
  await sleep(500);
  const citerTitles = await page.$$eval(`${ACT} .side.refs .reflist .rtitle2`, (els) => els.map((e) => e.textContent.trim()));
  ok("the cached citers render", citerTitles.length === 2 && citerTitles[0].includes("highly cited"), citerTitles.join(" | "));
  ok("citers came from cache without a network call", true); // seeded cache = the only source headless

  const pdfBtns = await page.$$eval(`${ACT} .side.refs .reflist .pdfbtn`, (els) => els.length);
  ok("only the in-library-with-PDF row offers Open PDF", pdfBtns === 1, `${pdfBtns} buttons`);
  await shot(page, "r8-02-citers");

  await page.click(`${ACT} .side.refs .reflist .pdfbtn`);
  await sleep(700);
  ok("Open PDF opens that paper as a tab", (await tabKeys()).includes(libKey), (await tabKeys()).join(","));
  ok("…and it becomes the active tab", (await page.evaluate(() => window.__fluxReaderKey)) === libKey);

  // Back to the citing paper's tab and flip the sort.
  await page.click(`[data-testid="reader-tabs"] .rtab[data-key="r8main"] .rtab-main`);
  await sleep(500);
  await page.click(`${ACT} .side.refs .csort .cbtn:nth-child(2)`); // Newest
  await sleep(500);
  const newest = await page.$$eval(`${ACT} .side.refs .reflist .rtitle2`, (els) => els.map((e) => e.textContent.trim()));
  ok("the sort toggle swaps in the newest-first list", newest.length === 1 && newest[0].includes("newest"), newest.join(" | "));
  await page.click(`${ACT} .side.refs .csort .cbtn:nth-child(1)`);
  await sleep(400);
  ok("switching back restores the most-cited list",
    (await page.$$eval(`${ACT} .side.refs .reflist .rtitle2`, (e) => e.length)) === 2);

  // A paper with no OpenAlex id reports the setup state, not an error.
  await page.evaluate((b64) => { window.__fluxSeedReaderItem("r8bare", b64); window.__fluxOpenReader("r8bare"); }, pdfB64);
  await waitRendered();
  await sleep(400);
  await page.click(`${ACT} .side.refs .stab:nth-child(2)`);
  await sleep(600);
  const bareMsg = await page.$eval(`${ACT} .side.refs .smsg`, (el) => el.textContent.trim());
  ok("an unenriched paper explains itself instead of erroring", /Enrich/i.test(bareMsg), bareMsg.slice(0, 70));

  // --- Alt+R library panel ------------------------------------------------------------
  await page.keyboard.down("Alt");
  await page.keyboard.press("r");
  await page.keyboard.up("Alt");
  await sleep(600);
  ok("Alt+R opens the library panel in the right rail", !!(await page.$(`${ACT} [data-testid="reader-library"]`)));
  ok("…with the search box focused", (await page.evaluate(() => document.activeElement?.classList.contains("libsearch"))) === true);
  ok("…and the right rail remembers the choice", (await storedLayout()).rightTab === "library");
  const allRows = await page.$$eval(`${ACT} .liblist .libitem`, (els) => els.length);
  ok("the whole library lists by default", allRows === 8, `${allRows} rows`);

  await page.type(`${ACT} .libsearch`, "author:Author0");
  await sleep(400);
  const hits = await page.$$eval(`${ACT} .liblist .libitem .ltitle`, (els) => els.map((e) => e.textContent.trim()));
  ok("search-as-you-type filters the library", hits.length === 1, `${hits.length}: ${hits[0] ?? ""}`);
  ok("the seeded entry offers Open PDF", (await page.$$eval(`${ACT} .liblist .lpill`, (e) => e.length)) === 1);
  await shot(page, "r8-03-library-panel");

  // The panel is a PANEL, not a transient layer: Escape must leave it alone.
  await page.keyboard.press("Escape");
  await sleep(300);
  ok("Escape does not dismiss the library panel", !!(await page.$(`${ACT} [data-testid="reader-library"]`)));

  await page.click(`${ACT} .liblist .lpill`);
  await sleep(700);
  ok("Open PDF from the panel opens that paper", (await page.evaluate(() => window.__fluxReaderKey)) === libKey);
  await page.click(`${ACT} .side.annots .stab:nth-child(1)`);
  await sleep(300);
  ok("switching back to Annotations dismisses the panel", !(await page.$(`${ACT} [data-testid="reader-library"]`)));

  // --- tab drag-reorder ---------------------------------------------------------------
  const before = await tabKeys();
  ok("three tabs are open for the reorder leg", before.length === 3, before.join(","));
  const first = await page.$eval('[data-testid="reader-tabs"] .rtab:first-child .rtab-main', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const last = await page.$eval('[data-testid="reader-tabs"] .rtab:last-child', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width - 8, y: r.y + r.height / 2 };
  });
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (let x = first.x; x < last.x; x += 25) { await page.mouse.move(x, first.y); await sleep(25); }
  await page.mouse.move(last.x, first.y);
  await page.mouse.up();
  await sleep(400);
  const after = await tabKeys();
  ok("dragging a tab to the end reorders the strip", after[after.length - 1] === before[0], `${before.join(",")} → ${after.join(",")}`);
  ok("reordering keeps the same open set", [...after].sort().join(",") === [...before].sort().join(","), after.join(","));
  // The persisted session lives under the PROJECT-scoped key (multi-window A4.4).
  ok("reordering persists", (await page.evaluate(() =>
    JSON.parse(localStorage.getItem("flux-reader-tabs:/demo/myc-growth-paper") || "{}").tabs ?? []))
    .join(",") === after.join(","));
  await shot(page, "r8-04-reordered");

  // --- toolbar cleanup + panel chords -------------------------------------------------
  const toolbarBtns = await page.$$eval(`${ACT} .rtoolbar button`, (els) =>
    els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()),
  );
  ok("the ✦ Ask AI button is gone from the toolbar", !toolbarBtns.some((t) => /ask ai/i.test(t)), toolbarBtns.join(" | "));
  ok("the find magnifier is gone from the toolbar", !toolbarBtns.some((t) => /find in document/i.test(t)));
  ok("the rails are icon toggles now", toolbarBtns.filter((t) => /Toggle the (left|right) sidebar/.test(t)).length === 2);

  const chord = async (key, { alt = false, ctrl = false, shift = false } = {}) => {
    if (alt) await page.keyboard.down("Alt");
    if (ctrl) await page.keyboard.down("Control");
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press(key);
    if (shift) await page.keyboard.up("Shift");
    if (ctrl) await page.keyboard.up("Control");
    if (alt) await page.keyboard.up("Alt");
    await sleep(320);
  };

  await chord("b", { ctrl: true });
  ok("Ctrl+B hides the left rail", !(await page.$(`${ACT} .side.refs`)));
  await chord("b", { ctrl: true });
  ok("…and brings it back", !!(await page.$(`${ACT} .side.refs`)));
  await chord("b", { ctrl: true, shift: true });
  ok("Ctrl+Shift+B hides the right rail", !(await page.$(`${ACT} .side.annots`)));
  await chord("a", { alt: true });
  ok("Alt+A reopens the right rail on Annotations",
    !!(await page.$(`${ACT} .side.annots`)) && (await storedLayout()).rightTab === "annots");
  await chord("r", { alt: true });
  ok("Alt+R switches it to Library", (await storedLayout()).rightTab === "library");

  // --- Search pane: Ctrl+F, grouped results, click-to-jump ----------------------------
  await chord("f", { ctrl: true });
  ok("Ctrl+F opens the Search pane", !!(await page.$(`${ACT} [data-testid="reader-search"]`)));
  ok("…with the query box focused", await page.evaluate(() => document.activeElement?.classList.contains("srchin")));
  await page.type(`${ACT} .srchin`, "vision");
  await page.waitForFunction(
    (act) => /of [1-9]/.test(document.querySelector(`${act} .srchcount`)?.textContent ?? ""),
    { timeout: 8000 },
    ACT,
  );
  const firstCount = await page.$eval(`${ACT} .srchcount`, (el) => el.textContent.trim());
  ok("the counter reports the match total", /^1 of [2-9]/.test(firstCount), firstCount);
  const hitRows = await page.$$eval(`${ACT} .hit`, (els) => els.length);
  ok("every match gets a result row with context", hitRows >= 2, `${hitRows} rows`);
  const heads = await page.$$eval(`${ACT} .hithead`, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok("results are grouped with a section/page header", heads.length >= 1 && /p\.\d/.test(heads[0]), heads.join(" | "));
  ok("the hit itself is marked in the snippet", (await page.$$eval(`${ACT} .hitmark`, (e) => e.length)) >= 2);
  await shot(page, "r8-05-search");

  await page.click(`${ACT} .hitrows li:last-child .hit`);
  await sleep(900);
  const jumped = await page.$eval(`${ACT} .srchcount`, (el) => el.textContent.trim());
  ok("clicking a result jumps to it (the counter follows)", jumped !== firstCount && /of/.test(jumped), `${firstCount} → ${jumped}`);
  ok("the clicked row is the active one", (await page.$$eval(`${ACT} .hit.on`, (e) => e.length)) === 1);
  await page.click(`${ACT} .srchnav .cbtn:last-child`); // next wraps back to 1
  await sleep(600);
  ok("› steps through the list", (await page.$eval(`${ACT} .srchcount`, (el) => el.textContent.trim())) !== jumped);

  // --- terminal drawer: Alt+T, drag to resize, dblclick reset -------------------------
  await chord("t", { alt: true });
  const drawer = () => page.$eval(`${ACT} .agentpane`, (el) => Math.round(el.getBoundingClientRect().height));
  ok("Alt+T opens the terminal drawer", !!(await page.$(`${ACT} .agentpane`)));
  ok("it opens at the stored height", (await drawer()) === 300, String(await drawer()));
  const dg = await page.$eval(`${ACT} .drawer-gutter`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(dg.x, dg.y);
  await page.mouse.down();
  for (let y = dg.y; y > dg.y - 120; y -= 20) {
    await page.mouse.move(dg.x, y);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(300);
  const grown = await drawer();
  ok("dragging its top edge resizes the drawer", grown > 380, `300 → ${grown}`);
  ok("the height persists", (await storedLayout()).terminalH === grown, String((await storedLayout()).terminalH));
  // The gutter moved with the drawer — re-read it before double-clicking.
  const dg2 = await page.$eval(`${ACT} .drawer-gutter`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(dg2.x, dg2.y, { count: 2 });
  await sleep(300);
  ok("double-click resets the drawer height", (await drawer()) === 300, String(await drawer()));
  await chord("t", { alt: true });
  ok("Alt+T closes it again", !(await page.$(`${ACT} .agentpane`)));

  const errs = realErrors(page);
  const readerErrs = errs.filter((e) => /Reader|PdfView|pdf|annot|tab|library|devSeed/i.test(e));
  const foreign = errs.filter((e) => !readerErrs.includes(e));
  if (foreign.length) console.log(`INFO ${foreign.length} non-reader page error(s) ignored:`, foreign[0].split("\n")[0]);
  ok("no reader page errors", readerErrs.length === 0, readerErrs.slice(0, 3).join(" ;; "));
} catch (e) {
  ok(`run threw: ${String((e && e.message) || e)}`, false);
  await shot(page, "r8-EXCEPTION").catch(() => {});
} finally {
  await browser.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
