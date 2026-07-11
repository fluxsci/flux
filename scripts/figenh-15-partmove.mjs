// figure-v1 Phase 2 — part move + nudge + Esc + 'x' (canvas interaction):
//  - a real pointer drag on an already-selected plot's part commits an
//    id-keyed {dx,dy} override (ONE undo step) and the live node's transform
//    starts with the translate;
//  - arrow keys nudge the drilled part (dx/dy ± 1 plot unit);
//  - Esc mid-drag restores the node's transform and commits nothing;
//  - undo reverts each step;
//  - a click-drag on plot SCAFFOLDING (the background patch) still moves the
//    WHOLE plot (element x/y change; no dx override; part selection cleared);
//  - 'x' toggles the drilled part's hidden override.
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, waitFor, waitForFrame } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const near = (a, b, tol = 1.5) => typeof a === "number" && Math.abs(a - b) <= tol;

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const PART = "axis.x.ticklabel.2";

// viewport fold settled: the zoom <g> carries viewport.zoom and the wrapper residual
// is exactly 1 — screen coords equal logical coords, so pointer math is exact.
const viewportSettled = () => {
  const F = window.__flux;
  const g = document.querySelector(".scene-svg > g");
  const scene = document.querySelector(".scene");
  if (!F?.fig || !g || !scene) return false;
  const zoom = F.get(F.fig.viewport).zoom;
  const gs = /scale\(([-\d.e]+)/.exec(g.getAttribute("transform") || "");
  const m = /matrix\(([-\d.e]+)/.exec(getComputedStyle(scene).transform);
  return (gs ? Number(gs[1]) : 1) === zoom && Math.abs((m ? Number(m[1]) : 1) - 1) < 1e-9;
};

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready (dev handle + demo figures + canvas)",
  });

  // Seed: plot placed at viewBox size → 1 client px == 1 plot-local unit at zoom 1.
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("part-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 900;
        g.height = 620;
        g.elements = [];
        g.elements.push({
          type: "plot",
          id: "plot1",
          x: 40,
          y: 40,
          width: 504,
          height: 360,
          rotation: 0,
          assetId: "part-asset",
          overrides: {},
        });
      });
      F.selectOnly("plot1");
      F.viewport.set({ panX: 140, panY: 140, zoom: 1 });
    },
    SVG,
    MANIFEST,
  );
  await waitFor(page, (p) => !!document.getElementById(`plot1__${p}`), PART, {
    timeout: 8000,
    label: "plot part mounted",
  });
  await waitFor(page, viewportSettled, null, { label: "viewport folded (pointer math exact)" });

  const partRect = (part) =>
    page.evaluate((p) => {
      const n = document.getElementById(`plot1__${p}`);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, part);
  const model = () =>
    page.evaluate(() => {
      const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1");
      return { x: el.x, y: el.y, overrides: el.overrides ?? {}, ps: window.__flux.get(window.__flux.fig.partSelection) };
    });
  const nodeTransform = (part) =>
    page.evaluate((p) => document.getElementById(`plot1__${p}`)?.getAttribute("transform") ?? null, part);

  // ---- 1. drag the tick label → {dx,dy} override, one undo, translate on node ----
  let r = await partRect(PART);
  assert(r && r.w > 0, "tick label node found on the canvas");
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const baseTransform = await nodeTransform(PART);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 18, { steps: 6 });
  await waitFor(
    page,
    ({ p, base }) => (document.getElementById(`plot1__${p}`)?.getAttribute("transform") ?? null) !== base,
    { p: PART, base: baseTransform },
    { label: "transient part translate applied mid-drag" },
  );
  await page.mouse.up();
  await waitFor(
    page,
    (p) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[p]?.dx != null,
    PART,
    { label: "part drag committed an override" },
  );

  let m = await model();
  assert(m.ps && m.ps.partId === PART, `clicking the part drilled the selection (${m.ps?.partId})`);
  let ov = m.overrides[PART];
  assert(near(ov?.dx, 30) && near(ov?.dy, 18), `drag committed {dx≈30, dy≈18} in plot units (got ${ov?.dx}, ${ov?.dy})`);
  assert(m.x === 40 && m.y === 40, "the plot element itself did NOT move");
  const t1 = await nodeTransform(PART);
  assert(t1 && t1.startsWith("translate("), `re-mounted node transform starts with translate (${t1})`);
  const r2 = await partRect(PART);
  assert(r2 && near(r2.x, r.x + 30, 2) && near(r2.y, r.y + 18, 2), "the part visually moved by the drag delta");
  await shot(page, "figenh15-01-dragged");

  // waitOv: poll the plot's override for PART until `field` compares === `want`
  // (undefined-safe — the condition the next assert reads)
  const waitOv = (field, want, label) =>
    waitFor(
      page,
      ({ p, field, want }) => {
        const ov = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[p];
        return (ov?.[field] ?? undefined) === (want ?? undefined);
      },
      { p: PART, field, want },
      { label },
    );

  // one undo reverts the whole drag
  await page.evaluate(() => window.__flux.fig.undo());
  await waitOv("dx", undefined, "undo removed the dx override");
  m = await model();
  assert(m.overrides[PART]?.dx === undefined, "ONE undo reverts the drag (dx override gone)");
  const rBack = await partRect(PART);
  assert(rBack && near(rBack.x, r.x, 2), "part back at its original position after undo");

  // ---- 2. arrow-key nudge (plot-local units; shift = 10) ----
  await page.keyboard.press("ArrowRight");
  await waitOv("dx", 1, "ArrowRight nudged dx to 1");
  await page.keyboard.press("ArrowUp");
  await waitOv("dy", -1, "ArrowUp nudged dy to -1");
  m = await model();
  ov = m.overrides[PART];
  assert(ov?.dx === 1 && ov?.dy === -1, `arrows nudge the part (dx=${ov?.dx}, dy=${ov?.dy})`);
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
  await waitOv("dy", 9, "Shift+ArrowDown stepped dy to 9");
  m = await model();
  assert(m.overrides[PART]?.dy === 9, `shift-arrow steps by 10 (dy=${m.overrides[PART]?.dy})`);
  assert(m.x === 40, "nudges never move the plot element");
  // undo peels one nudge at a time
  await page.evaluate(() => window.__flux.fig.undo());
  await waitOv("dy", -1, "undo peeled one nudge");
  m = await model();
  assert(m.overrides[PART]?.dy === -1, "undo reverts one nudge step");
  await page.evaluate(() => {
    window.__flux.fig.undo();
    window.__flux.fig.undo();
  });
  await waitOv("dx", undefined, "nudges fully undone");
  m = await model();
  assert(m.overrides[PART]?.dx === undefined, "nudges fully undone");

  // ---- 3. Esc mid-drag restores the transform, commits nothing ----
  r = await partRect(PART);
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2 + 44, r.y + r.h / 2 + 26, { steps: 5 });
  await waitFor(
    page,
    ({ p, base }) => (document.getElementById(`plot1__${p}`)?.getAttribute("transform") ?? null) !== base,
    { p: PART, base: baseTransform },
    { label: "transient translate applied mid-drag (Esc case)" },
  );
  const midT = await nodeTransform(PART);
  assert(midT && midT.startsWith("translate("), `mid-drag: node carries the transient translate (${midT})`);
  await page.keyboard.press("Escape");
  await waitFor(
    page,
    ({ p, base }) => (document.getElementById(`plot1__${p}`)?.getAttribute("transform") ?? null) === base,
    { p: PART, base: baseTransform },
    { label: "Esc restored the node transform" },
  );
  await page.mouse.up();
  await waitForFrame(page); // a (wrong) commit would land with this paint
  m = await model();
  assert(m.overrides[PART]?.dx === undefined, "Esc mid-drag commits NOTHING");
  const tAfter = await nodeTransform(PART);
  assert(tAfter === baseTransform, `Esc restored the node's original transform (${tAfter})`);
  await shot(page, "figenh15-02-escaped");

  // ---- 4. scaffold (background patch) click-drag moves the WHOLE plot ----
  // patch_1 is the figure background; click near its top-left corner (bare margin).
  const bg = await partRect("patch_1");
  assert(bg, "background patch node present");
  await page.mouse.move(bg.x + 6, bg.y + 6);
  await page.mouse.down();
  await page.mouse.move(bg.x + 6 + 25, bg.y + 6 + 10, { steps: 5 });
  await waitFor(
    page,
    (x0) => {
      const n = document.getElementById("plot1__patch_1");
      return !!n && Math.abs(n.getBoundingClientRect().x - x0) > 10;
    },
    bg.x,
    { label: "whole-plot transient move visible mid-drag" },
  );
  await page.mouse.up();
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.x !== 40,
    null,
    { label: "scaffold drag committed the plot move" },
  );
  m = await model();
  assert(m.x === 65 && m.y === 50, `scaffold drag moved the WHOLE plot (x=${m.x}, y=${m.y})`);
  assert(!m.overrides["patch_1"] && !m.overrides["figure"], "no part override written by a scaffold drag");
  assert(m.ps === null, "scaffold click cleared the part selection");
  await page.evaluate(() => window.__flux.fig.undo());
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.x === 40,
    null,
    { label: "undo restored the plot position" },
  );

  // ---- 5. 'x' toggles hidden (part; and elements without a part) ----
  await page.evaluate((part) => window.__flux.fig.partSelection.set({ elementId: "plot1", partId: part }), PART);
  await waitFor(page, (p) => window.__flux.get(window.__flux.fig.partSelection)?.partId === p, PART, {
    label: "partSelection drilled",
  });
  await page.keyboard.press("x");
  await waitOv("hidden", true, "'x' hid the drilled part");
  m = await model();
  assert(m.overrides[PART]?.hidden === true, "'x' hides the drilled part (override {hidden:true})");
  const disp = await page.evaluate(
    (p) => document.getElementById(`plot1__${p}`)?.style.display ?? "",
    PART,
  );
  assert(disp === "none", "hidden part is display:none on the live node");
  await page.keyboard.press("x");
  await waitOv("hidden", false, "'x' unhid the drilled part");
  m = await model();
  assert(m.overrides[PART]?.hidden === false, "'x' again shows the part");

  await page.evaluate(() => window.__flux.fig.partSelection.set(null));
  await waitFor(page, () => window.__flux.get(window.__flux.fig.partSelection) === null, null, {
    label: "partSelection cleared",
  });
  await page.keyboard.press("x");
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.hidden === true,
    null,
    { label: "'x' hid the element" },
  );
  m = await page.evaluate(() => {
    const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1");
    return { hidden: el.hidden ?? false };
  });
  assert(m.hidden === true, "'x' without a part hides the selected ELEMENT");
  await page.keyboard.press("x");
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.hidden !== true,
    null,
    { label: "'x' unhid the element" },
  );
  m = await page.evaluate(() => {
    const el = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1");
    return { hidden: el.hidden ?? false };
  });
  assert(m.hidden === false, "'x' again shows the element");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nFIGENH-15 PART MOVE ALL PASS" : `\nFIGENH-15 PART MOVE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
