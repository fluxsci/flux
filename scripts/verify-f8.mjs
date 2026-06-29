// F8 frames-as-objects: drag the title label to move the frame (flicker-free,
// frame-selected outline), snap to a neighbour, duplicate, arrow-nudge, delete.
import { launch, gotoApp, clickMode, shot, sleep, errors } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Figure");
await sleep(800);

await page.evaluate(() => {
  const F = window.__flux.fig;
  F.commit((p) => { const g = p.figures.find((f) => f.id === "growth"); g.x = 0; g.y = 0; });
  F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
});
await sleep(200);

// 1) Move the frame by its title label.
const lab = await page.evaluate(() => {
  const t = document.querySelector(".figure-label");
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.max(2, r.height / 2), name: t.textContent };
});
await page.mouse.move(lab.x, lab.y);
await page.mouse.down();
await page.mouse.move(lab.x + 150, lab.y + 100, { steps: 10 });
await sleep(100);
const mid = await page.evaluate(() => ({
  frameSel: !!document.querySelector(".figure-bg.frame-selected"),
  wrapped: [...document.querySelectorAll(".scene g")].some(
    (g) => (g.style.transform || "").includes("translate3d") && !g.classList.contains("el"),
  ),
}));
await shot(page, "f8-frame-drag");
await page.mouse.up();
await sleep(120);
const moved = await page.evaluate(() => {
  const g = window.__flux.figures().find((f) => f.id === "growth");
  return { x: Math.round(g.x), y: Math.round(g.y) };
});

// 2) Snap: add a neighbour at x=700; drag growth so its left edge approaches it.
await page.evaluate(() => {
  const F = window.__flux.fig;
  const cid = window.__flux.figures().find((f) => f.id === "growth").canvasId;
  F.commit((p) => {
    const g = p.figures.find((f) => f.id === "growth");
    g.x = 0; g.y = 0;
    p.figures.push({ ...F.blankFigure(cid, "Neighbor"), x: 700, y: 0, width: 600, height: 300, elements: [] });
  });
  F.viewport.set({ panX: 60, panY: 120, zoom: 0.7 });
});
await sleep(200);
const lab2 = await page.evaluate(() => {
  const t = [...document.querySelectorAll(".figure-label")].sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
  )[0];
  const r = t.getBoundingClientRect();
  return { x: r.left + 6, y: r.top + Math.max(2, r.height / 2) };
});
const dxPx = Math.round((700 - 4) * 0.7);
await page.mouse.move(lab2.x, lab2.y);
await page.mouse.down();
await page.mouse.move(lab2.x + dxPx, lab2.y, { steps: 12 });
await sleep(100);
const snapGuideLines = await page.evaluate(() => document.querySelectorAll(".overlay-svg line.guide").length);
await page.mouse.up();
await sleep(120);
const snapped = await page.evaluate(() => Math.round(window.__flux.figures().find((f) => f.id === "growth").x));

// 3) Duplicate the frame (store path; same as Inspector button / Ctrl+D).
const dup = await page.evaluate(() => {
  const before = window.__flux.figures().length;
  window.__flux.fig.duplicateFigure("growth");
  const figs = window.__flux.figures();
  const copy = figs.find((f) => f.name && f.name.includes("copy"));
  return {
    added: figs.length - before,
    copyName: copy?.name,
    elsRemapped: copy ? copy.elements.every((e) => !e.id.startsWith("el-")) : false,
    belowSource: copy ? copy.y > 0 : false,
  };
});

// 4) Frame arrow-nudge + 5) delete via keyboard.
await page.evaluate(() => {
  window.__flux.fig.selectFrame("growth");
  document.activeElement?.blur?.();
});
const beforeNudge = await page.evaluate(() => Math.round(window.__flux.figures().find((f) => f.id === "growth").x));
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
await sleep(60);
const afterNudge = await page.evaluate(() => Math.round(window.__flux.figures().find((f) => f.id === "growth").x));
await page.keyboard.press("Delete");
await sleep(80);
const afterDelete = await page.evaluate(() => ({
  hasGrowth: !!window.__flux.figures().find((f) => f.id === "growth"),
  count: window.__flux.figures().length,
}));

console.log(JSON.stringify({ lab, mid, moved, snapGuideLines, snapped, dup, beforeNudge, afterNudge, afterDelete, errs: errors(page) }, null, 2));
await browser.close();
