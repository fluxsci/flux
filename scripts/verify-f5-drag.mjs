// F5.1 flicker-free move: during a move drag the dragged element's LIVE scene
// group is transformed (translate3d) — not hidden, no overlay copy, so it never
// re-decodes/blanks. Inspect DOM mid-drag (pointer down + move, no up).
import { launch, gotoApp, clickMode, shot, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure");
await sleep(900);

const c = await page.evaluate(() => {
  const vp = window.__flux.get(window.__flux.fig.viewport);
  const fig = window.__flux.figures().find((f) => f.id === "growth");
  const el = fig.elements.find((e) => e.id === "el-a-rect");
  const host = document.querySelector(".canvas-host").getBoundingClientRect();
  return {
    cx: host.left + vp.panX + (fig.x + el.x + el.width / 2) * vp.zoom,
    cy: host.top + vp.panY + (fig.y + el.y + el.height / 2) * vp.zoom,
  };
});

// Begin a drag and hold mid-gesture (no pointer-up).
await page.mouse.move(c.cx, c.cy);
await page.mouse.down();
await page.mouse.move(c.cx + 90, c.cy + 60, { steps: 12 });
await sleep(120);

const mid = await page.evaluate(() => {
  const els = [...document.querySelectorAll(".scene .el")];
  const transformed = els.filter((g) => (g.style.transform || "").includes("translate3d"));
  const hidden = els.filter((g) => g.style.visibility === "hidden");
  // Overlay copies would be <g> children of .overlay-svg carrying drawn shapes.
  // For a move there should be none (only sel-box/handles chrome).
  const overlayShapeGroups = [...document.querySelectorAll(".overlay-svg > g:not(.sel-chrome)")].length; // .sel-chrome = the selection box/handles group (rides a rigid translate during a move)
  return {
    totalEls: els.length,
    transformedCount: transformed.length,
    transformVal: transformed[0]?.style.transform || null,
    hiddenCount: hidden.length,
    overlayShapeGroups,
    // 2026-09-30 drag-layer: the dragged group and the selection chrome each ride ONE paused
    // animation (compositor drive) instead of a per-move layerization.
    elAnims: transformed.reduce((n, g) => n + g.getAnimations().filter((a) => a.playState === "paused").length, 0),
    chromeAnims: document.querySelector(".overlay-svg .sel-chrome")?.getAnimations().filter((a) => a.playState === "paused").length ?? -1,
  };
});
await shot(page, "f5-mid-drag");
await page.mouse.up();
await sleep(150);

// After commit: element x/y moved by ~ the drag delta (world units = drag/zoom).
const after = await page.evaluate(() => {
  const el = window.__flux.figures().find((f) => f.id === "growth").elements.find((e) => e.id === "el-a-rect");
  return { x: Math.round(el.x), y: Math.round(el.y) };
});

// At rest nothing stays promoted or animated on the moved element or the chrome.
const rest = await page.evaluate(() => {
  const els = [...document.querySelectorAll(".scene .el")];
  const chrome = document.querySelector(".overlay-svg .sel-chrome");
  return {
    elAnims: els.reduce((n, g) => n + g.getAnimations().length, 0),
    elStyled: els.filter((g) => g.style.transform || g.style.willChange).length,
    chromeAnims: chrome ? chrome.getAnimations().length : 0,
    chromeTransform: chrome ? chrome.style.transform : "",
  };
});
console.log(JSON.stringify({ mid, after, rest, errs: errors(page) }, null, 2));
await browser.close();
const bad = [];
if (mid.transformedCount !== 1) bad.push("expected exactly one transformed element mid-drag");
if (mid.elAnims !== 1) bad.push(`dragged element should ride one paused animation mid-drag (got ${mid.elAnims})`);
if (mid.chromeAnims !== 1) bad.push(`selection chrome should ride one paused animation mid-drag (got ${mid.chromeAnims})`);
if (mid.overlayShapeGroups !== 0) bad.push("a move must not draw overlay copies");
if (rest.elAnims || rest.elStyled || rest.chromeAnims || rest.chromeTransform) bad.push(`at rest: something stayed promoted/animated ${JSON.stringify(rest)}`);
if (bad.length) { console.error("verify-f5-drag: FAIL\n  " + bad.join("\n  ")); process.exit(1); }
console.log("verify-f5-drag: PASS");
