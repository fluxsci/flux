// fluximg stage 2, W2: an image movie on a slide in the REAL app (Slide mode's preview and Present), with the measurements
// the owner's constraint asks for ("DO NOT ALLOW the quality of the animation engine to degrade IN ANY WAY").
//
// A synthetic stack (240 time points x 2 channels x 512 x 512 uint16, a label layer of ~100 outlines) is written with the TS
// writer into a mkdtemp directory, handed to the page through intercepted same-origin requests, seeded into the memory bridge and
// imported through the real import (`window.fig.importFluximg`), exactly as the live-view gate does. One slide shows it;
// its step walks the whole time axis in 4 s. Then, in Slide mode: the preview plays the step (the real player, the real
// app host: the window's decode workers and ONE shared WebGL renderer), scrubs, and ends on the end state's still (the
// last frame equals the reference renderer's still of that state, pixel for pixel within the GL parity bound); in
// Present: the step plays and leaving the slide gives the GPU textures back. Printed: main-thread script + layout + style
// per frame while the walk plays (CDP Performance.getMetrics), frames that showed an older plane than asked, the first
// frame's latency after play, GPU textures before and after the slide changes. No console errors.
//
// UI tier (dev server via FLUX_URL), runtime tsx (it writes the bundle with the TS writer).
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-slide-player-gui.mjs
//
// Until work package W1b admits images into decks, the deck fold drops them (deckProject.foldSlide); this gate needs a dev
// server where that drop is lifted (W2 ran it with a scratch Vite transform doing exactly that, see the W2 report).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFluximg } from "../src/lib/fluximg/writer.ts";
import { nodeBundleWriter, nodeZstd } from "../flux-core/fluximgIo.ts";

