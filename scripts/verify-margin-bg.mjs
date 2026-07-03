// Dynamic-margin background gate — the always-on generative canvas behind the
// paper margin (src/shell/modes/paper/margin/DynamicBackground.svelte).
// Verifies: the canvas fills the margin box and animates; all five BgSources
// cycle cleanly (with ink on the paper after a seek); a grip drag is SEAMLESS
// (canvas tracks the box every step, the field is never reset — old art
// survives); and the frame/spawn budgets hold: p95 frame within one vsync
// (<17.5ms — headless ticks at ~59.5Hz, so a uniform 16.8ms is clean 60fps)
// and ZERO frames over two vsyncs (34ms) — a dropped frame is a stutter;
// spawns p95 < 8ms, max < 24ms.
//   Run (dev server on :1420 must be up): node scripts/verify-margin-bg.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
// The WHOLE gate runs under emulated `prefers-reduced-motion: reduce`. The
// owner's Linux desktop reports it via GTK (headless Chrome never does), and
// honoring it once froze the background solid. The dynamic background must
// animate regardless — only UI transitions may collapse under reduce.
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

// Count non-paper pixels in (a crop of) the background canvas — the "is there
// ink on the page" probe. Sampled at native resolution, no scaling.
const inkCount = () =>
  page.evaluate(() => {
    const c = document.querySelector(".dynmargin .bg canvas");
    if (!c) return -1;
    const w = Math.min(c.width, 700);
    const h = Math.min(c.height, 1500);
    const t = document.createElement("canvas");
    t.width = w;
    t.height = h;
    const x = t.getContext("2d");
    x.drawImage(c, 0, 0, w, h, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 255) > 6 || Math.abs(d[i + 1] - 252) > 6 || Math.abs(d[i + 2] - 240) > 6) n++;
    }
    return n;
  });

const setup = await page.evaluate(() => {
  const box = document.querySelector(".dynmargin");
  const canvas = document.querySelector(".dynmargin .bg canvas");
  const bg = window.__fluxMargin?.bg;
  if (!box || !canvas || !bg) return { error: `missing: box=${!!box} canvas=${!!canvas} hook=${!!bg}` };
  const r = box.getBoundingClientRect();
  const d = bg.dims();
  return {
    ok: true,
    source: d.source,
    fits: Math.abs(d.cssW - (r.width - 3)) <= 2 && Math.abs(d.cssH - (r.height - 3)) <= 2,
  };
});
if (setup.error) {
  console.error(JSON.stringify(setup));
  await browser.close();
  process.exit(1);
}

// --- it animates on its own -------------------------------------------------
const frameA = await page.evaluate(() => document.querySelector(".dynmargin .bg canvas").toDataURL());
await sleep(900);
const frameB = await page.evaluate(() => document.querySelector(".dynmargin .bg canvas").toDataURL());
const animates = frameA !== frameB;

// --- all five sources cycle cleanly ------------------------------------------
const SOURCES = ["harmonograph", "neurons", "inkwind", "loom", "vines"];
const cycle = {};
for (const id of SOURCES) {
  await page.evaluate((s) => window.__fluxMargin.setBg(s), id);
  await sleep(450); // crossfade (300ms) + a few live frames
  await page.evaluate(() => window.__fluxMargin.bg.seek(12));
  await sleep(120);
  const d = await page.evaluate(() => window.__fluxMargin.bg.dims());
  const ink = await inkCount();
  cycle[id] = { source: d.source, ink };
  await shot(page, `margin-bg-${id}`);
}
const cycleOk = SOURCES.every((id) => cycle[id].source === id && cycle[id].ink > 150);

