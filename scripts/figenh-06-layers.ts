#!/usr/bin/env -S npx tsx
// Feature 6 — Layers overhaul + enforce lock + element hide (+ aspect-ratio lock).
// Drives the real GUI: hide removes an element from the canvas; locked can't be
// clicked/marquee-selected but IS panel-selectable; drag-reorder changes z-order
// (GIF); the W/H chain toggle keeps proportions.
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  // tsx/esbuild `keepNames` injects __name() into serialized page.evaluate bodies;
  // shim it in the page so injected callbacks resolve it.
  await page.evaluateOnNewDocument(() => {
    (window as any).__name = (window as any).__name || ((f: unknown) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed 3 rects (z-order bottom→top = [r1,r2,r3]) in a roomy figure.
  const ids = await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    const out: string[] = [];
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 400; g.elements = [];
      const mk = (fill: string, x: number) => {
        const id = F.newId("rect");
        g.elements.push({ type: "rect", id, x, y: 120, width: 200, height: 140, rotation: 0, fill, stroke: "#222222", strokeWidth: 3, cornerRadius: 0 });
        out.push(id);
      };
      mk("#d62728", 40); mk("#2ca02c", 350); mk("#1f77b4", 660);
    });
    F.viewport.set({ panX: 40, panY: 120, zoom: 1 });
    (window as any).__ids = out;
    return out;
  });
  const [r1, r2, r3] = ids;
  await sleep(300);

  const order = () =>
    page.evaluate(() => {
      const g = (window as any).__flux.figures().find((f: any) => f.id === "growth");
      return g.elements.map((e: any) => e.id);
    });
  const elCount = () => page.evaluate(() => document.querySelectorAll(".scene g.el").length);
  const sel = () => page.evaluate(() => [...(window as any).__flux.get((window as any).__flux.fig.selection)]);
  const model = (id: string) =>
    page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id), id);
  const elScreen = (id: string) =>
    page.evaluate((id: string) => {
      const g = (window as any).__flux.get((window as any).__flux.fig.project);
      const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
      let fig: any, el: any;
      for (const f of g.figures) { const e = f.elements.find((x: any) => x.id === id); if (e) { fig = f; el = e; break; } }
      const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
      return {
        cx: host.left + vp.panX + (fig.x + el.x + el.width / 2) * vp.zoom,
        cy: host.top + vp.panY + (fig.y + el.y + el.height / 2) * vp.zoom,
        host: { left: host.left, top: host.top, width: host.width, height: host.height },
      };
    }, id);

  await shot(page, "f6-01-layers");
  assert(await elCount() === 3, `3 elements on canvas (${await elCount()})`);

  // --- HIDE: toggle hidden → gone from the canvas DOM ---
  await page.evaluate((id: string) => {
    const F = (window as any).__flux.fig;
    F.commit((p: any) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.hidden = true; });
  }, r2);
  await sleep(200);
  assert(await elCount() === 2, `hiding r2 removes it from canvas (${await elCount()} left)`);
  await shot(page, "f6-02-hidden");
  // unhide
  await page.evaluate((id: string) => {
    (window as any).__flux.fig.commit((p: any) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.hidden = false; });
  }, r2);
  await sleep(150);
  assert(await elCount() === 3, "unhide restores it");

  // --- LOCK: click + marquee can't select; panel can ---
  await page.evaluate((id: string) => {
    (window as any).__flux.fig.commit((p: any) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.locked = true; });
    (window as any).__flux.fig.clearSelection();
  }, r2);
  await sleep(150);
  const p2 = await elScreen(r2);
  await page.mouse.click(p2.cx, p2.cy);
  await sleep(120);
  assert(!(await sel()).includes(r2), "locked r2 NOT selectable by click");

  // marquee over everything: selects r1 + r3, not r2
  await page.evaluate(() => (window as any).__flux.fig.clearSelection());
  const host = p2.host;
  await page.mouse.move(host.left + 40 + 890, host.top + 120 + 395);
  await page.mouse.down();
  await page.mouse.move(host.left + 40 + 5, host.top + 120 + 5, { steps: 12 });
  await sleep(80);
  await page.mouse.up();
  await sleep(120);
  const marq = await sel();
  assert(marq.includes(r1) && marq.includes(r3) && !marq.includes(r2), `marquee skips locked r2 (got ${marq.length})`);

  // panel-select r2 (what the Layers row button does) works
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), r2);
  await sleep(100);
  assert(eq(await sel(), [r2]), "locked r2 IS selectable from the panel (selectOnly)");
  await shot(page, "f6-03-locked");
  // unlock restores click-select
  await page.evaluate((id: string) => {
    (window as any).__flux.fig.commit((p: any) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.locked = false; });
    (window as any).__flux.fig.clearSelection();
  }, r2);
  await sleep(120);
  await page.mouse.click((await elScreen(r2)).cx, (await elScreen(r2)).cy);
  await sleep(120);
  assert((await sel()).includes(r2), "unlocked r2 is click-selectable again");

  // --- RENAME persists on the model ---
  await page.evaluate((id: string) => {
    (window as any).__flux.fig.commit((p: any) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.name = "Scale bar"; });
  }, r1);
  await sleep(100);
  assert((await model(r1)).name === "Scale bar", "rename sets el.name");

  // --- DRAG-REORDER the Layers list (grip drag) → z-order changes ---
  await page.evaluate(() => (window as any).__flux.fig.clearSelection());
  await sleep(100);
  const before = await order();
  // Layers list is top-first: [r3, r2, r1]. Drag r1's row (bottom) to the top.
  const grip = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".layers li.layer")] as HTMLElement[];
    const top = rows[0].getBoundingClientRect();
    const bottom = rows[rows.length - 1].getBoundingClientRect();
    const g = rows[rows.length - 1].querySelector(".grip")!.getBoundingClientRect();
    return { gx: g.left + g.width / 2, gy: g.top + g.height / 2, topY: top.top + 4 };
  });
  await recordGif(page, "f6-reorder", async (frame: () => Promise<void>) => {
    await page.mouse.move(grip.gx, grip.gy);
    await page.mouse.down();
    await frame();
    const dyTotal = grip.gy - grip.topY;
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(grip.gx, grip.gy - (dyTotal * i) / 16);
      if (i % 2 === 0) await frame();
    }
    await sleep(60);
    await frame();
    await page.mouse.up();
    await frame();
  }, { width: 360 });
  await sleep(150);
  const after = await order();
  assert(!eq(before, after) && after[after.length - 1] === r1, `drag-reorder moved r1 to top of z-order: ${before} -> ${after}`);
  await shot(page, "f6-04-reordered");

  // --- ASPECT LOCK: chain toggle keeps W/H proportional ---
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), r3);
  await sleep(150);
  // click the ratio toggle
  const clickedRatio = await page.evaluate(() => {
    const b = document.querySelector(".inspector .ratio") as HTMLButtonElement | null;
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(120);
  assert(clickedRatio && (await model(r3)).lockAspect === true, "ratio toggle set lockAspect");
  // set W = 400 via the field; H should scale 140/200 = 0.7 -> 280
  await page.evaluate(() => {
    const nfs = [...document.querySelectorAll(".inspector .nf")];
    const nf = nfs.find((n) => n.querySelector(".lb")?.textContent?.trim() === "W") as HTMLElement;
    const inp = nf.querySelector("input") as HTMLInputElement;
    inp.value = "400";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(150);
  const m = await model(r3);
  assert(Math.abs(m.width - 400) < 1 && Math.abs(m.height - 280) < 1, `aspect lock: W=400 -> H=${m.height} (expect 280)`);
  await shot(page, "f6-05-aspect");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF6 ALL PASS" : `\nF6 ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
