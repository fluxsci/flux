// verify-crisp.mjs — figure-v1 P6 gate: crisp-at-rest zoom raster contract
// (ui-extra + retryOnce; dev server on :1420 must be up — never spawned here).
//
// Guards the two-part Phase 6 fix in src/lib/Canvas.svelte (diagnosis:
// notes/Flux_Electron_Compositor_Notes.md — blur reproduces at DSF 2 only, and
// ONLY will-change demotion releases full sharpness; plain repaints are
// bit-identical):
//   A. one repaint per zoom gesture — wheel zoom applies a compositor-only
//      residual scale on the .scene wrapper; the scene SVG's <g scale(renderZoom)>
//      mutates EXACTLY ONCE per burst, on the ZOOM_SETTLE_MS fold;
//   B. will-change lifecycle — .scene promotes while interacting (sceneHot),
//      DEMOTES at idle: computed will-change === "auto" at rest, so the settled
//      raster IS the full-quality demoted raster (the blur fix).
//
// Runs its own puppeteer launch at device-scale-factor 2 — the defect only
// reproduces at DSF 2 (driver.mjs pins DSF 1, which hides it). Sharpness metric
// (mean absolute Laplacian on a screenshot clip) copied from
// scripts/diagnose-crisp.mjs (Phase 0a instrument).
//
// GATE-DESIGN NOTE (per Phase 0a): post-drag is NOT a valid crisp reference in
// headless Chrome (the drag never re-rasters there even while blur is provably
// present). The crisp reference is the WILL-CHANGE-DEMOTED state; after the fix
// the settled state IS demoted, so settled/demoted must be ~1.0 (assert ≥0.95).
//
//   node scripts/verify-crisp.mjs               # the gate (asserts, exit != 0 on fail)
//   node scripts/verify-crisp.mjs --baseline    # measurement-only (pre-fix numbers)
//   CRISP_EVIDENCE=out.png node scripts/verify-crisp.mjs   # also writes the
//        settled-vs-forced-demote side-by-side evidence PNG at zoom 4x.
//
// Baseline measured FIRST at parent commit 02649f6 (pre-fix, this machine, DSF 2):
//   zoom-g mutations per 20-tick burst: 20 (one content repaint per tick)
//   will-change at rest: "transform" (permanent) · residual: none (scale in <g>)
//   sharpness settled 17.467 vs demoted 22.522 (ratio 0.776 — the 0.95 assert
//   below FAILS pre-fix; forced-promote control re-softens to 17.467)
//   wheel-burst rAF p95 on the 1600-element fixture: 16.7ms (see BASELINE_P95 —
//   headless rAF timestamps are vsync-quantized at ~16.7ms; the per-tick raster
//   cost rides the compositor/raster threads, so main-thread p95 was already at
//   the floor pre-fix and must simply not regress).

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.FLUX_CHROME || "/usr/bin/google-chrome";
const APP_URL = (process.env.FLUX_URL || "http://127.0.0.1:1420/") + "?fixture=demo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASELINE = process.argv.includes("--baseline");

// Pre-fix wheel-burst rAF p95 measured FIRST at the parent commit (02649f6) with
// --baseline on this machine (DSF 2, 1600-element fixture): 16.7ms — the vsync
// floor (see header note). Post-fix p95 must stay at that floor; +1ms absorbs
// timestamp jitter between frames, nothing more. The hard budget is 33ms.
const BASELINE_P95 = 16.7;
const P95_TOLERANCE_MS = 1;
const P95_BUDGET_MS = 33;

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}
function info(msg) {
  console.log(`  · ${msg}`);
}

