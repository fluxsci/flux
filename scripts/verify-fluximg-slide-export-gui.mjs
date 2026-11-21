// verify-fluximg-slide-export-gui (ui tier; dev server up, FLUX_URL for a worktree): a deck with an image leaves the
// app through the REAL Export menu (SlideMode onExportPdf / onExportPptx: the window's image service draws the stills,
// not the Node renderer) — review S2 "not done": the GUI-path PDF and PPTX of a deck with images.
//   * a placed image, a step that changes its view, a step whose camera rests 2.5x on it; saved;
//   * Export → PDF per step: one page per step, each page the still of its state (three distinct stills; the zoomed
//     step's still drawn at the zoom's resolution, review B4), the vector layers as vectors, the success toast;
//   * Export → PowerPoint (animated) and (final state): a valid package with one picture per image state;
//   * a clean console.
//   Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-slide-export-gui.mjs
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { launch, gotoApp, clickMode, realErrors, APP_URL, sleep } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-slide-export-gui");
const dir = mkdtempSync(path.join(tmpdir(), "fx-slide-export-gui-"));
for (const f of fixtures()) if (f.name === "stack_u16") await writeFixture(dir, f);
function bundleFiles(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}
const stack = bundleFiles(path.join(dir, "stack_u16.fluximg"));

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
const fileText = (p) => page.evaluate((p) => { const v = window.fig._files.get(p); return v ? (v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v)) : null; }, p);
const fileBytes = (p) => page.evaluate((p) => { const v = window.fig._files.get(p); return v ? Array.from(v) : null; }, p);
const exportVia = async (item) => {
  await page.click(".export-btn");
  await waitFor(page, (s) => !!document.querySelector(`.export-menu [data-export="${s}"]`), item, { label: `the ${item} item` });
  await page.click(`.export-menu [data-export="${item}"]`);
  return waitFor(page, () => { const t = document.querySelector(".export-toast"); return t ? { ok: !t.classList.contains("err"), text: t.textContent.trim() } : null; }, null, { label: `${item} toast`, timeout: 60000 });
};
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const root = await page.evaluate(() => window.__flux.get(window.__flux.shell.projectModel).root);
  const deckId = await page.evaluate(() => window.__flux.slide.currentDeck().id);
  await page.evaluate((stack) => window.__fluxSeedFluximg("plots/cells.fluximg", stack), stack);

  h.section("a deck with an image, a view Change and a camera zoom on it");
  await page.mouse.click(900, 500);
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
  const tile = '[data-plots-gallery] [data-tile$="/cells.fluximg"]';
  await waitFor(page, (s) => !!document.querySelector(s), tile, { label: "the bundle's tile", timeout: 15000 });
  const at = await waitFor(page, (s) => { const r = document.querySelector(`${s} .page`)?.getBoundingClientRect(); return r && r.width > 4 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, tile, { label: "tile box" });
  await page.mouse.click(at.x, at.y, { count: 2 });
  const placed = await waitFor(page, () => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.figures().find((x) => x.id === sid).elements.find((e) => e.type === "fluximg") ?? null; }, null, { label: "an image on the slide", timeout: 15000 });
  // Shown small (16 x 12 canvas px for its 64 x 48 pixels): the 2x still (32 x 24) has pixels to spare for a zoom.
  await page.evaluate((id) => window.__flux.fig.mutate((p) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) { e.width = 16; e.height = 12; } }), placed.id);
  const sizeOf = await page.evaluate((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); const e = f.figures().find((x) => x.id === sid).elements.find((x) => x.id === id); return { x: e.x, y: e.y, width: e.width, height: e.height }; }, placed.id);
  // Two steps: the view Change (written through the editor's own "Edit after step 1"), then a camera that rests 2.5x
  // on the image's centre (a camera track, as the camera tool writes it).
  await page.evaluate(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { d.slides.find((x) => x.id === sid).beats.push({ id: "fxview", tracks: [] }); }); f.slide.activeBeat.set(1); f.slide.editAfterBeat(1); });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.editDestination).kind === "after", null, { label: "Edit after step 1" });
  await page.evaluate((id) => window.__flux.fig.mutate((p) => window.__flux.ops.setFluximgView(p, id, { index: { z: 1 } })), placed.id);
  await page.evaluate(({ box }) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { d.slides.find((x) => x.id === sid).beats.push({ id: "fxcam", tracks: [{ id: "fxcz", target: "@camera", preset: "camera", start: 0, duration: 600, easing: "linear", to: { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: 2.5 } }] }); }); f.slide.activeBeat.set(0); f.slide.setEditDestination({ kind: "design" }); }, { box: sizeOf });
  await page.evaluate(async () => { await window.__flux.lifecycle.flushById("slide"); });
  const saved = JSON.parse(await fileText(`${root}/slides/${deckId}/deck.json`));
  const savedSlide = saved.slides.find((s) => s.elements.some((e) => e.id === placed.id));
  h.ok(savedSlide?.beats.length === 3 && savedSlide.beats[1].tracks.some((t) => t.to?.state?.view?.index?.z === 1) && savedSlide.beats[2].tracks.some((t) => t.preset === "camera"), "saved: Design, a view Change, a camera zoom");
  await waitFor(page, () => !document.querySelector(".export-btn")?.disabled, null, { label: "export enabled" });

  h.section("Export → PDF (per step), through the window's image service");
  const pdf = await exportVia("pdf-steps");
  h.ok(pdf.ok, `the toast says it exported (${pdf.text})`);
  const html = await waitFor(page, async (p) => { const v = window.fig._files.get(p); return v ? new TextDecoder().decode(v) : null; }, `${root}/exports/${deckId}-steps.pdf`, { label: "the printed PDF", timeout: 30000 }).catch(() => null)
    ?? await fileText(`${root}/exports/${deckId}.pdf`);
  const pages = (html ?? "").split('<div class="page">').slice(1);
  h.eq(pages.length, 3, "one page per step (Design, the Change, the zoom)");
  const stillOf = (pg) => /href="(data:image\/png;base64,[^"]+)"/.exec(pg)?.[1] ?? null;
  const stills = pages.map(stillOf);
  h.ok(stills.every(Boolean), "every page carries its image's still");
  h.ok(new Set(stills).size === 3, "three different stills: the Design plane, the Change's plane, the zoomed still");
  const dims = (url) => { const b = Buffer.from(url.slice(url.indexOf(",") + 1), "base64"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  const [d1, d2] = [dims(stills[1]), dims(stills[2])];
  h.ok(d1.w === 32 && d2.w === 64 && d2.h === 48, `the zoomed step's still is drawn at the zoom, up to the crop's own 64 x 48 pixels (${d1.w}x${d1.h} → ${d2.w}x${d2.h})`);
  h.ok(pages.every((pg) => /data-fluximg|data-layer|<svg/.test(pg)), "each page is SVG with the image's markup");

  h.section("Export → PowerPoint (animated) and (final state)");
  for (const [item, file] of [["pptx", `${deckId}.pptx`], ["pptx-final", `${deckId}-final.pptx`]]) {
    await sleep(300);
    const t = await exportVia(item);
    h.ok(t.ok, `${item}: the toast says it exported (${t.text})`);
    const bytes = await waitFor(page, async (p) => { const v = window.fig._files.get(p); return v ? Array.from(v) : null; }, `${root}/exports/${file}`, { label: file, timeout: 30000 });
    const zip = unzipSync(new Uint8Array(bytes));
    const media = Object.keys(zip).filter((k) => /^ppt\/media\/image\d+\.png$/.test(k));
    const slides = Object.keys(zip).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    h.ok(!!zip["[Content_Types].xml"] && slides.length >= 1 && media.length >= 1, `${item}: a package with ${slides.length} slide page(s) and ${media.length} picture(s)`);
    if (item === "pptx") h.ok(slides.length === 3 && media.length >= 3, "animated: a page per build, a picture per image state");
    const pngDims = media.map((k) => ({ w: Buffer.from(zip[k]).readUInt32BE(16), h: Buffer.from(zip[k]).readUInt32BE(20) }));
    if (item === "pptx") h.ok(Math.max(...pngDims.map((d) => d.w)) > Math.min(...pngDims.map((d) => d.w)), `the zoomed page's picture is rasterised larger (${pngDims.map((d) => `${d.w}x${d.h}`).join(", ")})`);
    h.ok(slides.every((k) => !strFromU8(zip[k]).includes("undefined")), `${item}: no "undefined" in any page`);
  }

  h.section("console");
  h.eq(errs.length, 0, `clean console${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
await h.done();
