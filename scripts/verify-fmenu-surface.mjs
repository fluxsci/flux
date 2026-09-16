// 2026-09-15 surface redesign gate (browser) — the property menu as a SURFACE:
//   · `f` opens it INSTANTLY beside the selection: it never covers the
//     selection box and stays inside the viewport
//   · a hotkey ARMS a row (o = opacity): the mouse wheel then steps the value
//     (up = increase), Space applies; the whole armed edit is ONE undo entry
//   · typed digits replace the armed value; Enter applies; Escape reverts
//   · a choice (align) expands its options inline; `3` picks the third
//   · a colour opens the palette picker: hovering a swatch PREVIEWS, Escape
//     reverts, a click commits; the picker exposes the `.hex` field
//   · several drilled parts (store.partSelections) edit as one: one field
//     write lands on every selected part
//   · the panel's fields keep their exact labels (other gates pin them)
//   Run (dev server on :1420): node scripts/verify-fmenu-surface.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForGone } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed: a rect, a text, and one real fluxplot; pin the view at zoom 1.
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("fm-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0; g.y = 0; g.width = 1000; g.height = 700;
        g.elements = [
          { type: "rect", id: "fm-rect", x: 60, y: 80, width: 180, height: 120, rotation: 0, fill: "#d95f02", stroke: "#222222", strokeWidth: 2, cornerRadius: 0, opacity: 1 },
          { type: "text", id: "fm-text", x: 60, y: 260, width: 220, height: 40, rotation: 0, text: "Hello surface", fontFamily: "Georgia", fontSize: 18, fontWeight: 400, fontStyle: "normal", color: "#222222", align: "left", lineHeight: 1.2, sizing: "auto" },
          { type: "plot", id: "fm-plot", x: 420, y: 60, width: 504, height: 360, rotation: 0, assetId: "fm-asset", overrides: {} },
        ];
        window.__figId = g.id;
        F.activeFigureId.set(g.id);
      });
      F.viewport.set({ panX: 80, panY: 110, zoom: 1 });
      F.resetHistory();
    },
    SVG,
    MANIFEST,
  );
  await sleep(400);
  const model = () => page.evaluate(() => {
    const f = window.__flux.figures()[0];
    const by = (id) => structuredClone(f.elements.find((e) => e.id === id));
    return { rect: by("fm-rect"), text: by("fm-text"), plot: by("fm-plot"), h: window.__flux.fig.historyStats() };
  });
  const menuRect = () => page.evaluate(() => {
    const m = document.querySelector(".fluxFigMenu");
    const s = document.querySelector(".canvas-host .sel-box");
    if (!m) return null;
    const r = m.getBoundingClientRect(), b = s?.getBoundingClientRect();
    return {
      placed: getComputedStyle(m).visibility === "visible",
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      overlaps: b ? !(r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom) : null,
      right: b ? r.left >= b.right : null,
      armed: document.querySelector(".fluxFigMenu .field.editing")?.getAttribute("data-key") ?? null,
      cols: getComputedStyle(document.querySelector(".fluxFigMenu .body")).columnCount,
    };
  });

  // --- 1. anchored beside the selection -----------------------------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("fm-rect"));
  await sleep(200);
  await page.mouse.move(250, 260); // the pointer sits over the rect
  await page.keyboard.press("f");
  await waitFor(page, () => getComputedStyle(document.querySelector(".fluxFigMenu") ?? document.body).visibility === "visible" && !!document.querySelector(".fluxFigMenu"), null, { label: "menu placed" });
  let mr = await menuRect();
  ok(!!mr && mr.placed, "f opens the property menu");
  ok(mr && mr.overlaps === false, "the menu never covers the selection box");
  ok(mr && mr.right === true, "…and lands to the RIGHT of it (room available)");
  ok(mr && mr.inView, "…inside the viewport");
  await shot(page, "fmenu-01-anchored");

  // --- 2. arm a number, wheel it, Space applies — one undo -----------------------------
  await page.keyboard.press("a");
  await sleep(120);
  mr = await menuRect();
  ok(mr?.armed === "a", `pressing a arms the opacity row (armed: ${mr?.armed})`);
  const panel = await page.evaluate(() => { const r = document.querySelector(".fluxFigMenu").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(panel.x, panel.y);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: 100 }); await sleep(30); } // wheel DOWN = decrease
  await sleep(150);
  let m = await model();
  ok(m.rect.opacity < 1 && m.rect.opacity >= 0.5, `wheel down lowers opacity live (${m.rect.opacity})`);
  await page.keyboard.press("Space");
  await sleep(120);
  mr = await menuRect();
  ok(mr?.armed === null, "Space applies and returns to hotkey mode");
  m = await model();
  ok(m.h.past === 1, `the whole wheel edit is ONE undo entry (past=${m.h.past})`);
  const afterWheel = m.rect.opacity;
  for (let i = 0; i < 2; i++) { await page.mouse.wheel({ deltaY: -100 }); await sleep(30); } // hover-wheel in hotkey mode on a non-field spot: no change
  await sleep(120);
  m = await model();
  ok(m.rect.opacity === afterWheel, "wheel over no row changes nothing in hotkey mode");

  // --- 3. typed digits replace; Enter applies; Escape reverts --------------------------
  await page.keyboard.press("w");
  await sleep(120);
  await page.keyboard.type("250");
  await page.keyboard.press("Enter");
  await sleep(150);
  m = await model();
  ok(m.rect.width === 250, `w, typing 250, Enter → width 250 (${m.rect.width})`);
  ok(m.h.past === 2, `…one more undo entry (past=${m.h.past})`);
  await page.keyboard.press("x");
  await sleep(120);
  await page.keyboard.type("999");
  await sleep(80);
  m = await model();
  ok(m.rect.x === 999, "typing previews live");
  await page.keyboard.press("Escape");
  await sleep(150);
  m = await model();
  ok(m.rect.x === 60 && m.h.past === 2, `Escape reverts the armed edit without an undo entry (x=${m.rect.x}, past=${m.h.past})`);
  mr = await menuRect();
  ok(mr?.armed === null && !!mr, "…and the menu stays open in hotkey mode");
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu");
  ok(!(await page.$(".fluxFigMenu")), "Escape in hotkey mode closes the menu");

  // --- 4. a choice expands inline; 1–9 picks ----------------------------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("fm-text"));
  await sleep(200);
  await page.mouse.move(200, 400);
  await page.keyboard.press("f");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "menu (text)" });
  await sleep(120);
  await page.keyboard.press("3");
  await sleep(120);
  const opts = await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .field.opts-open .opt")].map((o) => o.textContent.trim().replace(/^\d/, "")));
  ok(opts.length === 3 && /Right/.test(opts[2]), `align expands its options inline (${opts.join(" | ")})`);
  await page.keyboard.press("3");
  await sleep(150);
  m = await model();
  ok(m.text.align === "right", `3 picks the third option (align=${m.text.align})`);
  mr = await menuRect();
  ok(mr?.armed === null, "…and returns to hotkey mode");
  ok(mr && mr.cols !== "auto", `groups lay out in columns (${mr?.cols})`);

  // --- 5. colour: hover previews, Escape reverts, click commits ---------------------------
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu");
  await page.evaluate(() => window.__flux.fig.selectOnly("fm-rect"));
  await sleep(200);
  await page.keyboard.press("f");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "menu (rect)" });
  await sleep(120);
  await page.keyboard.press("c");
  await sleep(150);
  const pick = await page.evaluate(() => ({
    cs: !!document.querySelector(".fluxFigMenu .cs"),
    hex: !!document.querySelector(".fluxFigMenu .cs input.hex"),
    exp: !!document.querySelector(".fluxFigMenu .cs .sv") && !!document.querySelector(".fluxFigMenu .cs input.hue"),
    swatches: document.querySelectorAll(".fluxFigMenu .cs .sw:not(.none)").length,
  }));
  ok(pick.cs && pick.hex && pick.exp, "c opens the palette picker (.cs with the .hex field and the always-visible spectrum)");
  ok(pick.swatches > 10, `the palette renders as swatches (${pick.swatches})`);
  const target = await page.evaluate(() => {
    const sw = [...document.querySelectorAll(".fluxFigMenu .cs .sw:not(.none)")].find((s) => s.style.background && s.style.background !== "rgb(217, 95, 2)");
    const r = sw.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hex: sw.title.split(" · ").pop() };
  });
  await page.mouse.move(target.x, target.y);
  await sleep(150);
  m = await model();
  ok(m.rect.fill.toLowerCase() === target.hex.toLowerCase(), `hovering a swatch previews it live (${m.rect.fill})`);
  await page.keyboard.press("Escape");
  await sleep(150);
  m = await model();
  ok(m.rect.fill === "#d95f02", "Escape reverts the preview");
  ok(!!(await page.$(".fluxFigMenu")) && !(await page.$(".fluxFigMenu .cs")), "…and returns to the menu's hotkey mode");
  await page.keyboard.press("c");
  await sleep(150);
  await page.mouse.move(target.x, target.y);
  await sleep(60);
  await page.mouse.click(target.x, target.y);
  await sleep(200);
  m = await model();
  ok(m.rect.fill.toLowerCase() === target.hex.toLowerCase(), `a click commits the colour (${m.rect.fill})`);
  ok(m.h.past === 4, `…as one undo entry — opacity, width, align, colour (past=${m.h.past})`);
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu");

  // --- 6. several drilled parts edit as one ------------------------------------------------
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.selectOnly("fm-plot");
    F.setPartSelections([{ elementId: "fm-plot", partId: "axis.x" }, { elementId: "fm-plot", partId: "axis.y" }]);
  });
  await sleep(200);
  await page.mouse.move(700, 300);
  await page.keyboard.press("f");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "menu (parts)" });
  await sleep(120);
  const ctx = await page.evaluate(() => document.querySelector(".fluxFigMenu .ctx")?.textContent ?? "");
  ok(/2 plot parts/.test(ctx), `the header names the plural pick (${ctx})`);
  await page.keyboard.press("a");
  await sleep(120);
  await page.keyboard.type("0.4");
  await page.keyboard.press("Enter");
  await sleep(150);
  m = await model();
  ok(m.plot.overrides?.["axis.x"]?.opacity === 0.4 && m.plot.overrides?.["axis.y"]?.opacity === 0.4, "one field write lands on every selected part");
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu");

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-FMENU-SURFACE ALL PASS" : `\nVERIFY-FMENU-SURFACE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
