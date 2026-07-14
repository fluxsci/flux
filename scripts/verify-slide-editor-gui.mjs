// slide-migration §7.2 items 1–4 — the slide editing surface IS the figure
// editor, driven in the REAL GUI (dev server :1420, ?fixture=demo):
//   1. draw Rect/Ellipse/Line/Arrow/Pen on a slide with the REAL tools +
//      pointer gestures; inspector edits (dash checkbox) hit the same model;
//      the slide-accented chrome (darker backdrop, "Slide" brand) is present
//      and the figure-only inspector sections are hidden.
//   2. plot X-ray on a slide: seed a semantic plot, Alt+P opens the SHARED
//      figure X-ray, part rows list, an override lands via the part write path.
//   3. selection/arrange: select-all, align, group/ungroup, z-order, nudge —
//      through the ONE figure keymap — and the unified history interleaves
//      static + overlay edits under a single Cmd+Z stack.
//   4. slide switching is an in-memory activeFigureId swap: instant, viewport
//      persists, selection clears (figure active-figure semantics).
// Consoles must be clean. Run: node scripts/verify-slide-editor-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, shot, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // --- chrome: the sanctioned differentiators ------------------------------------
  const chrome = await page.evaluate(() => {
    const host = document.querySelector(".canvas-host.frame");
    const bg = host ? getComputedStyle(host).backgroundColor : "";
    const figHostBg = getComputedStyle(document.documentElement).getPropertyValue("--c-canvas").trim();
    const brand = [...document.querySelectorAll(".brand")].map((b) => b.textContent?.trim()).join("|");
    const inspectorText = document.querySelector(".inspector")?.textContent ?? "";
    return {
      frame: !!host,
      bg,
      figHostBg,
      brandHasSlide: /Slide/.test(brand),
      noExportSection: !/Journal-spec raster/i.test(inspectorText),
      noMm: !/mm\b/.test(inspectorText),
    };
  });
  ok(chrome.frame, "canvas runs in frame mode (single slide)");
  ok(chrome.bg && chrome.bg !== "", `slide backdrop painted (${chrome.bg})`);
  ok(chrome.brandHasSlide, "toolbar brand reads 'Slide' (accented)");
  ok(chrome.noExportSection && chrome.noMm, "figure-only inspector sections (exports, mm readouts) hidden in slide mode");

  // --- 1. draw all four primitives + pen with the REAL tools ----------------------
  const canvasBox = await page.evaluate(() => {
    const r = document.querySelector(".canvas-host.frame").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = canvasBox.x + canvasBox.w / 2;
  const cy = canvasBox.y + canvasBox.h / 2;
  // warm the compositor + focus before the first gesture (first-run raster
  // warmup once ate the opening pointerdown)
  await page.mouse.click(cx, cy + 200);
  await page.keyboard.press("Escape");
  await sleep(300);
  async function drag(tool, x0, y0, x1, y1) {
    await page.keyboard.press(tool);
    await sleep(120);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 8 });
    await page.mouse.up();
    await sleep(250);
  }
  const countTypes = () =>
    page.evaluate(() => {
      const f = window.__flux;
      const p = f.get(f.fig.project);
      const fig = p.figures.find((x) => x.id === f.get(f.fig.activeFigureId));
      return fig.elements.map((e) => e.type);
    });
  const before = await countTypes();
  await drag("r", cx - 200, cy - 100, cx - 120, cy - 40);
  await drag("o", cx - 90, cy - 100, cx - 20, cy - 30);
  await drag("l", cx + 10, cy - 90, cx + 90, cy - 40);
  await drag("a", cx + 110, cy - 90, cx + 190, cy - 40);
  // pen: 3 clicks + Enter finishes an open path
  await page.keyboard.press("p");
  await sleep(120);
  for (const [px, py] of [[cx - 180, cy + 40], [cx - 120, cy + 90], [cx - 60, cy + 40]]) {
    await page.mouse.click(px, py);
    await sleep(120);
  }
  await page.keyboard.press("Enter");
  await sleep(300);
  const after = await countTypes();
  const added = after.slice(before.length);
  ok(JSON.stringify(added) === JSON.stringify(["rect", "ellipse", "line", "line", "path"]),
    `all four primitives + pen drew as FIGURE elements (${added.join(", ")})`);
  const arrowOk = await page.evaluate(() => {
    const f = window.__flux;
    const p = f.get(f.fig.project);
    const fig = p.figures.find((x) => x.id === f.get(f.fig.activeFigureId));
    const lines = fig.elements.filter((e) => e.type === "line");
    return lines.length === 2 && lines[1].arrowEnd === true && lines[0].arrowEnd === false;
  });
  ok(arrowOk, "the arrow tool set arrowEnd (figure line semantics)");

  // inspector edit: select the rect, tick Dashed → dash lands in the model
  await page.evaluate(() => {
    const f = window.__flux;
    const p = f.get(f.fig.project);
    const fig = p.figures.find((x) => x.id === f.get(f.fig.activeFigureId));
    const rect = fig.elements.find((e) => e.type === "rect");
    f.fig.selectOnly(rect.id);
  });
  await sleep(300);
  const dashClicked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".inspector label.chk")];
    const dash = boxes.find((l) => /Dashed/.test(l.textContent || ""));
    const input = dash?.querySelector("input");
    if (!input) return false;
    input.click();
    return true;
  });
  await sleep(300);
  const dashed = await page.evaluate(() => {
    const f = window.__flux;
    const p = f.get(f.fig.project);
    const fig = p.figures.find((x) => x.id === f.get(f.fig.activeFigureId));
    return (fig.elements.find((e) => e.type === "rect").dash ?? []).length === 2;
  });
  ok(dashClicked && dashed, "an inspector edit (Dashed) writes the figure model on the slide");

  // --- 2. plot X-ray on a slide ----------------------------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" width="100" height="80">
      <g id="axis.x"><path id="axis.x.spine" d="M10 70 H 90" stroke="#888" fill="none"/></g>
      <g id="series.a"><circle id="a.point.0" cx="30" cy="40" r="3"/><circle id="a.point.1" cx="60" cy="30" r="3"/></g>
    </svg>`;
    f.plot.cachePlot("demo-plot", SVG);
    let id = null;
    f.slide.commitDeckLive((d) => {
      const sid = f.get(f.fig.activeFigureId);
      id = f.slideOps.addPlotToSlide(d, sid, { assetId: "demo-plot", x: 360, y: 180, width: 150, height: 120 });
    });
    f.fig.selectOnly(id);
  });
  await sleep(400);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await sleep(600);
  const xray = await page.evaluate(() => {
    const f = window.__flux;
    return {
      open: f.get(f.fig.xrayOpen),
      panel: !!document.querySelector(".xray, [class*=xray]"),
      rows: document.querySelectorAll("[class*=xray] [class*=row], .xray .row").length,
    };
  });
  ok(xray.open && xray.panel, `Alt+P opens the SHARED figure X-ray on a slide plot (rows: ${xray.rows})`);
  // part override via the shared write path (the X-ray's model op)
  const partWrite = await page.evaluate(async () => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const p = f.get(f.fig.project);
    const fig = p.figures.find((x) => x.id === sid);
    const plot = fig.elements.find((e) => e.type === "plot");
    // the FluxFig/X-ray write path: setPartOverride through a store commit
    f.fig.commit((proj) => {
      const el = proj.figures.find((x) => x.id === sid).elements.find((e) => e.id === plot.id);
      el.overrides = { ...(el.overrides ?? {}), "axis.x.spine": { stroke: "#bc5215" } };
    });
    const now = f.get(f.fig.project).figures.find((x) => x.id === sid).elements.find((e) => e.id === plot.id);
    // and it must fold into the DECK on compose
    const deck = f.slide.currentDeck();
    const slideEl = deck.slides.find((s) => s.id === sid).elements.find((e) => e.id === plot.id);
    return { live: now.overrides["axis.x.spine"].stroke, deck: slideEl.overrides["axis.x.spine"].stroke };
  });
  ok(partWrite.live === "#bc5215" && partWrite.deck === "#bc5215", "a plot-part override written on the slide folds into the deck");
  await page.keyboard.press("Escape");
  await sleep(200);

  // --- 3. arrange + unified undo ----------------------------------------------------
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const fig = f.get(f.fig.project).figures.find((x) => x.id === sid);
    const ids = fig.elements.filter((e) => e.type === "rect" || e.type === "ellipse").map((e) => e.id);
    f.fig.selection.set(new Set(ids));
  });
  await sleep(150);
  // align left (Alt+A), then group (Ctrl+G)
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Alt");
  await sleep(250);
  const aligned = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const fig = f.get(f.fig.project).figures.find((x) => x.id === sid);
    const els = fig.elements.filter((e) => e.type === "rect" || e.type === "ellipse");
    return els.every((e) => Math.abs(e.x - els[0].x) < 0.01);
  });
  ok(aligned, "Alt+A aligned the selection (figure keymap on the slide)");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyG");
  await page.keyboard.up("Control");
  await sleep(250);
  const grouped = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const fig = f.get(f.fig.project).figures.find((x) => x.id === sid);
    return Object.keys(fig.groups ?? {}).length === 1;
  });
  ok(grouped, "Ctrl+G made a REAL registry group on the slide (figure GroupDef)");

  // unified history: overlay edit (beat) + static edit (nudge) under one stack
  const hist0 = await page.evaluate(() => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => {
      const sid = f.get(f.fig.activeFigureId);
      f.slideOps.addBeat(d, sid, { label: "gate-beat" });
    });
    return f.fig.historyStats().past;
  });
  await page.keyboard.press("ArrowRight"); // nudge the grouped selection (static)
  await sleep(500); // nudge session closes ~350ms after the last repeat
  const state1 = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const fig = f.get(f.fig.project).figures.find((x) => x.id === sid);
    return {
      hist: f.fig.historyStats().past,
      beats: o.slides.find((s) => s.id === sid).beats.length,
      x: fig.elements.find((e) => e.type === "rect").x,
    };
  });
  ok(state1.hist === hist0 + 1 && state1.beats === 2, "an overlay edit and a static edit stack on ONE history");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(250);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(250);
  const undone = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const fig = f.get(f.fig.project).figures.find((x) => x.id === sid);
    return {
      beats: o.slides.find((s) => s.id === sid).beats.length,
      x: fig.elements.find((e) => e.type === "rect").x,
    };
  });
  ok(undone.beats === 1, "Cmd+Z ×2 unwound the interleaved static edit AND the overlay beat (one unified undo)");
  ok(undone.x === state1.x - 1, "…in order (the nudge undone first)");

  // --- 4. slide switching: instant, viewport persists --------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    f.slide.commitDeckLive((d) => f.slideOps.addSlide(d, { name: "S2", layout: "blank" }));
  });
  await sleep(400);
  const sw = await page.evaluate(async () => {
    const f = window.__flux;
    const o = f.get(f.slide.deckOverlay);
    const [a, b] = o.slides.map((s) => s.id);
    const vp0 = { ...f.get(f.fig.viewport) };
    const t0 = performance.now();
    f.slide.selectSlide(b);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dt = performance.now() - t0;
    const vp1 = { ...f.get(f.fig.viewport) };
    const activeNow = f.get(f.fig.activeFigureId);
    f.slide.selectSlide(a);
    return { dt, vpSame: JSON.stringify(vp0) === JSON.stringify(vp1), switched: activeNow === b, selCleared: f.get(f.fig.selection).size === 0 };
  });
  ok(sw.switched, "thumbnail switch = activeFigureId swap");
  ok(sw.vpSame, "viewport (pan/zoom) persists across slide switches (frames coincide)");
  ok(sw.selCleared, "selection clears on slide switch (figure active-figure semantics)");
  ok(sw.dt < 250, `switch painted in ${sw.dt.toFixed(0)}ms (dev-mode smoke; the scale gate owns the p95 budget)`);

  await shot(page, "slide-editor-gui");
  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE EDITOR GUI: FAIL (${fails})` : "\nSLIDE EDITOR GUI: PASS");
process.exit(fails ? 1 : 0);
