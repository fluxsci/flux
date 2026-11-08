// Manuscript Check in the REAL Paper UI (dev server, ?fixture=demo):
//   A. Alt+K summons the pane; on the demo manuscript with seeded defects it
//      lists them — and the list is EXACTLY the shared pure core's findings
//      for the same inputs (GUI ≡ pure; the CLI side is pinned by
//      verify-manuscript-check.ts).
//   B. Clicking a finding puts the editor selection on its range.
//   C. A fix applies as ONE undoable transaction; the pane re-checks on the
//      idle mirror with no keystroke; Ctrl+Z restores the text.
//   D. Keystroke cost with the pane open on the 20k-line scale document:
//      no check runs on the keystroke path (the run counter is flat during a
//      typing burst and moves only after typing settles), the run happens in
//      the worker, and per-keystroke sync dispatch stays within budget of the
//      pane-closed baseline.
//   E. Clean console.
// Run (dev server): node scripts/run-verifies.mjs --tier ui --only manuscript-check-gui   (FLUX_URL for a worktree)
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, shot } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { DEMO_DEFECTS, scaleDoc } from "./lib/manuscriptCheckFixture.mjs";

const h = harness("verify-manuscript-check-gui");
const { browser, page } = await launch({ width: 1440, height: 900 });
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 2500 });
await clickMode(page, "Paper").catch(() => {});
await waitFor(page, () => !!window.__fluxView, null, { label: "__fluxView (Paper mode)", timeout: 15000 });

const alt = async (code) => {
  await page.keyboard.down("Alt");
  await page.keyboard.press(code);
  await page.keyboard.up("Alt");
};
const paneRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-pane-id="manuscript-check"] .mc-item')].map((li) => [
      li.dataset.rule,
      li.querySelector(".mc-excerpt")?.textContent ?? "",
    ]),
  );
const runs = () => page.evaluate(() => window.__flux?.manuscriptCheck?.runs ?? 0);

// ---- A. summon on the demo with seeded defects ---------------------------------
h.section("A. Alt+K lists the seeded defects, identical to the pure core");
await page.evaluate((defects) => {
  const v = window.__fluxView;
  v.dispatch({ changes: { from: v.state.doc.length, insert: defects } });
  v.focus();
}, DEMO_DEFECTS);
await sleep(300); // the idle mirror (150 ms) settles before the summon
await alt("KeyK");
await waitFor(page, () => !!document.querySelector('[data-pane-id="manuscript-check"] .mc-item'), null, {
  label: "Manuscript Check findings",
  timeout: 8000,
});
const rows = await paneRows();
const want = [
  ["ref.undefined-crossref", "@fig-missing"],
  ["ref.undefined-crossref", "@fig-growht"],
  ["cite.missing-key", "@ghost2020"],
  ["placeholder.marker", "TODO:"],
  ["placeholder.marker", "[??]"],
  ["placeholder.marker", "[??]"],
  ["abbr.used-before-definition", "LTP"],
];
h.eq(rows, want, "the pane lists exactly the seeded defects, grouped by pack");
const pure = await page.evaluate(async () => {
  const checks = await import("/src/lib/manuscript/checks/index.ts");
  const v = window.__fluxView;
  const text = v.state.doc.toString();
  const r = checks.checkManuscript({
    doc: "",
    text,
    figures: window.__fluxFigures.refs().map((f) => ({ label: f.label, family: f.family, number: f.number, display: f.display, caption: f.caption, panels: f.panels })),
    bib: checks.checkBibEntries(window.__fluxBib.entries()),
    comments: [],
  });
  return r.findings.map((f) => [f.ruleId, f.excerpt ?? ""]);
});
h.eq(rows, pure, "GUI findings == checkManuscript over the same document, figures and bibliography");
const paneMeta = await page.evaluate(() => ({
  summary: document.querySelector('[data-pane-id="manuscript-check"] .mc-summary')?.textContent?.trim(),
  packs: [...document.querySelectorAll('[data-pane-id="manuscript-check"] .mc-pack')].map((s) => s.dataset.pack),
  mode: window.__flux?.manuscriptCheck?.lastMode,
}));
h.eq(paneMeta.summary, "3 errors · 4 warnings", "the summary counts by severity");
h.eq(paneMeta.packs, ["references", "placeholders", "abbreviations"], "findings are grouped by rule pack");
h.eq(paneMeta.mode, "worker", "the check ran in the worker, not on the main thread");
await shot(page, "manuscript-check-pane");

