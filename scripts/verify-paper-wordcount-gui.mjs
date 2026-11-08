// Paper word counts — the rendered half (the counting law and the agreement of
// every former counter are verify-word-count.ts, pure).
//
//   (A) the status bar shows main-text words, and on the demo fixture that
//       number IS the shared pure core's count of the same text;
//   (B) on the Nature-shaped fixture: the status bar per venue (Nature 50,
//       Science 39, Cell 53 — the popover's venue pick), the outline's
//       per-section counts (faint, right-aligned, outside the heading label);
//   (C) "N selected" appears only after the idle settle — the selection
//       transaction itself leaves the readout untouched — and clears on collapse;
//   (D) the popover: bucket rows vs limits, the word target written into and
//       removed from the front matter (`word-target:`), Esc closes it and
//       returns focus to the editor;
//   (E) the keystroke path: on a 20k-line document a typing burst runs ZERO
//       word analyses (they run once, on the idle tick), prose keystroke sync
//       p95 stays inside a frame, and the idle analysis stays under a long task.
//   node scripts/run-verifies.mjs --tier ui --only verify-paper-wordcount-gui
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { analyzeWords } from "../src/lib/manuscript/wordCount.ts";
import { wordBudget, countRulesFor, mainTextWords } from "../src/lib/manuscript/wordBudget.ts";
import { resolveJournalStyle } from "../src/lib/style/journalStyle.ts";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets.ts";

const h = harness("verify-paper-wordcount-gui");
const { browser, page } = await launch({ width: 1440, height: 900 });
const FIXTURE = readFileSync(new URL("../fixtures/word-count/nature.qmd", import.meta.url), "utf8");
const VENUE_KEY = "flux.paper.countVenue";

const paints = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const status = () =>
  page.evaluate(() => {
    const b = document.querySelector(".statusbar .count");
    return b ? { words: b.getAttribute("data-word-count"), selected: b.getAttribute("data-selected-words"), text: (b.textContent || "").replace(/\s+/g, " ").trim() } : null;
  });
const setDoc = (text) =>
  page.evaluate((t) => {
    const v = window.__fluxView;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } });
  }, text);
const waitWords = (n, label) =>
  waitFor(page, (want) => document.querySelector(".statusbar .count")?.getAttribute("data-word-count") === String(want), n, { timeout: 5000, label });
const venueMain = (id, text) => wordBudget(analyzeWords(text), countRulesFor(resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES))).main;

