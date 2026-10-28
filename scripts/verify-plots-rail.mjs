// The Plots rail (browser, demo fixture): the Figure editor's left rail in its Plots view — a
// justified-row gallery over a live Dissections pane. The fixture bridge renders thumbnails in
// the page with the same ink analysis the desktop worker runs, so the client path is the real
// one; the worker itself is gated by verify-plot-thumbs.ts (pure) and the Electron gate.
//   * switching: the tabs, Alt+G's three states (also from inside the search box), Ctrl+B from
//     the search, the canvas holding still across the width change; in Slide, Alt+G is Slide's
//     own [Slides | Plots] rail and Shift+Alt+G the full gallery (verify-plots-rail-slide.mjs);
//   * the gallery: folder sections, collapse, search, "_" collections, Recent sort, the backdrop
//     law on real matplotlib fixtures (and on the fallback path), the ⧉ chip, the in-use mark,
//     the linked ring;
//   * keyboard ownership: tool letters type into search, Ctrl+Z undoes a rail insert;
//   * placing: double-click, Enter, drag onto a (non-active) figure at the pointer at true size;
//   * dissections: follow a gallery click and a canvas click (incl. re-clicking the selected
//     plot), sticky, pin, summary-first table cards (one wide row transposed), the "Show all"
//     cap, aligned flipping, a placed dissection file focusing its owner, live re-lists;
//   * the split: drag, snap-collapse, reset; Quick Look; the global library; clean console.
//   Run (dev server up; FLUX_URL for a worktree): node scripts/verify-plots-rail.mjs
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-plots-rail");
const ROOT = "/demo/myc-growth-paper";
const P = `${ROOT}/plots`;
const FIX = path.join(import.meta.dirname, "fixtures", "plots-rail");
const fixtures = Object.fromEntries(readdirSync(FIX).filter((f) => f.endsWith(".svg")).map((f) => [f, readFileSync(path.join(FIX, f), "utf8")]));

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!document.querySelector("[data-left-rail]"), null, { label: "left rail" });