// ---- B. click jumps the caret ----------------------------------------------------
h.section("B. a click puts the selection on the finding");
const jumped = await page.evaluate(() => {
  const li = [...document.querySelectorAll('[data-pane-id="manuscript-check"] .mc-item')].find(
    (x) => x.dataset.rule === "cite.missing-key",
  );
  li.querySelector(".mc-msg").click();
  const v = window.__fluxView;
  const sel = v.state.selection.main;
  return { text: v.state.doc.sliceString(sel.from, sel.to), focused: v.hasFocus };
});
h.eq(jumped.text, "@ghost2020", "the selection is exactly the missing citekey");
h.ok(jumped.focused, "focus returns to the editor");

// ---- C. a fix: one transaction, re-check on idle, undo restores -----------------
h.section("C. a fix applies once, the pane re-checks without a keystroke, Ctrl+Z restores");
const before = await page.evaluate(() => window.__fluxView.state.doc.toString());
const runsBeforeFix = await runs();
await page.evaluate(() => {
  const li = [...document.querySelectorAll('[data-pane-id="manuscript-check"] .mc-item')].find(
    (x) => x.querySelector(".mc-fix")?.textContent === "Remove the repeat",
  );
  li.querySelector(".mc-fix").click();
});
const fixed = await page.evaluate(() => window.__fluxView.state.doc.toString());
h.ok(before.includes("[??] [??]") && !fixed.includes("[??] [??]") && fixed.includes("stats [??]."), "the repeated placeholder is removed, the first kept");
h.eq(fixed.length, before.length - " [??]".length, "the fix changed exactly its own range");
await waitFor(page, (n) => (window.__flux?.manuscriptCheck?.runs ?? 0) > n, runsBeforeFix, { label: "re-check after the fix", timeout: 4000 });
await waitFor(page, () => [...document.querySelectorAll('[data-pane-id="manuscript-check"] .mc-item')].filter((x) => x.dataset.rule === "placeholder.marker").length === 2, null, { label: "pane drops the fixed finding", timeout: 4000 });
h.eq((await paneRows()).filter((r) => r[0] === "placeholder.marker").length, 2, "the re-check (idle mirror, no keystroke) dropped the fixed finding");
// Define-at-first-use: two exact edits in one transaction.
await page.evaluate(() => {
  const li = [...document.querySelectorAll('[data-pane-id="manuscript-check"] .mc-item')].find((x) => x.dataset.rule === "abbr.used-before-definition");
  li.querySelector(".mc-fix").click();
});
const defined = await page.evaluate(() => window.__fluxView.state.doc.toString());
h.ok(defined.includes("Long-term potentiation (LTP) rose. We measured LTP twice."), "Define at first use moves the definition to the first use");
await page.evaluate(() => window.__fluxView.focus());
await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
h.eq(await page.evaluate(() => window.__fluxView.state.doc.toString()), fixed, "one Ctrl+Z undoes the two-edit fix as a unit");
await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
h.eq(await page.evaluate(() => window.__fluxView.state.doc.toString()), before, "a second Ctrl+Z restores the removed placeholder");

