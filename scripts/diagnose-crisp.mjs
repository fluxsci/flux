#!/usr/bin/env node
// diagnose-crisp.mjs — Phase 0a crispness DIAGNOSIS tool (flux-figure V1 upgrade).
//
// STANDALONE TOOL, deliberately NOT registered in scripts/verify-manifest.json:
// run-verifies.mjs executes only manifest-listed scripts (it never globs the
// scripts/ dir), so an unlisted file is invisible to the gate — this is a
// measurement instrument, not a pass/fail verify.
//
// What it measures (the "blurry until you drag something" complaint, changes-list #8):
//   1. Seed a content-heavy figure scene (semantic plot + 550KB <image> SVG +
//      ~215 mixed elements incl. a dense text/hairline "sharpness target").
//   2. Zoom to ~3.5x with REAL ctrl+wheel events on .canvas-host (the exact
//      onWheel path users hit), zoom-about-cursor pinned on the target.
//   3. Sharpness = mean absolute Laplacian (edge energy) of a screenshot clip
//      over the target, computed in-page on a canvas. Higher = crisper.
//   4. S_settled (600ms after last tick) vs S_afterDrag (after a small real
//      mouse drag of an off-clip element — the user's workaround).
//      Repro criterion: S_afterDrag / S_settled > 1.15.
//   5. Discrimination toggles, each from a freshly re-blurred state:
//        (a) .scene style.willChange="auto"      → sharp ⇒ layer demotion suffices
//        (b0) no-op commit (store bump, no DOM Δ) → sharp ⇒ svelte-level staleness
//        (b1) 1px off-clip element mutation       → sharp ⇒ plain repaint suffices
//        (a)-not-(b) ⇒ budget-limited tiles (raster-scale stuck on the permanent
//        will-change layer) — the Phase 6 pre-designed fix covers either way.
//   6. CDP LayerTree bounds/paintCount for the .scene layer at zoom .5/1/4/16
//      (supplementary; headless may not emit layer events).
//   Whole matrix runs at device-scale-factor 1 AND 2 (driver.mjs pins DSF 1,
//   which can hide the real case — hence own puppeteer launch here).
//
// Usage:
//   node scripts/diagnose-crisp.mjs [--dsf 1,2] [--notes] [--connect URL]
//     --dsf      comma list of device scale factors (default "1,2")
//     --notes    append a "## Phase 0a findings" section to
//                flux_figure_upgrades_fixes/IMPLEMENTATION_NOTES.md (official runs
//                only — flag-gated so dev re-runs don't spam the journal)
//     --connect  browserURL of an ALREADY-RUNNING browser (e.g. Electron started
//                with --remote-debugging-port=9223 → http://127.0.0.1:9223): runs
//                the same matrix on its real compositor instead of launching
//                headless Chrome. Pair with --enable-logging=stderr on the
//                Electron side and grep the log for tile_manager.cc /
//                "Frame latency" counts (see notes/Flux_Electron_Compositor_Notes.md).
//
// Requires the dev server already on :1420 (never spawns/kills one).

