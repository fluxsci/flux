// The Plots rail in Slide mode (P4; browser, demo fixture): Slide's left rail is
// [Slides | Plots] — the filmstrip, or the same PlotsRail Figure has.
//   * switching: the default is Slides (the filmstrip gates keep their world), the tabs, Alt+G's
//     three states (also from the search box), the filmstrip and the Plots rail keep their OWN
//     widths (the gutter sizes whichever shows), Shift+Alt+G is still the full gallery;
//   * placing through Slide's import route: double-click and Enter place on the active slide
//     ("on Slide …" toast), a drag lands at the pointer at true size, the destination chip lists
//     the deck's slides and switches slide;
//   * focus from the slide selection (Dissections follow a plot clicked on the stage);
//   * the Become pick: Enter in the rail places — it never confirms the pick — and the placed
//     plot joins the pick (Add mode); Add ▾ → Plot… opens the rail; Escape stays the rail's;
//   * F5 from the rail still presents; clips: `_videos` is offered here (and only here), its
//     tiles show posters on the dark backdrop;
//   * clean console.
//   Run (dev server up; FLUX_URL for a worktree): node scripts/verify-plots-rail-slide.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-plots-rail-slide");
const ROOT = "/demo/myc-growth-paper";
const P = `${ROOT}/plots`;

const clipFixture = new URL("./fixtures/slide-video-clips/", import.meta.url);
const movie = readFileSync(new URL("moving-box.mp4", clipFixture)).toString("base64");
const posterPng = readFileSync(new URL("poster.png", clipFixture)).toString("base64");
const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });

