#!/usr/bin/env -S npx tsx
// Feature 10 — copy/paste properties. Cmd/Ctrl+Alt+C snapshots one element's style;
// Cmd/Ctrl+Alt+V applies it to the selection (geometry/text EXCLUDED, per-type
// safe). Inspector "Copy/Paste style" mirror; one undo per paste; cross-type safe.
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const ids = await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    const out: Record<string, string> = {};
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 800; g.height = 320; g.elements = [];
      const styled = F.newId("rect");
      g.elements.push({ type: "rect", id: styled, x: 60, y: 120, width: 80, height: 80, rotation: 0, fill: "#d62728", stroke: "#1f77b4", strokeWidth: 6, cornerRadius: 14 });
      out.styled = styled;
      [220, 340, 460].forEach((x, i) => { const id = F.newId("rect"); g.elements.push({ type: "rect", id, x, y: 120, width: 80, height: 80, rotation: 0, fill: "#cccccc", stroke: "#222222", strokeWidth: 2, cornerRadius: 0 }); out["p" + i] = id; });
      const t = F.newId("text");
      g.elements.push({ type: "text", id: t, x: 600, y: 140, width: 120, height: 28, rotation: 0, text: "label", fontFamily: "sans-serif", fontSize: 18, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "auto" });
      out.text = t;
    });
    F.viewport.set({ panX: 40, panY: 120, zoom: 1 });
    return out;
  });
  await sleep(150);
  const el = (id: string) => page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id), id);
  const copyStyle = async () => { await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("c"); await page.keyboard.up("Alt"); await page.keyboard.up("Control"); await sleep(80); };
  const pasteStyle = async () => { await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("v"); await page.keyboard.up("Alt"); await page.keyboard.up("Control"); await sleep(120); };

  await shot(page, "f10-00-before");
  // copy the styled rect, paste onto the 3 plain rects
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.styled);
  await sleep(80);
  await copyStyle();
  await page.evaluate((arr: string[]) => (window as any).__flux.fig.selection.set(new Set(arr)), [ids.p0, ids.p1, ids.p2]);
  await sleep(80);
  await pasteStyle();
  for (const k of ["p0", "p1", "p2"]) {
    const e = await el(ids[k]);
    assert(e.fill === "#d62728" && e.stroke === "#1f77b4" && e.strokeWidth === 6 && e.cornerRadius === 14, `${k} got the style (fill=${e.fill} sw=${e.strokeWidth} r=${e.cornerRadius})`);
    assert(e.x !== 60 && e.width === 80, `${k} geometry unchanged (x=${e.x} w=${e.width})`);
  }
  await shot(page, "f10-01-pasted");

  // one undo reverts the whole paste
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert((await el(ids.p0)).fill === "#cccccc", "one undo reverts the paste");

  // cross-type: paste a rect style onto text → no crash, text keeps its own props
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.text);
  await sleep(80);
  await pasteStyle();
  const t = await el(ids.text);
  assert(t.type === "text" && t.color === "#111111" && t.fontSize === 18, "cross-type paste left text props intact (no fill/stroke applied)");

  // Inspector buttons mirror the shortcuts
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.styled);
  await sleep(60);
  await page.evaluate(() => { const b = [...document.querySelectorAll(".inspector button")].find((x) => x.textContent?.trim() === "Copy style") as HTMLButtonElement; b.click(); });
  await sleep(60);
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.p0);
  await sleep(60);
  await page.evaluate(() => { const b = [...document.querySelectorAll(".inspector button")].find((x) => x.textContent?.trim() === "Paste style") as HTMLButtonElement; b.click(); });
  await sleep(120);
  assert((await el(ids.p0)).fill === "#d62728", "Inspector Copy/Paste style buttons work");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF10 STYLE ALL PASS" : `\nF10 STYLE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