const h = harness("verify-fluximg-slide-player-gui");
const scratch = mkdtempSync(path.join(tmpdir(), "fx-slidegui-"));
const T = 240, C = 2, N = 512;
const t0 = Date.now();
{
  // Smooth structure that drifts with time, plus a little noise (so planes do not compress to nothing).
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 26; };
  // A PixelSource built plane by plane (never 240 MiB in memory at once).
  const source = { dims: ["t", "c", "y", "x"], shape: [T, C, N, N], dtype: "uint16" };
  source.plane = (leading) => {
    const [t, c] = leading, d = new Uint16Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = 600 + 500 * Math.sin((x + t * 3 * (c + 1)) / 23) * Math.cos((y - t * 2) / 31) + (c ? 300 * Math.sin((x * y) / 9000 + t / 9) : 0);
      d[y * N + x] = Math.max(0, Math.round(v + 900 + rnd()));
    }
    return d;
  };
  const labels = new Uint16Array(N * N);
  for (let k = 0; k < 100; k++) {
    const cy = 24 + (k % 10) * 48, cx = 24 + Math.floor(k / 10) * 48, r = 6 + (k % 5) * 2;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) labels[y * N + x] = k + 1;
  }
  await writeFluximg(nodeBundleWriter(path.join(scratch, "movie.fluximg")), await nodeZstd(), {
    name: "synthetic movie", source,
    axes: { t: { unit: "s", scale: 1 / 60 }, y: { unit: "µm", scale: 0.4 }, x: { unit: "µm", scale: 0.4 } },
    channels: [{ name: "a", color: "#ff00ff", range: [900, 2400] }, { name: "b", color: "#00ff00", range: [900, 2600] }],
    layers: [{ kind: "labels", id: "cells", name: "cells", data: labels, visible: true }],
  });
}
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(path.relative(path.join(scratch, "movie.fluximg"), p).split(path.sep).join("/")); } };
walk(path.join(scratch, "movie.fluximg"));
const bytes = files.reduce((s, f) => s + statSync(path.join(scratch, "movie.fluximg", f)).size, 0);
console.log(`  bundle: ${T} x ${C} x ${N} x ${N} uint16, ${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB, written in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const { browser, page } = await launch({ width: 1500, height: 950 });
// The bundle's files reach the page through intercepted same-origin requests (the app's CSP allows only its own origin).
const FILES_URL = new URL("/__w2-bundle/", APP_URL).href;
await page.setRequestInterception(true);
page.on("request", (req) => {
  if (!req.url().startsWith(FILES_URL)) { void req.continue(); return; }
  const rel = decodeURIComponent(req.url().slice(FILES_URL.length));
  if (!files.includes(rel)) { void req.respond({ status: 404, body: "" }); return; }
  void req.respond({ status: 200, contentType: "application/octet-stream", body: readFileSync(path.join(scratch, "movie.fluximg", rel)) });
});
const cdp = await page.target().createCDPSession();
await cdp.send("Performance.enable");
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const paint = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const clickText = (selector, text) => page.evaluate(({ selector, text }) => { const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text); if (!el) throw new Error(`Missing ${text}`); el.click(); }, { selector, text });
const stats = () => page.evaluate(() => ({ ...window.__flux.fluximgSlide.stats, hosts: window.__flux.fluximgSlide.hosts() }));
try {
  const base = new URL(APP_URL); base.search = "?fixture=demo";
  await gotoApp(page, { url: base.href, settle: 1200 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fluximg && !!window.__flux.fluximgSlide, null, { label: "the dev handles" });
  // ---- import the bundle through the real path ----------------------------------------------------------------------------
  const asset = await page.evaluate(async ({ files, url }) => {
    const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir);
    const content = {};
    for (const f of files) content[f] = new Uint8Array(await (await fetch(url + f)).arrayBuffer());
    window.__fluxSeedFluximg("plots/movie.fluximg", content);
    const place = F.fluximg.place, assetId = place.fluximgAssetId("movie", "slidegui");
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/movie.fluximg", assetId });
    return place.fluximgAsset(assetId, result, "plots/movie.fluximg");
  }, { files, url: FILES_URL });
  h.ok(asset?.kind === "fluximg", `the bundle is imported (${asset.id})`);

  // ---- a deck: slide 1 shows the image, its step walks t 0 -> 239 in 4 s; slide 2 has no image ------------------------------
  await clickMode(page, "Slide", { settle: 600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck load" });
  const placed = await page.evaluate((asset) => {
    const F = window.__flux, sid = F.get(F.fig.activeFigureId);
    F.fig.commit((p) => {
      if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
      const fig = p.figures.find((f) => f.id === sid);
      fig.elements = [{ type: "fluximg", id: "movie", x: 60, y: 30, width: 300, height: 300, rotation: 0, assetId: asset.id, view: { index: { t: 0 }, layers: { cells: { visible: true } }, furniture: { stamp: {} } } }];
    });
    F.slide.commitDeckLive((d) => {
      const s = F.slideOps.slideById(d, sid);
      s.beats = [s.beats[0]];
      const beat = F.slideOps.addBeat(d, sid, { label: "walk" });
      F.slideOps.setTransform(d, sid, beat.id, "movie", { state: { view: { index: { t: 239 }, layers: { cells: { visible: true } }, furniture: { stamp: {} } } }, duration: 4000, easing: "linear" });
      if (d.slides.length < 2) F.slideOps.addSlide(d, { layout: "blank" });
    });
    const deck = F.slide.currentDeck();
    return { sid, held: deck.slides.find((s) => s.id === sid).elements.some((e) => e.type === "fluximg"), track: !!deck.slides.find((s) => s.id === sid).beats[1]?.tracks[0], slides: deck.slides.length };
  }, asset);
  h.ok(placed.held && placed.track, "the deck holds the image and its Change (deck fold keeps fluximg)");
  await page.evaluate(() => { window.__flux.slide.activeBeat.set(1); });
  await clickText(".deckbar button", "Animate ⏱").catch(() => {});
  await paint();

  // ---- the preview: warm, play, measure ------------------------------------------------------------------------------------
  // A scrub creates the preview player (and warms in idle time); then the step plays.
  const scrubTo = (fraction) => page.evaluate(async (fraction) => {
    const el = document.querySelector(".ruler"), r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.x + r.width * fraction, clientY: r.y + 6, pointerId: 91 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 91 }));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }, fraction);
  await scrubTo(0);
  await waitFor(page, () => !!document.querySelector(".preview-overlay canvas[data-slide-fluximg]"), null, { timeout: 10000, label: "the preview mounts the image" });
  await waitFor(page, () => document.querySelector(".preview-overlay canvas[data-slide-fluximg]")?.style.display === "block", null, { timeout: 15000, label: "the first live frame" });
  await sleep(1500); // idle warming
  const rest = await page.evaluate(() => { const r0 = window.__fxRaf ?? 0; return r0; });
  await page.evaluate(() => { const real = window.requestAnimationFrame.bind(window); window.__fxRaf = 0; window.requestAnimationFrame = (cb) => { window.__fxRaf++; return real(cb); }; });
  await sleep(400);
  h.eq(await page.evaluate(() => window.__fxRaf), 0, "no animation frame at rest in the preview with an image on the slide");
  void rest;

  const before = await metrics(), s0 = await stats();
  const clickAt = await page.evaluate(() => { window.__fluxPlayAt = performance.now(); window.__flux.fluximgSlide.stats.mark = performance.now(); window.__flux.fluximgSlide.stats.firstAfterMark = -1; window.__fxFrames = 0; const real = window.requestAnimationFrame; let on = true; const tick = () => { if (!on) return; window.__fxFrames++; real(tick); }; real(tick); window.__fxStop = () => { on = false; }; return 0; });
  void clickAt;
  await page.evaluate(() => [...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Play")).click());
  await waitFor(page, () => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Pause")), null, { timeout: 5000, label: "playing" });
  await waitFor(page, () => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Play")), null, { timeout: 15000, label: "the step ends" });
  const after = await metrics(), s1 = await stats();
  const frames = await page.evaluate(() => { window.__fxStop(); return window.__fxFrames; });
  const per = (k) => ((after[k] - before[k]) * 1000) / Math.max(1, frames);
  const script = per("ScriptDuration"), layout = per("LayoutDuration"), style = per("RecalcStyleDuration");
  const asked = s1.asked - s0.asked, late = s1.late - s0.late;
  console.log(`  MEASURED (preview, 4 s walk over 240 planes): ${frames} frames; per frame main thread script ${script.toFixed(2)} ms + layout ${layout.toFixed(2)} ms + style ${style.toFixed(2)} ms = ${(script + layout + style).toFixed(2)} ms`);
  console.log(`  MEASURED: ${asked} image frames asked, ${late} showed an older frame than asked (${(100 * late / Math.max(1, asked)).toFixed(1)} %); first frame drawn ${s1.firstAfterMark >= 0 ? s1.firstAfterMark.toFixed(1) : "?"} ms after Play`);
  h.ok(frames > 100 && asked > 100, `the step played ${frames} frames, ${asked} of them asked the image for a frame`);
  h.ok(script + layout + style < 16, `main-thread work per frame stays far inside a 60 Hz frame (${(script + layout + style).toFixed(2)} ms; generous ceiling 16)`);

  // ---- it ends on the still: the last frame is the reference renderer's picture of the end state ---------------------------
  const ending = await page.evaluate(async (assetPath) => {
    const F = window.__flux, svc = F.fluximg.store.fluximgService();
    const canvas = document.querySelector(".preview-overlay canvas[data-slide-fluximg]");
    const w = canvas.width, h = canvas.height, copy = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d");
    copy.drawImage(canvas, 0, 0);
    const got = copy.getImageData(0, 0, w, h).data;
    const href = await svc.still(`gate-end-${w}x${h}`, { bundle: `fig/${assetPath}`, view: { index: { t: 239 } }, crop: null, outWidth: w, outHeight: h });
    const img = new Image(); img.src = href; await img.decode();
    const c = document.createElement("canvas"); c.width = w; c.height = h; const k = c.getContext("2d"); k.drawImage(img, 0, 0);
    const ref = k.getImageData(0, 0, w, h).data;
    let max = 0; for (let i = 0; i < ref.length; i++) max = Math.max(max, Math.abs(ref[i] - got[i]));
    return { w, h, max, visible: canvas.style.display };
  }, asset.path);
  h.ok(ending.visible === "block" && ending.max <= 1, `the preview ends on the end state's still (${ending.w}x${ending.h}, max diff ${ending.max})`);

  // ---- scrub: a parked frame lands exactly, with no frame loop ----------------------------------------------------------
  await page.evaluate(() => { window.__fxRaf = 0; });
  const sc0 = await stats();
  await scrubTo(0.37);
  await waitFor(page, () => window.__flux.fluximgSlide.stats.pending === 0, null, { timeout: 10000, label: "the scrubbed frame lands" });
  await sleep(300);
  const sc1 = await stats();
  h.ok(sc1.asked > sc0.asked, "a scrub asks the image for the frame at that time");
  console.log(`  scrub: ${await page.evaluate(() => window.__fxRaf)} animation frames requested around one scrub (the ruler's own paint included)`);

  // ---- the baseline: the same 4 s preview of a slide WITHOUT an image (a box moving), measured the same way -------------------
  await clickText(".transport button", "■ Stop").catch(() => {});
  const other = await page.evaluate(() => {
    const F = window.__flux, d = F.slide.currentDeck(), sid = d.slides[1].id;
    F.fig.activeFigureId.set(sid);
    return sid;
  });
  await paint();
  await page.evaluate((sid) => {
    const F = window.__flux;
    F.fig.commit((p) => { p.figures.find((f) => f.id === sid).elements = [{ id: "box", type: "rect", x: 60, y: 60, width: 120, height: 80, rotation: 0, opacity: 1, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 6 }]; });
    F.slide.commitDeckLive((d) => { const s = F.slideOps.slideById(d, sid); s.beats = [s.beats[0]]; const b = F.slideOps.addBeat(d, sid, { label: "move" }); F.slideOps.setTransform(d, sid, b.id, "box", { state: { x: 420 }, duration: 4000, easing: "linear" }); });
    F.slide.activeBeat.set(1);
  }, other);
  await paint();
  await scrubTo(0); await sleep(800);
  const bb = await metrics();
  await page.evaluate(() => { window.__fxFrames = 0; const real = window.requestAnimationFrame; let on = true; const tick = () => { if (!on) return; window.__fxFrames++; real(tick); }; real(tick); window.__fxStop = () => { on = false; }; });
  await page.evaluate(() => [...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Play")).click());
  await waitFor(page, () => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Pause")), null, { timeout: 5000, label: "baseline playing" });
  await waitFor(page, () => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Play")), null, { timeout: 15000, label: "baseline ends" });
  const ba = await metrics(), bframes = await page.evaluate(() => { window.__fxStop(); return window.__fxFrames; });
  const bper = (k) => ((ba[k] - bb[k]) * 1000) / Math.max(1, bframes);
  console.log(`  MEASURED baseline (preview, 4 s move of a box, no image): ${bframes} frames; per frame script ${bper("ScriptDuration").toFixed(2)} ms + layout ${bper("LayoutDuration").toFixed(2)} ms + style ${bper("RecalcStyleDuration").toFixed(2)} ms`);
  await clickText(".transport button", "■ Stop").catch(() => {});
  await page.evaluate(() => { const F = window.__flux; F.fig.activeFigureId.set(F.slide.currentDeck().slides[0].id); });
  await paint();

  // ---- Present: plays, and leaving the slide gives the GPU back ------------------------------------------------------------
  await page.keyboard.press("F5");
  await waitFor(page, () => !!document.querySelector(".present canvas[data-slide-fluximg], [class*=present] canvas[data-slide-fluximg]"), null, { timeout: 10000, label: "Present shows the image" });
  await waitFor(page, () => [...document.querySelectorAll("canvas[data-slide-fluximg]")].some((c) => c.style.display === "block"), null, { timeout: 15000, label: "a live frame in Present" });
  const p0 = await stats();
  await page.keyboard.press("ArrowRight");
  await sleep(4600);
  const p1 = await stats();
  h.ok(p1.asked - p0.asked > 100, `Present plays the walk (${p1.asked - p0.asked} image frames)`);
  const gpuOn = p1.hosts;
  await page.keyboard.press("ArrowRight");   // the next slide (no image)
  await sleep(300);
  const gpuOff = (await stats()).hosts;
  console.log(`  MEASURED GPU: on the image slide ${gpuOn.textures} textures (${(gpuOn.textureBytes / 1048576).toFixed(1)} MiB), after the slide changes ${gpuOff.textures} (${(gpuOff.textureBytes / 1048576).toFixed(1)} MiB)`);
  h.ok(gpuOn.textures > 0 && gpuOff.textures === 0 && gpuOff.liveSurfaces === 0, "leaving the image slide in Present frees every GL texture");
  await page.keyboard.press("Escape");
  await sleep(300);
  h.eq(realErrors(page), [], "no console errors");
} catch (error) {
  h.fail(String(error?.stack ?? error));
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
await h.done();