// --- seamless grip drag -------------------------------------------------------
// Back to the default scene with settled art, then drag the margin wider and
// assert (a) the canvas tracks the box on every sampled step, and (b) the art
// survives — a field reset would blank the paper (draw-in takes seconds).
await page.evaluate(() => window.__fluxMargin.setBg("harmonograph"));
await sleep(450);
await page.evaluate(() => window.__fluxMargin.bg.seek(15));
await sleep(200);
const inkBefore = await inkCount();
await page.evaluate(() => (window.__fluxMargin.bg.frames.length = 0));
const grip = await page.evaluate(() => {
  const g = document.querySelector(".dm-grip");
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
let dragTracked = true;
let dragBlank = false;
if (grip) {
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(grip.x - i * 30, grip.y);
    await sleep(30);
    const s = await page.evaluate(() => {
      const box = document.querySelector(".dynmargin").getBoundingClientRect();
      const d = window.__fluxMargin.bg.dims();
      return { boxW: box.width - 3, cssW: d.cssW };
    });
    if (Math.abs(s.boxW - s.cssW) > 2) dragTracked = false;
  }
  await page.mouse.up();
  await sleep(150);
}
const inkAfter = await inkCount();
dragBlank = inkAfter < inkBefore * 0.5;
const dragFrames = await page.evaluate(() => [...window.__fluxMargin.bg.frames]);
await shot(page, "margin-bg-after-drag");

// --- frame budget at rest ------------------------------------------------------
await page.evaluate(() => (window.__fluxMargin.bg.frames.length = 0));
await sleep(3000);
const rest = await page.evaluate(() => ({
  frames: [...window.__fluxMargin.bg.frames],
  spawns: [...window.__fluxMargin.bg.spawns],
}));

// --- frame budget with frosted panes over the canvas ----------------------------
// The glass panes backdrop-blur a 60fps-repainting canvas — the top perf risk.
// Measure the busiest scene (neurons, max 4 concurrent sprites) under 2 and 4
// open panes.
await page.evaluate(() => window.__fluxMargin.setBg("neurons"));
await sleep(450);
await page.evaluate(() => window.__fluxMargin.bg.seek(10));
const paneFrames = {};
for (const n of [2, 4]) {
  await page.evaluate(() => window.__fluxMargin.closeAll());
  await sleep(200);
  const ids = ["reference-search", "terminal", "comments", "figure"].slice(0, n);
  for (const id of ids) {
    await page.evaluate((i) => window.__fluxMargin.summon(i), id);
    await sleep(150);
  }
  await sleep(300); // materialize animations done
  await page.evaluate(() => (window.__fluxMargin.bg.frames.length = 0));
  await sleep(2500);
  paneFrames[n] = await page.evaluate(() => [...window.__fluxMargin.bg.frames]);
}
await page.evaluate(() => window.__fluxMargin.closeAll());
const p = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const stats = {
  restP95: +p(rest.frames, 0.95).toFixed(2),
  restMax: +Math.max(0, ...rest.frames).toFixed(2),
  restOver34: rest.frames.filter((f) => f > 34).length,
  panes2P95: +p(paneFrames[2], 0.95).toFixed(2),
  panes2Over34: paneFrames[2].filter((f) => f > 34).length,
  panes4P95: +p(paneFrames[4], 0.95).toFixed(2),
  panes4Over34: paneFrames[4].filter((f) => f > 34).length,
  dragP95: +p(dragFrames, 0.95).toFixed(2),
  dragOver34: dragFrames.filter((f) => f > 34).length,
  spawnP95: +p(rest.spawns, 0.95).toFixed(2),
  spawnMax: +Math.max(0, ...rest.spawns).toFixed(2),
};

const errs = realErrors(page);
await browser.close();

const res = {
  fits: setup.fits,
  animates,
  cycleOk,
  dragTracked,
  dragSurvives: !dragBlank,
  restBudget: stats.restP95 < 17.5 && stats.restOver34 === 0,
  paneBudget: stats.panes2P95 < 17.5 && stats.panes4P95 < 17.5 && stats.panes2Over34 === 0 && stats.panes4Over34 === 0,
  dragBudget: stats.dragP95 < 20 && stats.dragOver34 <= 1,
  spawnBudget: stats.spawnP95 < 8 && stats.spawnMax < 24,
};
console.log(JSON.stringify({ bg: res, cycle, stats, inkBefore, inkAfter, errs }, null, 2));
const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nMARGIN BG VERIFY: FAIL");
  process.exit(1);
}
console.log("\nMARGIN BG VERIFY: PASS");