const alt = async (code, shift = false) => { await page.keyboard.down("Alt"); if (shift) await page.keyboard.down("Shift"); await page.keyboard.press(code); if (shift) await page.keyboard.up("Shift"); await page.keyboard.up("Alt"); };
const ctrl = async (code) => { await page.keyboard.down("Control"); await page.keyboard.press(code); await page.keyboard.up("Control"); };
const view = () => page.evaluate(() => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") ?? "hidden");
const railW = () => page.evaluate(() => Math.round(document.querySelector("[data-left-rail]")?.getBoundingClientRect().width ?? 0));
const activeIsSearch = () => page.evaluate(() => document.activeElement?.hasAttribute("data-plots-search") ?? false);
const elementCount = () => page.evaluate(() => window.__flux.figures().reduce((n, f) => n + f.elements.length, 0));
const tileSel = (suffix) => `[data-plots-gallery] [data-tile$="${suffix}"]`;
const tilePoint = (suffix, fx = 0.5, fy = 0.5, pane = "[data-plots-gallery]") => page.evaluate(async (suffix, fx, fy, pane) => {
  const vp = document.querySelector(`${pane} .viewport`);
  if (!document.querySelector(`${pane} [data-tile$="${suffix}"]`)) vp.scrollTop = 0;
  await new Promise((res) => setTimeout(res, 40));
  for (let i = 0; i < 80; i++) {
    const n = document.querySelector(`${pane} [data-tile$="${suffix}"]`);
    const r = n?.querySelector(".page").getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    if (r && r.top >= v.top - 1 && r.bottom <= v.bottom + 1) return { x: r.left + r.width * fx, y: r.top + r.height * fy, w: r.width, h: r.height };
    if (r) vp.scrollTop += r.top < v.top ? r.top - v.top - 40 : r.bottom - v.bottom + 10; else vp.scrollTop += 120;
    await new Promise((res) => setTimeout(res, 40));
  }
  return null;
}, suffix, fx, fy, pane);
/** Scroll a pane until a section header is rendered (headers are windowed like tiles). */
const findSection = (key, pane = "[data-plots-gallery]") => page.evaluate(async (key, pane) => {
  const vp = document.querySelector(`${pane} .viewport`);
  vp.scrollTop = 0;
  for (let i = 0; i < 120; i++) {
    const n = document.querySelector(`${pane} .spacer [data-section="${key}"]`);
    if (n) { vp.scrollTop = Math.max(0, n.offsetTop - 30); await new Promise((r) => setTimeout(r, 60)); return true; }
    vp.scrollTop += 150;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}, key, pane);
const focusKey = () => page.evaluate(() => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") ?? "");
const write = (files) => page.evaluate(async (files) => { for (const [p, text] of Object.entries(files)) await window.fig.writeText(p, text); }, files);
const svg = (fill, w = 72, hgt = 48) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${hgt}pt" viewBox="0 0 ${w} ${hgt}"><rect width="${w}" height="${hgt}" fill="${fill}"/></svg>`;

// ---- seed -------------------------------------------------------------------------------
{
  const files = {};
  for (const [name, text] of Object.entries(fixtures)) files[`${P}/fixtures/${name}`] = text;
  for (const k of ["alpha", "beta"]) {
    files[`${P}/${k}.svg`] = svg(k === "alpha" ? "#d95f02" : "#66800b", 96, 48);
    const D = `${P}/_dissections/${k}`;
    for (let i = 1; i <= 9; i++) files[`${D}/by_subject/s0${i}.svg`] = svg(i % 2 ? "#e7298a" : "#205ea6");
    files[`${D}/overview.svg`] = svg("#7570b3");
    files[`${D}/_stats/anova.csv`] = "term,estimate,p\nintake,0.42,0.003\nexercise,-0.11,0.2\n";
  }
  files[`${P}/_dissections/alpha/_stats/test.csv`] = "test,statistic,df,p,effect,ci_low,ci_high\nwelch,3.21,14.2,0.006,0.81,0.2,1.4\n";
  for (let i = 1; i <= 70; i++) files[`${P}/_dissections/beta/sweep/t${String(i).padStart(2, "0")}.svg`] = svg("#24837b", 40, 40);
  for (let i = 1; i <= 6; i++) files[`${P}/panels/deep/more/fig${i}_a.svg`] = svg("#4385be");
  await write(files);
}

h.section("switching views");
{
  h.eq(await view(), "layers", "the rail starts in Layers");
  const figBefore = await page.evaluate(() => document.querySelector(".canvas-wrap .figure-bg")?.getBoundingClientRect().left ?? null);
  await page.click('[data-rail-tab="plots"]');
  await waitFor(page, () => !!document.querySelector("[data-plots-gallery] [data-tile]"), null, { label: "gallery tiles", timeout: 8000 });
  h.eq(await view(), "plots", "the Plots tab switches the rail");
  h.eq(await railW(), 320, "the Plots view has its own width (320)");
  const figAfter = await page.evaluate(() => document.querySelector(".canvas-wrap .figure-bg")?.getBoundingClientRect().left ?? null);
  h.ok(figBefore == null || Math.abs(figAfter - figBefore) < 1.5, `the canvas holds still across the width change (Δ ${figBefore == null ? "n/a" : (figAfter - figBefore).toFixed(1)} px)`);
  await page.click('[data-rail-tab="layers"]');
  h.eq(await railW(), 200, "Layers keeps its own width (200)");
  // Alt+G from the canvas: Layers → Plots with the search focused.
  await page.mouse.click(900, 600);
  await alt("KeyG");
  await waitFor(page, () => document.activeElement?.hasAttribute("data-plots-search"), null, { label: "search focus" });
  h.ok((await view()) === "plots" && (await activeIsSearch()), "Alt+G shows Plots and focuses its search");
  await alt("KeyG");
  h.eq(await view(), "layers", "Alt+G from inside the rail goes back to Layers");
  await alt("KeyG");
  await page.mouse.click(900, 600); // keyboard to the canvas, Plots still showing
  await alt("KeyG");
  h.eq(await view(), "layers", "Alt+G with Plots showing returns to Layers even when the keyboard moved to the canvas");
  await alt("KeyG");
  h.ok((await view()) === "plots" && (await activeIsSearch()), "Alt+G returns to Plots and focuses search");
  await ctrl("KeyB");
  h.eq(await view(), "hidden", "Ctrl+B from the rail's search hides the rail");
  await page.mouse.click(900, 600);
  await alt("KeyG");
  await waitFor(page, () => document.activeElement?.hasAttribute("data-plots-search"), null, { label: "search focus after hidden" });
  h.eq(await view(), "plots", "Alt+G on a hidden rail opens it in Plots");
}

h.section("the gallery");
{
  h.ok(await findSection("dir:") && await findSection("dir:fixtures"), "folders are section headers");
  h.ok(await findSection("dir:panels/deep/more"), "a deep folder has its own section");
  h.ok(!(await page.$('[data-plots-gallery] [data-tile*="/panels/deep/more/"]')), "…collapsed by default (depth ≥ 2)");
  h.ok(!(await page.$('[data-plots-gallery] [data-tile*="/_dissections/"]')), "reserved collections are not plots");
  await page.click('[data-plots-gallery] .spacer [data-section="dir:panels/deep/more"] .chev');
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile*="/panels/deep/more/"]'), null, { label: "expanded deep folder" });
  h.ok(true, "a header's chevron expands its folder");
  // The backdrop law on real matplotlib output.
  await waitFor(page, () => [...document.querySelectorAll('[data-plots-gallery] [data-tile*="/fixtures/"]')].filter((n) => n.querySelector("img")).length >= 6, null, { label: "fixture thumbnails", timeout: 15000 });
  const backdrops = await page.evaluate(async () => {
    const vp = document.querySelector("[data-plots-gallery] .viewport");
    const out = {};
    for (let i = 0; i < 40 && Object.keys(out).length < 11; i++) {
      for (const n of document.querySelectorAll('[data-plots-gallery] [data-tile*="/fixtures/"]')) if (n.querySelector("img")) out[n.getAttribute("data-tile").split("/").pop()] = n.getAttribute("data-backdrop");
      vp.scrollTop += 80;
      await new Promise((r) => setTimeout(r, 80));
    }
    vp.scrollTop = 0;
    return out;
  });
  for (const [f, want] of Object.entries({ "dark.svg": "dark", "white_text_only.svg": "dark", "mixed.svg": "mid", "white_points.svg": "mid", "light.svg": "paper", "halo_markers.svg": "paper", "opaque.svg": "own" }))
    h.eq(backdrops[f], want, `backdrop: ${f} → ${want}`);
  // Search, "_" collections.
  await page.focus("[data-plots-search]");
  await page.keyboard.type("halo");
  await waitFor(page, () => document.querySelectorAll("[data-plots-gallery] [data-tile]").length === 1, null, { label: "search result" });
  h.ok(true, "search filters as you type");
  await page.keyboard.press("Escape");
  await page.keyboard.type("_");
  await waitFor(page, () => !!document.querySelector('[data-reserved="_dissections"]'), null, { label: "reserved row" });
  h.ok(true, "typing _ offers the companion collections");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile*="/_dissections/alpha/"]'), null, { label: "inside collection" });
  h.ok(true, "Enter enters a collection; its files are listed");
  await page.focus("[data-plots-search]");
  await page.keyboard.press("Backspace");
  await waitFor(page, () => !document.querySelector(".chip-collection") && !!document.querySelector(`[data-plots-gallery] [data-tile$="/alpha.svg"]`), null, { label: "left collection" });
  h.ok(true, "Backspace in an empty search leaves the collection");
  // ⧉ chip.
  await tilePoint("/alpha.svg");
  const chip = await waitFor(page, () => document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"] [data-dissections-chip]')?.textContent?.trim(), null, { label: "dissections chip" }).catch(() => undefined);
  h.ok(/⧉\s*1[0-9]/.test(chip ?? ""), `a plot with companions shows its count (“${chip}”)`);
}

h.section("keyboard ownership and placing");
{
  await page.focus("[data-plots-gallery] .viewport");
  await page.keyboard.type("ot");
  const state = await page.evaluate(() => ({ search: document.querySelector("[data-plots-search]").value, tool: window.__flux.get(window.__flux.fig.activeTool) }));
  h.ok(state.search === "ot" && state.tool === "select", "tool letters typed in the grid go to the search, not the canvas tools");
  await page.focus("[data-plots-search]");
  await page.keyboard.press("Escape");
  const n0 = await elementCount();
  const a = await tilePoint("/alpha.svg");
  await page.mouse.click(a.x, a.y, { count: 2 });
  await waitFor(page, (n) => window.__flux.figures().reduce((s, f) => s + f.elements.length, 0) === n + 1, n0, { label: "dblclick insert" });
  h.ok(true, "double-click places the plot in the active figure");
  h.ok(await page.evaluate(() => /Placed 1 plot/.test(document.body.textContent)), "a toast names the destination");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"] .chip.use.active'), null, { label: "in-use chip" });
  h.ok(true, "the tile marks the plot as placed in the active figure");
  await page.focus("[data-plots-gallery] .viewport");
  await ctrl("KeyZ");
  await waitFor(page, (n) => window.__flux.figures().reduce((s, f) => s + f.elements.length, 0) === n, n0, { label: "undo" });
  h.ok(true, "Ctrl+Z inside the rail undoes the insert");
  await page.focus("[data-plots-gallery] .viewport");
  await page.keyboard.press("Enter");
  await waitFor(page, (n) => window.__flux.figures().reduce((s, f) => s + f.elements.length, 0) === n + 1, n0, { label: "Enter insert" });
  h.ok(true, "Enter places the selection");
  await ctrl("KeyZ");
  // A second figure, to drop onto a NON-active one.
  await page.click('[data-rail-tab="layers"]');
  await page.click('.sidebar button.mini[title="Add figure"]');
  await sleep(200);
  const figs = await page.evaluate(() => window.__flux.figures().map((f) => ({ id: f.id, x: f.x, y: f.y })));
  await page.evaluate((id) => window.__flux.fig.activeFigureId.set(id), figs[0].id);
  await page.click('[data-rail-tab="plots"]');
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/beta.svg"] img'), null, { label: "beta tile", timeout: 8000 });
  const target = figs[figs.length - 1];
  const at = await page.evaluate((t) => { const v = window.__flux.get(window.__flux.fig.viewport); const host = document.querySelector(".canvas-host, .canvas-wrap").getBoundingClientRect(); return { x: host.left + v.panX + (t.x + 200) * v.zoom, y: host.top + v.panY + (t.y + 100) * v.zoom, zoom: v.zoom }; }, target);
  await page.evaluate((t) => window.__flux.fig.viewport.update((v) => ({ ...v })), target);
  const b = await tilePoint("/beta.svg", 0.25, 0.5);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) { await page.mouse.move(b.x + ((at.x - b.x) * i) / 14, b.y + ((at.y - b.y) * i) / 14); await sleep(16); }
  const ghost = await page.evaluate(() => { const g = document.querySelector("[data-plots-rail-ghost]")?.getBoundingClientRect(); return g ? { w: g.width, h: g.height } : null; });
  h.ok(ghost && Math.abs(ghost.w - 128 * at.zoom) < 1 && Math.abs(ghost.h - 64 * at.zoom) < 1, `over the canvas the ghost is the plot's true size at the zoom (${ghost?.w.toFixed(1)} × ${ghost?.h.toFixed(1)})`);
  await page.mouse.up();
  await waitFor(page, (id) => window.__flux.figures().find((f) => f.id === id)?.elements.length === 1, target.id, { label: "drop placed" });
  const placed = await page.evaluate((id) => { const e = window.__flux.figures().find((f) => f.id === id).elements[0]; return { x: e.x, y: e.y, w: e.width }; }, target.id);
  h.ok(Math.abs(placed.x - (200 - 0.25 * 128)) < 1.5 && Math.abs(placed.y - (100 - 0.5 * 64)) < 1.5, `the drop lands the grabbed point under the pointer (${placed.x.toFixed(1)}, ${placed.y.toFixed(1)})`);
  h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.activeFigureId)), target.id, "the drop target becomes the active figure");
}