const svg = (fill, w = 72, hgt = 48) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${hgt}pt" viewBox="0 0 ${w} ${hgt}"><rect width="${w}" height="${hgt}" fill="${fill}"/></svg>`;
const alt = async (code, shift = false) => { await page.keyboard.down("Alt"); if (shift) await page.keyboard.down("Shift"); await page.keyboard.press(code); if (shift) await page.keyboard.up("Shift"); await page.keyboard.up("Alt"); };
const view = () => page.evaluate(() => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") ?? "hidden");
const railW = () => page.evaluate(() => Math.round(document.querySelector("[data-left-rail]")?.getBoundingClientRect().width ?? 0));
const slideEls = () => page.evaluate(() => { const F = window.__flux, id = F.get(F.fig.activeFigureId); return F.figures().find((f) => f.id === id)?.elements ?? []; });
const tileCenter = (suffix) => page.evaluate((suffix) => { const n = document.querySelector(`[data-plots-gallery] [data-tile$="${suffix}"] .page`); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, suffix);
const toasts = () => page.evaluate(() => [...document.querySelectorAll(".toast, [data-toast]")].map((t) => t.innerText.trim()).join(" | "));

await page.evaluate(async (files) => { for (const [p, t] of Object.entries(files)) await window.fig.writeText(p, t); }, {
  [`${P}/alpha.svg`]: svg("#d95f02", 96, 48),
  [`${P}/beta.svg`]: svg("#4385be", 120, 80),
  [`${P}/gamma.svg`]: svg("#879a39", 60, 60),
  [`${P}/_dissections/beta/by_subject/s01.svg`]: svg("#e7298a"),
  [`${P}/_dissections/beta/by_subject/s02.svg`]: svg("#205ea6"),
  [`${P}/_videos/clip.mp4`]: "not really a movie",
  [`${P}/loose_clip.mp4`]: "a clip outside _videos",
  [`${P}/broken.svg`]: "this is not an svg",
  ["/home/demo/FluxConfig/plot_library/lib_plot.svg"]: svg("#bc5215"),
  ["/home/demo/FluxConfig/plot_library/lib_clip.mp4"]: "a library clip",
});
// Clip posters come from the desktop app's video reader; stub it (the dialog's gates do too).
await page.evaluate(() => {
  const c = document.createElement("canvas"); c.width = 160; c.height = 90;
  const g = c.getContext("2d"); g.fillStyle = "#3aa99f"; g.fillRect(0, 0, 160, 90);
  const poster = c.toDataURL("image/png");
  window.fig.videoPreview = async () => ({ poster, width: 160, height: 90, durationMs: 1200, hasAudio: false });
});

h.section("Slide's left rail: [Slides | Plots]");
{
  await clickMode(page, "Slide");
  await waitFor(page, () => !!document.querySelector(".filmstrip .thumb"), null, { label: "filmstrip", timeout: 10000 });
  h.eq(await view(), "slides", "the left rail opens on the filmstrip");
  // A second slide for the destination menu; then back to the first.
  await page.evaluate(() => [...document.querySelectorAll(".filmstrip .addslide")].find((b) => /Add slide/.test(b.textContent)).click());
  await waitFor(page, () => document.querySelectorAll(".filmstrip .thumb").length === 2, null, { label: "two slides" });
  await page.click(".filmstrip .thumb:first-of-type");
  await waitFor(page, () => document.querySelector(".filmstrip .thumb.active .n")?.textContent.trim() === "1", null, { label: "slide 1 active" });
  h.ok(await page.evaluate(() => [...document.querySelectorAll("[data-left-rail] .rail-tab")].map((t) => t.dataset.railTab).join(",") === "slides,plots"), "its tabs are Slides and Plots");
  const filmW = await railW();
  h.eq(filmW, 172, "the filmstrip keeps its own width (172)");
  await page.mouse.click(760, 520);
  await alt("KeyG");
  await waitFor(page, async () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots" && document.activeElement?.hasAttribute("data-plots-search"), null, { label: "alt+g plots" });
  h.ok(true, "Alt+G shows the Plots rail and focuses its search");
  h.eq(await railW(), 320, "the Plots rail has its own width (320)");
  await alt("KeyG");
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "slides", null, { label: "back to slides" });
  h.ok(!(await page.evaluate(() => document.activeElement?.closest?.("[data-left-rail]"))), "Alt+G from inside the rail returns to the filmstrip and the keyboard leaves it");
  await page.click('[data-rail-tab="plots"]');
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots", null, { label: "tab plots" });
  // The gutter sizes the Plots rail only.
  const g = await page.evaluate(() => { const r = document.querySelector(".film-gutter").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200 }; });
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + 60, g.y, { steps: 6 }); await page.mouse.up();
  await sleep(100);
  const layout = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.slide.layout")));
  h.ok(Math.abs(layout.plotsRailW - 380) <= 3 && layout.filmstripW === 172, `the gutter resizes the Plots rail and leaves the filmstrip's width alone (${layout.plotsRailW}/${layout.filmstripW})`);
  await page.evaluate(() => { const n = document.querySelector(".film-gutter"); n.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await sleep(100);
  h.eq(await railW(), 320, "double-clicking the gutter resets the Plots rail's width");
  await alt("KeyG", true);
  await waitFor(page, () => window.__flux.get(window.__flux.fig.importerOpen) === true, null, { label: "full gallery" });
  await waitFor(page, () => window.__flux.get(window.__flux.fig.importerDetached) === true, null, { label: "pinned", timeout: 5000 });
  h.ok(true, "Shift+Alt+G still opens the full gallery, pinned in its own window");
  // Pinned = its own window (a popup here): close it through the store.
  await page.evaluate(() => window.__flux.fig.importerOpen.set(false));
  await waitFor(page, () => !document.querySelector(".importer") && window.__flux.get(window.__flux.fig.importerOpen) === false, null, { label: "gallery closed" });
}

h.section("placing on the slide");
{
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"] img'), null, { label: "alpha tile", timeout: 10000 });
  h.ok(/→ Title/.test(await page.evaluate(() => document.querySelector("[data-rail-destination]").textContent)), "the destination chip names the active slide");
  const n0 = (await slideEls()).length;
  const a = await tileCenter("/alpha.svg");
  await page.mouse.click(a.x, a.y, { count: 2 });
  await waitFor(page, async () => true, null, { label: "noop" });
  await page.waitForFunction((n0) => { const F = window.__flux, id = F.get(F.fig.activeFigureId); return (F.figures().find((f) => f.id === id)?.elements.length ?? 0) === n0 + 1; }, { timeout: 6000 }, n0);
  const placed = (await slideEls()).at(-1);
  h.ok(placed.type === "plot" && /plots\/alpha\.svg$/.test(placed.source?.svgPath ?? "") && placed.width === 128 && placed.height === 64, `double-click places the plot on the slide at its true size (${placed.width}×${placed.height})`);
  h.ok(/Placed 1 plot on Title/.test(await toasts()), "the toast says where (“on Title”)");
  // Enter places the focused tile.
  const g = await tileCenter("/gamma.svg");
  await page.mouse.click(g.x, g.y);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n0) => { const F = window.__flux, id = F.get(F.fig.activeFigureId); return (F.figures().find((f) => f.id === id)?.elements.length ?? 0) === n0 + 2; }, { timeout: 6000 }, n0);
  h.ok(true, "Enter places the focused plot");
  // Drag: lands at the pointer, true size at the stage zoom.
  const b = await tileCenter("/beta.svg");
  const stage = await page.evaluate(() => { const r = document.querySelector(".canvas-wrap").getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.62 }; });
  await page.mouse.move(b.x, b.y); await page.mouse.down();
  for (let i = 1; i <= 14; i++) { await page.mouse.move(b.x + (stage.x - b.x) * i / 14, b.y + (stage.y - b.y) * i / 14); await sleep(16); }
  await sleep(80);
  const ghost = await page.evaluate(() => { const g = document.querySelector("[data-plots-rail-ghost]")?.getBoundingClientRect(); return g ? { w: Math.round(g.width), h: Math.round(g.height) } : null; });
  const zoom = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
  h.ok(ghost && Math.abs(ghost.w - 160 * zoom) <= 2 && Math.abs(ghost.h - 106.67 * zoom) <= 2, `over the stage the ghost is the plot's true size at the stage zoom (${JSON.stringify(ghost)} at ${zoom.toFixed(2)}×)`);
  await page.mouse.up();
  await page.waitForFunction((n0) => { const F = window.__flux, id = F.get(F.fig.activeFigureId); return (F.figures().find((f) => f.id === id)?.elements.length ?? 0) === n0 + 3; }, { timeout: 6000 }, n0);
  const dropped = (await slideEls()).at(-1);
  const screen = await page.evaluate((el) => { const F = window.__flux, vp = F.get(F.fig.viewport), host = document.querySelector(".canvas-wrap .canvas-host, .canvas-host").getBoundingClientRect(); const f = F.figures().find((x) => x.id === F.get(F.fig.activeFigureId)); return { x: host.left + vp.panX + (f.x + el.x + el.width / 2) * vp.zoom, y: host.top + vp.panY + (f.y + el.y + el.height / 2) * vp.zoom }; }, dropped);
  h.ok(/beta\.svg$/.test(dropped.source?.svgPath ?? "") && Math.abs(screen.x - stage.x) <= 3 && Math.abs(screen.y - stage.y) <= 3, `a drag places it under the pointer, the grab point kept (${screen.x.toFixed(0)},${screen.y.toFixed(0)} vs ${stage.x.toFixed(0)},${stage.y.toFixed(0)})`);
  // The destination chip lists the deck's slides.
  await page.click("[data-rail-destination]");
  await waitFor(page, () => !!document.querySelector("[data-plots-rail-menu]"), null, { label: "dest menu" });
  const items = await page.evaluate(() => [...document.querySelectorAll("[data-plots-rail-menu] button .label")].map((b) => b.textContent.trim()));
  h.ok(items.length >= 2 && /^1\s+Title/.test(items[0]), `the destination menu lists the slides (${items.join(" · ")})`);
  await page.evaluate(() => [...document.querySelectorAll("[data-plots-rail-menu] button")][1].click());
  await waitFor(page, () => !/→ Title/.test(document.querySelector("[data-rail-destination]").textContent), null, { label: "switched slide" });
  h.ok(await page.evaluate(() => document.querySelector(".filmstrip") === null), "choosing one switches the active slide (the rail stays on Plots)");
  await page.click("[data-rail-destination]");
  await waitFor(page, () => !!document.querySelector("[data-plots-rail-menu]"), null, { label: "dest menu 2" });
  await page.evaluate(() => [...document.querySelectorAll("[data-plots-rail-menu] button")][0].click());
  await waitFor(page, () => /→ Title/.test(document.querySelector("[data-rail-destination]").textContent), null, { label: "back to slide 1" });
}