import { readFileSync, appendFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.FLUX_CHROME || "/usr/bin/google-chrome";
const APP_URL = (process.env.FLUX_URL || "http://127.0.0.1:1420/") + "?fixture=demo";
const NOTES = path.join(repoRoot, "flux_figure_upgrades_fixes", "IMPLEMENTATION_NOTES.md");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { dsfs: [1, 2], notes: false, connect: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dsf") opt.dsfs = String(argv[++i]).split(",").map(Number).filter(Boolean);
  else if (argv[i] === "--notes") opt.notes = true;
  else if (argv[i] === "--connect") opt.connect = argv[++i];
  else {
    console.error(`Unknown arg ${argv[i]}`);
    process.exit(2);
  }
}

// ---------- fixture assets (node side) ----------
const FIX = path.join(repoRoot, "fixtures", "plots");
const growthSvg = readFileSync(path.join(FIX, "growth.svg"), "utf8");
const growthManifest = JSON.parse(readFileSync(path.join(FIX, "growth.fluxplot.json"), "utf8"));
const growthRecipe = JSON.parse(readFileSync(path.join(FIX, "growth.recipe.json"), "utf8"));
// Large <image>-rendered SVG asset (tile pressure): 575KB matplotlib trace strip.
const EEG = path.join(process.env.HOME || "/home/driessen2", "Master_flux_test/plots/overview_traces/eeg.svg");
let eegSvg = null;
try {
  eegSvg = readFileSync(EEG, "utf8");
} catch {
  console.error(`note: ${EEG} unavailable — substituting a generated 400KB path-noise SVG`);
  let d = "M0 40";
  for (let i = 1; i < 30000; i++) d += `L${(i * 0.04).toFixed(2)} ${(40 + Math.sin(i * 0.7) * 30).toFixed(1)}`;
  eegSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="80" viewBox="0 0 1200 80"><path d="${d}" stroke="#333" stroke-width="0.4" fill="none"/></svg>`;
}

// ---------- in-page helpers ----------

// Seed the heavy scene through the dev handle. Runs inside the page.
function seedScene({ growthSvg, growthManifest, growthRecipe, eegSvg }) {
  const F = window.__flux;
  // Semantic plot: cachePlot via reimportPlot (also sets assetData → <image> fallback).
  F.io.reimportPlot("diag-growth", growthSvg, growthManifest, growthRecipe);
  // eeg is rendered by a type:"svg" element = opaque <image> path (Element.svelte);
  // reimportPlot is just the headless-callable seam that feeds assetData.
  F.io.reimportPlot("diag-eeg", eegSvg, { specVersion: "diag/0", axes: [], series: [], guides: [] });

  const T = { x: 260, y: 560 }; // sharpness-target centre, figure-local
  let figId = null;
  F.fig.commit((p) => {
    // Seed INTO an existing figure (demo "growth" in Chrome, figures[0] on a
    // real project) and blow it up to 2600x1800: the figure's full-size
    // background/clip rects then stretch the permanent .scene layer to
    // content-bounds x zoom — the REPRO configuration. (Measured control: the
    // same content in an isolated far-away figure keeps the layer near
    // viewport size and the softness disappears — bounds-dependence.)
    const fig = p.figures.find((f) => f.id === "growth") ?? p.figures[0];
    figId = fig.id;
    fig.width = 2600;
    fig.height = 1800;
    // Idempotent across re-runs on a persisted project (Electron Surface B
    // auto-saves): drop any previously seeded diagnosis elements first.
    fig.elements = fig.elements.filter((e) => !/^(diag-|bg-)/.test(e.id));
    const els = fig.elements;
    // 1 semantic plot (inline DOM: text + hairlines + paths)
    els.push({ type: "plot", id: "diag-plot", assetId: "diag-growth", x: 40, y: 40, width: 480, height: 360, rotation: 0 });
    // 1 large <image>-rendered svg asset (895pt-wide trace strip)
    els.push({ type: "svg", id: "diag-eeg-el", assetId: "diag-eeg", x: 560, y: 60, width: 1200, height: 74, rotation: 0 });
    // Sharpness target: 8 rows of 9px text interleaved with 0.5px hairlines,
    // plus a fine-stroke rect strip — the clip below must be full of ink edges.
    for (let i = 0; i < 8; i++) {
      els.push({
        type: "text", id: `diag-t${i}`, x: T.x - 120, y: T.y - 54 + i * 13, width: 260, height: 12, rotation: 0,
        text: `sharpness ${i} · Ijk 0.017 uV/mm2 fine hairline row ${i}${i}${i}`,
        fontFamily: "sans-serif", fontSize: 9, fontWeight: 400, fontStyle: "normal",
        align: "left", color: "#111111", autoWidth: true,
      });
      els.push({
        type: "line", id: `diag-l${i}`, x: T.x - 120, y: T.y - 45 + i * 13, width: 0, height: 0,
        x1: 0, y1: 0, x2: 250, y2: 0, stroke: "#445566", strokeWidth: 0.5,
        arrowStart: false, arrowEnd: false, rotation: 0,
      });
    }
    for (let i = 0; i < 12; i++)
      els.push({
        type: "rect", id: `diag-r${i}`, x: T.x - 120 + i * 21, y: T.y + 52, width: 14, height: 14, rotation: 0,
        fill: "#ffffff", stroke: "#333333", strokeWidth: 0.75, cornerRadius: 0,
      });
    // ~185 mixed background elements across the 2600x1800 figure (kept out of a
    // guard band around the target so the measured clip stays deterministic).
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
          els.push({ type: "text", id: `bg-${n}`, x, y, width: 90, height: 16, rotation: 0, text: `bg label ${n}`, fontFamily: "sans-serif", fontSize: 12, fontWeight: 400, fontStyle: "normal", align: "left", color: "#222222", autoWidth: true });
        n++;
      }
    // Drag handle: OUTSIDE the measured clip (world +92,+64 from T ⇒ ~+330,+230
    // screen px at 3.5x). Pushed last ⇒ topmost, so the pointer always hits it.
    els.push({ type: "rect", id: "diag-drag", x: T.x + 92, y: T.y + 64, width: 30, height: 30, rotation: 0, fill: "#e0564a", stroke: "#7a2018", strokeWidth: 1, cornerRadius: 2 });
  });

  // Anchor the target at a fixed screen point (zoom-about-cursor keeps it there).
  const host = document.querySelector(".canvas-host").getBoundingClientRect();
  const fig = F.figures().find((f) => f.id === figId);
  const ax = Math.round(host.left + host.width * 0.45);
  const ay = Math.round(host.top + host.height * 0.5);
  F.fig.viewport.set({ panX: ax - host.left - (fig.x + T.x), panY: ay - host.top - (fig.y + T.y), zoom: 1 });
  return {
    ax, ay, figId,
    els: fig.elements.length,
    host: { left: host.left, top: host.top },
    fig: { x: fig.x, y: fig.y },
    T,
  };
}

// Mean absolute Laplacian of a PNG (passed as base64) — computed in-page.
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
    let sum = 0, n = 0, lum = 0, lum2 = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        sum += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]);
        lum += g[i];
        lum2 += g[i] * g[i];
        n++;
      }
    const mean = lum / n;
    return { lap: sum / n, inkStd: Math.sqrt(Math.max(0, lum2 / n - mean * mean)) };
  })();
}

// ---------- node-side driving ----------

async function sharpness(page, clip) {
  const b64 = await page.screenshot({ clip, encoding: "base64", captureBeyondViewport: false });
  return page.evaluate(laplacianOfPng, b64);
}

async function wheelBurst(page, ax, ay, ticks, deltaY) {
  for (let i = 0; i < ticks; i++) {
    await page.evaluate(
      (x, y, dy) => {
        document.querySelector(".canvas-host").dispatchEvent(
          new WheelEvent("wheel", { ctrlKey: true, deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true })
        );
      },
      ax, ay, deltaY
    );
    await sleep(40);
  }
}

const ZOOM_TICKS = 7; // exp(0.18)^7 ≈ 3.53 — inside the requested 3–4 band

async function zoomOf(page) {
  return page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
}

// Re-establish the (potentially) blurry settled-at-zoom state: out 7, in 7 —
// exactly invertible about the same cursor point, so pan/zoom/clip content are
// bit-identical to the first settle.
async function reblur(page, ax, ay) {
  await wheelBurst(page, ax, ay, ZOOM_TICKS, +120);
  await sleep(300);
  await wheelBurst(page, ax, ay, ZOOM_TICKS, -120);
  await sleep(600);
}

async function dragElement(page, figId, id, dx = 10) {
  const c = await page.evaluate((figId, elId) => {
    const F = window.__flux;
    const vp = F.get(F.fig.viewport);
    const fig = F.figures().find((f) => f.id === figId);
    const el = fig.elements.find((e) => e.id === elId);
    const host = document.querySelector(".canvas-host").getBoundingClientRect();
    return {
      cx: host.left + vp.panX + (fig.x + el.x + el.width / 2) * vp.zoom,
      cy: host.top + vp.panY + (fig.y + el.y + el.height / 2) * vp.zoom,
    };
  }, figId, id);
  await page.mouse.move(c.cx, c.cy);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(c.cx + (dx / 5) * i, c.cy);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(300);
}

// CDP LayerTree snapshot: bounds/paintCount of the .scene-attributed layer at a
// set of programmatic zooms. Supplementary — headless may emit nothing.
async function layerMatrix(page, anchor) {
  const out = [];
  try {
    const cdp = await page.createCDPSession();
    let last = null;
    cdp.on("LayerTree.layerTreeDidChange", (e) => {
      if (e.layers && e.layers.length) last = e.layers;
    });
    await cdp.send("DOM.enable");
    await cdp.send("LayerTree.enable");
    const doc = await cdp.send("DOM.getDocument");
    const q = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".scene" });
    let sceneBackendId = null;
    if (q.nodeId) {
      const d = await cdp.send("DOM.describeNode", { nodeId: q.nodeId });
      sceneBackendId = d.node.backendNodeId;
    }
    for (const z of [0.5, 1, 4, 16]) {
      await page.evaluate(
        ({ z, anchor }) => {
          const F = window.__flux;
          const host = document.querySelector(".canvas-host").getBoundingClientRect();
          F.fig.viewport.set({
            panX: anchor.ax - host.left - (anchor.figX + anchor.tx) * z,
            panY: anchor.ay - host.top - (anchor.figY + anchor.ty) * z,
            zoom: z,
          });
        },
        { z, anchor }
      );
      await sleep(500);
      if (!last) {
        out.push({ z, layers: null });
        continue;
      }
      const layers = last;
      const scene =
        (sceneBackendId && layers.find((l) => l.backendNodeId === sceneBackendId)) ||
        layers.filter((l) => l.drawsContent).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      out.push({
        z,
        totalLayers: layers.length,
        totalPx: layers.reduce((s, l) => s + l.width * l.height, 0),
        scene: scene
          ? { w: scene.width, h: scene.height, paintCount: scene.paintCount, drawsContent: scene.drawsContent, attributed: scene.backendNodeId === sceneBackendId }
          : null,
      });
    }
    await cdp.detach().catch(() => {});
  } catch (e) {
    out.push({ error: String(e).slice(0, 160) });
  }
  return out;
}

// The full measurement protocol against one live page. `dsf` is a label for the
// report column (a number for launched Chrome, "N (electron)" in connect mode).
async function measurePage(page, dsf, url = APP_URL) {
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
  {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => !!window.__flux?.fig, { timeout: 15000 });
    await sleep(1500);
    // In Electron the fixture's memBridge cannot override the preload's
    // window.fig (contextBridge properties are read-only), so the demo project
    // never auto-opens — open the disposable test project through the shell
    // instead (FLUX_DIAG_PROJECT overrides; ~/Master_flux_test per the plan).
    const onHome = await page.evaluate(
      () => ![...document.querySelectorAll("button[aria-label]")].some((e) => e.getAttribute("aria-label") === "Figure")
    );
    if (onHome) {
      const proj = process.env.FLUX_DIAG_PROJECT || path.join(process.env.HOME || "/home/driessen2", "Master_flux_test");
      console.error(`— demo fixture unavailable on this surface; opening ${proj}`);
      await page.evaluate((p) => window.__flux.shell.openProjectAt(p), proj);
      await sleep(3000);
    }
    // Figure mode via the activity rail (driver.clickMode idiom).
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button[aria-label]")].find((e) => e.getAttribute("aria-label") === "Figure");
      if (b) b.click();
    });
    await sleep(900);
    await page.waitForSelector(".canvas-host", { timeout: 10000 });

    const seed = await page.evaluate(seedScene, { growthSvg, growthManifest, growthRecipe, eegSvg });
    await sleep(600);
    const anchor = { ax: seed.ax, ay: seed.ay, figX: seed.fig.x, figY: seed.fig.y, tx: seed.T.x, ty: seed.T.y };
    const clip = { x: seed.ax - 160, y: seed.ay - 160, width: 320, height: 320 };

    const sanity = await page.evaluate(() => ({
      els: document.querySelectorAll(".scene .el").length,
      plotInline: !!document.querySelector(".scene .el svg"),
      images: document.querySelectorAll(".scene image").length,
      willChange: getComputedStyle(document.querySelector(".scene")).willChange,
    }));

    // Context reference at zoom 1 (different content scale — not comparable to
    // the zoomed numbers; recorded for orientation only).
    const S_zoom1 = await sharpness(page, clip);

    // --- core repro: settle vs after-drag --------------------------------
    await wheelBurst(page, seed.ax, seed.ay, ZOOM_TICKS, -120);
    await sleep(600);
    const zoomAt = await zoomOf(page);
    const S_settled = await sharpness(page, clip);
    await dragElement(page, seed.figId, "diag-drag", 10);
    const S_afterDrag = await sharpness(page, clip);
    const reproRatio = S_afterDrag.lap / S_settled.lap;

    // --- toggle (a): will-change demotion --------------------------------
    await reblur(page, seed.ax, seed.ay);
    const S_preA = await sharpness(page, clip);
    await page.evaluate(() => {
      document.querySelector(".scene").style.willChange = "auto";
    });
    await sleep(300);
    const S_a = await sharpness(page, clip);
    // Causality check: re-promoting the layer should re-soften if the
    // will-change promotion itself carries the raster-scale cap.
    await page.evaluate(() => {
      document.querySelector(".scene").style.willChange = "";
    });
    await sleep(300);
    const S_aRestored = await sharpness(page, clip);

    // --- toggle (b): no-op commit, then 1px off-clip mutation -------------
    await reblur(page, seed.ax, seed.ay);
    const S_preB = await sharpness(page, clip);
    await page.evaluate(() => window.__flux.fig.commit(() => {}));
    await sleep(300);
    const S_b0 = await sharpness(page, clip);
    await page.evaluate((figId) =>
      window.__flux.fig.commit((p) => {
        const fig = p.figures.find((f) => f.id === figId);
        fig.elements.find((e) => e.id === "diag-drag").x += 1;
      })
    , seed.figId);
    await sleep(300);
    const S_b1 = await sharpness(page, clip);

    // --- supplementary: LayerTree bounds ----------------------------------
    const layers = await layerMatrix(page, anchor);

    return {
      dsf, zoomAt, seedEls: seed.els, sanity,
      S_zoom1, S_settled, S_afterDrag, reproRatio,
      repro: reproRatio > 1.15,
      a: { pre: S_preA, post: S_a, restored: S_aRestored, ratio: S_a.lap / S_preA.lap, resoftRatio: S_aRestored.lap / S_a.lap },
      b: { pre: S_preB, noop: S_b0, mut: S_b1, noopRatio: S_b0.lap / S_preB.lap, mutRatio: S_b1.lap / S_preB.lap },
      layers,
      errs: errs.filter((e) => !/Failed to load resource.*404/i.test(e)).slice(0, 5),
    };
  }
}

async function runMatrix(dsf) {
  const width = 1440, height = 900;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", `--window-size=${width},${height}`, `--force-device-scale-factor=${dsf}`],
    defaultViewport: { width, height, deviceScaleFactor: dsf },
  });
  try {
    return await measurePage(await browser.newPage(), dsf);
  } finally {
    await browser.close();
  }
}

// Connect to an already-running browser (real Electron) and run the same matrix
// on its real compositor. Navigating the window to APP_URL resets the SPA state.
async function runConnected(browserURL) {
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  try {
    const pages = await browser.pages();
    const page = pages.find((p) => p.url().includes("127.0.0.1:1420"));
    if (!page) throw new Error(`no app page (127.0.0.1:1420) found on ${browserURL}`);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    // Plain app URL (no ?fixture=demo): the fixture's memBridge cannot install
    // over the Electron preload — measurePage opens the disposable project.
    return await measurePage(page, `${dpr} (electron)`, process.env.FLUX_URL || "http://127.0.0.1:1420/");
  } finally {
    await browser.disconnect();
  }
}

// ---------- report ----------
const f3 = (x) => (typeof x === "number" ? x.toFixed(3) : String(x));

function table(rows) {
  const lines = [];
  lines.push("| condition | " + rows.map((r) => `DSF ${r.dsf}`).join(" | ") + " |");
  lines.push("|---|" + rows.map(() => "---").join("|") + "|");
  const push = (label, fn) => lines.push(`| ${label} | ` + rows.map((r) => fn(r)).join(" | ") + " |");
  push("elements seeded / rendered", (r) => `${r.seedEls} / ${r.sanity.els}`);
  push("plot inline · <image> count · .scene will-change", (r) => `${r.sanity.plotInline} · ${r.sanity.images} · ${r.sanity.willChange}`);
  push("zoom at measurement", (r) => f3(r.zoomAt));
  push("S @zoom1 (context)", (r) => f3(r.S_zoom1.lap));
  push("S_settled (600ms post-wheel)", (r) => `${f3(r.S_settled.lap)} (ink ${f3(r.S_settled.inkStd)})`);
  push("S_afterDrag (user workaround)", (r) => `${f3(r.S_afterDrag.lap)} (ink ${f3(r.S_afterDrag.inkStd)})`);
  push("repro ratio afterDrag/settled (>1.15 ⇒ repro)", (r) => `${f3(r.reproRatio)} ${r.repro ? "⇒ REPRO" : "⇒ no repro"}`);
  push("(a) will-change=auto: pre → post (ratio)", (r) => `${f3(r.a.pre.lap)} → ${f3(r.a.post.lap)} (${f3(r.a.ratio)})`);
  push("(a′) will-change restored: post (resoften ratio)", (r) => `${f3(r.a.restored.lap)} (${f3(r.a.resoftRatio)})`);
  push("(b0) no-op commit: pre → post (ratio)", (r) => `${f3(r.b.pre.lap)} → ${f3(r.b.noop.lap)} (${f3(r.b.noopRatio)})`);
  push("(b1) 1px off-clip mutation: → post (ratio)", (r) => `${f3(r.b.mut.lap)} (${f3(r.b.mutRatio)})`);
  push("page errors", (r) => (r.errs.length ? r.errs.length + " (see JSON)" : "0"));
  return lines.join("\n");
}

function layerReport(rows) {
  const lines = [];
  for (const r of rows) {
    lines.push(`DSF ${r.dsf} LayerTree (.scene layer) —`);
    for (const l of r.layers) {
      if (l.error) lines.push(`  error: ${l.error}`);
      else if (!l.layers && !l.totalLayers) lines.push(`  zoom ${l.z}: no layer events received (headless)`);
      else
        lines.push(
          `  zoom ${l.z}: layers=${l.totalLayers} totalPx=${(l.totalPx / 1e6).toFixed(1)}M scene=${l.scene ? `${l.scene.w}x${l.scene.h} paints=${l.scene.paintCount} attributed=${l.scene.attributed}` : "n/a"}`
        );
    }
  }
  return lines.join("\n");
}

function verdict(rows) {
  // A row shows "softness" whenever ANY condition reaches a sharpness >1.15x the
  // settled state — the drag ratio alone is too narrow (the drag may fail to fix
  // it headless even when a crisper raster provably exists via toggle (a)).
  const parts = [];
  for (const r of rows) {
    const crispRef = Math.max(r.S_settled.lap, r.S_afterDrag.lap, r.a.post.lap, r.b.noop.lap, r.b.mut.lap);
    const soft = crispRef / r.S_settled.lap > 1.15;
    const dragFixes = r.reproRatio > 1.15;
    const aFixes = r.a.ratio > 1.15;
    const resoftens = r.a.resoftRatio < 0.87; // re-promoting the layer re-softens
    const bFixes = r.b.mutRatio > 1.15;
    const noopFixes = r.b.noopRatio > 1.15;
    let h;
    if (!soft)
      h = "no softness detectable (all conditions within 15% of settled) — user-visible blur does not reproduce in this configuration";
    else if (aFixes && !bFixes && !noopFixes)
      h =
        "(iii)/(i) settled zoom IS soft and ONLY will-change demotion releases full sharpness (a-not-b) ⇒ " +
        "raster-scale capped / tile-budget-limited on the permanent will-change .scene layer; plain repaint insufficient" +
        (dragFixes ? "; drag also fixes (via child will-change churn)" : "; the drag workaround does NOT fix it headless (real-display path differs)") +
        (resoftens ? "; re-promoting will-change re-softens — causality confirmed" : "");
    else if (bFixes && !noopFixes) h = "(ii) plain repaint suffices (content staleness)";
    else if (noopFixes) h = "(ii-weak) even a no-op store commit restores sharpness";
    else if (aFixes && bFixes) h = "(i)+(ii) both demotion and repaint restore sharpness — either fix path works";
    else h = "soft but neither toggle restored sharpness — drag-specific (input-pipeline / child will-change churn)";
    parts.push(`DSF ${r.dsf}: settled ${f3(r.S_settled.lap)} vs best ${f3(crispRef)} (soft=${soft}, drag ${f3(r.reproRatio)}) → ${h}`);
  }
  return parts.join("\n");
}

// ---------- main ----------
const rows = [];
if (opt.connect) {
  console.error(`— running matrix on connected browser ${opt.connect} …`);
  rows.push(await runConnected(opt.connect));
} else {
  for (const dsf of opt.dsfs) {
    console.error(`— running matrix at device-scale-factor ${dsf} …`);
    rows.push(await runMatrix(dsf));
  }
}

const md = [
  "### Crispness discrimination matrix (diagnose-crisp.mjs)",
  "",
  table(rows),
  "",
  "```",
  layerReport(rows),
  "```",
  "",
  "**Verdict:**",
  "",
  verdict(rows),
].join("\n");

console.log(md);
console.log("\n--- raw JSON ---");
console.log(JSON.stringify(rows, null, 2));

if (opt.notes) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  appendFileSync(
    NOTES,
    `\n## Phase 0a findings (${stamp}, headless Chrome, no-monitor box)\n\n${md}\n\nFull protocol + Electron-leg outcome: notes/Flux_Electron_Compositor_Notes.md\n`
  );
  console.error(`— appended findings to ${NOTES}`);
}
