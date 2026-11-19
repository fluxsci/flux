// verify-fluximg-place-gui (ui tier; dev server up, FLUX_URL for a worktree): an image bundle under plots/ in the
// headless app, from the Plots rail to a placed element and back in step with its source.
//   * a seeded `*.fluximg` folder is ONE tile (nothing inside it is listed) with a picture (a worker still), the
//     image-stack mark, the dark media backdrop, and its Peek line ("2 channels · 7 z · 64 × 48 · uint16");
//   * a folder named .fluximg without a manifest is listed, and its tile says why it has no picture;
//   * double-click places it: the element's [data-fluximg] node gets an <image> still; the source is recorded;
//   * placing the same bundle again makes a second element on the SAME asset (one content id, one asset);
//   * a re-seeded, changed bundle hot-swaps every placed element (new asset, same view), and one Ctrl+Z restores;
//   * a clean console.
//   Run: FLUX_URL=http://127.0.0.1:<port>/ node --import tsx scripts/verify-fluximg-place-gui.mjs
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, openGalleryDialog, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-place-gui");
const dir = mkdtempSync(path.join(tmpdir(), "fx-place-gui-"));
for (const f of fixtures()) if (f.name === "stack_u16" || f.name === "gray2d_u8") await writeFixture(dir, f);
function bundleFiles(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}
const stack = bundleFiles(path.join(dir, "stack_u16.fluximg"));
const gray = bundleFiles(path.join(dir, "gray2d_u8.fluximg"));

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!document.querySelector("[data-left-rail]"), null, { label: "left rail" });
  const root = await page.evaluate(() => { const F = window.__flux; return F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir); });

  h.section("the bundle in the Plots rail");
  await page.evaluate(({ stack, gray }) => {
    window.__fluxSeedFluximg("plots/cells.fluximg", stack);
    window.__fluxSeedFluximg("plots/sub/plane.fluximg", gray);
    window.__fluxSeedFluximg("plots/sub/half.fluximg", { "pixels/zarr.json": btoa("{}") }); // an unfinished write
  }, { stack, gray });
  // Show the Plots view (Alt+G from the canvas), as a user would.
  await page.mouse.click(900, 500);
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots", null, { label: "Plots view" });
  const tileOf = (suffix) => `[data-plots-gallery] [data-tile$="${suffix}"]`;
  await waitFor(page, (s) => !!document.querySelector(s), tileOf("/cells.fluximg"), { label: "the bundle's tile", timeout: 10000 });
  const listed = await page.evaluate(() => [...document.querySelectorAll("[data-plots-gallery] [data-tile]")].map((n) => n.getAttribute("data-tile")));
  h.eq(listed.filter((p) => /\.fluximg$/.test(p)).length >= 2, true, `the bundles are tiles: ${listed.filter((p) => /\.fluximg/.test(p)).map((p) => p.split("/plots/")[1]).join(", ")}`);
  h.eq(listed.filter((p) => /\.fluximg\//.test(p)), [], "nothing inside a bundle is a tile of its own");
  const pic = await waitFor(page, (s) => { const img = document.querySelector(`${s} .page img`); return img && img.src && img.naturalWidth > 0 ? { src: img.src.slice(0, 22), w: img.naturalWidth, h: img.naturalHeight } : null; }, tileOf("/cells.fluximg"), { label: "the bundle's picture", timeout: 15000 });
  h.ok(/^data:image\/png|^blob:/.test(pic.src) && pic.w > 0, `the tile shows a picture (${pic.src}…, ${pic.w} x ${pic.h})`);
  const mark = await page.evaluate((s) => ({ glyph: document.querySelector(`${s} .chip.kind`)?.textContent ?? "", backdrop: document.querySelector(s)?.getAttribute("data-backdrop") }), tileOf("/cells.fluximg"));
  h.ok(mark.glyph.includes("▦") && mark.backdrop === "dark", `it is marked as an image stack (${mark.glyph}) on the dark media backdrop`);
  const line = await waitFor(page, async (abs) => { const m = await import("/src/lib/fluximg/railFacts.ts"); const F = window.__flux; return F.get(m.fluximgRailFacts).get(abs)?.line ?? null; }, `${root}/plots/cells.fluximg`, { label: "the manifest line" });
  h.eq(line, "2 channels · 7 z · 64 × 48 · uint16", "its line says what it is");
  const aria = await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-label") ?? "", tileOf("/cells.fluximg"));
  h.ok(aria.includes("2 channels · 7 z"), "…and the tile's label carries it");
  // The unfinished bundle is listed; its tile says why there is no picture.
  await page.evaluate(() => { const vp = document.querySelector("[data-plots-gallery] .viewport"); if (vp) vp.scrollTop = vp.scrollHeight; });
  const half = await waitFor(page, (s) => { const n = document.querySelector(`${s} .unavailable`); return n ? n.getAttribute("title") : null; }, tileOf("/half.fluximg"), { label: "the broken bundle's tile", timeout: 10000 });
  h.ok(/^No fluximg.json: an unfinished or damaged image bundle$/.test(half), `a folder named .fluximg without a manifest is listed and says why it has no picture: ${half}`);

  h.section("the bundle in the Plot gallery");
  await openGalleryDialog(page);
  const rows = await waitFor(page, () => {
    const all = [...document.querySelectorAll(".importer [data-path]")].map((n) => ({ path: n.getAttribute("data-path"), kind: n.getAttribute("data-kind") }));
    return all.some((r) => r.path?.endsWith("/cells.fluximg")) ? all : null;
  }, null, { label: "the gallery's bundle row", timeout: 10000 });
  h.ok(rows.find((r) => r.path.endsWith("/cells.fluximg"))?.kind === "file", "the gallery lists a bundle as one file, not a folder to enter");
  h.eq(rows.filter((r) => /\.fluximg\//.test(r.path)), [], "…and nothing inside it");
  await page.evaluate(() => window.__flux.fig.importerOpen.set(false));
  await waitFor(page, () => !document.querySelector(".importer"), null, { label: "gallery closed" });

  h.section("placing it");
  await page.evaluate(() => { const vp = document.querySelector("[data-plots-gallery] .viewport"); if (vp) vp.scrollTop = 0; });
  const at = await waitFor(page, (s) => { const r = document.querySelector(`${s} .page`)?.getBoundingClientRect(); return r && r.width > 4 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, tileOf("/cells.fluximg"), { label: "tile box" });
  await page.mouse.click(at.x, at.y, { count: 2 });
  const placed = await waitFor(page, () => {
    const els = window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg");
    return els.length === 1 ? els[0] : null;
  }, null, { label: "a placed fluximg element", timeout: 10000 });
  h.eq(placed.source?.bundlePath, "plots/cells.fluximg", "the element records its project-relative source");
  h.ok(typeof placed.source?.sha256 === "string" && placed.source.sha256.length === 64, "…and the content id it was imported at");
  await waitFor(page, (id) => !!document.querySelector(`[data-fluximg][data-editor-element-id="${id}"] image, [data-editor-element-id="${id}"] [data-fluximg] image`), placed.id, { label: "the element's still", timeout: 15000 });
  h.ok(true, "the placed element's [data-fluximg] node shows an <image> still");

  await page.mouse.click(at.x, at.y, { count: 2 });
  const two = await waitFor(page, () => {
    const els = window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg");
    return els.length === 2 ? els : null;
  }, null, { label: "a second element", timeout: 10000 });
  const assets = await page.evaluate(() => { const F = window.__flux; return F.get(F.fig.project).assets.filter((a) => a.kind === "fluximg").map((a) => a.id); });
  h.ok(two[0].assetId === two[1].assetId && assets.length === 1, "placing the same bundle twice makes one asset");
  const copies = await page.evaluate((r) => [...new Set([...window.fig._files.keys()].filter((k) => k.startsWith(`${r}/fig/assets/`) && k.includes(".fluximg/")).map((k) => k.slice(r.length + 12).split("/")[0]))], root);
  h.eq(copies.length, 1, "…and one asset folder (the second copy was discarded)");

  h.section("update from source");
  const before = two[0].assetId;
  const changed = { ...stack, "fluximg.json": Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(stack["fluximg.json"], "base64").toString()), name: "cells, rerun" })).toString("base64") };
  await page.evaluate((files) => window.__fluxSeedFluximg("plots/cells.fluximg", files), changed);
  const swapped = await waitFor(page, (b) => {
    const els = window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg");
    return els.length === 2 && els.every((e) => e.assetId !== b) ? els : null;
  }, before, { label: "the hot swap", timeout: 10000 });
  h.ok(swapped[0].assetId === swapped[1].assetId && swapped[0].source.sha256 !== two[0].source.sha256, "a changed bundle moves every placed element to the new content");
  await waitFor(page, (id) => !!document.querySelector(`[data-editor-element-id="${id}"] image`), swapped[0].id, { label: "the swapped still", timeout: 15000 });
  h.ok(true, "…and the element shows a still of it");
  // One undo (the editor's own key) restores both.
  await page.mouse.click(1200, 820);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Control");
  const undone = await waitFor(page, (b) => {
    const els = window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg");
    return els.length === 2 && els.every((e) => e.assetId === b) ? els : null;
  }, before, { label: "undo", timeout: 5000 }).catch(() => null);
  h.ok(!!undone, "one Ctrl+Z restores the placed images to the previous content");
  h.eq(errs.length, 0, `clean console${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
} catch (error) {
  h.fail(`unexpected: ${error?.stack ?? error}`);
}
await h.done(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
