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
    // A folder that holds only image stacks must never read as empty (owner's first view of a real project).
    window.__fluxSeedFluximg("plots/stacks/a.fluximg", stack);
    window.__fluxSeedFluximg("plots/stacks/b.fluximg", gray);
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

  // The rail's folder navigator: a bundle is never a folder; a folder of bundles counts them.
  await page.click("[data-directory-toggle]");
  await waitFor(page, () => !!document.querySelector("[data-plots-directories] .tree [role=\"treeitem\"]"), null, { label: "folder navigator" });
  const dirRows = await waitFor(page, () => {
    const rows = [...document.querySelectorAll("[data-plots-directories] .row")].map((el) => ({ name: el.querySelector(".name")?.textContent ?? "", count: el.querySelector(".count")?.textContent ?? "" }));
    return rows.some((r) => r.name === "stacks" && r.count === "2") ? rows : null;
  }, null, { label: "the stacks folder row with its count" }).catch(() => null);
  h.ok(!!dirRows, `the rail's folder navigator counts a folder of image stacks: ${JSON.stringify(dirRows?.find((r) => r.name === "stacks"))}`);
  h.ok(!!dirRows && !dirRows.some((r) => /\.fluximg$|^pixels$|^layers$/.test(r.name)), "…and lists no bundle (or anything inside one) as a folder");
  await page.click("[data-directory-toggle]");
  // The rail's own folder section for it: its header counts the stacks, its tiles have pictures.
  const railSection = await waitFor(page, async () => {
    const vp = document.querySelector("[data-plots-gallery] .viewport");
    for (let y = 0; vp && y <= vp.scrollHeight; y += 200) {
      vp.scrollTop = y;
      await new Promise((r) => setTimeout(r, 30));
      const head = document.querySelector("[data-plots-gallery] [data-section=\"dir:stacks\"]");
      if (head) return head.textContent?.replace(/\s+/g, " ").trim() ?? "";
    }
    return null;
  }, null, { label: "the rail's stacks section" }).catch(() => "");
  h.ok(/stacks.*· 2/.test(railSection), `the rail's section for a folder of stacks counts them: "${railSection}"`);
  const railPics = await waitFor(page, () => { const n = [...document.querySelectorAll("[data-plots-gallery] [data-tile*=\"/stacks/\"] .page img")].filter((i) => i.naturalWidth > 0).length; return n >= 2 ? n : null; }, null, { label: "the stacks' tiles", timeout: 10000 }).catch(() => 0);
  h.eq(railPics, 2, "…and both its tiles have pictures");
  await page.evaluate(() => { const vp = document.querySelector("[data-plots-gallery] .viewport"); if (vp) vp.scrollTop = 0; });

  h.section("the bundle in the Plot gallery");
  await openGalleryDialog(page);
  // The Folders view: the bundle-only folder shows a count and a mosaic picture; the header names image stacks.
  const folderTile = await waitFor(page, () => {
    const b = [...document.querySelectorAll(".importer button.row[data-kind=\"dir\"]")].find((n) => n.querySelector(".nm")?.textContent?.trim() === "stacks");
    if (!b) return null;
    const imgs = [...b.querySelectorAll(".mosaic-cell img")].filter((i) => i.naturalWidth > 0);
    const count = b.querySelector(".fcount")?.textContent?.trim() ?? "";
    return imgs.length && count ? { count, pictures: imgs.length } : null;
  }, null, { label: "the stacks folder tile's mosaic and count", timeout: 15000 }).catch(() => null);
  h.ok(!!folderTile && folderTile.count === "2", `a folder holding only image stacks shows its count (${folderTile?.count})`);
  h.ok(!!folderTile && folderTile.pictures >= 1, `…and a mosaic picture (${folderTile?.pictures} of its stacks drawn)`);
  const header = await waitFor(page, () => { const t = document.querySelector(".importer [data-gallery-count]")?.textContent ?? ""; return /image/.test(t) ? t : null; }, null, { label: "the header count", timeout: 10000 }).catch(() => "");
  h.ok(/^(\d+ plots? · )?[1-9]\d* images?$/.test(header), `the header counts the image stacks under the folder: "${header}"`);
  // Search reaches bundles in folders; the List view lists them with their kind.
  await page.type(".importer input.search-in", "stacks/");
  const hits = await waitFor(page, () => { const p = [...document.querySelectorAll(".importer [data-path]")].map((n) => n.getAttribute("data-path")); return p.some((x) => x.endsWith("/stacks/a.fluximg")) && p.some((x) => x.endsWith("/stacks/b.fluximg")) ? p : null; }, null, { label: "search hits", timeout: 8000 }).catch(() => null);
  h.ok(!!hits, "searching reaches the image stacks inside a folder");
  await page.click(".importer button[aria-label=\"List view\"]");
  const listRow = await waitFor(page, () => { const r = [...document.querySelectorAll(".importer button.row")].find((n) => n.getAttribute("data-path")?.endsWith("/stacks/a.fluximg")); return r ? (r.querySelector(".ic")?.textContent?.trim() ?? "") : null; }, null, { label: "a list row", timeout: 8000 }).catch(() => null);
  h.eq(listRow, "▦", "the List view lists the stacks, marked as image stacks");
  await page.click(".importer button[aria-label=\"Gallery view\"]");
  await page.click(".importer input.search-in", { count: 3 }); await page.keyboard.press("Backspace");
  await page.evaluate(() => window.__flux.fig.importerOpen.set(false));
  await waitFor(page, () => !document.querySelector(".importer"), null, { label: "gallery closed" });
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
