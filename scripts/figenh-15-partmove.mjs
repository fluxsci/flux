// figure-v1 Phase 2 (reworked 2026-07 for Figma deep-select) — plot part
// selection + move on the canvas:
//  - a PLAIN click-drag anywhere on a plot — selected or not, part or not —
//    moves the WHOLE plot (the accidental-part-grab fix);
//  - CTRL-click deep-selects the part under the cursor, even when the plot
//    wasn't selected yet; ctrl-drag commits an id-keyed {dx,dy} override
//    (ONE undo step) and the live node's transform starts with the translate;
//  - a plain drag on the ALREADY-drilled part keeps moving the part (Figma:
//    drag a selected child); a plain click on a DIFFERENT part re-selects the
//    whole plot and clears the drill;
//  - arrow keys nudge the drilled part (dx/dy ± 1 plot unit);
//  - Esc mid-drag restores the node's transform and commits nothing;
//  - ctrl-click on plot SCAFFOLDING (the background patch) selects the whole
//    plot without drilling; a plain scaffold drag still moves the whole plot;
//  - double-click DESCENDS into the part (the modifier-free drill);
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
const PART2 = "axis.x.ticklabel.1";

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
      F.clearSelection();
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
      return {
        x: el.x,
        y: el.y,
        overrides: el.overrides ?? {},
        ps: window.__flux.get(window.__flux.fig.partSelection),
        sel: [...window.__flux.get(window.__flux.fig.selection)],
      };
    });
  const nodeTransform = (part) =>
    page.evaluate((p) => document.getElementById(`plot1__${p}`)?.getAttribute("transform") ?? null, part);
  // waitOv: poll the plot's override for PART until `field` compares === `want`
  // (undefined-safe — the condition the next assert reads)
  const waitOv = (field, want, label, part = PART) =>
    waitFor(
      page,
      ({ p, field, want }) => {
        const ov = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[p];
        return (ov?.[field] ?? undefined) === (want ?? undefined);
      },
      { p: part, field, want },
      { label },
    );

  // ---- 1. PLAIN drag on a part of a SELECTED plot moves the WHOLE PLOT -------
  // (the accidental-part-grab fix: no drill, no override — the plot moves)
  await page.evaluate(() => window.__flux.fig.selectOnly("plot1"));
  let r = await partRect(PART);
  assert(r && r.w > 0, "tick label node found on the canvas");
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2 + 25, r.y + r.h / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.x === 65,
    null,
    { label: "plain part drag committed a whole-plot move" },
  );
  let m = await model();
  assert(m.x === 65 && m.y === 50, `plain drag on a part moves the WHOLE plot (x=${m.x}, y=${m.y})`);
  assert(m.overrides[PART] === undefined, "…and writes NO part override");
  assert(m.ps === null, "…and does NOT drill the part selection");
  await page.evaluate(() => window.__flux.fig.undo());
  await waitFor(page, () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.x === 40, null, {
    label: "undo restored the plot position",
  });

  // ---- 2. CTRL-click drills — even with the plot UNSELECTED ------------------
  await page.evaluate(() => window.__flux.fig.clearSelection());
  r = await partRect(PART);
  await page.keyboard.down("Control");
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await page.keyboard.up("Control");
  await waitFor(page, (p) => window.__flux.get(window.__flux.fig.partSelection)?.partId === p, PART, {
    label: "ctrl-click drilled the part",
  });
  m = await model();
  assert(m.ps && m.ps.elementId === "plot1" && m.ps.partId === PART, `ctrl-click on an UNSELECTED plot deep-selects the part (${m.ps?.partId})`);
  assert(m.sel.length === 1 && m.sel[0] === "plot1", "…and selects the owning plot element");
  assert(m.x === 40 && m.overrides[PART] === undefined, "…click alone commits nothing");

  // ---- 3. ctrl-DRAG moves the part: {dx,dy} override, one undo, translate ----
  const baseTransform = await nodeTransform(PART);
  await page.keyboard.down("Control");
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2 + 30, r.y + r.h / 2 + 18, { steps: 6 });
  await waitFor(
    page,
    ({ p, base }) => (document.getElementById(`plot1__${p}`)?.getAttribute("transform") ?? null) !== base,
    { p: PART, base: baseTransform },
    { label: "transient part translate applied mid-drag" },
  );
  await page.mouse.up();
  await page.keyboard.up("Control");
  await waitFor(
    page,
    (p) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[p]?.dx != null,
    PART,
    { label: "ctrl-drag committed the {dx,dy} override" },
  );
  m = await model();
  let ov = m.overrides[PART];
  assert(near(ov?.dx, 30) && near(ov?.dy, 18), `ctrl-drag committed {dx≈30, dy≈18} in plot units (got ${ov?.dx}, ${ov?.dy})`);
  assert(m.x === 40 && m.y === 40, "the plot element itself did NOT move");
  const t1 = await nodeTransform(PART);
  assert(t1 && t1.startsWith("translate("), `re-mounted node transform starts with translate (${t1})`);
  const r2 = await partRect(PART);
  assert(r2 && near(r2.x, r.x + 30, 2) && near(r2.y, r.y + 18, 2), "the part visually moved by the drag delta");
  await shot(page, "figenh15-01-ctrl-dragged");

  // ---- 4. plain drag on the ALREADY-drilled part continues the part move -----
  await page.mouse.move(r2.x + r2.w / 2, r2.y + r2.h / 2);
  await page.mouse.down();
  await page.mouse.move(r2.x + r2.w / 2 + 10, r2.y + r2.h / 2 + 5, { steps: 4 });
  await page.mouse.up();
  await waitFor(
    page,
    (p) => {
      const dx = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[p]?.dx;
      return typeof dx === "number" && Math.abs(dx - 40) <= 1.5;
    },
    PART,
    { label: "plain drag on the drilled part extended the override" },
  );
  m = await model();
  ov = m.overrides[PART];
  assert(near(ov?.dx, 40) && near(ov?.dy, 23), `drilled part keeps moving without ctrl (dx=${ov?.dx}, dy=${ov?.dy})`);
  assert(m.x === 40, "…and the plot element still did not move");
  // one undo per drag
  await page.evaluate(() => window.__flux.fig.undo());
  await waitFor(
    page,
    (p) => {
      const dx = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.overrides?.[p]?.dx;
      return typeof dx === "number" && Math.abs(dx - 30) <= 1.5;
    },
    PART,
    { label: "undo peeled the continuation drag" },
  );
  await page.evaluate(() => window.__flux.fig.undo());
  await waitOv("dx", undefined, "undo removed the ctrl-drag override");
  m = await model();
  assert(m.overrides[PART]?.dx === undefined, "ONE undo per drag (both overrides gone)");
  const rBack = await partRect(PART);
  assert(rBack && near(rBack.x, r.x, 2), "part back at its original position after undo");

  // ---- 5. plain click on a DIFFERENT part re-selects the whole plot ----------
  const rp2 = await partRect(PART2);
  assert(rp2, "second tick label present");
  await page.mouse.click(rp2.x + rp2.w / 2, rp2.y + rp2.h / 2);
  await waitFor(page, () => window.__flux.get(window.__flux.fig.partSelection) === null, null, {
    label: "drill cleared by a plain click elsewhere on the plot",
  });
  m = await model();
  assert(m.ps === null, "plain click on another part clears the drill");
  assert(m.sel.length === 1 && m.sel[0] === "plot1", "…and the whole plot stays selected");

  // ---- 5b. ctrl-hover previews the deep-select target -------------------------
  r = await partRect(PART);
  await page.mouse.move(r.x - 60, r.y - 60); // off the plot first (fresh pointerenter)
  await page.keyboard.down("Control");
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 3 });
  await waitFor(page, () => !!document.querySelector(".overlay-svg .part-hover"), null, {
    label: "ctrl-hover shows the deep-target outline",
  });
  const hov = await page.evaluate((want) => {
    const n = document.querySelector(".overlay-svg .part-hover");
    const part = document.getElementById(`plot1__${want}`);
    if (!n || !part) return null;
    const hb = n.getBoundingClientRect();
    const pb = part.getBoundingClientRect();
    return { dx: Math.abs(hb.x - pb.x), dy: Math.abs(hb.y - pb.y) };
  }, PART);
  assert(hov && hov.dx <= 4 && hov.dy <= 4, `hover outline hugs the part under the cursor (Δ ${hov?.dx},${hov?.dy})`);
  await page.keyboard.up("Control");
  await waitFor(page, () => !document.querySelector(".overlay-svg .part-hover"), null, {
    label: "releasing ctrl clears the hover outline",
  });

  // ---- 6. arrow-key nudge (plot-local units; shift = 10) ---------------------
  await page.keyboard.down("Control");
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await page.keyboard.up("Control");
  await waitFor(page, (p) => window.__flux.get(window.__flux.fig.partSelection)?.partId === p, PART, {
    label: "re-drilled via ctrl-click",
  });
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
  await page.evaluate(() => {
    window.__flux.fig.undo();
    window.__flux.fig.undo();
  });
  await waitOv("dx", undefined, "nudges fully undone");

  // ---- 7. Esc mid-drag restores the transform, commits nothing ---------------
  r = await partRect(PART);
  await page.keyboard.down("Control");
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
  await page.keyboard.up("Control");
  await waitForFrame(page); // a (wrong) commit would land with this paint
  m = await model();
  assert(m.overrides[PART]?.dx === undefined, "Esc mid-drag commits NOTHING");
  const tAfter = await nodeTransform(PART);
  assert(tAfter === baseTransform, `Esc restored the node's original transform (${tAfter})`);
  await shot(page, "figenh15-02-escaped");

  // ---- 8. scaffold (background patch): plain drag moves the WHOLE plot;
  //         ctrl-click selects the whole plot WITHOUT drilling ------------------
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
  assert(m.ps === null, "no part selection from a scaffold drag");
  await page.evaluate(() => window.__flux.fig.undo());
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "plot1")?.x === 40,
    null,
    { label: "undo restored the plot position" },
  );
  await page.evaluate(() => window.__flux.fig.clearSelection());
  await page.keyboard.down("Control");
  await page.mouse.click(bg.x + 6, bg.y + 6);
  await page.keyboard.up("Control");
  await waitFor(page, () => window.__flux.get(window.__flux.fig.selection).has("plot1"), null, {
    label: "ctrl-click on scaffold selected the plot",
  });
  m = await model();
  assert(m.sel.length === 1 && m.sel[0] === "plot1", "ctrl-click on scaffold selects the whole plot");
  assert(m.ps === null, "…without drilling a part (scaffold never drills)");

  // ---- 9. double-click DESCENDS into the part (modifier-free drill) ----------
  // A REAL double-click: two down/up pairs, the second with clickCount 2 —
  // that's what makes Chrome synthesize the dblclick event (citegroup recipe).
  await page.evaluate(() => window.__flux.fig.clearSelection());
  r = await partRect(PART);
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await waitFor(page, (p) => window.__flux.get(window.__flux.fig.partSelection)?.partId === p, PART, {
    label: "double-click drilled the part",
  });
  m = await model();
  assert(m.ps && m.ps.partId === PART && m.ps.elementId === "plot1", `double-click descends into the part (${m.ps?.partId})`);
  assert(m.sel.length === 1 && m.sel[0] === "plot1", "…with the owning plot selected");

  // ---- 10. 'x' toggles hidden (part; and elements without a part) ------------
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