h.section("dissections follow the focus");
{
  const a = await tilePoint("/alpha.svg");
  await page.mouse.click(a.x, a.y);
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "alpha", null, { label: "focus alpha" });
  h.ok(true, "a gallery click shows that plot's dissections");
  const titles = await page.evaluate(() => [...document.querySelectorAll("[data-plots-dissections] [data-section]")].map((n) => n.textContent.trim().split("·")[0].replace(/[▾▸]/g, "").trim()));
  h.eq(titles[0], "Summary", "Summary comes first");
  await waitFor(page, () => !!document.querySelector('[data-plots-dissections] [data-table-card="test.csv"] .kv'), null, { label: "transposed card" });
  h.ok(true, "a one-row wide stats table is shown transposed");
  // The canvas: the beta plot placed on the second figure.
  const placedPt = await page.evaluate(() => { const els = [...document.querySelectorAll(".canvas-wrap .el")]; const r = els[els.length - 1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(placedPt.x, placedPt.y);
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "beta", null, { label: "canvas focus" });
  h.ok(true, "a canvas click on a plot shows its dissections");
  h.ok(!!(await page.$('[data-plots-gallery] [data-tile$="/beta.svg"]')) && await page.evaluate(() => !!document.querySelector('[data-plots-gallery] .tile.linked[data-tile$="/beta.svg"]')), "its gallery tile wears the linked ring");
  const a2 = await tilePoint("/alpha.svg");
  await page.mouse.click(a2.x, a2.y);
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "alpha", null, { label: "gallery re-focus" });
  await page.mouse.click(placedPt.x, placedPt.y); // the plot is ALREADY selected on the canvas
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "beta", null, { label: "re-click re-claims" });
  h.ok(true, "re-clicking the already-selected canvas plot takes the focus back from the gallery");
  await page.keyboard.press("Escape");
  await sleep(150);
  h.eq(await focusKey(), "beta", "deselecting keeps the pane on the plot (sticky)");
  h.ok(await page.evaluate(() => document.querySelector("[data-dissect-focus]").classList.contains("stale")), "…and says it is no longer selected");
  await page.click("[data-dissect-pin]");
  const a3 = await tilePoint("/alpha.svg");
  await page.mouse.click(a3.x, a3.y);
  await sleep(250);
  h.eq(await focusKey(), "beta", "pinned: a gallery click does not move the pane");
  await page.click("[data-dissect-pin]");
  await page.mouse.click(a3.x, a3.y);
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "alpha", null, { label: "unpinned" });
  h.ok(true, "unpinned: it follows again");
  // Aligned flipping: select alpha's s05, focus beta — beta's s05 lands at the same height.
  const s05 = await tilePoint("/alpha/by_subject/s05.svg", 0.5, 0.5, "[data-plots-dissections]");
  await page.mouse.click(s05.x, s05.y);
  const y0 = await page.evaluate(() => document.querySelector('[data-plots-dissections] [aria-selected="true"]')?.getBoundingClientRect().top);
  const bt = await tilePoint("/beta.svg");
  await page.mouse.click(bt.x, bt.y);
  await waitFor(page, () => document.querySelector('[data-plots-dissections] [aria-selected="true"]')?.getAttribute("data-grid-id")?.endsWith("/beta/by_subject/s05.svg"), null, { label: "aligned flip" });
  const y1 = await page.evaluate(() => document.querySelector('[data-plots-dissections] [aria-selected="true"]').getBoundingClientRect().top);
  h.ok(Math.abs(y1 - y0) < 1.5, `aligned flipping keeps s05 selected at the same height (Δ ${(y1 - y0).toFixed(1)} px)`);
  // The "Show all" cap on beta's 70-file sweep.
  h.ok(await page.evaluate(async () => {
    const vp = document.querySelector("[data-plots-dissections] .viewport");
    for (let i = 0; i < 60; i++) { if (document.querySelector('[data-show-all="sweep"]')) return true; vp.scrollTop += 120; await new Promise((r) => setTimeout(r, 40)); }
    return false;
  }), "a 70-file group shows a few tiles and “Show all”");
  h.ok(await page.evaluate(() => /Show all 70/.test(document.querySelector('[data-show-all="sweep"]').textContent)), "…with its count");
  // Live: a new file under beta's folder appears without a refresh.
  await write({ [`${P}/_dissections/beta/by_subject/s99.svg`]: svg("#ad8301") });
  await page.evaluate((p) => window.__fluxEmitFsChange({ subsystem: "dissections", path: p }), `${P}/_dissections/beta/by_subject/s99.svg`);
  await waitFor(page, () => document.querySelector("[data-plots-dissections] .count")?.textContent?.trim() === "82", null, { label: "live dissection", timeout: 6000 });
  h.ok(true, "a file written into the plot's dissection folder appears live");
  // A placed dissection FILE focuses its owner, that file selected.
  await page.evaluate(async (p) => { await window.__flux.io.importPlotsFromPaths([p]); }, `${P}/_dissections/alpha/by_subject/s03.svg`);
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "alpha" && document.querySelector('[data-plots-dissections] [aria-selected="true"]')?.getAttribute("data-grid-id")?.endsWith("/alpha/by_subject/s03.svg"), null, { label: "owner focus", timeout: 6000 });
  h.ok(true, "a placed per-subject panel focuses its owner plot with that panel selected");
}