try {
  await page.evaluateOnNewDocument((k) => {
    try { localStorage.removeItem(k); } catch { /* fresh profile */ }
  }, VENUE_KEY);
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 900 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!window.__fluxView, null, { timeout: 15000, label: "paper editor mounted" });
  await waitFor(page, () => !!document.querySelector(".statusbar .count"), null, { timeout: 5000, label: "status-bar word count" });

  // ---------------------------------------------------------------- (A)
  h.section("demo fixture: status bar == the pure core");
  const demoText = await page.evaluate(() => window.__fluxView.state.doc.toString());
  const venue = await page.evaluate(() => document.querySelector(".statusbar .count")?.getAttribute("title") ?? "");
  const demoWant = mainTextWords(demoText);
  h.ok(demoText.length > 0, `demo document loaded (${demoText.length} chars)`);
  await waitWords(demoWant, `status bar settles on ${demoWant}`).catch(() => {});
  const s0 = await status();
  h.eq(Number(s0?.words), demoWant, `status bar main-text words == mainTextWords(demo) (${demoWant})`);
  h.ok(s0?.text.includes(`${demoWant.toLocaleString("en-US")} words`), `status bar reads "${s0?.text}"`);
  h.ok(/journals count them|Nature counts them/.test(venue), "default venue: the house rules / Nature");

  // ---------------------------------------------------------------- (B)
  h.section("Nature-shaped fixture: venues and outline counts");
  await setDoc(FIXTURE);
  await waitWords(50, "status bar 50 (Nature: summary paragraph included)");
  h.eq(Number((await status())?.words), venueMain("nature", FIXTURE), "fixture main text (Nature) == pure core");
  const outline = await waitFor(
    page,
    () => {
      const rows = [...document.querySelectorAll("aside.outline .orow")].map((r) => ({
        label: (r.querySelector(".oitem")?.textContent || "").trim(),
        n: r.querySelector(".ocount")?.getAttribute("data-words") ?? null,
      }));
      return rows.length >= 10 && rows.every((r) => r.n != null) ? rows : false;
    },
    null,
    { timeout: 5000, label: "outline rows carry counts" },
  ).catch(() => null);
  const pureSections = wordBudget(analyzeWords(FIXTURE)).sections;
  h.eq(outline?.map((r) => Number(r.n)), pureSections.map((s) => s.words), "outline per-section counts == the pure core's (subsections included)");
  h.eq(outline?.[2]?.label, "Discussion", "the count sits outside the heading label (row text is the heading alone)");
  const ocStyle = await page.evaluate(() => {
    const el = document.querySelector("aside.outline .ocount");
    const row = el?.closest(".orow")?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    const cs = el ? getComputedStyle(el) : null;
    return cs && r && row ? { mono: /mono|Menlo|Consolas/i.test(cs.fontFamily), right: row.right - r.right } : null;
  });
  h.ok(!!ocStyle?.mono && ocStyle.right < 12, `outline count is mono and right-aligned (${JSON.stringify(ocStyle)})`);

  // ---------------------------------------------------------------- (C)
  h.section("selection count rides the idle settle");
  const sel = await page.evaluate(() => {
    const v = window.__fluxView;
    const src = v.state.doc.toString();
    const from = src.indexOf("Tau fell by half");
    const to = src.indexOf("\n", from);
    v.dispatch({ selection: { anchor: from, head: to } });
    // Same task: the watcher only arms a timer.
    return document.querySelector(".statusbar .count")?.getAttribute("data-selected-words");
  });
  h.eq(sel, "", "the selection transaction itself does not count (no per-event work)");
  await paints();
  h.eq((await status())?.selected, "", "still uncounted one frame later (it waits for the settle)");
  const selN = await waitFor(page, () => document.querySelector(".statusbar .count")?.getAttribute("data-selected-words") || false, null, { timeout: 3000, label: "N selected appears" }).catch(() => null);
  h.eq(selN, "10", "\"10 selected\": the sentence, cross-ref = 2, math and code = 0");
  h.ok((await status())?.text.startsWith("10 selected · 50 / 900 words"), `status reads "${(await status())?.text}"`);
  await page.evaluate(() => window.__fluxView.dispatch({ selection: { anchor: 0 } }));
  await paints();
  h.eq((await status())?.selected, "", "collapsing the selection clears the readout at once");

  // ---------------------------------------------------------------- (D)
  h.section("popover: buckets, venues, target");
  await page.click(".statusbar .count");
  await waitFor(page, () => !!document.querySelector("[data-word-count-popover]"), null, { timeout: 3000, label: "popover open" });
  const rows = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll("[data-word-count-popover] .wc-row[data-bucket]")].map((r) => [r.getAttribute("data-bucket"), Number(r.querySelector(".wc-n")?.getAttribute("data-words"))])),
  );
  // The demo project's figure model has no fig-dose caption, so legends are the
  // in-text ones only — exactly what the pure core says without a caption source.
  const pb = wordBudget(analyzeWords(FIXTURE));
  h.eq(rows, { abstract: pb.abstract, main: pb.main, methods: pb.methods, legends: pb.legends, tables: pb.tables }, `popover buckets == the pure core (summary ${pb.abstract}, main ${pb.main}, Methods ${pb.methods}, legends ${pb.legends}, tables ${pb.tables})`);
  const lim = await page.evaluate(() => (document.querySelector('[data-word-count-popover] [data-bucket="main"] .wc-lim')?.textContent || "").trim());
  h.eq(lim, "/ 4,300", "main text drawn against Nature's limit (4,300)");
  const box = await page.evaluate(() => {
    const p = document.querySelector("[data-word-count-popover]")?.getBoundingClientRect();
    return p ? { top: p.top, bottom: p.bottom, left: p.left, right: p.right, vh: innerHeight, vw: innerWidth } : null;
  });
  h.ok(!!box && box.top >= 0 && box.left >= 0 && box.bottom <= box.vh && box.right <= box.vw, `popover fits the window (${JSON.stringify(box)})`);
  for (const [id, want] of [["science", 39], ["cell", 53], ["nature", 50]]) {
    await page.select('[data-word-count-popover] select[aria-label="Count for journal"]', id);
    await waitWords(want, `${id}: status bar ${want}`).catch(() => {});
    h.eq(Number((await status())?.words), venueMain(id, FIXTURE), `venue ${id}: status bar == pure core (${want})`);
  }
  h.eq(await page.evaluate((k) => localStorage.getItem(k), VENUE_KEY), "nature", "the venue pick persists (localStorage)");
  // The fixture carries word-target: 900.
  h.eq(await page.evaluate(() => document.querySelector("[data-word-count-popover] [data-target]")?.getAttribute("data-target")), "900", "target read from the front matter");
  h.ok((await status())?.text.includes("/ 900 words"), "status bar shows the target");
  await page.click("[data-word-count-popover] .wc-target .wc-link");
  await waitFor(page, () => !window.__fluxView.state.doc.toString().includes("word-target:"), null, { timeout: 3000, label: "Clear removes the key" }).catch(() => {});
  h.ok(!(await page.evaluate(() => window.__fluxView.state.doc.toString())).includes("word-target:"), "Clear removes `word-target:` from the front matter");
  await waitFor(page, () => !!document.querySelector('[data-word-count-popover] input[aria-label="Word target"]'), null, { timeout: 3000, label: "target input" });
  await page.type('[data-word-count-popover] input[aria-label="Word target"]', "40");
  await page.keyboard.press("Enter");
  await waitFor(page, () => window.__fluxView.state.doc.toString().includes("word-target: 40\n"), null, { timeout: 3000, label: "target written" }).catch(() => {});
  h.ok((await page.evaluate(() => window.__fluxView.state.doc.toString())).includes("word-target: 40\n"), "Set writes `word-target: 40` into the front matter");
  await waitFor(page, () => document.querySelector(".statusbar .count")?.classList.contains("over"), null, { timeout: 3000, label: "over target" }).catch(() => {});
  h.ok(await page.evaluate(() => document.querySelector(".statusbar .count")?.classList.contains("over")), "50 words against a 40-word target marks the count over");
  await shot(page, "paper-wordcount-popover");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector("[data-word-count-popover]"), null, { timeout: 2000, label: "Esc closes" }).catch(() => {});
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-word-count-popover]"))), "Esc closes the popover");
  h.ok(await page.evaluate(() => window.__fluxView.hasFocus), "focus returns to the editor");

  // ---------------------------------------------------------------- (E)
  h.section("keystroke path (20k lines, popover closed)");
  const lines = ["---", 'title: "Scale"', "---", ""];
  while (lines.length < 20000) {
    const i = lines.length;
    if (i % 5 === 4) lines.push("");
    else if (i % 25 === 5) lines.push(`See @fig-s${i % 7} and [@smith${i % 40}2020; @lee2021] for $E=mc^2$ context.`);
    else lines.push(`Prose line ${i} — the quick brown fox jumps over the lazy dog again.`);
  }
  lines.push("", "Typing anchor sentence here.", "");
  const big = lines.join("\n");
  await setDoc(big);
  const bigWant = mainTextWords(big);
  await waitWords(bigWant, "20k-line count settles").catch(() => {});
  h.eq(Number((await status())?.words), bigWant, `20k-line document: status bar == pure core (${bigWant})`);
  const burst = await page.evaluate(async () => {
    const v = window.__fluxView;
    const perf = window.__flux.paperPerf;
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let caret = v.state.doc.toString().indexOf("Typing anchor") + "Typing anchor".length;
    v.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
    await raf2();
    await new Promise((r) => setTimeout(r, 400)); // let the scroll's idle work land first
    const before = perf.wordAnalyses;
    const sync = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      v.dispatch({ changes: { from: caret, insert: "x" }, selection: { anchor: caret + 1 }, userEvent: "input.type" });
      sync.push(performance.now() - t0);
      caret++;
      await raf2();
    }
    const during = perf.wordAnalyses - before;
    await new Promise((r) => setTimeout(r, 600)); // the idle tick (150 ms) + slack
    await raf2();
    return { during, after: perf.wordAnalyses - before, ms: perf.wordAnalysisMs, sync: sync.slice(2).sort((a, b) => a - b) };
  });
  const p95 = burst.sync[Math.floor(burst.sync.length * 0.95) - 1] ?? burst.sync[burst.sync.length - 1];
  h.eq(burst.during, 0, "a 20-key typing burst runs ZERO word analyses");
  h.eq(burst.after, 1, "exactly one analysis lands on the idle tick after the burst");
  h.ok(p95 <= 16, `prose keystroke sync p95 ${p95.toFixed(1)}ms ≤ one frame (16ms)`);
  h.ok(burst.ms < 50, `idle analysis of 20k lines ${burst.ms.toFixed(1)}ms < 50ms (no long task)`);
  h.eq(Number((await status())?.words), mainTextWords(await page.evaluate(() => window.__fluxView.state.doc.toString())), "after the burst the status bar is the pure count of the new text");

  const errs = realErrors(page);
  h.ok(errs.length === 0, errs.length ? `page errors: ${errs[0]}` : "no page errors");
} catch (e) {
  h.fail(`run threw: ${String((e && e.stack) || e)}`);
  await shot(page, "paper-wordcount-EXCEPTION").catch(() => {});
}

await h.done(() => browser.close());
