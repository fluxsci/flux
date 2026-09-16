// 2026-09-15 — the crosshair cursor family (styles/cursors.css + Canvas.svelte)
// gates in the browser (ui tier — dev server on :1420, demo fixture):
// the canvas default is the precise crosshair (a hardware `url()` cursor with a
// platform fallback), hovering an object shows the dot, a press contracts the
// arms (the click ring was retired 2026-09-16 — nothing else may bloom),
// objects carry the family (no stray `move`), the draw tools use the plain
// cross, pan keeps grab, and the text tool keeps the I-beam.
//
// 2026-09-16 — the FIREWALL leg. `cursor` is an inherited property: a host
// value that flipped per hover restyled every mounted plot node (~120 ms per
// flip at 15k nodes — the Linux "laggy Figure" report). The contract now: the
// host flips only for pan / tool / press, every `.el` wrapper carries an
// explicit constant (the hover dot), and a plot's inner nodes keep ONE computed
// cursor at rest, hovered and pressed. Pinned on the dense lazy-assets fixture
// with CDP's RecalcStyleDuration per pointer transition + a long-task count.
//   node scripts/verify-cursor-gui.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor, sleep, APP_URL } from "./lib/driver.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2500 });
await clickMode(page, "Figure").catch(() => {});
await waitFor(page, () => !!document.querySelector(".canvas-host") && !!document.querySelector("[data-editor-element-id]"), null, { timeout: 15000, label: "figure canvas" });

const checks = [];
const ok = (cond, msg) => { checks.push([!!cond, msg]); console.log(`${cond ? "✓" : "✗"} ${msg}`); };
const cursorOf = (sel = ".canvas-host") => page.$eval(sel, (el) => getComputedStyle(el).cursor);
const isCross = (c) => /data:image\/svg\+xml/.test(c) && /crosshair$/.test(c);
const isHover = (c) => isCross(c) && /circle/.test(c) && !/y1='4'/.test(c);
const isPress = (c) => isCross(c) && /y1='4'/.test(c);
const host = await page.$eval(".canvas-host", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const empty = { x: host.x + host.w - 60, y: host.y + host.h - 60 };
const el = await page.$eval("[data-editor-element-id]", (g) => { const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: g.getAttribute("data-editor-element-id") }; });

// --- 1. idle: the crosshair over empty canvas -----------------------------------------
await page.mouse.move(empty.x, empty.y);
await sleep(80);
let c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), `empty canvas shows the plain crosshair (hardware svg + crosshair fallback)`);

// --- 2. hover: the dot comes from the OBJECT; the host never flips per hover ------------
await page.mouse.move(el.x, el.y);
await waitFor(page, () => !!window.__flux?.get(window.__flux.fig.hoverId), null, { label: "hover registered" }).catch(() => {});
c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), "hovering an object leaves the HOST cursor plain (no per-hover flip of an inherited property)");
const elCursor = await page.$eval("[data-editor-element-id]", (g) => getComputedStyle(g).cursor);
ok(isHover(elCursor), "the object itself carries the dotted crosshair (an explicit constant on .el — the firewall)");

// --- 3. press: contracted arms, and nothing else appears --------------------------------
await page.mouse.move(empty.x, empty.y);
await page.mouse.down();
await sleep(60);
c = await cursorOf();
ok(isPress(c), "a press contracts the crosshair (press variant)");
const overlayKids = await page.$$eval(".canvas-host .overlay-svg > *", (l) => l.filter((n) => /ring|ripple/i.test(n.className.baseVal || n.className || "")).length);
ok(overlayKids === 0, "no click ring or ripple is drawn at a press (retired 2026-09-16)");
await page.mouse.up();
await sleep(60);
c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), "release returns to the plain crosshair");

// --- 4. tools: draw = plain cross, pan = grab, text = I-beam --------------------------
await page.keyboard.press("r");
await sleep(60);
c = await cursorOf();
ok(isCross(c) && !/circle/.test(c), "the rect tool uses the plain crosshair");
await page.keyboard.press("h");
await sleep(60);
ok((await cursorOf()) === "grab", "the pan tool keeps grab");
await page.keyboard.press("t");
await sleep(60);
ok((await cursorOf()) === "text", "the text tool keeps the I-beam");
await page.keyboard.press("v");