h.section("live gallery, Recent sort, Quick Look, the split, the library");
{
  await write({ [`${P}/fresh_plot.svg`]: svg("#bc5215") });
  await page.evaluate((p) => window.__fluxEmitFsChange({ subsystem: "plots", path: p }), `${P}/fresh_plot.svg`);
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/fresh_plot.svg"]'), null, { label: "live plot", timeout: 6000 });
  h.ok(true, "a plot written into plots/ appears live");
  await page.click("[data-rail-menu]");
  await page.evaluate(() => [...document.querySelectorAll("[data-plots-rail-menu] button")].find((b) => /Recent first/.test(b.textContent)).click());
  await waitFor(page, () => document.querySelector("[data-plots-gallery] [data-tile]")?.getAttribute("data-tile").endsWith("/fresh_plot.svg"), null, { label: "recent first" });
  h.ok(!!(await page.$("[data-recent-note]")), "Recent sort: one newest-first list, the newest plot on top");
  await page.click("[data-recent-note] button");
  await waitFor(page, () => !document.querySelector("[data-recent-note]"), null, { label: "folders again" });
  // Quick Look.
  await page.focus("[data-plots-gallery] .viewport");
  await page.keyboard.press(" ");
  await waitFor(page, () => !!document.querySelector(".expanded-preview"), null, { label: "quick look" });
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".expanded-preview") && !!document.activeElement?.closest("[data-plots-rail]"), null, { label: "quick look closed" });
  h.ok(true, "Space opens Quick Look; Esc returns to the rail");
  // The split: drag to the top edge collapses the gallery; double-click resets.
  const sp = await page.evaluate(() => { const r = document.querySelector("[data-plots-splitter]").getBoundingClientRect(); const b = document.querySelector("[data-plots-rail]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 2, top: b.top }; });
  await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x, sp.y - 60, { steps: 4 }); await page.mouse.up();
  const frac = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.figure.layout")).plotsSplit);
  h.ok(frac > 0.05 && frac < 0.62, `dragging the splitter sets and persists the split (${frac.toFixed(2)})`);
  const sp2 = await page.evaluate(() => { const r = document.querySelector("[data-plots-splitter]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 2 }; });
  await page.mouse.move(sp2.x, sp2.y); await page.mouse.down(); await page.mouse.move(sp2.x, sp.top + 6, { steps: 6 }); await page.mouse.up();
  await waitFor(page, () => !!document.querySelector("[data-gallery-collapsed]"), null, { label: "snap collapse" });
  h.ok(true, "dragging to the top edge snaps the gallery collapsed");
  await page.click("[data-gallery-collapsed]");
  await waitFor(page, () => !!document.querySelector("[data-plots-splitter]"), null, { label: "restored" });
  await page.click("[data-plots-splitter]", { count: 2 });
  await waitFor(page, () => Math.abs(JSON.parse(localStorage.getItem("flux.figure.layout")).plotsSplit - 0.62) < 1e-6, null, { label: "reset split" });
  h.ok(true, "double-clicking the splitter resets the split");
  // The global library.
  await write({ "/home/demo/FluxConfig/plot_library/shared/lib_plot.svg": svg("#5e409d") });
  await page.focus("[data-plots-search]");
  await alt("Digit2");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/lib_plot.svg"]'), null, { label: "library", timeout: 6000 });
  h.ok(true, "Alt+2 browses the global plot library");
  const lp = await tilePoint("/lib_plot.svg");
  await page.mouse.click(lp.x, lp.y);
  await waitFor(page, () => /Library plots have no dissections/.test(document.querySelector("[data-plots-dissections]").textContent), null, { label: "library focus" });
  h.ok(true, "a library plot's dissections pane explains there are none");
  await page.focus("[data-plots-search]");
  await alt("Digit1");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"]'), null, { label: "project again" });
}

h.section("review regressions: one-shot Alt+G, typing, the app's own writes");
{
  // Collapse the gallery, leave to Layers and come back by TAB: an old Alt+G must not replay
  // (no forced un-collapse, no search focus).
  await page.click("[data-plots-dissections] button[aria-label='Maximize dissections']");
  await waitFor(page, () => !!document.querySelector("[data-gallery-collapsed]"), null, { label: "gallery collapsed" });
  await page.click('[data-rail-tab="layers"]');
  await page.click('[data-rail-tab="plots"]');
  await sleep(250);
  h.ok(!!(await page.$("[data-gallery-collapsed]")) && !(await activeIsSearch()), "re-opening Plots by its tab does not replay an old Alt+G");
  await alt("KeyG");
  h.eq(await view(), "layers", "Alt+G leaves the already-open Plots view even when its gallery is collapsed");
  await alt("KeyG"); // returning to Plots lands in a visible search box
  await waitFor(page, () => document.activeElement?.hasAttribute("data-plots-search"), null, { label: "fresh Alt+G" });
  h.ok(!(await page.$("[data-gallery-collapsed]")), "a fresh Alt+G un-collapses the gallery to reach its search");
  // Typing in a field outside the rail: Alt+G is not the rail's (Option+G types © on macOS).
  await page.mouse.click(900, 600);
  const field = await page.$(".inspector input");
  if (field) {
    await field.focus();
    await alt("KeyG");
    await sleep(150);
    h.ok(!(await activeIsSearch()), "Alt+G while typing in an Inspector field leaves the keyboard there");
  } else h.ok(true, "(no Inspector field to type in)");
  // The app's own write under plots/ (a pasted image's archive) appears without a watcher event.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 30); const x = c.getContext("2d"); x.fillStyle = "#da702c"; x.fillRect(0, 0, 40, 30);
    const blob = await c.convertToBlob({ type: "image/png" });
    await window.__flux.io.archivePastedImage(new File([blob], "pasted-rail.png", { type: "image/png" }), "pasted-rail.png");
  });
  await waitFor(page, async () => {
    const vp = document.querySelector("[data-plots-gallery] .viewport");
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('[data-plots-gallery] [data-tile$="/pasted/pasted-rail.png"]')) return true;
      vp.scrollTop += 200; await new Promise((r) => setTimeout(r, 20));
    }
    vp.scrollTop = 0;
    return false;
  }, null, { label: "self-write appears", timeout: 8000 });
  h.ok(true, "an image the app archives into plots/pasted appears in the gallery live");
}

