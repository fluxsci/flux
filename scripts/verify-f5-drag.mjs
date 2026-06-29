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
  const overlayShapeGroups = [...document.querySelectorAll(".overlay-svg > g")].length;
  return {
    totalEls: els.length,
    transformedCount: transformed.length,
    transformVal: transformed[0]?.style.transform || null,
    hiddenCount: hidden.length,
    overlayShapeGroups,
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

console.log(JSON.stringify({ mid, after, errs: errors(page) }, null, 2));
await browser.close();
