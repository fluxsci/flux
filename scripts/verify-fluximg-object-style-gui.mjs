// fluximg objects styled by a column, on the real canvas (UI tier, private dev server or FLUX_URL): the fixture
// `mean_f64_layers` has a label layer whose table has `source_id` (key), `dendrite` (categorical, one null) and
// `pixels` (numeric). On the live board: the layer row's "colour by" / "opacity by" keys, the column keys with their
// pictures, the PREVIEW on the image while the pointer rests on a key (nothing written), one undo step per choice,
// each outline's computed stroke its category's colour (the null one dimmed), opacity by pixels, the range handles
// (drag, wheel), the colour maps, the key on the picture (on/off, Shift to its next corner, dragged to a corner, a
// hovered row lights its objects), the card beside the pointer leading with the styling columns, the chooser's keys;
// at rest the element's markup equals the live overlay's; the Inspector writes the same view as the board; an in-app
// export carries the same attributes; nothing animates at rest; no console errors. Screenshots go to
// test-results/scratch/shots/ (for a person to judge the look).
//
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-object-style-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, waitForFrame, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFixture, fixtures } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-object-style-gui");
const scratch = mkdtempSync(path.join(tmpdir(), "fx-objstyle-gui-"));
const SHOTS = "test-results/scratch/shots";
mkdirSync(SHOTS, { recursive: true });
await writeFixture(scratch, fixtures().find((f) => f.name === "mean_f64_layers"));
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}
const PALETTE = ["#4385be", "#da702c"], DIM = "#878580";
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

const W = 1500, H = 950;
const { browser, page } = await launch({ width: W, height: H });
const base = new URL(APP_URL);
base.search = "?fixture=demo";
await gotoApp(page, { url: base.href, settle: 1500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!window.__flux?.fluximg && !!document.querySelector(".canvas-host"), null, { label: "Figure mode with the dev handle" });
await page.evaluate(() => {
  const F = window.__flux;
  F.fig.commit((p) => { const f = p.figures[0]; f.x = 0; f.y = 0; f.width = 1400; f.height = 1100; f.elements = []; F.fig.activeFigureId.set(f.id); });
  F.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 });
});

const ID = await page.evaluate(async ({ files }) => {
  const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir);
  window.__fluxSeedFluximg("plots/mean_f64_layers.fluximg", files);
  const place = F.fluximg.place;
  const assetId = place.fluximgAssetId("mean_f64_layers", Math.random().toString(36).slice(2));
  const result = await window.fig.importFluximg({ root, sourcePath: "plots/mean_f64_layers.fluximg", assetId });
  const asset = place.fluximgAsset(assetId, result, "plots/mean_f64_layers.fluximg");
  const figureId = F.get(F.fig.activeFigureId);
  let id;
  F.fig.commit((p) => { id = F.ops.addFluximg(p, { figureId, asset, x: 300, y: 60, width: 450 }); });
  return id;
}, { files: bundleFiles("mean_f64_layers") });
await waitFor(page, (id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); const n = el && document.querySelector(`svg[data-fluximg="${el.assetId}"]`); return !!n?.querySelector("image"); }, ID, { label: "the still", timeout: 15000 });
await page.evaluate(() => window.__flux.fig.resetHistory());

