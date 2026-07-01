#!/usr/bin/env -S npx tsx
// Feature 4 — smart duplicate + repeat last offset (GUI). Alt-drag one copy to set
// the step, then Ctrl+D stamps an even row; a plain move updates the repeat offset;
// duplicated groups get fresh, independent group ids.
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 1.5) => Math.abs(a - b) <= t;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const seedOne = () => page.evaluate(() => {
    const F = (window as any).__flux.fig;
    let id = "";
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 480; g.elements = [];
      id = F.newId("rect");
      g.elements.push({ type: "rect", id, x: 120, y: 200, width: 80, height: 60, rotation: 0, fill: "#4c78a8", stroke: "#222", strokeWidth: 2, cornerRadius: 0 });
    });
    F.viewport.set({ panX: 60, panY: 140, zoom: 1 });
    return id;
  });
  const els = () => page.evaluate(() => (window as any).__flux.figures().find((f: any) => f.id === "growth").elements);
  const xs = async () => (await els()).map((e: any) => e.x).sort((a: number, b: number) => a - b);
  const pt = (lx: number, ly: number) => page.evaluate(([lx, ly]: [number, number]) => {
    const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
    const g = (window as any).__flux.get((window as any).__flux.fig.project);
    const fig = g.figures.find((f: any) => f.id === "growth");
    const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
    return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
  }, [lx, ly] as [number, number]);
  const ctrlD = async () => { await page.keyboard.down("Control"); await page.keyboard.press("d"); await page.keyboard.up("Control"); await sleep(140); };

  // --- Alt-drag sets the step (+40x), then Ctrl+D stamps an even row ---
  const id = await seedOne();
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), id);
  await sleep(100);
  await shot(page, "f4-00-before");
  const c0 = await pt(120 + 40, 200 + 30);
  const c1 = await pt(160 + 40, 200 + 30); // +40 in x
  await page.keyboard.down("Alt");
  await page.mouse.move(c0.x, c0.y); await page.mouse.down();
  await page.mouse.move(c1.x, c1.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await sleep(150);
  assert((await els()).length === 2, `alt-drag made a copy (${(await els()).length} elements)`);

  await recordGif(page, "f4-stamp", async (frame: () => Promise<void>) => {
    await frame();
    for (let i = 0; i < 3; i++) { await ctrlD(); await frame(); }
  });
  const row = await xs();
  const diffs = row.slice(1).map((x: number, i: number) => x - row[i]);
  assert(row.length === 5, `Ctrl+D ×3 → 5 elements (${row.length})`);
  assert(diffs.every((d: number) => near(d, 40)), `even row at +40 steps (${row.map((x: number) => x.toFixed(0)).join(",")})`);
  await shot(page, "f4-01-row");

  // undo removes one stamp per Ctrl+D
  await page.evaluate(() => (window as any).__flux.fig.undo());
  await sleep(120);
  assert((await els()).length === 4, `undo removes one stamp (${(await els()).length})`);

  // --- a plain move updates the repeat offset ---
  const id2 = await seedOne();
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), id2);
  await sleep(100);
  const m0 = await pt(120 + 40, 200 + 30);
  const m1 = await pt(120 + 40, 260 + 30); // move +60 in y (no snap coincidence)
  await page.mouse.move(m0.x, m0.y); await page.mouse.down();
  await page.mouse.move(m1.x, m1.y, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  const movedY = (await els())[0].y;
  await ctrlD();
  const two = await els();
  assert(two.length === 2, "plain move + Ctrl+D duplicated");
  const dy = Math.abs(two[1].y - two[0].y);
  assert(near(dy, 60) && near(Math.abs(two[1].x - two[0].x), 0), `Ctrl+D repeated the plain-move offset (dy=${dy}, expect 60)`);
  void movedY;

  // --- duplicated group gets a fresh, independent group id ---
  const gids = await page.evaluate(() => {
    const F = (window as any).__flux.fig;
    const out: string[] = [];
    F.commit((p: any) => {
      const g = p.figures.find((f: any) => f.id === "growth");
      g.elements = [];
      const gid = F.newId("grp");
      for (let i = 0; i < 2; i++) { const id = F.newId("rect"); g.elements.push({ type: "rect", id, x: 100 + i * 100, y: 100, width: 70, height: 50, rotation: 0, fill: "#54a24b", stroke: "#222", strokeWidth: 2, cornerRadius: 0, groupId: gid }); out.push(id); }
    });
    return out;
  });
  await page.evaluate((arr: string[]) => (window as any).__flux.fig.selection.set(new Set(arr)), gids);
  await sleep(100);
  await ctrlD();
  const after = await els();
  const origGid = after.find((e: any) => e.id === gids[0]).groupId;
  const copies = after.filter((e: any) => !gids.includes(e.id));
  assert(copies.length === 2, `group duplicated (${copies.length} copies)`);
  assert(copies[0].groupId && copies[0].groupId === copies[1].groupId && copies[0].groupId !== origGid, `copies share a NEW group id (${copies[0].groupId} ≠ ${origGid})`);

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF4 DUP ALL PASS" : `\nF4 DUP ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