// --- 6. the firewall: cursor state flips must not restyle mounted plot DOM ---------------
// A dense lazy-assets figure (14 panels, ~30k svg tags) is the realistic worst
// case: the 2026-09-16 regression (`.el { cursor: inherit }` + a host value that
// followed hoverId) read ~120 ms of Document::recalcStyle per flip here.
await waitFor(page, () => !!window.__flux?.fig && !!window.__flux?.bridge, null, { label: "dev handle" });
const fx = await installDenseProject(page, { root: "/demo/cursor-firewall", figures: 1 });
await page.evaluate(async (root) => { await window.__flux.bridge.loadFigInto(root, "cursor-firewall"); }, fx.root);
await page.evaluate((id) => {
  const F = window.__flux.fig;
  const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
  F.activeCanvasId.set(fig.canvasId);
  F.activeFigureId.set(id);
  const zoom = 0.55;
  F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
}, fx.figIds[0]);
await waitFor(page, () => document.querySelectorAll("[data-editor-element-id] svg *").length > 10000, null, { timeout: 90000, label: "dense plot DOM mounted" });
// let the lazy parse queue drain so its own long tasks never land in the window
await sleep(1500);
const dense = await page.evaluate(() => {
  const h = document.querySelector(".canvas-host").getBoundingClientRect();
  const g = [...document.querySelectorAll("[data-editor-element-id]")].find((n) => {
    const r = n.getBoundingClientRect();
    return n.querySelector("svg *") && r.width > 40 && r.height > 40 && r.left > h.left + 30 && r.right < h.right - 30 && r.top > h.top + 30 && r.bottom < h.bottom - 30;
  });
  const r = g.getBoundingClientRect();
  let empty = null;
  for (let y = h.bottom - 30; y > h.top + 40 && !empty; y -= 24) {
    for (let x = h.right - 30; x > h.left + 40; x -= 24) {
      const n = document.elementFromPoint(x, y);
      if (n && n.closest(".canvas-host") && !n.closest("[data-editor-element-id],.figure-bg,.figure-titlebar,.ruler,.overlay-svg,.fig-shadow")) { empty = { x, y }; break; }
    }
  }
  return { id: g.dataset.editorElementId, x: r.x + r.width / 2, y: r.y + r.height / 2, nodes: document.querySelectorAll("[data-editor-element-id] svg *").length, empty };
});
ok(dense.nodes > 10000 && !!dense.empty, `dense fixture mounted: ${dense.nodes} plot nodes, an empty spot at ${dense.empty?.x},${dense.empty?.y}`);
const innerCursorOf = (id) => page.evaluate((id) => getComputedStyle(document.querySelector(`[data-editor-element-id="${id}"] svg *`)).cursor, id);
const cdp = await page.target().createCDPSession();
await cdp.send("Performance.enable");
const metric = async (name) => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === name)?.value ?? 0;
await page.evaluate(() => {
  window.__cursorLongTasks = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__cursorLongTasks.push(Math.round(e.duration)); }).observe({ type: "longtask" });
});
await page.mouse.move(dense.empty.x, dense.empty.y);
await sleep(200);
const atRest = await innerCursorOf(dense.id);
const before = await metric("RecalcStyleDuration");
const HOVERS = 12, CLICKS = 6;
for (let i = 0; i < HOVERS; i++) {
  await page.mouse.move(dense.x, dense.y); await sleep(45);
  await page.mouse.move(dense.empty.x, dense.empty.y); await sleep(45);
}
for (let i = 0; i < CLICKS; i++) {
  await page.mouse.down(); await sleep(35);
  await page.mouse.up(); await sleep(35);
}
await sleep(250);
const transitions = HOVERS * 2 + CLICKS * 2;
const perFlipMs = ((await metric("RecalcStyleDuration")) - before) * 1000 / transitions;
const longTasks = await page.evaluate(() => window.__cursorLongTasks);
ok(perFlipMs < 8, `style recalc per pointer transition over the dense figure: ${perFlipMs.toFixed(2)} ms (<8; the inherit regression read ~120)`);
ok(longTasks.filter((d) => d >= 50).length === 0, `no long task ≥50 ms across ${transitions} hover/press transitions (${longTasks.join(",") || "none"})`);
await page.mouse.move(dense.x, dense.y);
await sleep(80);
const hovered = await innerCursorOf(dense.id);
await page.mouse.down();
await sleep(80);
const pressed = await innerCursorOf(dense.id);
const hostPressed = await cursorOf();
await page.mouse.up();
await sleep(60);
ok(isHover(atRest) && hovered === atRest && pressed === atRest, "a plot's inner nodes keep ONE computed cursor (the wrapper's hover dot) at rest, hovered and pressed — the firewall holds");
ok(isPress(hostPressed), "the host still contracts while pressed on a plot (the press variant rides the pointer capture)");

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);
await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-cursor-gui", ok: failed === 0, checks: checks.length, failed })}`);
console.log(failed ? `verify-cursor-gui: FAIL (${failed}/${checks.length})` : `verify-cursor-gui: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