// --- helpers --------------------------------------------------------------------------------------------------
const model = () => page.evaluate((id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); return { view: structuredClone(el?.view ?? {}), past: F.fig.historyStats().past }; }, ID);
const styleBy = async () => (await model()).view.layers?.footprints?.styleBy ?? null;
const rect = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const isOpen = () => page.evaluate(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const settled = () => waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgLiveBusy), null, { label: "the gesture settled", timeout: 3000 });
const LIVE = (key) => `[data-fluximg-live] [id$="-footprints/${key}"]`;
/** Each outline's COMPUTED stroke and opacity in the live overlay (what Chromium paints). */
const outlines = (where = "[data-fluximg-live]") => page.evaluate((where) => Object.fromEntries([...document.querySelectorAll(`${where} [data-layer="footprints"] [data-key]`)].map((e) => { const s = getComputedStyle(e); return [e.getAttribute("data-key"), { stroke: s.stroke, opacity: s.opacity, fill: s.fill }]; })), where);
async function openLive() {
  if (await isOpen()) return;
  await page.evaluate((id) => { document.activeElement?.blur?.(); window.__flux.fig.selectOnly(id); }, ID);
  const r = await page.evaluate((id) => { const F = window.__flux; const el = F.figures().flatMap((f) => f.elements).find((e) => e.id === id); const n = document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getBoundingClientRect(); return n ? { x: n.left + n.width / 2, y: n.top + n.height / 2 } : null; }, ID);
  if (r) await page.mouse.move(r.x, r.y);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fxb-layers]"), null, { label: "the board" });
}
async function closeLive() {
  if (await isOpen()) await page.evaluate(() => window.__flux.fluximg.live.closeFluximgLive());
  await waitFor(page, () => !document.querySelector("[data-fluximg-live]"), null, { label: "closed" });
}
/** Hover the footprints row (its keys show), then press one of them. */
async function rowKey(id) {
  const row = await rect("[data-fxb-layers] .row[data-rid='layer:footprints']");
  await page.mouse.move(row.x + 20, row.cy);
  await waitFor(page, (id) => { const e = document.querySelector(`[data-fxb-key='${id}']`); return !!e && e.getBoundingClientRect().width > 0; }, id, { label: `the row's ${id} key` });
  const k = await rect(`[data-fxb-key='${id}']`);
  await page.mouse.move(k.cx, k.cy);
  await page.mouse.click(k.cx, k.cy);
  await waitForFrame(page);
}
const colKey = (part, col) => `[data-fxb-style='${part}:footprints'] [data-fxb-style-col='${col}']`;