// ---- D. keystroke cost with the pane open (20k-line document) -------------------
h.section("D. typing with the pane open on 20,000 lines");
const heavy = scaleDoc(20000);
const burst = () =>
  page.evaluate(async () => {
    const v = window.__fluxView;
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let caret = v.state.doc.toString().indexOf("KEYPOINT") + "KEYPOINT".length;
    v.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
    await raf2();
    await new Promise((r) => setTimeout(r, 400)); // settle any pending idle run
    const runs0 = window.__flux?.manuscriptCheck?.runs ?? 0;
    const sync = [];
    for (let i = 0; i < 24; i++) {
      const t0 = performance.now();
      v.dispatch({ changes: { from: caret, insert: "x" }, selection: { anchor: caret + 1 } });
      sync.push(performance.now() - t0);
      caret++;
      await raf2(); // ~33 ms between keys: a fast typist, inside the 150 ms idle window
    }
    const runsDuring = (window.__flux?.manuscriptCheck?.runs ?? 0) - runs0;
    // The settle: typing stops, the idle mirror fires (and, with the pane
    // open, the worker check runs and its result paints). Record main-thread
    // long tasks across it.
    const long = [];
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) long.push(e.duration); });
    obs.observe({ type: "longtask" });
    await new Promise((r) => setTimeout(r, 900));
    obs.disconnect();
    return { sync: sync.slice(2), runsDuring, runs0, settleLongMax: long.length ? Math.max(...long) : 0, settleLong: long };
  });
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
// Baseline: pane closed.
await page.evaluate(() => window.__fluxView.focus());
await alt("KeyP"); // close the active pane (Manuscript Check)
await waitFor(page, () => !document.querySelector('[data-pane-id="manuscript-check"]'), null, { label: "pane closed", timeout: 3000 });
await page.evaluate((t) => {
  const v = window.__fluxView;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
}, heavy);
await sleep(900);
const closed = await burst();
// Pane open.
const runsPreOpen = await runs();
await page.evaluate(() => window.__fluxView.focus());
await alt("KeyK");
await waitFor(page, (n) => (window.__flux?.manuscriptCheck?.runs ?? 0) > n, runsPreOpen, { label: "summon runs the check", timeout: 8000 });
await waitFor(page, () => !!document.querySelector('[data-pane-id="manuscript-check"] .mc-item'), null, { label: "20k findings listed", timeout: 8000 });
const workerMs = await page.evaluate(() => window.__flux.manuscriptCheck.lastMs);
await page.evaluate(() => window.__fluxView.focus());
const open = await burst();
h.ok((await runs()) > open.runs0 + open.runsDuring, "once typing settled, the idle tick re-ran the check");
const settled = await page.evaluate(() => ({ mode: window.__flux.manuscriptCheck.lastMode, ms: window.__flux.manuscriptCheck.lastMs }));
const cP95 = p95(closed.sync), oP95 = p95(open.sync);
console.log(`  · keystroke sync p95: pane closed ${cP95.toFixed(2)} ms · pane open ${oP95.toFixed(2)} ms · check in worker ${workerMs.toFixed(1)} / ${settled.ms.toFixed(1)} ms`);
console.log(`  · settle long tasks (ms): pane closed ${JSON.stringify(closed.settleLong.map(Math.round))} · pane open ${JSON.stringify(open.settleLong.map(Math.round))}`);
h.eq(open.runsDuring, 0, "no check runs during a typing burst with the pane open (nothing on the keystroke path)");
h.eq(settled.mode, "worker", "the post-typing re-check runs in the worker");
// Relative budget (machine speed cancels): the open pane may not add more than
// 50% (+3 ms floor: two 22-sample bursts on a loaded machine differ by ~1.5 ms
// with nothing in between) to the per-keystroke synchronous cost.
h.ok(oP95 <= Math.max(cP95 * 1.5, cP95 + 3), `keystroke p95 with the pane open (${oP95.toFixed(2)} ms) within budget of closed (${cP95.toFixed(2)} ms)`);
// The settle with the pane open adds no main-thread long task (≥50 ms) beyond
// what the editor's own idle work costs with it closed: the check ran in the
// worker and the pane paints at most 50 rows per pack.
h.ok(open.settleLongMax <= closed.settleLongMax + 20,
  `no long task from the check while typing settles (open max ${Math.round(open.settleLongMax)} ms vs closed ${Math.round(closed.settleLongMax)} ms)`);
h.ok(oP95 < 50, `keystroke sync p95 stays in the instantaneous class (${oP95.toFixed(2)} ms < 50 ms)`);
mkdirSync("test-results", { recursive: true });
writeFileSync(
  path.join("test-results", "manuscript-check-gui.json"),
  JSON.stringify({ closedSyncP95: cP95, openSyncP95: oP95, workerCheckMs: workerMs, settledCheckMs: settled.ms, closedSettleLongTasks: closed.settleLong, openSettleLongTasks: open.settleLong, lines: 20000 }, null, 2),
);

// ---- E. clean console --------------------------------------------------------------
h.eq(realErrors(page), [], "clean console");
await h.done(() => browser.close());