h.section("focus follows the slide selection; in-use marks");
{
  const el = (await slideEls()).find((e) => /beta\.svg$/.test(e.source?.svgPath ?? ""));
  await page.evaluate((id) => { const F = window.__flux; F.fig.selection.set(new Set([id])); }, el.id);
  await waitFor(page, () => document.querySelector("[data-dissect-focus]")?.getAttribute("data-dissect-focus") === "beta", null, { label: "focus beta" });
  h.ok(true, "selecting a placed plot on the slide focuses its dissections");
  h.ok(await page.evaluate(() => !!document.querySelector('[data-plots-gallery] [data-tile$="/beta.svg"] .chip.use.active')), "its tile carries the in-use mark for the active slide");
  await page.evaluate(() => window.__flux.fig.selection.set(new Set()));
}

h.section("the Become pick");
{
  const title = await page.evaluate(() => { const n = [...document.querySelectorAll(".canvas-wrap [data-editor-element-id]")].find((x) => /Title/.test(x.textContent)); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(title.x, title.y);
  await page.keyboard.press("KeyB");
  await waitFor(page, () => document.querySelector("[data-pick-bar]")?.getAttribute("data-pick-bar") === "pick", null, { label: "become armed" }).catch(async (e) => { await page.screenshot({ path: "/tmp/p0/become-fail.png" }); console.log(await page.evaluate(() => ({ sel: [...window.__flux.get(window.__flux.fig.selection)], active: document.activeElement?.tagName + "." + document.activeElement?.className }))); throw e; });
  const n0 = (await slideEls()).length;
  await page.focus("[data-plots-search]");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  h.eq(await page.evaluate(() => document.querySelector("[data-pick-bar]")?.getAttribute("data-pick-bar")), "pick", "Escape inside the rail is the rail's (the pick survives)");
  await page.focus("[data-plots-search]");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction((n0) => { const F = window.__flux, id = F.get(F.fig.activeFigureId); return (F.figures().find((f) => f.id === id)?.elements.length ?? 0) === n0 + 1; }, { timeout: 6000 }, n0);
  await waitFor(page, () => document.querySelector("[data-pick-bar]")?.getAttribute("data-pick-bar") === "add", null, { label: "add mode" });
  const bar = await page.evaluate(() => document.querySelector("[data-pick-bar]").innerText.replace(/\s+/g, " "));
  h.ok(/1 picked/.test(bar), `Enter in the rail places a plot (never confirms the pick), and it joins the pick in Add mode (…${bar.slice(-60)})`);
  const cancel = () => page.evaluate(() => [...document.querySelectorAll("[data-pick-bar] button")].find((b) => /^Cancel/.test(b.textContent.trim()))?.click());
  // Back to picking (Done), then a placement that FAILS: the pick returns to picking, unchanged.
  await page.evaluate(() => [...document.querySelectorAll("[data-pick-bar] button")].find((b) => /^Done/.test(b.textContent.trim()))?.click());
  await waitFor(page, () => document.querySelector("[data-pick-bar]")?.getAttribute("data-pick-bar") === "pick", null, { label: "back to picking" });
  const bk = await tileCenter("/broken.svg");
  await page.mouse.click(bk.x, bk.y, { count: 2 });
  await waitFor(page, () => /Import failed|Could not place/.test([...document.querySelectorAll(".toast, [data-toast]")].map((t) => t.innerText).join(" ")), null, { label: "broken refused", timeout: 6000 });
  await sleep(150);
  h.eq(await page.evaluate(() => document.querySelector("[data-pick-bar]")?.getAttribute("data-pick-bar")), "pick", "a placement that fails leaves the pick picking (not stuck in Add mode)");
  await cancel();
  await waitFor(page, () => !document.querySelector("[data-pick-bar]"), null, { label: "pick cancelled", timeout: 4000 });
  // Add ▾ → Plot… shows the rail (from the filmstrip view).
  await page.click('[data-rail-tab="slides"]');
  await page.evaluate(() => { const F = window.__flux, id = F.get(F.fig.activeFigureId); const el = F.figures().find((f) => f.id === id).elements.find((e) => e.type === "text"); F.fig.selection.set(new Set([el.id])); document.activeElement?.blur?.(); });
  await page.keyboard.press("KeyB");
  await waitFor(page, () => document.querySelector("[data-pick-bar]")?.getAttribute("data-pick-bar") === "pick", null, { label: "become armed again" });
  await page.evaluate(() => [...document.querySelectorAll("[data-pick-bar] button")].find((b) => /^Add/.test(b.textContent.trim())).click());
  await waitFor(page, () => !!document.querySelector(".menu[role=menu]"), null, { label: "add menu" });
  await page.evaluate(() => [...document.querySelectorAll(".menu[role=menu] button")].find((b) => /^Plot…/.test(b.textContent.trim())).click());
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots" && document.activeElement?.hasAttribute("data-plots-search"), null, { label: "add plot → rail" });
  h.ok(!(await page.evaluate(() => !!document.querySelector(".importer"))), "Add ▾ → Plot… opens the Plots rail, its search focused (no dialog)");
  await cancel();
  await waitFor(page, () => !document.querySelector("[data-pick-bar]"), null, { label: "pick cancelled again", timeout: 4000 });
}

h.section("F5 and clips");
{
  await page.focus("[data-plots-search]");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("F5");
  await waitFor(page, () => !!document.querySelector(".present"), null, { label: "present from the rail", timeout: 6000 });
  h.ok(true, "F5 from the rail still presents");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".present"), null, { label: "present closed" });
  await page.focus("[data-plots-search]");
  await page.keyboard.type("_");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-reserved="_videos"]'), null, { label: "_videos offered" });
  h.ok(true, "typing _ offers the _videos collection in Slide");
  await page.keyboard.type("vid");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/_videos/clip.mp4"] img'), null, { label: "clip poster", timeout: 8000 }).catch(async (e) => { console.log(await page.evaluate(() => ({ g: document.querySelector("[data-plots-gallery]")?.innerText.slice(0, 300), t: document.querySelector('[data-plots-gallery] [data-tile] .page')?.innerHTML.slice(0, 200), vp: typeof window.fig.videoPreview }))); throw e; });
  const clip = await page.evaluate(() => { const t = document.querySelector('[data-plots-gallery] [data-tile$="/_videos/clip.mp4"]'); const r = t.querySelector(".page").getBoundingClientRect(); return { backdrop: t.getAttribute("data-backdrop"), glyph: t.querySelector(".chip.kind")?.textContent, aspect: r.width / r.height }; });
  h.ok(clip.backdrop === "dark" && clip.glyph === "▶" && Math.abs(clip.aspect - 16 / 9) < 0.05, `a clip tile shows its poster on the dark backdrop, ▶, at the poster's aspect (${JSON.stringify(clip)})`);
  const ck = await tileCenter("/_videos/clip.mp4");
  await page.mouse.move(ck.x, ck.y);
  await waitFor(page, () => !!document.querySelector("[data-plots-peek]"), null, { label: "clip peek" });
  h.eq(await page.evaluate(() => document.querySelector("[data-plots-peek] [data-peek-backdrop]")?.getAttribute("data-peek-backdrop")), "dark", "Peek shows a clip on the same dark backdrop as its tile");
  await page.mouse.move(800, 500);
  // Placing a clip goes through Slide's video import (the desktop app's preparer, stubbed as in
  // verify-slide-video-clips-gui) — and is not cancelled for want of an open gallery dialog.
  await page.evaluate(({ movie, posterPng }) => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = "data:video/mp4;base64," + movie, posterUrl = "data:image/png;base64," + posterPng;
    window.fig.onVideoImportProgress = () => () => {};
    window.fig.videoMediaUrl = async () => url;
    window.fig.discardVideoImport = async () => {};
    window.fig.prepareSlideVideo = async (request) => {
      const root = request.path.slice(0, request.path.indexOf("/plots/"));
      const id = "rail-video-1";
      const asset = { id, kind: "mp4", path: `assets/${id}.mp4`, name: "clip.mp4", naturalWidth: 160, naturalHeight: 90, durationMs: 1200, hasAudio: false, sourcePath: request.path.slice(root.length + 1) };
      const posterAsset = { id: id + "-poster", kind: "png", path: `assets/${id}-poster.png`, name: "poster.png", naturalWidth: 160, naturalHeight: 90 };
      await window.fig.writeFile(`${root}/slides/${request.deckId}/${asset.path}`, bytes(movie));
      await window.fig.writeFile(`${root}/slides/${request.deckId}/${posterAsset.path}`, bytes(posterPng));
      return { asset, posterAsset, url, poster: posterUrl };
    };
  }, { movie, posterPng });
  const before = (await slideEls()).filter((e) => e.type === "video").length;
  // A long preparation shows its progress in the rail, with Cancel.
  await page.evaluate(() => {
    const real = window.fig.prepareSlideVideo;
    window.fig.cancelVideoImport = async () => { window.__releaseRailClip?.(); };
    window.fig.prepareSlideVideo = async (request) => { window.__railClipHeld = true; await new Promise((r) => { window.__releaseRailClip = r; }); window.fig.prepareSlideVideo = real; return real(request); };
  });
  const c0 = await tileCenter("/_videos/clip.mp4");
  await page.mouse.click(c0.x, c0.y, { count: 2 });
  await waitFor(page, () => !!document.querySelector("[data-rail-status] button"), null, { label: "rail status", timeout: 6000 });
  h.ok(/Preparing/.test(await page.evaluate(() => document.querySelector("[data-rail-status]").textContent)), "a clip being prepared shows its progress in the rail, with Cancel");
  await page.click("[data-rail-status] button");
  await waitFor(page, () => !document.querySelector("[data-rail-status]"), null, { label: "status gone", timeout: 6000 });
  await sleep(300);
  h.eq((await slideEls()).filter((e) => e.type === "video").length, before, "Cancel stops it: nothing is placed");
  const cp = await tileCenter("/_videos/clip.mp4");
  await page.mouse.click(cp.x, cp.y, { count: 2 });
  await page.waitForFunction((before) => { const F = window.__flux, id = F.get(F.fig.activeFigureId); return (F.figures().find((f) => f.id === id)?.elements.filter((e) => e.type === "video").length ?? 0) === before + 1; }, { timeout: 8000 }, before);
  h.ok(/Placed 1 clip on Title/.test(await toasts()), "double-clicking a clip places it on the slide through Slide's video import");
  await page.keyboard.press("Escape");
  await page.focus("[data-plots-search]");
  await page.keyboard.press("Backspace");
  await clickMode(page, "Figure");
  await page.mouse.click(760, 520);
  await alt("KeyG");
  await waitFor(page, () => document.activeElement?.hasAttribute("data-plots-search"), null, { label: "figure rail search" });
  await page.keyboard.type("_");
  await sleep(300);
  h.ok(!(await page.evaluate(() => !!document.querySelector('[data-plots-gallery] [data-reserved="_videos"]'))), "…and not in Figure, which cannot place clips");
  await page.keyboard.press("Escape");
  // Back in Slide: the clip Figure never listed is not "new" (each listing kind keeps its own past).
  await clickMode(page, "Slide");
  await page.mouse.click(760, 520);
  await alt("KeyG");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/loose_clip.mp4"]'), null, { label: "loose clip listed", timeout: 8000 });
  h.ok(!(await page.evaluate(() => document.querySelector('[data-plots-gallery] [data-tile$="/loose_clip.mp4"]').hasAttribute("data-fresh"))), "switching from Figure to Slide marks no clip as new");
  // The global library: plots yes, clips no (only the project's clips can be read and imported).
  await page.click('[data-plots-gallery] [data-scope="global"]');
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/lib_plot.svg"]'), null, { label: "library listed", timeout: 8000 });
  h.ok(!(await page.evaluate(() => !!document.querySelector('[data-plots-gallery] [data-tile$="/lib_clip.mp4"]'))), "the library lists its plots, never clips (Slide cannot import them)");
  await page.click('[data-plots-gallery] [data-scope="project"]');
}

h.section("rename from the Plots view");
{
  await page.mouse.click(760, 520);
  await page.keyboard.press("F2");
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "slides" && document.activeElement?.classList.contains("nm-edit"), null, { label: "rename field", timeout: 4000 });
  h.ok(true, "F2 with the Plots view showing switches to the filmstrip and opens the rename field");
  await page.keyboard.press("Escape");
}

h.eq(errs.length, 0, `console stays clean${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
await h.done(() => browser.close());
