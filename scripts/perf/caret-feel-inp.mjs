// Diagnostic: per-caret-mode keystroke INP in REAL Electron (caret-feel branch).
// Adapted from scripts/verify-writer-latency-inp.mjs. Ambient background stays
// ON (shipped condition). For each caret mode we set localStorage, reload the
// page (clean module graph), reopen the scaffolded project, type a fast burst,
// and report keydown Event-Timing p50/p95. The E43 question: does the transient
// caret rAF ticker (which is effectively continuous DURING sustained typing)
// deepen the frame pipeline and tax INP like the old ambient rAF loop did?
// Run from repo root against a FRESH dev server (in-page module imports need a
// timestamp-free graph — the §9 HMR instance trap):
//   npx vite --port 14211 --strictPort &   # then:
//   node scripts/perf/caret-feel-inp.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const DEV = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:14211/";
const PORT = 9224;
const CADENCE = 45;
const BURST = 44;
const ELECTRON = path.join("node_modules", ".bin", "electron");
const udd = mkdtempSync(path.join(tmpdir(), "flux-cfinp-udd-"));
const projParent = mkdtempSync(path.join(tmpdir(), "flux-cfinp-proj-"));
const PROJ = path.join(projParent, "proj");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quant = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const round = (n) => Math.round(n * 10) / 10;

let child = null;
let browser = null;
function cleanup() {
  try { if (browser) browser.disconnect(); } catch {}
  try { if (child) process.kill(-child.pid, "SIGKILL"); } catch {}
  for (const d of [udd, projParent]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
function errorOut(msg) {
  console.log(`CARET-INP PROBE: ERROR ${msg}`);
  cleanup();
  process.exit(2);
}
const hardExit = setTimeout(() => errorOut("timed out (240s)"), 240000);

child = spawn(ELECTRON, [".", `--remote-debugging-port=${PORT}`, "--no-sandbox", "--ozone-platform=x11", `--user-data-dir=${udd}`], {
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV },
  stdio: "ignore",
  detached: true,
});
child.on("error", (e) => errorOut("could not launch electron: " + e.message));

const CDP = `http://127.0.0.1:${PORT}`;
let connected = false;
for (let i = 0; i < 60 && !connected; i++) {
  await sleep(500);
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) connected = true;
  } catch {}
}
if (!connected) errorOut(`Electron CDP never came up on :${PORT} (seat/display issue?)`);
browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });

async function appPage() {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(DEV));
    if (!page) await sleep(300);
  }
  if (!page) errorOut(`no app page on ${DEV}`);
  return page;
}
let page = await appPage();
console.log(`  ✓ Electron booted, windows=${(await browser.pages()).length} (positive boot evidence)`);

// One-time scaffold (project persists on disk across reloads).
const seeded = await page.evaluate(async (proj) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const poll = async (fn, tries = 100, ms = 250) => {
    for (let i = 0; i < tries; i++) { try { if (fn()) return true; } catch {} await sleep(ms); }
    return false;
  };
  if (!(await poll(() => !!window.__flux))) return { error: "no __flux" };
  const scaffold = await import("/src/lib/project/scaffold.ts");
  await scaffold.scaffoldProject(proj, { title: "perf" });
  return { ok: true };
}, PROJ);
if (seeded.error) errorOut(seeded.error);

async function openAndSeed() {
  const r = await page.evaluate(async (proj) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const poll = async (fn, tries = 100, ms = 250) => {
      for (let i = 0; i < tries; i++) { try { if (fn()) return true; } catch {} await sleep(ms); }
      return false;
    };
    if (!(await poll(() => !!window.__flux))) return { error: "no __flux" };
    const shell = await import("/src/shell/shellStore.ts");
    await shell.openProjectAt(proj);
    if (!(await poll(() => !!document.querySelector('button[aria-label="Paper"]')))) return { error: "no Paper button" };
    document.querySelector('button[aria-label="Paper"]').click();
    if (!(await poll(() => !!(window.__fluxView || (window.__flux?.editors ?? [])[0])))) return { error: "no editor" };
    const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
    const lines = ["# Manuscript", ""];
    for (let s = 0; s < 8; s++) {
      lines.push(`## Section ${s}`, "");
      for (let p = 0; p < 12; p++) lines.push(`Paragraph ${s}.${p} — ` + "the quick brown fox jumps over the lazy dog. ".repeat(4));
      lines.push("");
    }
    const text = lines.join("\n");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length }, scrollIntoView: true });
    window.__perf = { inp: [] };
    const eo = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === "keydown") window.__perf.inp.push(e.duration);
    });
    try { eo.observe({ type: "event", durationThreshold: 0 }); } catch { eo.observe({ type: "event" }); }
    view.focus();
    return { ok: true, feel: JSON.parse(localStorage.getItem("flux.settings") || "{}").paperCaretFeel };
  }, PROJ);
  if (r.error) errorOut(r.error);
  return r;
}

async function typeBurst() {
  await page.evaluate(() => {
    window.__perf.inp.length = 0;
    const v = window.__fluxView;
    v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true });
    v.focus();
  });
  const chars = "the quick brown fox jumps over the lazy dog and then some more words appear here ".split("").slice(0, BURST);
  for (const ch of chars) {
    await page.keyboard.type(ch, { delay: 0 });
    await sleep(CADENCE);
  }
  await sleep(600);
  return await page.evaluate(() => window.__perf.inp.slice());
}

const results = {};
for (const mode of ["chase", "smooth"]) {
  await page.evaluate((m) => {
    const cur = JSON.parse(localStorage.getItem("flux.settings") || "{}");
    localStorage.setItem("flux.settings", JSON.stringify({ ...cur, paperCaretFeel: m }));
  }, mode);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1500);
  const opened = await openAndSeed();
  if (opened.feel !== mode) errorOut(`mode did not stick (${opened.feel} != ${mode})`);
  await typeBurst(); // warmup
  const a = await typeBurst();
  const b = await typeBurst();
  const all = [...a, ...b];
  results[mode] = { n: all.length, p50: round(quant(all, 0.5)), p95: round(quant(all, 0.95)) };
  console.log(`  ${mode.padEnd(12)} n=${all.length} p50=${results[mode].p50}ms p95=${results[mode].p95}ms`);
}

console.log(`\nsmooth − chase p95 delta: ${round(results.smooth.p95 - results.chase.p95)}ms`);
clearTimeout(hardExit);
cleanup();
process.exit(0);
