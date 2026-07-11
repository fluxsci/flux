// WS-7.1 (fortify plan) — paper-editor SCALE GATE.
//
// Measures per-keystroke SYNCHRONOUS dispatch cost (the O(doc) scaling signal;
// paint time is vsync-quantized and hides sub-frame regressions) on a
// science-dense manuscript with REALISTIC paragraphing, heavy (20,000 lines)
// vs control (200 lines) on the same page, typing (i) in prose, (ii) inside a
// [@…] citation group, (iii) inside a table cell. Gates on heavy/control
// ratios (relative-delta — machine speed cancels). Absolute ms live in
// test-results/scale-paper.json only.
//
// RE-BASELINE NOTE (2026-07-10, fortify WS-7.1): the original fortify-plan §1.2
// numbers (223.6ms/keystroke @20k lines) came from a degenerate fixture — 20k
// prose lines with NO blank lines form ONE markdown paragraph, and lezer
// re-runs parseInline over the whole ~1.4MB paragraph synchronously per
// keystroke. With realistic paragraphs the same doc costs ~10ms sync/keystroke
// (still O(doc) — the three block StateFields + cite machinery walk every line;
// WS-2 targets exactly that). This gate uses realistic paragraphing for its
// gated profiles and keeps ONE giant-paragraph burst as recorded-only data
// (the pathological ceiling: ~165ms sync at 20k lines).
//
// STRUCTURAL gate (activates with WS-2 Fix 1): a prose keystroke must invoke
// ZERO block-field build() calls (window.__flux.paperPerf counters — skipped
// while uninstrumented).
//
//   node scripts/verify-scale-paper.mjs      (dev server on :1420)

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

// WS-2 Fix 1 landed: prose 7.3×→2.2× (4.3ms @20k), zero block-field builds on
// prose keystrokes. cite/cell keep a higher residual by design: an in-cite edit
// pays the semantically-required O(doc) ordinal rescan (appearance-order), an
// in-cell edit pays the (gated-in) table walk. Budgets per burst kind.
const BUDGET = {
  proseRatio: Number(process.env.FLUX_SCALE_PAPER_RATIO || 3),
  citeRatio: Number(process.env.FLUX_SCALE_PAPER_RATIO || 6),
  cellRatio: Number(process.env.FLUX_SCALE_PAPER_RATIO || 6),
  proseBuildsMax: 0,
};

const h = harness("verify-scale-paper");
const quant = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const round1 = (n) => Math.round(n * 10) / 10;
// 2ms floor: a ~1.8ms control makes raw ratios noise.
const ratio = (heavy, control) => heavy / Math.max(control, 2);

// ---- doc builder: §1.2 construct density, REALISTIC paragraphing ---------------
const PROSE_SENTINEL = "PROSEPTX";
const CITE_SENTINEL = "@citepoint2020";
const CELL_SENTINEL = "CELLPTX";

function buildDoc(lines) {
  const out = ["---", 'title: "Scale probe"', "author: Flux", "---", ""];
  let embeds = 0;
  let tables = 0;
  let maths = 0;
  const embedEvery = Math.max(60, Math.floor(lines / 20));
  const tableEvery = Math.max(90, Math.floor(lines / 10));
  const mathEvery = Math.max(110, Math.floor(lines / 10));
  while (out.length < lines - 14) {
    const i = out.length;
    if (i % embedEvery === 37) out.push(`![](../fig/renders/f${embeds}.svg){#fig-scale${embeds++}}`);
    else if (i % tableEvery === 62) {
      out.push(`| Group | Mean ${tables} | SD |`, "|---|---|---|", `| control | 1.2 | 0.3 |`, `| treated t${tables} | 2.4 | 0.5 |`);
      tables++;
    } else if (i % mathEvery === 87) {
      out.push("$$", `E_{${maths}} = m c^2 + \\alpha_{${maths}}`, "$$");
      maths++;
    } else if (i % 25 === 5) out.push(`See @fig-s${i % 7} and [@smith${i % 40}2020; @lee2021] for $E=mc^2$ context.`);
    else if (i % 5 === 4) out.push(""); // realistic paragraph breaks
    else out.push(`Prose line ${i} — the quick brown fox jumps over the lazy dog again.`);
  }
  out.push("", `Mid-document anchor ${PROSE_SENTINEL} sits in plain prose here.`, "");
  out.push(`Grouped citations [${CITE_SENTINEL}; @other2021] anchor the cite burst.`, "");
  out.push(`| Cell | Value |`, "|---|---|", `| ${CELL_SENTINEL} | 42 |`, "");
  while (out.length < lines) out.push(`Tail line ${out.length} of filler.`, "");
  return { text: out.slice(0, lines).join("\n"), embeds, tables, maths };
}

/** Degenerate shape: one giant paragraph (recorded only — the parseInline ceiling). */
function giantParagraphDoc(lines) {
  const out = ["---", 'title: "x"', "---", ""];
  while (out.length < lines) out.push(`Giant paragraph line ${out.length} — the quick brown fox jumps over the lazy dog.`);
  return out.join("\n");
}

// ---- app -----------------------------------------------------------------------
const { browser, page } = await launch({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  window.__name = window.__name || ((f) => f);
});
await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2500 });
await clickMode(page, "Paper");
await waitFor(page, () => !!window.__fluxView, null, { label: "__fluxView (Paper mode)", timeout: 15000 });

