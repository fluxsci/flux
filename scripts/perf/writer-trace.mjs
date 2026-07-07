// Deep-dive companion to writer-latency.mjs: captures a DevTools timeline trace of a
// typing burst INSIDE Electron and attributes main-thread SELF-time across the render
// pipeline (scripting / style / layout / prepaint / paint / raster / composite / gc),
// so we can see which phase the Chromium jump made expensive.
//   Env: FLUX_PERF_PROJECT (throwaway project), FLUX_CADENCE (ms between keys, default 45),
//        FLUX_NOCANVAS=1 (pause the ambient DynamicBackground first), FLUX_TRACE (out path).
//   Run: node scripts/perf/writer-trace.mjs
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const CDP = process.env.FLUX_CDP || "http://127.0.0.1:9222";
const PROJ = process.env.FLUX_PERF_PROJECT;
const CADENCE = Number(process.env.FLUX_CADENCE || 45);
const NOCANVAS = process.env.FLUX_NOCANVAS === "1";
const TRACE = process.env.FLUX_TRACE || "/tmp/writer-trace.json";
if (!PROJ) {
  console.error(JSON.stringify({ error: "set FLUX_PERF_PROJECT" }));
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
let page;
for (let i = 0; i < 40 && !page; i++) {
  page = (await browser.pages()).find((p) => /1420/.test(p.url()));
  if (!page) await sleep(250);
}
if (!page) {
  console.error(JSON.stringify({ error: "no app page on :1420" }));
  process.exit(1);
}

const ua = await page.evaluate(() => navigator.userAgent);
const seeded = await page.evaluate(
  async (projPath, noCanvas) => {
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
    await poll(() => !!window.__flux);
    if (!document.querySelector('button[aria-label="Paper"]')) {
      const shell = await import("/src/shell/shellStore.ts");
      await shell.openProjectAt(projPath);
      await poll(() => !!document.querySelector('button[aria-label="Paper"]'));
    }
    document.querySelector('button[aria-label="Paper"]')?.click();
    await poll(() => !!(window.__fluxView || (window.__flux?.editors ?? [])[0]));
    const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
    if (!view) return { error: "no __fluxView" };
    const lines = ["# Manuscript", ""];
    for (let s = 0; s < 8; s++) {
      lines.push(`## Section ${s}`, "");
      for (let p = 0; p < 12; p++) lines.push(`Paragraph ${s}.${p} — ` + "the quick brown fox jumps over the lazy dog. ".repeat(4));
      lines.push("");
    }
    const text = lines.join("\n");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
    await new Promise((r) => requestAnimationFrame(r));
    if (noCanvas && window.__fluxMargin?.bg?.pause) window.__fluxMargin.bg.pause();
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    view.focus();
    return { ok: true, canvasPaused: noCanvas && !!window.__fluxMargin?.bg?.pause };
  },
  PROJ,
  NOCANVAS,
);
if (seeded.error) {
  console.error(JSON.stringify(seeded));
  await browser.disconnect();
  process.exit(1);
}
await sleep(400);

await page.tracing.start({ path: TRACE, screenshots: false, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
const CHARS = "the quick brown fox jumps over the lazy dog and then some more words appear here ".split("");
for (const ch of CHARS) {
  await page.keyboard.type(ch, { delay: 0 });
  await sleep(CADENCE);
}
await sleep(500);
await page.tracing.stop();
await browser.disconnect();

// ---- analyze: self-time by category on the busiest renderer thread ----------------
const events = JSON.parse(readFileSync(TRACE, "utf8")).traceEvents || [];
// pick the renderer thread with the most keydown EventDispatch events.
const keydownByThread = {};
for (const e of events) {
  if (e.name === "EventDispatch" && e.args?.data?.type === "keydown") {
    const k = `${e.pid}:${e.tid}`;
    keydownByThread[k] = (keydownByThread[k] || 0) + 1;
  }
}
const [mainKey, keydowns] = Object.entries(keydownByThread).sort((a, b) => b[1] - a[1])[0] || ["", 0];
const [pid, tid] = mainKey.split(":").map(Number);

const catOf = (name) => {
  if (/^(FunctionCall|EvaluateScript|v8|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|ProfileCall|V8\.|MinorGC|MajorGC|GCEvent|BlinkGC)/.test(name)) return "scripting";
  if (/^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|StyleRecalcInvalidationTracking)/.test(name)) return "style";
  if (/^(Layout|InvalidateLayout|LayoutShift|HitTest|ComputeIntersections)/.test(name)) return "layout";
  if (/^(PrePaint|Pre-Paint|UpdateLayerTree|Layerize)/.test(name)) return "prepaint";
  if (/^(Paint|PaintImage|ScrollLayer|SetLayerTreeId)/.test(name)) return "paint";
  if (/^(RasterTask|Rasterize|ImageDecode|Draw|GPUTask)/.test(name)) return "raster";
  if (/^(CompositeLayers|Commit|UpdateLayer|BeginFrame|DrawFrame|NeedsBeginFrameChanged|RequestMainThreadFrame)/.test(name)) return "composite";
  if (/GC/.test(name)) return "gc";
  return "other";
};

const X = events
  .filter((e) => e.pid === pid && e.tid === tid && e.ph === "X" && e.dur > 0)
  .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const nodes = [];
const stack = [];
for (const e of X) {
  while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
  const node = { end: e.ts + e.dur, self: e.dur, name: e.name };
  if (stack.length) stack[stack.length - 1].self -= e.dur;
  nodes.push(node);
  stack.push(node);
}
const byCat = {};
const byName = {};
let totalSelf = 0;
for (const n of nodes) {
  const self = Math.max(0, n.self);
  totalSelf += self;
  byCat[catOf(n.name)] = (byCat[catOf(n.name)] || 0) + self;
  byName[n.name] = (byName[n.name] || 0) + self;
}
const ms = (us) => +(us / 1000).toFixed(1);
const perKey = (us) => +(us / 1000 / Math.max(1, keydowns)).toFixed(2);
const topNames = Object.entries(byName)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([n, v]) => `${n}=${ms(v)}ms (${perKey(v)}/key)`);

console.log(
  JSON.stringify(
    {
      electron: (ua.match(/Electron\/([\d.]+)/) || [])[1],
      chrome: (ua.match(/Chrome\/([\d.]+)/) || [])[1],
      cadenceMs: CADENCE,
      canvasPaused: seeded.canvasPaused,
      keydowns,
      totalMainThreadMs: ms(totalSelf),
      perKeyMs: perKey(totalSelf),
      byCategoryPerKeyMs: Object.fromEntries(Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, perKey(v)])),
      topEvents: topNames,
    },
    null,
    2,
  ),
);
