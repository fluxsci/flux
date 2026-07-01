#!/usr/bin/env -S npx tsx
// Feature 2 — rotate handle + numeric rotation. Drags the rotate handle to ~37°
// (GIF), Shift-snaps to 15°, checks the Inspector field (incl. "45*2"), and
// rotates a 3-element group about its centre (members orbit).
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;
const D2R = Math.PI / 180;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const seed = async () =>
    page.evaluate(() => {
      const F = (window as any).__flux.fig;
      const out: string[] = [];
      F.commit((p: any) => {
        const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
        g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = [];
        const mk = (fill: string, x: number, y: number) => {
          const id = F.newId("rect");
          g.elements.push({ type: "rect", id, x, y, width: 160, height: 110, rotation: 0, fill, stroke: "#222", strokeWidth: 3, cornerRadius: 0 });
          out.push(id);
        };
        mk("#d62728", 300, 190); mk("#2ca02c", 80, 60); mk("#1f77b4", 560, 320);
      });
      F.viewport.set({ panX: 60, panY: 120, zoom: 1 });
      return out;
    });
  const ids = await seed();
  const rot = (id: string) => page.evaluate((id: string) => (window as any).__flux.figures().flatMap((f: any) => f.elements).find((e: any) => e.id === id).rotation, id);
  const geom = (id: string) => page.evaluate((id: string) => { const e = (window as any).__flux.figures().flatMap((f: any) => f.elements).find((x: any) => x.id === id); return { x: e.x, y: e.y, rotation: e.rotation }; }, id);

  // Handle + centre in screen coords for a single selected element.
  const handleAndCentre = (id: string) =>
    page.evaluate((id: string) => {
      const g = (window as any).__flux.get((window as any).__flux.fig.project);
      const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
      let fig: any, el: any;
      for (const f of g.figures) { const e = f.elements.find((x: any) => x.id === id); if (e) { fig = f; el = e; break; } }
      const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
      const left = host.left + vp.panX + (fig.x + el.x) * vp.zoom;
      const top = host.top + vp.panY + (fig.y + el.y) * vp.zoom;
      const w = el.width * vp.zoom, h = el.height * vp.zoom;
      return { cx: left + w / 2, cy: top + h / 2, hx: left + w / 2, hy: top - 20, r: h / 2 + 20 };
    }, id);

  // --- single-element rotate to ~37° (GIF) ---
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids[0]);
  await sleep(200);
  await shot(page, "f2-01-before");
  let hc = await handleAndCentre(ids[0]);
  // press straight up (startAngle -90°), drag to -90+37 = -53°
  const targetDeg = -53;
  const tx = hc.cx + hc.r * Math.cos(targetDeg * D2R);
  const ty = hc.cy + hc.r * Math.sin(targetDeg * D2R);
  await recordGif(page, "f2-rotate", async (frame: () => Promise<void>) => {
    await page.mouse.move(hc.hx, hc.hy);
    await page.mouse.down();
    await frame();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(hc.hx + (tx - hc.hx) * i / 20, hc.hy + (ty - hc.hy) * i / 20);
      if (i % 2 === 0) await frame();
    }
    await sleep(60);
    await frame();
    await page.mouse.up();
    await frame();
  });
  await sleep(120);
  const r0 = await rot(ids[0]);
  assert(near(r0, 37, 2), `drag-rotate → ${r0.toFixed(1)}° (expect ~37)`);
  await shot(page, "f2-02-rotated");

  // Inspector field reflects it
  const fieldVal = await page.evaluate(() => {
    const nfs = [...document.querySelectorAll(".inspector .nf")];
    const nf = nfs.find((n) => n.querySelector(".lb")?.textContent?.trim() === "Rotation°") as HTMLElement | undefined;
    return nf ? (nf.querySelector("input") as HTMLInputElement).value : null;
  });
  assert(fieldVal != null && near(parseFloat(fieldVal), r0, 1), `Inspector Rotation° shows ${fieldVal}`);

  // Field accepts a math expression: "45*2" → 90
  await page.evaluate(() => {
    const nfs = [...document.querySelectorAll(".inspector .nf")];
    const nf = nfs.find((n) => n.querySelector(".lb")?.textContent?.trim() === "Rotation°") as HTMLElement;
    const inp = nf.querySelector("input") as HTMLInputElement;
    inp.value = "45*2";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(120);
  assert(near(await rot(ids[0]), 90, 0.5), `Rotation° field "45*2" → ${await rot(ids[0])} (expect 90)`);

  // undo (field edit) then undo (rotate) → back to 0
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(80);
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(80);
  assert(near(await rot(ids[0]), 0, 0.5), `undo restores rotation to 0 (got ${await rot(ids[0])})`);

  // --- Shift-snap to 15° ---
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids[0]);
  await sleep(120);
  hc = await handleAndCentre(ids[0]);
  const tDeg = -90 + 50; // ~50° → snaps to 45
  const sx = hc.cx + hc.r * Math.cos(tDeg * D2R);
  const sy = hc.cy + hc.r * Math.sin(tDeg * D2R);
  await page.mouse.move(hc.hx, hc.hy);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(sx, sy, { steps: 12 });
  await sleep(60);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await sleep(120);
  const rs = await rot(ids[0]);
  assert(Math.abs(rs % 15) < 0.01, `Shift snaps to a multiple of 15° (got ${rs})`);
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(80);

  // --- group rotate about centre: members orbit ---
  await seed();
  await page.evaluate((arr: string[]) => (window as any).__flux.fig.selection.set(new Set(arr)), ids);
  // re-seed changed ids; re-read from model instead
  const gids = await page.evaluate(() => (window as any).__flux.figures().find((f: any) => f.id === "growth").elements.map((e: any) => e.id));
  await page.evaluate((arr: string[]) => (window as any).__flux.fig.selection.set(new Set(arr)), gids);
  await sleep(150);
  const before = await Promise.all(gids.map((id: string) => geom(id)));
  hc = await page.evaluate(() => {
    const g = (window as any).__flux.get((window as any).__flux.fig.project);
    const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
    const fig = g.figures.find((f: any) => f.id === "growth");
    // selection bbox centre
    const els = fig.elements;
    const xs = els.map((e: any) => e.x), ys = els.map((e: any) => e.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...els.map((e: any) => e.x + e.width)), maxY = Math.max(...els.map((e: any) => e.y + e.height));
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    const cx = host.left + vp.panX + (fig.x + (minX + maxX) / 2) * vp.zoom;
    const cy = host.top + vp.panY + (fig.y + (minY + maxY) / 2) * vp.zoom;
    const topY = host.top + vp.panY + (fig.y + minY) * vp.zoom;
    return { cx, cy, hx: cx, hy: topY - 20, r: cy - (topY - 20) };
  });
  // rotate 90°: from -90° to 0°
  const gx = hc.cx + hc.r * Math.cos(0);
  const gy = hc.cy + hc.r * Math.sin(0);
  await page.mouse.move(hc.hx, hc.hy);
  await page.mouse.down();
  await page.mouse.move(gx, gy, { steps: 16 });
  await sleep(60);
  await page.mouse.up();
  await sleep(150);
  const after = await Promise.all(gids.map((id: string) => geom(id)));
  const allRotated = after.every((a) => near(a.rotation, 90, 2));
  const centresMoved = after.some((a, i) => Math.abs(a.x - before[i].x) > 5 || Math.abs(a.y - before[i].y) > 5);
  assert(allRotated, `group: every member rotation ≈ 90 (${after.map((a) => a.rotation.toFixed(0)).join(",")})`);
  assert(centresMoved, "group: member centres orbited the pivot (positions changed)");
  await shot(page, "f2-03-group-rotated");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF2 ALL PASS" : `\nF2 ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
