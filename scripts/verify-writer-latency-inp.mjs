// Writer input-latency GATE (real Electron, orchestrated).
//
// The live counterpart to the hermetic scripts/verify-writer-latency.ts guard.
// It launches the REAL app (electron . — so the whole fileBridge/IPC surface is
// present), scaffolds a throwaway project through the app's own renderer, types
// a burst into the paper editor, and measures per-keystroke INP (Event Timing
// keydown duration) — twice, back-to-back on the same page:
//   · ambient DynamicBackground RUNNING (the shipped condition)
//   · ambient DynamicBackground PAUSED (__fluxMargin.bg.pause())
//
// RELATIVE-DELTA gate: the pass condition is that the ambient background adds
// only a small delta to keystroke INP p95. This normalizes out absolute
// machine/CI speed — the Chromium-150 rAF-coupling regression made ambient-ON
// ~48ms slower than OFF (88 vs 40ms); the setTimeout fix collapses that to ~0.
// A slow runner slows both phases equally, so the DELTA is the signal.
//
// Self-contained: launches its own Electron on an isolated port + user-data-dir,
// writes only under os.tmpdir(), and tears everything down. Needs the Vite dev
// server on :1420 (VITE_DEV_SERVER_URL) already up — the run-verifies `ui` tiers
// or `npm run dev` provide it.
//
//   node scripts/verify-writer-latency-inp.mjs

import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const DEV = process.env.VITE_DEV_SERVER_URL || process.env.FLUX_URL || "http://127.0.0.1:1420/";
const PORT = Number(process.env.FLUX_CDP_PORT || 9223);
const DELTA_BUDGET = Number(process.env.FLUX_INP_DELTA_BUDGET || 25); // ms the ambient bg may add to INP p95
const CADENCE = Number(process.env.FLUX_CADENCE || 45);
const BURST = Number(process.env.FLUX_BURST || 44);
const ELECTRON = path.join("node_modules", ".bin", "electron");

const udd = mkdtempSync(path.join(tmpdir(), "flux-perf-udd-"));
const projParent = mkdtempSync(path.join(tmpdir(), "flux-perf-proj-"));
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
  try {
    if (browser) browser.disconnect();
  } catch {}
  try {
    if (child) process.kill(-child.pid, "SIGKILL");
  } catch {}
  for (const d of [udd, projParent]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}
function fail(msg) {
  console.log(`  ✗ ${msg}`);
  console.log("\nWRITER-LATENCY INP GATE: FAIL");
  cleanup();
  process.exit(1);
}
function errorOut(msg) {
  console.log(`WRITER-LATENCY INP GATE: ERROR ${msg}`);
  cleanup();
  process.exit(2);
}

const hardExit = setTimeout(() => errorOut("timed out (150s)"), 150000);
process.on("SIGINT", () => errorOut("interrupted"));

// ---- launch the real app on an isolated port + profile ----------------------
child = spawn(ELECTRON, [".", `--remote-debugging-port=${PORT}`, "--no-sandbox", `--user-data-dir=${udd}`], {
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV },
  stdio: "ignore",
  detached: true,
});
child.on("error", (e) => errorOut("could not launch electron: " + e.message));

// ---- wait for the CDP endpoint, then connect --------------------------------
const CDP = `http://127.0.0.1:${PORT}`;
let connected = false;
for (let i = 0; i < 60 && !connected; i++) {
  await sleep(500);
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) connected = true;
  } catch {}
}
if (!connected) errorOut(`Electron CDP never came up on :${PORT}`);
browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });

let page;
for (let i = 0; i < 60 && !page; i++) {
  page = (await browser.pages()).find((p) => /127\.0\.0\.1:1420|localhost:1420/.test(p.url()));
  if (!page) await sleep(300);
}
if (!page) errorOut("no app page on :1420 (is the dev server up?)");
const ua = await page.evaluate(() => navigator.userAgent);
const electronV = (ua.match(/Electron\/([\d.]+)/) || [])[1] || "?";

