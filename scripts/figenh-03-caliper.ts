#!/usr/bin/env -S npx tsx
// Feature 3 — measurement caliper (Alt-hover). Unit-checks gapBetween, then in the
// GUI: Alt + selection draws red gap labels to a hovered panel (H + V) and to the
// figure edges over empty space; Alt release clears; and Alt-drag STILL duplicates
// (the caliper must not clash with Alt's existing roles).
import { gapBetween } from "../src/lib/geometry";
// @ts-expect-error mjs helper, no types
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
// @ts-expect-error mjs helper, no types
import { recordGif } from "./lib/gif.mjs";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}

// --- unit: gapBetween ---
{
  const A = { x: 100, y: 150, w: 160, h: 120 };
  const B = { x: 360, y: 150, w: 160, h: 120 };
  const C = { x: 100, y: 360, w: 160, h: 120 };
  const ab = gapBetween(A, B);
  assert(ab.dx === 100 && !ab.overlapX && ab.overlapY, `gapBetween(A,B) dx=100, overlapY (got dx=${ab.dx})`);
  const ac = gapBetween(A, C);
  assert(ac.dy === 90 && !ac.overlapY && ac.overlapX, `gapBetween(A,C) dy=90, overlapX (got dy=${ac.dy})`);
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
      g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = [];
      const mk = (k: string, x: number, y: number, fill: string) => {
        const id = F.newId("rect");
        g.elements.push({ type: "rect", id, x, y, width: 160, height: 120, rotation: 0, fill, stroke: "#222", strokeWidth: 2, cornerRadius: 0 });
        out[k] = id;
      };
      mk("A", 100, 150, "#4c78a8"); // x:100-260 y:150-270
      mk("B", 360, 150, "#f58518"); // gap from A = 100 (same y band)
      mk("C", 100, 360, "#54a24b"); // gap from A = 90 (same x band)
    });
    F.viewport.set({ panX: 80, panY: 120, zoom: 1 });
    return out;
  });
  await sleep(150);

  // figure-local → client
  const pt = (lx: number, ly: number) =>
    page.evaluate(([lx, ly]: [number, number]) => {
      const vp = (window as any).__flux.get((window as any).__flux.fig.viewport);
      const g = (window as any).__flux.get((window as any).__flux.fig.project);
      const fig = g.figures.find((f: any) => f.id === "growth");
      const host = document.querySelector(".canvas-host")!.getBoundingClientRect();
      return { x: host.left + vp.panX + (fig.x + lx) * vp.zoom, y: host.top + vp.panY + (fig.y + ly) * vp.zoom };
    }, [lx, ly] as [number, number]);
  const labels = () => page.evaluate(() => [...document.querySelectorAll(".measure-label")].map((n) => n.textContent));

  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.A);
  await sleep(120);

  // --- H gap: Alt + hover B → label "100" ---
  await page.keyboard.down("Alt");
  const bC = await pt(360 + 80, 150 + 60);
  await recordGif(page, "f3-caliper", async (frame: () => Promise<void>) => {
    await page.mouse.move(bC.x, bC.y, { steps: 6 }); await frame();
    await sleep(80); await frame();
    const cC = await pt(100 + 80, 360 + 60);
    await page.mouse.move(cC.x, cC.y, { steps: 8 }); await frame();
    await sleep(80); await frame();
  });
  // re-hover B for the assertion + screenshot
  await page.mouse.move(bC.x, bC.y, { steps: 4 });
  await sleep(150);
  let ls = await labels();
  assert(ls.includes("100"), `H gap to B labeled 100 (got [${ls.join(",")}])`);
  await shot(page, "f3-01-hgap");

  // --- V gap: hover C → label "90" ---
  const cC = await pt(100 + 80, 360 + 60);
  await page.mouse.move(cC.x, cC.y, { steps: 6 });
  await sleep(150);
  ls = await labels();
  assert(ls.includes("90"), `V gap to C labeled 90 (got [${ls.join(",")}])`);
  await shot(page, "f3-02-vgap");

  // --- figure-edge mode: hover empty space → 4 edge distances (incl. 540 & 230) ---
  const empty = await pt(650, 430);
  await page.mouse.move(empty.x, empty.y, { steps: 6 });
  await sleep(150);
  ls = await labels();
  assert(ls.includes("540") && ls.includes("230"), `figure-edge distances shown (right=540, bottom=230; got [${ls.join(",")}])`);
  assert(ls.length >= 4, `4 edge dimensions (got ${ls.length})`);
  await shot(page, "f3-03-edges");

  // --- Alt release clears the caliper ---
  await page.keyboard.up("Alt");
  await sleep(150);
  const cleared = await page.evaluate(() => document.querySelectorAll(".measure").length);
  assert(cleared === 0, `Alt release clears caliper (${cleared} lines left)`);

  // --- regression: Alt-drag still DUPLICATES (no clash) ---
  const before = await page.evaluate(() => (window as any).__flux.figures().find((f: any) => f.id === "growth").elements.length);
  await page.evaluate((id: string) => (window as any).__flux.fig.selectOnly(id), ids.A);
  await sleep(80);
  const aC = await pt(100 + 80, 150 + 60);
  const dst = await pt(560, 150 + 60);
  await page.keyboard.down("Alt");
  await page.mouse.move(aC.x, aC.y);
  await page.mouse.down();
  await page.mouse.move(dst.x, dst.y, { steps: 12 });
  // caliper must be suppressed mid-drag
  const midDrag = await page.evaluate(() => document.querySelectorAll(".measure").length);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await sleep(150);
  const after = await page.evaluate(() => (window as any).__flux.figures().find((f: any) => f.id === "growth").elements.length);
  assert(midDrag === 0, "caliper suppressed during a drag (no clash with Alt-drag)");
  assert(after === before + 1, `Alt-drag still duplicates (${before}→${after})`);

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nF3 CALIPER ALL PASS" : `\nF3 CALIPER ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