async function measureDoc(text, label) {
  await page.evaluate((t) => {
    const v = window.__fluxView;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
  }, text);
  await sleep(700); // initial builds + background parse settle
  const res = await page.evaluate(
    async ({ PROSE, CITE, CELL }) => {
      const v = window.__fluxView;
      const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const src = v.state.doc.toString();
      const spots = {
        prose: src.indexOf(PROSE) + PROSE.length,
        cite: src.indexOf(CITE) + CITE.length, // inside the [@…] group
        cell: src.indexOf(CELL) + CELL.length, // inside a table cell
      };
      for (const [k, at] of Object.entries(spots)) if (at < PROSE.length) return { error: `sentinel ${k} not found` };
      const perf = window.__flux?.paperPerf ?? null;
      const out = {};
      for (const [kind, at] of Object.entries(spots)) {
        let caret = at;
        v.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
        await raf2();
        await new Promise((r) => setTimeout(r, 200));
        const sync = [];
        const paint = [];
        const b0 = perf ? { ...perf } : null;
        for (let i = 0; i < 18; i++) {
          const t0 = performance.now();
          v.dispatch({ changes: { from: caret, insert: "x" }, selection: { anchor: caret + 1 } });
          const t1 = performance.now();
          await raf2();
          sync.push(t1 - t0);
          paint.push(performance.now() - t0);
          caret++;
        }
        out[kind] = {
          sync: sync.slice(2),
          paint: paint.slice(2),
          builds: perf && b0 ? { embeds: perf.embeds - b0.embeds, tables: perf.tables - b0.tables, math: perf.math - b0.math } : null,
        };
      }
      return { out, lines: v.state.doc.lines, instrumented: !!perf };
    },
    { PROSE: PROSE_SENTINEL, CITE: CITE_SENTINEL, CELL: CELL_SENTINEL },
  );
  if (res.error) {
    h.fail(`${label}: ${res.error}`);
    await h.done(() => browser.close());
  }
  const s = (k) => `${round1(quant(res.out[k].sync, 0.5))}/${round1(quant(res.out[k].sync, 0.95))}ms`;
  console.log(`  · ${label} (${res.lines}L) sync med/p95: prose ${s("prose")} · cite ${s("cite")} · cell ${s("cell")}`);
  return res;
}

h.section("control (200 lines, realistic paragraphing)");
const ctlDoc = buildDoc(200);
const ctl = await measureDoc(ctlDoc.text, "control");

h.section("heavy (20,000 lines, realistic paragraphing)");
const heavyDoc = buildDoc(20000);
console.log(`  · heavy seed: ${heavyDoc.embeds} embeds, ${heavyDoc.tables} tables, ${heavyDoc.maths} math blocks`);
const heavy = await measureDoc(heavyDoc.text, "heavy");

// ---- gates -----------------------------------------------------------------------
const stats = {};
const kindBudget = { prose: BUDGET.proseRatio, cite: BUDGET.citeRatio, cell: BUDGET.cellRatio };
for (const kind of ["prose", "cite", "cell"]) {
  const c = quant(ctl.out[kind].sync, 0.95);
  const hv = quant(heavy.out[kind].sync, 0.95);
  stats[kind] = {
    controlSyncP95: c,
    heavySyncP95: hv,
    ratio: ratio(hv, c),
    heavyPaintP95: quant(heavy.out[kind].paint, 0.95),
  };
  h.ok(
    stats[kind].ratio < kindBudget[kind],
    `${kind} keystroke sync p95 heavy/control ${round1(stats[kind].ratio)}× < ${kindBudget[kind]}×`,
  );
}
if (!heavy.instrumented)
  h.ok(BUDGET.proseBuildsMax == null, "block-field build() counter not instrumented yet (arrives with WS-2 Fix 1)");
else {
  const b = heavy.out.prose.builds;
  const total = b.embeds + b.tables + b.math;
  if (BUDGET.proseBuildsMax == null) h.ok(true, `prose builds recorded: ${JSON.stringify(b)} (gate activates with WS-2)`);
  else h.ok(total <= BUDGET.proseBuildsMax, `prose keystrokes invoked ${total} block-field build() calls ≤ ${BUDGET.proseBuildsMax}`);
}

h.section("giant-paragraph ceiling (recorded, not gated)");
await page.evaluate((t) => {
  const v = window.__fluxView;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
}, giantParagraphDoc(20000));
await sleep(700);
const giant = await page.evaluate(async () => {
  const v = window.__fluxView;
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  let caret = v.state.doc.lineAt(Math.floor(v.state.doc.length / 2)).to;
  v.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
  await raf2();
  const sync = [];
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now();
    v.dispatch({ changes: { from: caret, insert: "x" }, selection: { anchor: caret + 1 } });
    sync.push(performance.now() - t0);
    await raf2();
    caret++;
  }
  const med = [...sync].sort((a, b) => a - b)[Math.floor(sync.length / 2)];
  return { syncMed: med };
});
console.log(`  · giant single-paragraph 20k-line doc: keystroke sync median ${round1(giant.syncMed)}ms (parseInline over the whole paragraph — lezer-inherent)`);

const errs = realErrors(page);
await browser.close();
h.ok(errs.length === 0, errs.length ? `console errors: ${JSON.stringify(errs.slice(0, 4))}` : "no console errors");

let appRev = "unknown";
try {
  appRev = execSync("git rev-parse --short HEAD").toString().trim();
} catch {}
mkdirSync("test-results", { recursive: true });
writeFileSync(
  path.join("test-results", "scale-paper.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      appRev,
      node: process.versions.node,
      budgets: BUDGET,
      seed: { heavyLines: 20000, controlLines: 200, ...heavyDoc, text: undefined },
      stats,
      giantParagraphSyncMed: giant.syncMed,
      instrumented: heavy.instrumented,
      proseBuilds: heavy.out.prose.builds,
    },
    null,
    2,
  ) + "\n",
);
console.log("  · wrote test-results/scale-paper.json");
await h.done();