// ---- scaffold a throwaway project through the app, seed a manuscript --------
const seeded = await page.evaluate(async (proj) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const poll = async (fn, tries = 100, ms = 250) => {
    for (let i = 0; i < tries; i++) {
      try {
        if (fn()) return true;
      } catch {}
      await sleep(ms);
    }
    return false;
  };
  if (!(await poll(() => !!window.__flux))) return { error: "window.__flux never appeared" };
  try {
    const scaffold = await import("/src/lib/project/scaffold.ts");
    await scaffold.scaffoldProject(proj, { title: "perf" });
  } catch (e) {
    return { error: "scaffold: " + (e?.message || e) };
  }
  try {
    const shell = await import("/src/shell/shellStore.ts");
    await shell.openProjectAt(proj);
  } catch (e) {
    return { error: "open: " + (e?.message || e) };
  }
  if (!(await poll(() => !!document.querySelector('button[aria-label="Paper"]')))) return { error: "Paper rail button never appeared" };
  document.querySelector('button[aria-label="Paper"]').click();
  if (!(await poll(() => !!(window.__fluxView || (window.__flux?.editors ?? [])[0])))) return { error: "no editor view after Paper" };
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no __fluxView" };
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
  try {
    eo.observe({ type: "event", durationThreshold: 0 });
  } catch {
    eo.observe({ type: "event" });
  }
  view.focus();
  return { ok: true, lines: view.state.doc.lines };
}, PROJ);
if (seeded.error) fail("seed the paper editor — " + seeded.error);
console.log(`  ✓ launched Electron ${electronV} + seeded a ${seeded.lines}-line manuscript`);

// ---- helpers ----------------------------------------------------------------
async function setAmbient(on) {
  return await page.evaluate(async (want) => {
    const bg = window.__fluxMargin?.bg;
    if (!bg) return { present: false };
    if (want) bg.resume?.();
    else bg.pause?.();
    const n0 = bg.frames.length;
    await new Promise((r) => setTimeout(r, 400));
    return { present: true, animating: bg.frames.length > n0, ticks: bg.frames.length - n0 };
  }, on);
}
async function typeBurst() {
  await page.evaluate(() => {
    window.__perf.inp.length = 0;
    const v = window.__fluxView;
    v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true });
    v.focus();
  });
  const chars = "the quick brown fox jumps over the lazy dog and then some more words appear here now ".split("").slice(0, BURST);
  for (const ch of chars) {
    await page.keyboard.type(ch, { delay: 0 });
    await sleep(CADENCE);
  }
  await sleep(600);
  return await page.evaluate(() => window.__perf.inp.slice());
}

// ---- Phase A: ambient ON ----------------------------------------------------
const onState = await setAmbient(true);
if (!onState.present) fail("ambient background present — no __fluxMargin.bg (DEV build + Paper mode?)");
if (!onState.animating) fail(`ambient background animating in phase A — ticks=${onState.ticks}`);
console.log(`  ✓ ambient background animating (${onState.ticks} ticks/400ms)`);
const inpOn = await typeBurst();

// ---- Phase B: ambient OFF (paused) ------------------------------------------
const offState = await setAmbient(false);
if (offState.animating) fail(`ambient background paused in phase B — still ticking (${offState.ticks})`);
console.log("  ✓ ambient background paused for the control burst");
const inpOff = await typeBurst();

// ---- verdict ----------------------------------------------------------------
if (inpOn.length < BURST * 0.5 || inpOff.length < BURST * 0.5)
  fail(`captured enough INP samples — on=${inpOn.length} off=${inpOff.length} (need ≥${Math.round(BURST * 0.5)} each)`);
console.log(`  ✓ captured INP samples (on=${inpOn.length}, off=${inpOff.length})`);

const onP95 = quant(inpOn, 0.95);
const offP95 = quant(inpOff, 0.95);
const delta = onP95 - offP95;
console.log(
  `  · INP p95: ambient-ON ${round(onP95)}ms vs OFF ${round(offP95)}ms → Δ ${round(delta)}ms (budget <${DELTA_BUDGET}); ` +
    `p50 ON ${round(quant(inpOn, 0.5))} / OFF ${round(quant(inpOff, 0.5))}`,
);
clearTimeout(hardExit);
if (delta < DELTA_BUDGET) {
  console.log(`  ✓ ambient background adds <${DELTA_BUDGET}ms to keystroke INP (Δ ${round(delta)}ms)`);
  console.log("\nWRITER-LATENCY INP GATE: PASS");
  cleanup();
  process.exit(0);
} else {
  fail(`ambient background input-latency delta ${round(delta)}ms ≥ ${DELTA_BUDGET}ms — the rAF-coupling regression may be back`);
}