// ---------- fixture assets ----------
const FIX = path.join(repoRoot, "fixtures", "plots");
const growthSvg = readFileSync(path.join(FIX, "growth.svg"), "utf8");
const growthManifest = JSON.parse(readFileSync(path.join(FIX, "growth.fluxplot.json"), "utf8"));
const growthRecipe = JSON.parse(readFileSync(path.join(FIX, "growth.recipe.json"), "utf8"));
// Heavy inline trace (tile pressure) — synthesized, hermetic (same shape as the
// diagnose-crisp fallback; no dependency on ~/Master_flux_test).
let noiseD = "M0 40";
for (let i = 1; i < 30000; i++) noiseD += `L${(i * 0.04).toFixed(2)} ${(40 + Math.sin(i * 0.7) * 30).toFixed(1)}`;
const traceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="80" viewBox="0 0 1200 80"><path d="${noiseD}" stroke="#333" stroke-width="0.4" fill="none"/></svg>`;

// ---------- in-page helpers ----------

// Seed the Phase-0a repro configuration: the demo figure blown up to 2600x1800
// (figure-spanning bg/clip rects stretch the composited .scene layer to
// content-bounds x zoom) + a dense text/hairline sharpness target + ~185 mixed
// elements + one semantic plot + one heavy inline trace.
function seedScene({ growthSvg, growthManifest, growthRecipe, traceSvg }) {
  const F = window.__flux;
  F.io.reimportPlot("crisp-growth", growthSvg, growthManifest, growthRecipe);
  F.io.reimportPlot("crisp-trace", traceSvg, { specVersion: "diag/0", axes: [], series: [], guides: [] });
  const T = { x: 260, y: 560 };
  let figId = null;
  F.fig.commit((p) => {
    const fig = p.figures.find((f) => f.id === "growth") ?? p.figures[0];
    figId = fig.id;
    fig.width = 2600;
    fig.height = 1800;
    fig.elements = fig.elements.filter((e) => !/^(crisp-|bg-)/.test(e.id));
    const els = fig.elements;
    els.push({ type: "plot", id: "crisp-plot", assetId: "crisp-growth", x: 40, y: 40, width: 480, height: 360, rotation: 0 });
    els.push({ type: "plot", id: "crisp-trace-el", assetId: "crisp-trace", x: 560, y: 60, width: 1200, height: 74, rotation: 0 });
    for (let i = 0; i < 8; i++) {
      els.push({
        type: "text", id: `crisp-t${i}`, x: T.x - 120, y: T.y - 54 + i * 13, width: 260, height: 12, rotation: 0,
        text: `sharpness ${i} · Ijk 0.017 uV/mm2 fine hairline row ${i}${i}${i}`,
        fontFamily: "sans-serif", fontSize: 9, fontWeight: 400, fontStyle: "normal",
        align: "left", color: "#111111", sizing: "auto",
      });
      els.push({
        type: "line", id: `crisp-l${i}`, x: T.x - 120, y: T.y - 45 + i * 13, width: 0, height: 0,
        x1: 0, y1: 0, x2: 250, y2: 0, stroke: "#445566", strokeWidth: 0.5,
        arrowStart: false, arrowEnd: false, rotation: 0,
      });
    }
    for (let i = 0; i < 12; i++)
      els.push({
        type: "rect", id: `crisp-r${i}`, x: T.x - 120 + i * 21, y: T.y + 52, width: 14, height: 14, rotation: 0,
        fill: "#ffffff", stroke: "#333333", strokeWidth: 0.75, cornerRadius: 0,
      });
    let n = 0;
    for (let r = 0; r < 13 && n < 185; r++)
      for (let c = 0; c < 16 && n < 185; c++) {
        const x = 80 + c * 155;
        const y = 120 + r * 125;
        if (Math.abs(x - T.x) < 210 && Math.abs(y - T.y) < 170) continue;
        const k = n % 4;
        if (k === 0)
          els.push({ type: "rect", id: `bg-${n}`, x, y, width: 90, height: 64, rotation: 0, fill: "#7aa2f7", stroke: "#333333", strokeWidth: 1, cornerRadius: 2 });
        else if (k === 1)
          els.push({ type: "ellipse", id: `bg-${n}`, x, y, width: 74, height: 54, rotation: 0, fill: "#f7c67a", stroke: "#333333", strokeWidth: 1 });
        else if (k === 2)
          els.push({ type: "line", id: `bg-${n}`, x, y, width: 0, height: 0, x1: 0, y1: 0, x2: 110, y2: 34, stroke: "#666666", strokeWidth: 1, arrowStart: false, arrowEnd: true, rotation: 0 });
        else
          els.push({ type: "text", id: `bg-${n}`, x, y, width: 90, height: 16, rotation: 0, text: `bg label ${n}`, fontFamily: "sans-serif", fontSize: 12, fontWeight: 400, fontStyle: "normal", align: "left", color: "#222222", sizing: "auto" });
        n++;
      }
  });
  const host = document.querySelector(".canvas-host").getBoundingClientRect();
  const fig = F.figures().find((f) => f.id === figId);
  const ax = Math.round(host.left + host.width * 0.45);
  const ay = Math.round(host.top + host.height * 0.5);
  F.fig.viewport.set({ panX: ax - host.left - (fig.x + T.x), panY: ay - host.top - (fig.y + T.y), zoom: 1 });
  return { ax, ay, figId, els: fig.elements.length };
}

// Mean absolute Laplacian of a PNG (base64) — the diagnose-crisp.mjs metric.
function laplacianOfPng(b64) {
  return (async () => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const w = c.width, h = c.height;
    const g = new Float64Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    let sum = 0, n = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        sum += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]);
        n++;
      }
    return sum / n;
  })();
}

async function sharpness(page, clip) {
  const b64 = await page.screenshot({ clip, encoding: "base64", captureBeyondViewport: false });
  return page.evaluate(laplacianOfPng, b64);
}

// In-page ctrl+wheel burst (setInterval — immune to CDP roundtrip latency, so
// tick spacing stays far below ZOOM_SETTLE_MS and the burst can't fold early).
async function wheelBurst(page, ax, ay, ticks, deltaY, spacing = 25) {
  await page.evaluate(
    ({ x, y, ticks, dy, spacing }) =>
      new Promise((res) => {
        const h = document.querySelector(".canvas-host");
        let i = 0;
        const t = setInterval(() => {
          h.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
          if (++i >= ticks) {
            clearInterval(t);
            res();
          }
        }, spacing);
      }),
    { x: ax, y: ay, ticks, dy: deltaY, spacing }
  );
}

const zoomOf = (page) => page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
const sceneState = (page) =>
  page.evaluate(() => {
    const scene = document.querySelector(".scene");
    const g = document.querySelector(".scene-svg > g");
    const cs = getComputedStyle(scene);
    const m = /matrix\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+)/.exec(cs.transform);
    const gs = /scale\(([-\d.e]+)/.exec(g.getAttribute("transform") || "");
    return {
      willChange: cs.willChange,
      residual: m ? Number(m[1]) : null, // wrapper scale factor (a of the matrix)
      gScale: gs ? Number(gs[1]) : null,
    };
  });

// ---------- launch (own flags: DSF 2 is where the defect reproduces) ----------
const width = 1440, height = 900;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", `--window-size=${width},${height}`, "--force-device-scale-factor=2"],
  defaultViewport: { width, height, deviceScaleFactor: 2 },
});
const errs = [];
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
  await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => !!window.__flux?.fig, { timeout: 15000 });
  await sleep(1500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button[aria-label]")].find((e) => e.getAttribute("aria-label") === "Figure");
    if (b) b.click();
  });
  await sleep(900);
  await page.waitForSelector(".canvas-host", { timeout: 10000 });

  const seed = await page.evaluate(seedScene, { growthSvg, growthManifest, growthRecipe, traceSvg });
  await sleep(600); // > settle+cool: programmatic viewport.set folds via the timer
  const clip = { x: seed.ax - 160, y: seed.ay - 160, width: 320, height: 320 };
  info(`seeded ${seed.els} elements into ${seed.figId} (DSF 2)`);

  // ---- (1)+(4) fold-once + mid-gesture state over a 20-tick burst -----------
  await page.evaluate(() => {
    const g = document.querySelector(".scene-svg > g");
    const scene = document.querySelector(".scene");
    window.__crisp = { mut: 0, samples: [] };
    window.__crispObs = new MutationObserver((muts) => {
      for (const m of muts) if (m.attributeName === "transform") window.__crisp.mut++;
    });
    window.__crispObs.observe(g, { attributes: true, attributeFilter: ["transform"] });
    window.__crispSampling = true;
    const sample = () => {
      if (!window.__crispSampling) return;
      const cs = getComputedStyle(scene);
      const m = /matrix\(([-\d.e]+)/.exec(cs.transform);
      window.__crisp.samples.push({ wc: cs.willChange, s: m ? Number(m[1]) : 1 });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // ONE 20-tick net zoom-in burst (single in-page setInterval — no CDP gaps that
  // could fold early): exp(0.06)^20 = 3.320, inside the 3–4 repro band. A net
  // burst also dodges the FP edge where an exactly-invertible out/in pair folds
  // back to a bit-identical scale (which would legitimately write 0 mutations).
  await wheelBurst(page, seed.ax, seed.ay, 20, -40);
  await sleep(1200); // ZOOM_SETTLE_MS(180) + fold + SCENE_COOL_MS(200) + margin
  const burst = await page.evaluate(() => {
    window.__crispSampling = false;
    window.__crispObs.disconnect();
    return window.__crisp;
  });
  const rest = await sceneState(page);
  const zNow = await zoomOf(page);
  const hotSamples = burst.samples.filter((s) => s.wc === "transform");
  const residualSamples = burst.samples.filter((s) => Math.abs(s.s - 1) > 1e-6);
  info(`burst: ${burst.mut} zoom-g mutation(s), ${burst.samples.length} rAF samples (${hotSamples.length} hot, ${residualSamples.length} residual!=1)`);
  info(`rest: will-change="${rest.willChange}" residual=${rest.residual} gScale=${rest.gScale} zoom=${zNow}`);
  if (!BASELINE) {
    assert(burst.mut === 1, `20-tick ctrl-wheel burst mutates the scene zoom <g> transform EXACTLY once (got ${burst.mut})`);
    assert(rest.willChange === "auto", `at rest the .scene computed will-change is "auto" (got "${rest.willChange}")`);
    assert(rest.residual !== null && Math.abs(rest.residual - 1) < 1e-9, `at rest the wrapper residual scale is exactly 1 (got ${rest.residual})`);
    assert(rest.gScale !== null && rest.gScale === zNow, `at rest the <g> scale equals viewport.zoom (${rest.gScale} == ${zNow})`);
    assert(hotSamples.length > 0, `mid-burst the .scene will-change was "transform" in ${hotSamples.length} sample(s) (compositor path active)`);
    assert(residualSamples.length > 0, `mid-burst the wrapper residual scale left 1 in ${residualSamples.length} sample(s)`);
  }

  // ---- (3) sharpness: settled vs will-change-demoted reference at zoom ~3.3 --
  // (already zoomed + settled by the burst above — the target stayed pinned
  // under the cursor via zoom-about-cursor)
  const zAt = await zoomOf(page);
  const S_settled = await sharpness(page, clip);
  // Reference: explicit demotion (the ONLY crisp reference valid headless — see
  // gate-design note). Post-fix the settled state is already demoted ⇒ no-op.
  await page.evaluate(() => (document.querySelector(".scene").style.willChange = "auto"));
  await sleep(400);
  const S_demoted = await sharpness(page, clip);
  // Teeth control (recorded, non-fatal — headless-box variance): force-promote
  // should re-soften at DSF 2 while the layer bounds are huge.
  await page.evaluate(() => (document.querySelector(".scene").style.willChange = "transform"));
  await sleep(400);
  const S_promoted = await sharpness(page, clip);
  await page.evaluate(() => (document.querySelector(".scene").style.willChange = ""));
  await sleep(200);
  const ratio = S_settled / S_demoted;
  info(`sharpness @zoom ${zAt.toFixed(3)}: settled=${S_settled.toFixed(3)} demoted-ref=${S_demoted.toFixed(3)} ratio=${ratio.toFixed(3)} (forced-promote control=${S_promoted.toFixed(3)})`);
  if (!BASELINE)
    assert(ratio >= 0.95, `settled sharpness >= 0.95x the will-change-demoted reference (got ${ratio.toFixed(3)} — settled IS the demoted raster)`);

  // LIVE visual evidence (CRISP_EVIDENCE=path): zoom EXACTLY 4x on the
  // text-heavy target, settle 400ms+, screenshot; force-demote; screenshot —
  // post-fix the two must be identical (settled IS demoted).
  if (process.env.CRISP_EVIDENCE) {
    await page.evaluate((a) => {
      const F = window.__flux;
      const host = document.querySelector(".canvas-host").getBoundingClientRect();
      const v = F.get(F.fig.viewport);
      const wx = (a.ax - host.left - v.panX) / v.zoom;
      const wy = (a.ay - host.top - v.panY) / v.zoom;
      F.fig.viewport.set({ zoom: 4, panX: a.ax - host.left - wx * 4, panY: a.ay - host.top - wy * 4 });
    }, { ax: seed.ax, ay: seed.ay });
    await sleep(600); // settle fold (180) + cool (200) + margin — at rest
    const evSettled = await page.screenshot({ clip, encoding: "base64" });
    const evSettledLap = await page.evaluate(laplacianOfPng, evSettled);
    await page.evaluate(() => (document.querySelector(".scene").style.willChange = "auto"));
    await sleep(400);
    const evDemoted = await page.screenshot({ clip, encoding: "base64" });
    const evDemotedLap = await page.evaluate(laplacianOfPng, evDemoted);
    await page.evaluate(() => (document.querySelector(".scene").style.willChange = ""));
    const composite = await page.evaluate(async ({ a, b, la, lb, z }) => {
      const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + b64; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const c = document.createElement("canvas");
      c.width = ia.width + ib.width + 24;
      c.height = Math.max(ia.height, ib.height) + 48;
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(ia, 8, 40);
      x.drawImage(ib, ia.width + 16, 40);
      x.fillStyle = "#111";
      x.font = "600 20px sans-serif";
      x.fillText(`settled at rest, zoom ${z}x (Laplacian ${la.toFixed(3)})`, 8, 28);
      x.fillText(`forced will-change demote (Laplacian ${lb.toFixed(3)})`, ia.width + 16, 28);
      return c.toDataURL("image/png").split(",")[1];
    }, { a: evSettled, b: evDemoted, la: evSettledLap, lb: evDemotedLap, z: 4 });
    writeFileSync(process.env.CRISP_EVIDENCE, Buffer.from(composite, "base64"));
    info(`evidence @4x: settled=${evSettledLap.toFixed(3)} demoted=${evDemotedLap.toFixed(3)} → ${process.env.CRISP_EVIDENCE}`);
  }

  // ---- (5) pan leaves the visible-element set identical (cull quantization) --
  await page.evaluate(() => {
    const F = window.__flux;
    const v = F.get(F.fig.viewport);
    F.fig.viewport.set({ ...v, panX: 60, panY: 80, zoom: 1 });
  });
  await sleep(500); // settle the programmatic zoom change
  const before = await page.evaluate(() => document.querySelectorAll(".scene .el").length);
  await page.evaluate(() => {
    const F = window.__flux;
    const v = F.get(F.fig.viewport);
    F.fig.viewport.set({ ...v, panX: v.panX - 60, panY: v.panY - 60 });
  });
  await sleep(300);
  const after = await page.evaluate(() => document.querySelectorAll(".scene .el").length);
  info(`pan cull: ${before} els -> ${after} els after a small pan`);
  if (!BASELINE) assert(before === after && before > 0, `a small pan keeps the rendered .el set identical (${before} == ${after})`);

  // ---- (6) wheel-burst rAF p95 on the f5-style 1600-element fixture ----------
  // The shared :1420 dev server can full-reload mid-run (vite dep-optimizer /
  // a PARALLEL agent session's src edits — documented P0b flake). A reload also
  // wipes the in-memory demo project, so the WHOLE leg (fixture rebuild +
  // recorder + burst + collect) retries as a unit; retryOnce covers the rest.
  const cx = Math.round(width * 0.5), cy = Math.round(height * 0.55);
  let frames = null;
  for (let attempt = 0; attempt < 3 && !(frames && frames.length); attempt++) {
    try {
      await page.waitForFunction(() => !!window.__flux?.fig && !!document.querySelector(".canvas-host"), { timeout: 20000 });
      await page.evaluate(() => {
        const F = window.__flux.fig;
        F.commit((p) => {
          const fig = p.figures.find((f) => f.id === "growth") ?? p.figures[0];
          fig.width = 5000;
          fig.height = 5000;
          fig.elements = [];
          let id = 0;
          for (let r = 0; r < 40; r++)
            for (let c = 0; c < 40; c++)
              fig.elements.push({
                type: "rect", id: `gen-${id++}`, x: c * 120 + 10, y: r * 120 + 10,
                width: 90, height: 90, rotation: 0, fill: "#7aa2f7", stroke: "#333", strokeWidth: 1, cornerRadius: 2,
              });
        });
        F.viewport.set({ panX: 60, panY: 80, zoom: 1 });
      });
      await sleep(600);
      await page.evaluate(() => {
        window.__frames = [];
        window.__fs = true;
        const t = (ts) => {
          if (window.__fs) {
            window.__frames.push(ts);
            requestAnimationFrame(t);
          }
        };
        requestAnimationFrame(t);
      });
      await wheelBurst(page, cx, cy, 10, -60);
      await wheelBurst(page, cx, cy, 10, +60);
      await sleep(450); // include the settle fold in the measured window
      frames = await page.evaluate(() => {
        window.__fs = false;
        return window.__frames ?? null;
      });
    } catch (e) {
      info(`perf-leg attempt ${attempt + 1} lost to a page reload (${String(e).slice(0, 80)}…) — retrying`);
      frames = null;
      await sleep(1500);
    }
  }
  frames = frames ?? [];
  const ivals = frames.slice(1).map((t, i) => t - frames[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const med = ivals[Math.floor(ivals.length / 2)] || 0;
  const p95 = ivals[Math.floor(ivals.length * 0.95)] || 0;
  const max = ivals[ivals.length - 1] || 0;
  info(`wheel-burst rAF on 1600-el fixture: frames=${frames.length} median=${med.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms (budget ${P95_BUDGET_MS}ms, pre-fix baseline ${BASELINE_P95}ms)`);
  if (!BASELINE) {
    assert(p95 < P95_BUDGET_MS, `wheel-burst rAF p95 < ${P95_BUDGET_MS}ms (got ${p95.toFixed(1)}ms)`);
    assert(p95 <= BASELINE_P95 + P95_TOLERANCE_MS, `wheel-burst rAF p95 <= pre-fix baseline ${BASELINE_P95}ms (+${P95_TOLERANCE_MS}ms jitter; got ${p95.toFixed(1)}ms)`);
  }

  // ---- console errors ---------------------------------------------------------
  const realErrs = errs.filter((e) => !/Failed to load resource.*404/i.test(e));
  if (!BASELINE) assert(realErrs.length === 0, `0 console errors (got ${realErrs.length}${realErrs.length ? ": " + realErrs[0] : ""})`);
  else if (realErrs.length) info(`console errors: ${realErrs.join(" | ")}`);

  console.log(BASELINE ? "\nVERIFY-CRISP: BASELINE RUN (no asserts)" : failed === 0 ? "\nVERIFY-CRISP: PASS" : `\nVERIFY-CRISP: FAIL (${failed})`);
} finally {
  await browser.close();
}
process.exit(BASELINE ? 0 : failed === 0 ? 0 : 1);
