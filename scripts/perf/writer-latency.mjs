// Writer input-latency probe — runs INSIDE Electron (connects to its
// --remote-debugging-port CDP), so the Electron/Chromium version is the variable
// under test. The scripts/verify-*.mjs harness drives system Chrome and therefore
// CANNOT see a 33-vs-43 difference; this can.
//
// Measures, in the paper editor on a realistic manuscript:
//   · inp   — INP-style keydown→next-paint per keystroke (Event Timing API), p50/p95/max
//   · canvas— the ambient DynamicBackground rAF loop's own frame deltas (window.__fluxMargin.bg)
//   · idle  — long-task count + total blocking time over a 3s idle sample (no typing)
//
// Assumes vite (:1420) AND `electron . --remote-debugging-port=9222` (launched with
// VITE_DEV_SERVER_URL=http://127.0.0.1:1420/?fixture=demo) are already up — see the
// orchestration in the accompanying run. Prints one JSON line.
//   Run: node scripts/perf/writer-latency.mjs
import puppeteer from "puppeteer-core";

const CDP = process.env.FLUX_CDP || "http://127.0.0.1:9222";
const CADENCE = Number(process.env.FLUX_CADENCE || 45); // ms between keystrokes
const NOCANVAS = process.env.FLUX_NOCANVAS === "1"; // pause the ambient DynamicBackground
const hardExit = setTimeout(() => {
  console.error(JSON.stringify({ error: "probe timed out (90s)" }));
  process.exit(2);
}, 90000);
const quant = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
let page;
for (let i = 0; i < 40 && !page; i++) {
  page = (await browser.pages()).find((p) => /127\.0\.0\.1:1420|localhost:1420/.test(p.url()));
  if (!page) await new Promise((r) => setTimeout(r, 250));
}
if (!page) {
  console.error(JSON.stringify({ error: "no app page found on :1420 (targets: " + (await browser.pages()).map((p) => p.url()).join(", ") + ")" }));
  process.exit(1);
}

const ua = await page.evaluate(() => navigator.userAgent);

// Enter paper mode + seed a ~122-line manuscript (8 sections × 12 paragraphs) so
// the editor has real work. NOTE: deliberately small — this probe isolates the
// ambient-background delta, not doc-size scaling; verify-scale-paper.mjs owns
// the large-doc (20k-line) keystroke budgets.
const PROJ = process.env.FLUX_PERF_PROJECT;
if (!PROJ) {
  console.error(JSON.stringify({ error: "set FLUX_PERF_PROJECT to a throwaway scaffolded project path" }));
  process.exit(2);
}
const seeded = await page.evaluate(async (projPath) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const poll = async (fn, tries = 60, ms = 250) => {
    for (let i = 0; i < tries; i++) {
      try {
        if (fn()) return true;
      } catch {}
      await sleep(ms);
    }
    return false;
  };
  // 1. wait for the app to boot.
  await poll(() => !!window.__flux);
  // 2. open the THROWAWAY real project via the real Electron bridge if we're on Home
  //    (no rail). Any autosave writes land in the temp project, never the user's files.
  if (!document.querySelector('button[aria-label="Paper"]')) {
    try {
      const shell = await import("/src/shell/shellStore.ts");
      await shell.openProjectAt(projPath);
    } catch (e) {
      return { error: "could not open throwaway project: " + (e?.message || e) };
    }
    await poll(() => !!document.querySelector('button[aria-label="Paper"]'));
  }
  // 3. into paper mode, wait for the editor view.
  document.querySelector('button[aria-label="Paper"]')?.click();
  await poll(() => !!(window.__fluxView || (window.__flux?.editors ?? [])[0]));
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view)
    return {
      error: "no __fluxView (paper not active)",
      diag: {
        url: location.href,
        hasFlux: !!window.__flux,
        fluxKeys: window.__flux ? Object.keys(window.__flux).slice(0, 20) : [],
        rail: [...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).slice(0, 20),
        body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
      },
    };
  const lines = ["# Manuscript", ""];
  for (let s = 0; s < 8; s++) {
    lines.push(`## Section ${s}`, "");
    for (let p = 0; p < 12; p++) lines.push(`Paragraph ${s}.${p} — ` + "the quick brown fox jumps over the lazy dog. ".repeat(4));
    lines.push("");
  }
  const text = lines.join("\n");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
  await new Promise((r) => requestAnimationFrame(r));
  view.focus();
  return { ok: true, lines: view.state.doc.lines };
}, PROJ);
if (seeded.error) {
  console.error(JSON.stringify(seeded));
  await browser.disconnect();
  process.exit(1);
}
if (NOCANVAS) await page.evaluate(() => window.__fluxMargin?.bg?.pause?.());

// Observers: Event Timing (keydown INP) + long tasks.
await page.evaluate(() => {
  window.__perf = { inp: [], long: [] };
  const eo = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === "keydown") window.__perf.inp.push(e.duration);
  });
  try {
    eo.observe({ type: "event", durationThreshold: 0 });
  } catch {
    eo.observe({ type: "event" });
  }
  const lo = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__perf.long.push(e.duration);
  });
  try {
    lo.observe({ type: "longtask" });
  } catch {}
});

// Caret to the end, in view, focused.
await page.evaluate(() => {
  const v = window.__fluxView;
  v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true });
  v.focus();
});
await new Promise((r) => setTimeout(r, 400));

// Typing burst: real keystrokes via CDP at ~22 cps (each settles to a paint).
const CHARS = "the quick brown fox jumps over the lazy dog and then some more words appear here ".split("");
for (const ch of CHARS) {
  await page.keyboard.type(ch, { delay: 0 });
  await new Promise((r) => setTimeout(r, CADENCE));
}
await new Promise((r) => setTimeout(r, 600));

const inp = await page.evaluate(() => window.__perf.inp.slice());
const canvas = await page.evaluate(() => {
  const bg = window.__fluxMargin?.bg;
  if (!bg) return { present: false };
  return { present: true, frames: bg.frames.slice(-160), dims: bg.dims() };
});

// Idle sample: 3s with no input — surfaces the ambient loop's background cost.
await page.evaluate(() => (window.__perf.long.length = 0));
await new Promise((r) => setTimeout(r, 3000));
const idleLong = await page.evaluate(() => window.__perf.long.slice());

const out = {
  electron: (ua.match(/Electron\/([\d.]+)/) || [])[1] || "?",
  chrome: (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "?",
  cadenceMs: CADENCE,
  canvasPaused: NOCANVAS,
  inp: { n: inp.length, p50: Math.round(quant(inp, 0.5)), p95: Math.round(quant(inp, 0.95)), max: Math.round(Math.max(0, ...inp)) },
  canvas: canvas.present
    ? {
        p50: +quant(canvas.frames, 0.5).toFixed(1),
        p95: +quant(canvas.frames, 0.95).toFixed(1),
        max: +Math.max(0, ...canvas.frames).toFixed(1),
        sprites: canvas.dims.active,
        box: `${Math.round(canvas.dims.cssW)}x${Math.round(canvas.dims.cssH)}`,
      }
    : { present: false },
  idleLongTasks: { n: idleLong.length, totalBlockingMs: Math.round(idleLong.reduce((a, b) => a + Math.max(0, b - 50), 0)), maxMs: Math.round(Math.max(0, ...idleLong)) },
};
clearTimeout(hardExit);
console.log(JSON.stringify(out));
await browser.disconnect();
