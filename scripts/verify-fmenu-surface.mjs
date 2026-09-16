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

  // Fine adjustments must accumulate from the exact draft, not its rounded
  // display; the Inspector must report the same fractional model value.
  await page.keyboard.press("x");
  await waitFor(page, () => document.activeElement?.closest('.field')?.getAttribute('data-key') === 'x', null, { label: "position armed for fine stepping" });
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Alt");
  m = await model();
  const fineDisplay = await page.$eval('.fluxFigMenu .field[data-key="x"] .nin', el => el.value);
  ok(m.rect.x === 60.2 && fineDisplay === "60.2", `two fine steps accumulate and display exactly (x=${m.rect.x}, display=${fineDisplay})`);
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('.fluxFigMenu .field.editing') && document.activeElement === document.querySelector('.fluxFigMenu'), null, { label: "fine stepping cancelled and menu focus restored" });
  await page.keyboard.press("d");
  await waitFor(page, () => document.activeElement?.closest('.field')?.getAttribute('data-key') === 'd', null, { label: "stroke armed for fine stepping" });
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Alt");
  m = await model();
  ok(m.rect.strokeWidth === 2.1, `two fine half-unit stroke steps produce 2.1 (${m.rect.strokeWidth})`);
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('.fluxFigMenu .field.editing') && document.activeElement === document.querySelector('.fluxFigMenu'), null, { label: "stroke stepping cancelled and menu focus restored" });
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
  ok(await page.evaluate(() => {
    const tabs = document.querySelector('.cs > [aria-label="Palette collections"]'), side = document.querySelector(".cs .side");
    const t = tabs.getBoundingClientRect(), s = side.getBoundingClientRect();
    return tabs.scrollWidth <= tabs.clientWidth && t.bottom <= s.top;
  }), "the collection tabs and shortcuts fit above the palette and spectrum without overlap");
  const target = await page.evaluate(() => {
    const sw = [...document.querySelectorAll(".fluxFigMenu .cs .sw:not(.none)")].find((s) => s.style.background && s.style.background !== "rgb(217, 95, 2)");
    const r = sw.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hex: sw.title.split(" · ").pop() };
  });
  await page.mouse.move(target.x, target.y);
  await sleep(150);
  m = await model();
  ok(m.rect.fill.toLowerCase() === target.hex.toLowerCase(), `hovering a swatch previews it live (${m.rect.fill})`);
  const livePicker = await page.evaluate(() => ({ hex: document.querySelector(".cs .hex").value, opacity: Number(document.querySelector(".cs .erow input").value) }));
  ok(livePicker.hex.toLowerCase() === m.rect.fill.toLowerCase(), "the hex field follows the hovered colour");
  ok(livePicker.opacity === m.rect.opacity, "the picker shows the selected object's actual opacity");
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


  // --- 5b. collections (2026-09-16): tabs, Shift+Tab cycles, Tab → colormaps, a colour along a map ----
  await page.keyboard.press("c");
  await sleep(150);
  const tabs = await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .cs .tabs .tab")].map((t) => ({ name: t.textContent.trim(), on: t.classList.contains("on") })));
  ok(tabs.map((t) => t.name).join("|") === "Flexoki|ColorBrewer|Paul Tol|Colormaps" && tabs[0].on, `the picker offers the palette collections and the colormaps (${tabs.map((t) => t.name).join("|")}); Flexoki (the setting) is open`);
  await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
  await sleep(80);
  const after = await page.evaluate(() => ({ on: document.querySelector(".fluxFigMenu .cs .tabs .tab.on")?.textContent.trim(), rows: [...document.querySelectorAll(".fluxFigMenu .cs .plabel")].map((l) => l.textContent.trim()) }));
  ok(after.on === "ColorBrewer" && after.rows.includes("BLUES") === false && after.rows.some((r) => /blues/i.test(r)), `Shift+Tab cycles to ColorBrewer and its groups fill the grid (${after.on}; ${after.rows.slice(0, 3).join(", ")}…)`);
  await page.keyboard.press("Tab");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu .cs .cmp"), null, { label: "colormap view" });
  const cm = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll(".fluxFigMenu .cmp .tabs .tab")].map((t) => t.textContent.trim()),
    on: document.querySelector(".fluxFigMenu .cmp .tabs .tab.on")?.textContent.trim(),
    groups: [...document.querySelectorAll(".fluxFigMenu .cmp .gtitle")].map((g) => g.firstChild.textContent.trim()),
    maps: document.querySelectorAll(".fluxFigMenu .cmp .cm").length,
    bars: [...document.querySelectorAll(".fluxFigMenu .cmp .cm .bar")].every((b) => /gradient/.test(b.getAttribute("style") || "")),
  }));
  ok(cm.tabs.join("|") === "matplotlib|Crameri|Paul Tol|cmasher" && cm.on === "matplotlib", `Tab opens the colormap picker on the matplotlib collection (${cm.tabs.join("|")})`);
  ok(cm.groups.join("|") === "sequential|diverging|cyclic|qualitative|misc" && cm.maps > 80 && cm.bars, `maps are grouped by type with a preview bar each (${cm.maps} maps)`);
  ok(await page.$$eval(".cmp .cm", (rows) => rows.every((r) => r.getBoundingClientRect().height === 22)), "long colormap collections retain readable 22px rows instead of compressing them");
  await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift");
  await sleep(80);
  ok((await page.evaluate(() => document.querySelector(".fluxFigMenu .cmp .tabs .tab.on")?.textContent.trim())) === "Crameri", "Shift+Tab cycles the colormap collections too");
  ok(await page.evaluate(() => !!document.querySelector(".cmp .cm.cur") && !!document.querySelector(".cmp .pick") && !!document.querySelector(".cmp .gbtn")), "switching collections immediately selects a map and keeps colour/gradient controls ready");
  await page.evaluate(() => document.querySelector('.fluxFigMenu .cmp .cm[data-map="batlow"]').click());
  await sleep(80);
  const bar = await page.evaluate(() => { const r = document.querySelector(".fluxFigMenu .cmp .pick").getBoundingClientRect(); return { x: r.left + r.width * 0.9, y: r.top + r.height / 2 }; });
  await page.mouse.move(bar.x, bar.y);
  await sleep(120);
  m = await model();
  const previewed = m.rect.fill.toLowerCase();
  ok(/^#[0-9a-f]{6}$/.test(previewed) && previewed !== target.hex.toLowerCase(), `hovering along batlow previews the colour at that position (${previewed})`);
  await page.mouse.click(bar.x, bar.y);
  await sleep(200);
  m = await model();
  ok(m.rect.fill.toLowerCase() === previewed && !(await page.$(".fluxFigMenu .cs")), `a click along the map applies that colour and closes the picker (${m.rect.fill})`);

  // --- 5c. gradients (owner note, 2026-09-16): the whole map along an axis --------------------
  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu .cs"), null, { label: "picker (gradient)" });
  await page.keyboard.press("Tab");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu .cmp"), null, { label: "colormap view (gradient)" });
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await sleep(120);
  await page.evaluate(() => document.querySelector('.fluxFigMenu .cmp .cm[data-map="batlow"]').click());
  await sleep(120);
  const gbtns = await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .cmp .gbtn")].map((b) => b.dataset.axis).join("|"));
  ok(gbtns === "x|y", `the colour-mode footer offers the map as a gradient along x or y (${gbtns})`);
  await page.keyboard.press("y");
  await sleep(250);
  m = await model();
  ok(m.rect.fillMap?.map === "crameri.batlow" && m.rect.fillMap.axis === "y" && m.rect.fillMap.stops?.length === 32 && !(await page.$(".fluxFigMenu .cs")), `y applies the map as a gradient along y — name, axis and the 32 resolved stops on the element — and closes the picker (${JSON.stringify({ map: m.rect.fillMap?.map, axis: m.rect.fillMap?.axis, stops: m.rect.fillMap?.stops?.length })})`);
  // clicking the row in colour mode previewed the map's midpoint as a solid — that
  // solid stays underneath as the fallback for an unknown map
  ok(/^#[0-9a-f]{6}$/i.test(m.rect.fill), `…keeping a solid colour underneath as the fallback (${m.rect.fill})`);
  const painted = await page.evaluate(() => {
    const g = document.querySelector('linearGradient[id="fxg-fm-rect-fill"]');
    const r = document.querySelector('[data-id="fm-rect"] rect, g[data-id="fm-rect"] rect') || [...document.querySelectorAll("svg rect")].find((x) => (x.getAttribute("fill") || "").startsWith("url(#fxg-fm-rect"));
    return { def: !!g, stops: g ? g.querySelectorAll("stop").length : 0, y1: g?.getAttribute("y1"), fill: r?.getAttribute("fill") ?? "" };
  });
  ok(painted.def && painted.stops === 32 && painted.y1 === "1" && painted.fill === "url(#fxg-fm-rect-fill)", `the canvas paints the rect through a 32-stop bottom→top gradient (${JSON.stringify(painted)})`);
  const chip = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".fluxFigMenu .colorbtn")].find((x) => /batlow/.test(x.textContent));
    return b ? { name: b.querySelector(".cname")?.textContent.trim(), bg: b.querySelector(".dot")?.style.background || "" } : null;
  });
  ok(!!chip && chip.name === "crameri.batlow · along y" && /linear-gradient/.test(chip.bg), `the menu's colour chip shows the gradient and names the map (${JSON.stringify(chip)})`);
  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu .cs"), null, { label: "picker (solid again)" });
  await sleep(120);
  // re-find the swatch: the picker is a fresh instance and the chip above it now
  // carries a longer label, so never trust the old screen point
  const again = await page.evaluate((hex) => {
    const sw = [...document.querySelectorAll(".fluxFigMenu .cs .sw:not(.none)")].find((s) => s.title.split(" · ").pop().toLowerCase() === hex);
    if (!sw) return null;
    const r = sw.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, target.hex.toLowerCase());
  ok(!!again, "the palette view is back with the same swatches");
  await page.mouse.move(again.x, again.y);
  await sleep(60);
  await page.mouse.click(again.x, again.y);
  await sleep(200);
  m = await model();
  ok(m.rect.fillMap === undefined && m.rect.fill.toLowerCase() === target.hex.toLowerCase(), `a swatch pick returns the rect to a solid colour (${JSON.stringify({ fill: m.rect.fill, fillMap: m.rect.fillMap })})`);
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu");

  // --- 5d. colour feedback, invalid drafts and cancelled gestures ---------------------------
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => { const r = p.figures[0].elements.find((e) => e.id === "fm-rect"); r.fill = "#123456"; r.opacity = 0.4; });
    F.selectOnly("fm-rect");
    F.resetHistory();
  });
  await page.mouse.move(250, 260);
  await page.keyboard.press("f");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "menu (picker feedback)" });
  await page.keyboard.press("c");
  await waitFor(page, () => document.activeElement?.classList.contains("grid"), null, { label: "picker grid focused" });
  await page.keyboard.press("d");
  await waitFor(page, () => document.querySelector(".cs .hex")?.value === window.__flux.figures()[0].elements.find((e) => e.id === "fm-rect").fill, null, { label: "keyboard colour feedback" });
  ok(true, "keyboard palette navigation updates both the artwork and hex field");
  await page.click(".cs .hex");
  await page.keyboard.type("#12345");
  await page.keyboard.press("Enter");
  const invalidDraft = await page.evaluate(() => ({ open: !!document.querySelector(".cs"), value: document.querySelector(".cs .hex")?.value, invalid: document.querySelector(".cs .hex")?.getAttribute("aria-invalid") }));
  ok(invalidDraft.open && invalidDraft.value === "#12345" && invalidDraft.invalid === "true", "Enter keeps an incomplete hex draft open instead of applying its earlier valid prefix");
  await page.keyboard.press("Escape");
  await waitForGone(page, ".cs");
  m = await model();
  ok(m.rect.fill === "#123456" && m.h.past === 0, "cancel restores the original colour without an undo entry");

  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".cs .hex"), null, { label: "picker (achromatic hue)" });
  await page.click(".cs .hex");
  await page.keyboard.type("#000000");
  await page.evaluate(() => {
    const hue = document.querySelector(".cs .hue");
    hue.value = "180";
    hue.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitFor(page, () => document.querySelector(".cs .hex")?.value === "#000000", null, { label: "black preview" });
  ok(await page.$eval(".cs .hue", (el) => el.value === "180"), "a chosen hue survives at black instead of snapping back to red");
  const spectrum = await page.$eval(".cs .sv", (el) => { const r = el.getBoundingClientRect(); return { x: r.right - 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(spectrum.x, spectrum.y);
  await page.mouse.down();
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "fm-rect").fill !== "#000000", null, { label: "spectrum drag previews" });
  m = await model();
  ok(/^#0[0-9a-f][0-9a-f]{4}$/i.test(m.rect.fill) && parseInt(m.rect.fill.slice(3, 5), 16) > 80 && parseInt(m.rect.fill.slice(5, 7), 16) > 80, `the spectrum uses that chosen cyan hue (${m.rect.fill})`);
  await page.$eval(".cs .sv", (el) => el.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  await page.mouse.up();
  await waitForGone(page, ".cs");
  m = await model();
  ok(m.rect.fill === "#123456" && m.h.past === 0, "a cancelled spectrum gesture restores the baseline instead of committing");

  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".cs .grid"), null, { label: "picker (outside dismissal)" });
  const dismissSwatch = await page.$eval(".cs .sw:not(.none)", (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(dismissSwatch.x, dismissSwatch.y);
  await waitFor(page, () => window.__flux.figures()[0].elements.find((e) => e.id === "fm-rect").fill !== "#123456", null, { label: "uncommitted swatch preview" });
  await page.mouse.click(8, 120);
  await waitForGone(page, ".fluxFigMenu");
  m = await model();
  ok(m.rect.fill === "#123456" && m.h.past === 0, "clicking outside discards the unchosen preview and leaves history unchanged");

  // --- 5e. real range gestures commit but keep the picker available -------------------------
  await page.mouse.move(250, 260);
  await page.keyboard.press("f");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "menu (range gestures)" });
  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".cs .hue"), null, { label: "picker (range gestures)" });
  const huePoint = await page.$eval(".cs .hue", (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * 0.8, y: r.top + r.height / 2 }; });
  await page.mouse.click(huePoint.x, huePoint.y);
  await waitFor(page, () => window.__flux.fig.historyStats().past === 1, null, { label: "hue release commits" });
  m = await model();
  const chosenHue = m.rect.fill;
  ok(!!(await page.$(".cs .sv")) && chosenHue !== "#123456", "releasing the hue slider commits the colour and leaves the spectrum ready for saturation/brightness");
  const opacityPoint = await page.$eval(".cs .erow input", (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * 0.75, y: r.top + r.height / 2 }; });
  await page.mouse.click(opacityPoint.x, opacityPoint.y);
  await waitFor(page, () => window.__flux.fig.historyStats().past === 2, null, { label: "opacity release commits" });
  m = await model();
  const chosenOpacity = m.rect.opacity;
  ok(!!(await page.$(".cs")) && chosenOpacity > 0.6, `releasing the opacity slider commits its displayed value and keeps the picker open (${chosenOpacity})`);
  await page.keyboard.press("Escape");
  await waitForGone(page, ".cs");
  m = await model();
  ok(m.rect.fill === chosenHue && m.rect.opacity === chosenOpacity && m.h.past === 2, "Escape works from the focused range and preserves completed range edits");
  await waitFor(page, () => document.activeElement === document.querySelector(".fluxFigMenu"), null, { label: "menu focused after range Escape" });
  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".cs .grid"), null, { label: "picker after range edits" });
  const laterSwatch = await page.$eval(".cs .sw:not(.none)", (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(laterSwatch.x, laterSwatch.y);
  await waitFor(page, (hex) => window.__flux.figures()[0].elements.find((e) => e.id === "fm-rect").fill !== hex, chosenHue, { label: "a later unchosen preview" });
  await page.mouse.click(8, 120);
  await waitForGone(page, ".fluxFigMenu");
  m = await model();
  ok(m.rect.fill === chosenHue && m.rect.opacity === chosenOpacity && m.h.past === 2, "dismissing a later hover restores the explicitly chosen hue/opacity and preserves their two undo entries");

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

  // --- 7. gradient visibility, growth anchoring and viewport resize ------------------------
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      const e = p.figures[0].elements.find(e => e.id === "fm-rect");
      e.fill = "none"; e.stroke = "none";
      e.fillMap = { map: "review", axis: "x", stops: ["#123456", "#abcdef"] };
      e.strokeMap = { map: "review", axis: "y", stops: ["#123456", "#abcdef"] };
      e.width = 180; e.x = 60; e.y = 80;
    });
    F.selectOnly("fm-rect");
    F.resetHistory();
  });
  await waitFor(page, () => !!document.querySelector('.canvas-host .sel-box'), null, { label: "gradient rect selected" });
  // Locate the actual selection and move it to a spot with room for the initial
  // menu on its right, but only room for the larger palette on its left.
  await page.evaluate(() => {
    const r = document.querySelector('.canvas-host .sel-box').getBoundingClientRect();
    window.__flux.fig.viewport.update(v => ({ ...v, panX: v.panX + 760 - r.left, panY: v.panY + 200 - r.top }));
  });
  await page.mouse.move(800, 240);
  await page.keyboard.press("f");
  await waitFor(page, () => !!document.querySelector('.fluxFigMenu.placed'), null, { label: "gradient menu placed" });
  const toggles = await page.evaluate(() => ["2", "3"].map(key => document.querySelector(`.fluxFigMenu .field[data-key="${key}"] .toggle`)?.textContent));
  ok(toggles.every(v => v === "off"), "gradient paints count as visible even with a none fallback");
  await page.keyboard.press("2");
  m = await model();
  ok(m.rect.fill === "none" && m.rect.fillMap === undefined, "No fill removes the visible gradient paint");
  await page.evaluate(() => window.__flux.fig.undo());
  m = await model();
  ok(m.rect.fillMap?.map === "review" && m.h.past === 0, "one Undo restores the exact gradient fill");
  await page.keyboard.press("3");
  m = await model();
  ok(m.rect.stroke === "none" && m.rect.strokeMap === undefined, "No stroke removes the visible gradient stroke");
  await page.evaluate(() => window.__flux.fig.undo());
  m = await model();
  ok(m.rect.strokeMap?.map === "review" && m.h.past === 0, "one Undo restores the exact gradient stroke");
  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector('.fluxFigMenu .cs'), null, { label: "expanded palette placed" });
  // ResizeObserver placement happens before the following painted frame.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  mr = await menuRect();
  ok(mr?.inView && mr.overlaps === false, "expanding the colour picker stays on screen and avoids the selected object");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('.fluxFigMenu .cs'), null, { label: "palette dismissed" });
  await page.setViewport({ width: 900, height: 760 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  mr = await menuRect();
  ok(mr?.inView, "an open menu follows a resized viewport without clipping");
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