h.section("the fallback renderer keeps the law; Slide's Alt+G is its own rail");
{
  await page.evaluate(() => localStorage.setItem("flux.fixture.thumbsUnavailable", "1"));
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots", null, { label: "plots view persisted" });
  await write({ [`${P}/fb/dark.svg`]: fixtures["dark.svg"], [`${P}/fb/light.svg`]: fixtures["light.svg"] });
  await page.click("[data-rail-menu]");
  await page.evaluate(() => [...document.querySelectorAll("[data-plots-rail-menu] button")].find((b) => /^Refresh/.test(b.textContent.trim())).click());
  await waitFor(page, () => document.querySelector('[data-plots-gallery] [data-tile$="/fb/dark.svg"] img') && document.querySelector('[data-plots-gallery] [data-tile$="/fb/light.svg"] img'), null, { label: "fallback thumbs", timeout: 10000 });
  const fb = await page.evaluate(() => ({ dark: document.querySelector('[data-plots-gallery] [data-tile$="/fb/dark.svg"]').getAttribute("data-backdrop"), light: document.querySelector('[data-plots-gallery] [data-tile$="/fb/light.svg"]').getAttribute("data-backdrop") }));
  h.ok(fb.dark === "dark" && fb.light === "paper", `with the worker unavailable the renderer draws tiles and the law still holds (${JSON.stringify(fb)})`);
  await page.evaluate(() => localStorage.removeItem("flux.fixture.thumbsUnavailable"));
  await clickMode(page, "Slide");
  await sleep(600);
  await page.mouse.click(760, 520);
  await alt("KeyG");
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots" && !!document.querySelector(".filmstrip") === false, null, { label: "slide plots rail", timeout: 6000 });
  h.ok(!(await page.evaluate(() => !!document.querySelector(".importer"))), "in Slide, Alt+G shows Slide's own Plots rail (no dialog)");
  await alt("KeyG", true);
  await waitFor(page, () => window.__flux.get(window.__flux.fig.importerOpen) && window.__flux.get(window.__flux.fig.importerDetached), null, { label: "slide gallery", timeout: 6000 });
  h.ok(true, "…and Shift+Alt+G still opens the full gallery, pinned");
  await page.evaluate(() => window.__flux.fig.importerOpen.set(false));
}

h.eq(errs.length, 0, `console stays clean${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
await h.done(() => browser.close());
