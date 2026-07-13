// Primitive-completeness gate (GUI) — drives the REAL app for the slice the
// pure gate can't see: Inspector dash controls render as stroke-dasharray in
// the live SVG; open-path arrowheads appear as head polygons; hovering a path
// TRACES it (box for boxy elements); the widened path hit-stroke selects a few
// px off the curve; ctrl+drag BENDS a segment in node-edit (one undo); and the
// design-preset round trip: save (dev-handle) → Ctrl+P picker (real key) →
// thumbnail card → click inserts a styled clone.
//   Run (dev server on :1420): node scripts/verify-primitives-gui.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready",
  });

  // Blank figure + fixed viewport so screen math is exact (figenh-01 pattern).
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 800; g.height = 500; g.elements = [];
    });
    F.viewport.set({ panX: 80, panY: 120, zoom: 1 });
    F.selection.set(new Set());
    localStorage.removeItem("flux.presets.designs");
  });
  await waitFor(page, () => {
    const F = window.__flux;
    const g = document.querySelector(".scene-svg > g");
    const scene = document.querySelector(".scene");
    if (!F?.fig || !g || !scene) return false;
    const zoom = F.get(F.fig.viewport).zoom;
    const gs = /scale\(([-\d.e]+)/.exec(g.getAttribute("transform") || "");
    const m = /matrix\(([-\d.e]+)/.exec(getComputedStyle(scene).transform);
    return (gs ? Number(gs[1]) : 1) === zoom && Math.abs((m ? Number(m[1]) : 1) - 1) < 1e-9;
  }, null, { label: "viewport folded (pointer math exact)" });

  const ids = await page.evaluate(() => {
    const F = window.__flux.fig;
    const out = {};
    F.commit((p) => {
      const g = p.figures[0];
      out.rect = F.newId("rect");
      g.elements.push({ type: "rect", id: out.rect, x: 40, y: 40, width: 120, height: 90, rotation: 0, fill: "#d62728", stroke: "#222222", strokeWidth: 3, cornerRadius: 0 });
      out.path = F.newId("path");
      g.elements.push({ type: "path", id: out.path, x: 240, y: 60, width: 160, height: 90, rotation: 0, d: "M 0 90 C 40 0 120 0 160 90", fill: "none", stroke: "#222222", strokeWidth: 4, closed: false });
      out.bendy = F.newId("path");
      g.elements.push({ type: "path", id: out.bendy, x: 240, y: 250, width: 160, height: 1, rotation: 0, d: "M 0 0 L 160 0", fill: "none", stroke: "#222222", strokeWidth: 3, closed: false });
    });
    return out;
  });
  const el = (id) =>
    page.evaluate((id) => {
      const X = window.__flux;
      for (const f of X.get(X.fig.project).figures) for (const e of f.elements) if (e.id === id) return JSON.parse(JSON.stringify(e));
      return null;
    }, id);
  const select = (...list) => page.evaluate((l) => window.__flux.fig.selection.set(new Set(l)), list);
  // figure-local → client coords (fig at 0,0; pan 80,120; zoom 1)
  const pt = (lx, ly) =>
    page.evaluate(([lx, ly]) => {
      const host = document.querySelector(".canvas-host").getBoundingClientRect();
      const vp = window.__flux.get(window.__flux.fig.viewport);
      return { x: host.left + vp.panX + lx * vp.zoom, y: host.top + vp.panY + ly * vp.zoom };
    }, [lx, ly]);

  // --- A. dash via the Inspector --------------------------------------------
  await select(ids.rect);
  await waitFor(page, () => [...document.querySelectorAll("label.chk")].some((l) => /Dashed/.test(l.textContent)), null, { label: "Dashed checkbox present" });
  await page.evaluate(() => { [...document.querySelectorAll("label.chk")].find((l) => /Dashed/.test(l.textContent)).querySelector("input").click(); });
  let r = await el(ids.rect);
  ok(r.dash?.join() === "6,4", `Dashed checkbox writes dash [6,4] (got ${JSON.stringify(r.dash)})`);
  const domDash = await page.evaluate(() => !!document.querySelector('.scene-svg rect[stroke-dasharray="6 4"]'));
  ok(domDash, "canvas renders stroke-dasharray");
  await page.evaluate(() => { [...document.querySelectorAll("label.chk")].find((l) => /Dashed/.test(l.textContent)).querySelector("input").click(); });
  r = await el(ids.rect);
  ok(!r.dash, "unchecking returns to solid (dash removed)");

  // --- B. open-path arrowheads via the Inspector ----------------------------
  await select(ids.path);
  await waitFor(page, () => [...document.querySelectorAll("label.chk")].some((l) => /Arrow end/.test(l.textContent)), null, { label: "path Arrow-end checkbox present (open path)" });
  const polysBefore = await page.evaluate(() => document.querySelectorAll(".scene-svg polygon").length);
  await page.evaluate(() => { [...document.querySelectorAll("label.chk")].find((l) => /Arrow end/.test(l.textContent)).querySelector("input").click(); });
  const p = await el(ids.path);
  ok(p.arrowEnd === true, "Arrow end applies to the path model");
  const polysAfter = await page.evaluate(() => document.querySelectorAll(".scene-svg polygon").length);
  ok(polysAfter === polysBefore + 1, `arrowhead polygon rendered (${polysBefore}→${polysAfter})`);

  // --- C. hover: trace for paths, box for rects ------------------------------
  await select();
  await page.evaluate((id) => window.__flux.fig.hoverId.set(id), ids.path);
  await waitForFrame(page);
  ok(await page.evaluate(() => !!document.querySelector(".hover-trace") && !document.querySelector(".hover-box")), "hovered path → geometry TRACE (no bbox)");
  await page.evaluate((id) => window.__flux.fig.hoverId.set(id), ids.rect);
  await waitForFrame(page);
  ok(await page.evaluate(() => !!document.querySelector(".hover-box") && !document.querySelector(".hover-trace")), "hovered rect → box preview");
  await page.evaluate(() => window.__flux.fig.hoverId.set(null));

  // --- D. forgiving path hit: click ~5px off the straight path selects it ----
  const off = await pt(240 + 80, 250 + 5); // 5px below the bendy path's midline
  await page.mouse.click(off.x, off.y);
  await waitFor(page, (want) => window.__flux.get(window.__flux.fig.selection).has(want), ids.bendy, { label: "near-miss click selected the path (wide hit stroke)" });
  ok(true, "click 5px off the stroke selects the path");

  // --- E. ctrl+drag bend in node-edit ----------------------------------------
  await page.evaluate((id) => window.__flux.fig.selectOnly(id), ids.bendy);
  await page.keyboard.press("Enter");
  await waitFor(page, (want) => window.__flux.get(window.__flux.fig.nodeEditId) === want, ids.bendy, { label: "node-edit entered" });
  await waitFor(page, () => document.querySelectorAll(".seg-hit").length >= 1, null, { label: "segment hit targets mounted" });
  const segMid = await pt(240 + 80, 250);
  await page.keyboard.down("Control");
  await page.mouse.move(segMid.x, segMid.y);
  await page.mouse.down();
  await page.mouse.move(segMid.x, segMid.y + 46, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  let b = await el(ids.bendy);
  ok(/C /.test(b.d), `ctrl-drag bent the segment (d: ${b.d.slice(0, 40)}…)`);
  ok(Array.isArray(b.nodes) && !!b.nodes[0].hOut && !!b.nodes[1].hIn, "both end nodes gained handles");
  await page.keyboard.press("Escape"); // leave node-edit
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await waitFor(page, (want) => {
    const X = window.__flux;
    for (const f of X.get(X.fig.project).figures) for (const e of f.elements) if (e.id === want) return !/C /.test(e.d);
    return false;
  }, ids.bendy, { label: "single undo restored the straight segment" });
  ok(true, "bend is one undo entry");

  // --- F. presets: save → Ctrl+P grid → insert -------------------------------
  const rel = await page.evaluate(async (id) => {
    const X = window.__flux;
    let target = null;
    for (const f of X.get(X.fig.project).figures) for (const e of f.elements) if (e.id === id) target = e;
    return await X.presets.saveDesignPreset("gate/curve", target);
  }, ids.path);
  ok(rel === "gate/curve.json", `saveDesignPreset wrote ${rel}`);
  const countBefore = await page.evaluate(() => window.__flux.figures().flatMap((f) => f.elements).length);
  await page.keyboard.down("Control");
  await page.keyboard.press("p");
  await page.keyboard.up("Control");
  await waitFor(page, () => !!document.querySelector(".pp .card img"), null, { label: "Ctrl+P opened the preset grid with a thumbnail" });
  const thumbOk = await page.evaluate(() => (document.querySelector(".pp .card img")?.getAttribute("src") || "").startsWith("data:image/svg+xml"));
  ok(thumbOk, "card thumbnail is a rendered SVG data URL");
  await page.click(".pp .card");
  await waitFor(page, (n) => window.__flux.figures().flatMap((f) => f.elements).length === n + 1, countBefore, { label: "insert added one element" });
  const inserted = await page.evaluate(() => {
    const X = window.__flux;
    const sel = [...X.get(X.fig.selection)][0];
    for (const f of X.get(X.fig.project).figures) for (const e of f.elements) if (e.id === sel) return JSON.parse(JSON.stringify(e));
    return null;
  });
  ok(inserted && inserted.type === "path" && inserted.arrowEnd === true && inserted.id !== ids.path, "inserted clone keeps its styling, fresh id, selected");
  await waitFor(page, () => !document.querySelector(".pp"), null, { label: "picker closed after insert (out-transition done)" });
  ok(true, "picker closed after insert");

  const errs = realErrors(page);
  ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 220)}` : "zero console errors");
} finally {
  await browser.close();
}
console.log(fails ? `\nPRIMITIVES GUI VERIFY: FAIL — ${fails}` : "\nPRIMITIVES GUI VERIFY: PASS");
process.exit(fails ? 1 : 0);