try {
  await openLive();
  h.section("A. the row's keys open the columns, with pictures");
  {
    await rowKey("style-color:footprints");
    await waitFor(page, () => !!document.querySelector("[data-fxb-style='color:footprints']"), null, { label: "the colour-by drawer" });
    await waitFor(page, () => document.querySelectorAll("[data-fxb-style='color:footprints'] [data-fxb-style-col]").length >= 3, null, { label: "its columns (the table arrived)", timeout: 5000 });
    const keys = await page.$$eval("[data-fxb-style='color:footprints'] [data-fxb-style-col]", (n) => n.map((e) => e.getAttribute("data-fxb-style-col")));
    h.eq(keys, ["", "dendrite", "pixels"], "colour by: \"none\", then the table's columns (not its key, not the label numbers)");
    const pics = await page.$$eval("[data-fxb-style='color:footprints'] [data-fxb-style-col] .pic", (n) => n.map((e) => getComputedStyle(e).backgroundImage));
    h.ok(/linear-gradient/.test(pics[1]) && pics[1].includes("rgb(67, 133, 190)") && /linear-gradient/.test(pics[2]) && pics[1] !== pics[2], "each key carries a picture of what it does: the categories' first colours, the numbers' colour map");
    h.ok(await page.evaluate(() => !document.querySelector("[data-fxb] select, [data-fxb] option")), "no native select on the board");
  }

  h.section("B. a key previews before it acts; pressing it is one undo step");
  {
    const m0 = await model();
    const k = await rect(colKey("color", "dendrite"));
    await page.mouse.move(k.cx, k.cy);
    await waitFor(page, (sel) => document.querySelector(sel)?.getAttribute("stroke") === "#4385be", LIVE("s1"), { label: "the preview on the image", timeout: 3000 });
    const pre = await outlines();
    h.ok(pre.s1.stroke === rgb(PALETTE[0]) && pre.s3.stroke === rgb(PALETTE[1]), `resting on "dendrite" shows its colours on the image (${pre.s1.stroke}, ${pre.s3.stroke})`);
    const m1 = await model();
    h.ok(m1.past === m0.past && !m1.view.layers?.footprints?.styleBy, "…and writes nothing");
    await page.screenshot({ path: `${SHOTS}/1-preview-dendrite.png` });
    await page.mouse.move(k.cx, k.cy + 120);
    await waitFor(page, (sel) => !document.querySelector(sel)?.getAttribute("stroke"), LIVE("s1"), { label: "the preview gone", timeout: 3000 });
    h.ok(true, "leaving the key puts the image back");
    await page.mouse.move(k.cx, k.cy);
    await page.mouse.click(k.cx, k.cy);
    await waitFor(page, () => !!window.__flux.figures().flatMap((f) => f.elements).find((e) => e.type === "fluximg")?.view?.layers?.footprints?.styleBy, null, { label: "written" });
    const m2 = await model();
    h.eq(m2.view.layers.footprints.styleBy, { color: { column: "dendrite" } }, "pressing it writes styleBy.color");
    h.eq(m2.past - m0.past, 1, "…as ONE undo step");
    await page.mouse.move(10, 900); // off the board: what stays is the view, not the preview
    await waitForFrame(page); await waitForFrame(page);
    const o = await outlines();
    h.ok(o.s1.stroke === rgb(PALETTE[0]) && o.s2.stroke === rgb(PALETTE[0]) && o.s3.stroke === rgb(PALETTE[1]), `each outline's computed stroke is its category's colour (s1, s2: d1 ${o.s1.stroke}; s3: d2 ${o.s3.stroke})`);
    h.ok(o.s7.stroke === rgb(DIM) && Math.abs(Number(o.s7.opacity) - 0.35) < 1e-6, `the one without a dendrite is dimmed (${o.s7.stroke}, opacity ${o.s7.opacity})`);
    h.ok(!!(await page.$("[data-fxb-layers] [data-fxb-style-chip='footprints']")), "the layer's row shows a chip of its colours at rest");
    const cats = await page.$$eval("[data-fxb-style='color:footprints'] [data-fxb-style-cat]", (n) => n.map((e) => e.getAttribute("data-fxb-style-cat")));
    h.eq(cats, ["d1", "d2"], "the drawer lists the categories with their colours");
  }

  h.section("C. hovering a category, and the card beside the pointer");
  {
    const c = await rect("[data-fxb-style='color:footprints'] [data-fxb-style-cat='d1']");
    await page.mouse.move(c.cx, c.cy);
    await waitFor(page, () => document.querySelectorAll("[data-fluximg-live] .fx-hot").length === 2, null, { label: "d1's objects lit", timeout: 3000 });
    h.eq(await page.$$eval("[data-fluximg-live] .fx-hot", (n) => n.map((e) => e.getAttribute("data-key")).sort()), ["s1", "s2"], "resting on a category lights its objects on the image");
    await page.mouse.move(10, 900);
    await waitFor(page, () => !document.querySelector("[data-fluximg-live] .fx-hot"), null, { label: "unlit" });
    const s1 = await rect(LIVE("s1"));
    await page.mouse.move(s1.x + 1.5, s1.cy); await page.mouse.move(s1.x + 2, s1.cy);
    await waitFor(page, () => !!document.querySelector("[data-fxb-card]"), null, { label: "the object card", timeout: 3000 });
    const card = await page.evaluate(() => [...document.querySelectorAll("[data-fxb-card] .cell")].map((e) => ({ name: e.querySelector("i")?.textContent, styled: e.classList.contains("styled") })));
    h.ok(card[0]?.name === "dendrite" && card[0].styled, `the card beside the pointer leads with the styling column (${card.map((x) => x.name).join(", ")})`);
    h.eq(await page.evaluate(() => { const e = document.querySelector("[data-fxb-card] .cell.styled .sw"); return e ? getComputedStyle(e).backgroundColor : null; }), rgb(PALETTE[0]), "…with the object's own colour beside its value");
    await page.screenshot({ path: `${SHOTS}/2-styled-card.png` });
    await page.mouse.move(10, 900);
  }

  h.section("D. opacity by a column; its range handles and the wheel");
  {
    const m0 = await model();
    await rowKey("style-opacity:footprints");
    await waitFor(page, () => !!document.querySelector("[data-fxb-style='opacity:footprints']"), null, { label: "the opacity drawer" });
    const keys = await page.$$eval("[data-fxb-style='opacity:footprints'] [data-fxb-style-col]", (n) => n.map((e) => e.getAttribute("data-fxb-style-col")));
    h.eq(keys, ["", "pixels"], "opacity offers only columns of numbers");
    const k = await rect(colKey("opacity", "pixels"));
    await page.mouse.move(k.cx, k.cy); await page.mouse.click(k.cx, k.cy);
    await waitFor(page, () => !!document.querySelector("[data-fxb-style='opacity:footprints'] [data-fxb-style-knob='hi']"), null, { label: "the range strip" });
    const m1 = await model();
    h.ok(m1.past - m0.past === 1 && m1.view.layers.footprints.styleBy.opacity?.column === "pixels" && m1.view.layers.footprints.styleBy.color?.column === "dendrite", "opacity by pixels: one undo step, the colour kept");
    const o = await outlines();
    h.ok(Math.abs(Number(o.s7.opacity) - 0.35) < 1e-6 && Math.abs(Number(o.s2.opacity) - 1) < 1e-6 && Math.abs(Number(o.s1.opacity) - 0.6222) < 1e-3, `each object's opacity follows its pixels (s2 ${o.s2.opacity}, s1 ${o.s1.opacity}; s7 without a dendrite stays dimmed)`);
    // Drag the high handle to the middle: the window narrows, one undo step.
    const hi = await rect("[data-fxb-style='opacity:footprints'] [data-fxb-style-knob='hi']"), lo = await rect("[data-fxb-style='opacity:footprints'] [data-fxb-style-knob='lo']");
    const m2 = await model();
    await page.mouse.move(hi.cx, hi.cy - 8); await page.mouse.down();
    await page.mouse.move((hi.cx + lo.cx) / 2, hi.cy - 8, { steps: 6 }); await page.mouse.up();
    await waitForFrame(page);
    const r = (await styleBy()).opacity.range;
    const m3 = await model();
    h.ok(Array.isArray(r) && r[0] === 5 && r[1] < 32 && r[1] > 5, `dragging the high handle narrows the window (${JSON.stringify(r)})`);
    h.eq(m3.past - m2.past, 1, "…as one undo step");
    h.ok(Math.abs(Number((await outlines()).s2.opacity) - 1) < 1e-6 && Number((await outlines()).s1.opacity) > 0.62, "…and the objects follow (s1 brighter, s2 still opaque)");
    // The wheel over the strip moves the nearer handle.
    const strip = await rect("[data-fxb-style='opacity:footprints'] [data-fxb-stylewell]");
    await page.mouse.move(strip.x + 3, strip.cy);
    await page.mouse.wheel({ deltaY: -100 }); await sleep(60); await page.mouse.wheel({ deltaY: -100 });
    await settled();
    const r2 = (await styleBy()).opacity.range, m4 = await model();
    h.ok(r2[0] > 5 && r2[1] === r[1], `the wheel near the low end moves the low handle (${JSON.stringify(r2)})`);
    h.eq(m4.past - m3.past, 1, "…as one undo step once the wheel rests");
    await page.screenshot({ path: `${SHOTS}/3-opacity-range.png` });
  }

  h.section("E. numbers through a colour map, and the chooser's keys");
  {
    await rowKey("style-color:footprints");
    await waitFor(page, () => !!document.querySelector("[data-fxb-style='color:footprints']"), null, { label: "colour drawer" });
    const m0 = await model();
    await press("Digit2"); // "pixels": 0 = none, 1 = dendrite, 2 = pixels
    await waitFor(page, () => !!document.querySelector("[data-fxb-style='color:footprints'] [data-fxb-style-map]"), null, { label: "the colour maps" });
    const sb = await styleBy();
    h.ok(sb.color.column === "pixels" && (await model()).past - m0.past === 1, "a digit picks a column (2: pixels), one undo step");
    const o = await outlines();
    h.ok(o.s1.stroke !== o.s2.stroke && o.s2.stroke !== rgb(PALETTE[0]), `numbers go through viridis (s2 ${o.s2.stroke}, s7 ${o.s7.stroke})`);
    const mg = await rect("[data-fxb-style='color:footprints'] [data-fxb-style-map='magma']");
    await page.mouse.click(mg.cx, mg.cy); await waitForFrame(page);
    h.eq((await styleBy()).color.lut, "magma", "a map swatch sets the colour map");
    const o2 = await outlines();
    h.ok(o2.s2.stroke !== o.s2.stroke, `…and the outlines take its colours (${o2.s2.stroke})`);
    await press("ArrowRight"); // walk to "none" (index 0), previewed
    await waitFor(page, (sel) => !document.querySelector(sel)?.getAttribute("stroke"), LIVE("s1"), { label: "the walked key previewed", timeout: 3000 });
    h.ok(!!(await styleBy()).color, "arrows walk the keys and preview each (none: the outlines lose their colours), nothing written");
    await press("Digit1");
    h.eq((await styleBy()).color, { column: "dendrite" }, "1: dendrite again, starting afresh (no map from the numbers)");
    await press("Escape");
    h.ok(!(await page.$("[data-fxb-style]")) && (await isOpen()), "Esc closes the drawer, the view stays open");
  }

  h.section("F. the key on the picture");
  {
    const m0 = await model();
    await page.click("[data-fxb-layers] [data-fxb-key='key']");
    await waitFor(page, () => !!document.querySelector("[data-fluximg-live] [data-part='key']"), null, { label: "the key drawn" });
    h.ok((await model()).past - m0.past === 1 && (await model()).view.furniture?.key && Object.keys((await model()).view.furniture.key).length === 0, "the key's paper key switches it on ({}: defaults), one undo step");
    h.eq(await page.$$eval("[data-fluximg-live] [data-part='key.entry']", (n) => n.map((e) => e.textContent)), ["d1", "d2", "no value"], "it lists the categories and \"no value\"");
    await waitFor(page, () => !!document.querySelector("[data-fxb-grip='key']"), null, { label: "the key's grip" });
    const img = await rect("[data-fluximg-live]"), k0 = await rect("[data-fluximg-live] [data-part='key']");
    h.ok(k0.cx > img.cx && k0.cy < img.cy, "top right by default");
    await page.keyboard.down("Shift"); await page.click("[data-fxb-layers] [data-fxb-key='key']"); await page.keyboard.up("Shift");
    await waitForFrame(page);
    h.eq((await model()).view.furniture.key.corner, "bottom-right", "Shift + its key: the next corner (clockwise, as for every annotation)");
    // Hovering a row of the key lights its objects.
    await sleep(60); await waitForFrame(page);
    const row = await rect("[data-fluximg-live] [data-part='key.entry'][data-legend-row='0']");
    await page.mouse.move(row.cx - 2, row.cy); await page.mouse.move(row.cx, row.cy);
    await waitFor(page, () => document.querySelectorAll("[data-fluximg-live] .fx-hot").length === 2, null, { label: "d1 lit from the key", timeout: 3000 });
    h.eq(await page.$$eval("[data-fluximg-live] .fx-hot", (n) => n.map((e) => e.getAttribute("data-key")).sort()), ["s1", "s2"], "resting on a row of the key lights that category's objects");
    await page.screenshot({ path: `${SHOTS}/4-key-hover.png` });
    // Drag it to the bottom-right corner.
    const grip = await rect("[data-fxb-grip='key']"), m1 = await model();
    await page.mouse.move(grip.cx, grip.cy); await page.mouse.down();
    await page.mouse.move(img.x + img.w * 0.15, img.y + img.h * 0.85, { steps: 6 }); await page.mouse.up();
    await waitForFrame(page);
    const m2 = await model();
    h.ok(m2.view.furniture.key.corner === "bottom-left" && m2.past - m1.past === 1, `dragged to a corner on the picture, it stays there: one undo step (${m2.view.furniture.key.corner}, ${m2.past - m1.past})`);
  }

  h.section("G. at rest the element shows what the live view showed");
  {
    await waitForFrame(page); await sleep(150);
    const live = await page.evaluate(() => document.querySelector("[data-fluximg-live] [data-layer='footprints']")?.outerHTML.replace(/(id="|url\(#)fxl-[^"]*?-/g, '$1P-') ?? "");
    const liveKey = await page.evaluate(() => document.querySelector("[data-fluximg-live] [data-part='key']")?.outerHTML.replace(/(id="|url\(#)fxl-[^"]*?-/g, '$1P-') ?? "");
    await page.mouse.move(10, 900);
    await closeLive();
    await waitFor(page, () => !!document.querySelector("svg[data-fluximg] [data-layer='footprints']"), null, { label: "at rest" });
    const rest = await page.evaluate(() => document.querySelector("svg[data-fluximg] [data-layer='footprints']")?.outerHTML.replace(/(id="|url\(#)fx-[^"]*?-/g, '$1P-') ?? "");
    const restKey = await page.evaluate(() => document.querySelector("svg[data-fluximg] [data-part='key']")?.outerHTML.replace(/(id="|url\(#)fx-[^"]*?-/g, '$1P-') ?? "");
    h.ok(live.length > 100 && live.replace(/ class="[^"]*"/g, "") === rest.replace(/ class="[^"]*"/g, ""), "the styled outlines at rest are the live overlay's, attribute for attribute");
    if (liveKey !== restKey) { let i = 0; while (i < liveKey.length && liveKey[i] === restKey[i]) i++; console.log(`  differ at ${i}: live …${liveKey.slice(i - 80, i + 120)}\n  rest …${restKey.slice(i - 80, i + 120)}`); }
    h.ok(liveKey.length > 100 && liveKey === restKey, "…and so is the key");
    const o = await outlines("svg[data-fluximg]");
    h.ok(o.s1.stroke === rgb(PALETTE[0]) && o.s7.stroke === rgb(DIM), "at rest each outline is painted in its category's colour");
    await page.screenshot({ path: `${SHOTS}/5-at-rest.png` });
  }

  h.section("H. in-app export carries the same attributes");
  {
    const exp = await page.evaluate(async (id) => {
      const F = window.__flux;
      const ew = await import("/src/lib/fluximg/exportWindow.ts"), es = await import("/src/lib/fluximg/exportStatic.ts");
      const fig = F.figures()[0], el = fig.elements.find((e) => e.id === id);
      const ctx = await ew.prepareWindowFluximg([fig], F.get(F.fig.project).assets, "svg");
      return es.fluximgElementMarkup(el, ctx);
    }, ID);
    h.ok(new RegExp(`data-key="s1"[^>]*stroke="${PALETTE[0]}"`).test(exp) && new RegExp(`data-key="s7"[^>]*stroke="${DIM}"[^>]*opacity="0.35"`).test(exp) && /data-part="key"/.test(exp), "the in-app export's markup: per-object stroke and opacity attributes, and the key");
    const rest = await page.evaluate(() => document.querySelector("svg[data-fluximg] [data-layer='footprints']")?.outerHTML ?? "");
    const pathsOf = (s) => [...s.matchAll(/<path [^>]*data-key="([^"]+)"[^>]*?(stroke="[^"]*")?[^>]*?(opacity="[^"]*")?\/?>/g)].map((m) => m[0].replace(/ id="[^"]*"/, "").replace(/ class="[^"]*"/, "").replace(/\/?>$/, ">"));
    h.eq(pathsOf(exp.slice(exp.indexOf('data-layer="footprints"'))).slice(0, 4), pathsOf(rest).slice(0, 4), "…shape for shape the element at rest");
  }

  h.section("I. the Inspector writes the same view");
  {
    await page.evaluate((id) => { const F = window.__flux; F.fig.commit((p) => { const el = p.figures[0].elements.find((e) => e.id === id); el.view = {}; }); F.fig.selectOnly(id); }, ID);
    await waitFor(page, () => !!document.querySelector(".inspector [data-fluximg-style='footprints'] [data-fluximg-style-color]"), null, { label: "the Inspector's style fields", timeout: 10000 });
    await waitFor(page, () => document.querySelectorAll(".inspector [data-fluximg-style-color] option").length >= 3, null, { label: "the columns", timeout: 5000 });
    const m0 = await model();
    await page.select(".inspector [data-fluximg-style-color]", "dendrite");
    await waitForFrame(page);
    const m1 = await model();
    h.eq(m1.view.layers?.footprints?.styleBy, { color: { column: "dendrite" } }, "colour by dendrite from the Inspector: the same styleBy the board writes");
    h.eq(m1.past - m0.past, 1, "…one undo step");
    await page.select(".inspector [data-fluximg-style-opacity]", "pixels");
    await waitFor(page, () => !!document.querySelector(".inspector [data-fluximg-style-opacity-range]"), null, { label: "the opacity range fields" });
    h.eq((await model()).view.layers.footprints.styleBy, { color: { column: "dendrite" }, opacity: { column: "pixels" } }, "opacity by pixels joins it");
    await page.click(".inspector [data-fluximg-style-missing]"); await waitForFrame(page);
    h.eq((await model()).view.layers.footprints.styleBy.missing, "hide", "\"hide objects without a value\" writes missing: hide");
    await page.click(".inspector [data-fluximg-style-missing]"); await waitForFrame(page);
    h.ok(!("missing" in (await model()).view.layers.footprints.styleBy), "…and unticked, the default is written as nothing");
    await page.select(".inspector [data-fluximg-style-color]", "");
    await page.select(".inspector [data-fluximg-style-opacity]", "");
    await waitForFrame(page);
    h.ok(!(await model()).view.layers, "back to none: the view is empty again");
    await page.click(".inspector [data-fluximg-key]"); await waitForFrame(page);
    h.eq((await model()).view.furniture?.key, {}, "the Inspector's Key checkbox: on with defaults");
    await page.click(".inspector [data-fluximg-key]"); await waitForFrame(page);
  }

  h.section("J. chrome rules and undo");
  {
    await page.evaluate((id) => window.__flux.fig.selectOnly(id), ID);
    await openLive();
    await rowKey("style-color:footprints");
    await waitFor(page, () => !!document.querySelector("[data-fxb-style='color:footprints']"), null, { label: "drawer" });
    await page.mouse.move(10, 900);
    await sleep(250);
    h.eq(await page.evaluate(() => document.getAnimations().filter((a) => !a.effect?.target?.closest?.(".toasts")).length), 0, "nothing animates at rest with the drawer open (200 ms after the last change)");
    h.ok(await page.evaluate(() => [...document.querySelectorAll("[data-fxb-style] *")].every((e) => { const s = getComputedStyle(e); return (s.filter === "none" || !s.filter) && (s.backdropFilter === "none" || !s.backdropFilter); }) && !document.querySelector("[data-fxb-style] [title]")), "no filter, no browser tooltips in the drawer");
    const k = await rect(colKey("color", "dendrite"));
    await page.mouse.click(k.cx, k.cy); await waitForFrame(page);
    const before = await model();
    await page.mouse.move(10, 900);
    await press("z", ["Control"]);
    const after = await model();
    h.ok(!after.view.layers?.footprints?.styleBy && after.past === before.past - 1, "Ctrl+Z takes the choice back in one step");
    await page.screenshot({ path: `${SHOTS}/6-board-drawer.png` });
    await closeLive();
  }

  h.section("K. console");
  h.eq(realErrors(page).filter((e) => !/Couldn't save|save figures/i.test(e)), [], "no console errors");
} catch (error) {
  h.fail(`the gate stopped: ${error instanceof Error ? error.stack : String(error)}`);
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
}

await h.done(async () => { await browser.close(); rmSync(scratch, { recursive: true, force: true }); });
