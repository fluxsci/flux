// verify-fluximg-movie-gui (ui tier; dev server up, FLUX_URL for a worktree): the board's "Movie as MP4" key (fluximg
// stage 2, W10) in the headless app. The dev bridge is in memory: the save dialog and the out-of-process writer are
// stood in for at their seam (`window.fig.exportImageMovie` / `cancelImageMovie` / `onImageMovieProgress`), as the
// slide-video gates do; the real file is the pure gate's business (verify-fluximg-movie.ts).
//   * The key stands in each playable rail's own group, in Figure mode and on a slide (Design and at a step), with its
//     hotkey; it sits inside its rail, clear of the well, the flag and the projection key; the board's layout law holds
//     at the narrow widths the live gate uses.
//   * Hover previews: the walk ghost on the rail and the facts in the readout line ("N frames · s at fps · W × H",
//     equal to the pure planner's words); nothing is written (no request, no history step, the project unchanged).
//   * Press: what is on screen is saved first, then ONE request (element, dimension, range, speed; on a slide its
//     deckId/slideId, at a step its beat); the key becomes the progress instrument (lit, its ring filled to the
//     progress); press again cancels (the job id); Shift+R from the keyboard does the same; completion reports where it went.
//   * A clean console; nothing animates at rest before and after (document.getAnimations, live frames over a second).
//   * Frame gaps of a playing board while a real export runs in another process, against the same board without one
//     (measured; needs the pinned encoder, else said).
// Screenshots: test-results/scratch/shots/movie-{figure,slide}-{rest,hover,writing}.png
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-movie-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame, sleep, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFixture } from "./lib/fluximgFixtures.ts";
import { tsxRun } from "./lib/tsxRun.mjs";

const h = harness("verify-fluximg-movie-gui");
const SHOTS = "test-results/scratch/shots";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "fx-movie-gui-"));
{
  // Time (8 frames, 0.5 s apart) and depth (5 planes), two channels, a pixel size: both rails, a scale bar, a stamp.
  const T = 8, C = 2, Z = 5, Hh = 36, Ww = 48, d = new Uint16Array(T * C * Z * Hh * Ww);
  let k = 0;
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let z = 0; z < Z; z++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) d[k++] = 100 + ((x * (c + 1) * 9 + y * 5 + t * 70 + z * 110) % 1200);
  await writeFixture(scratch, { name: "tz_u16", about: "time and depth", dims: ["t", "c", "z", "y", "x"], shape: [T, C, Z, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { t: { unit: "s", scale: 0.5 }, z: { unit: "µm", scale: 1.5 }, y: { unit: "µm", scale: 0.3 }, x: { unit: "µm", scale: 0.3 } }, channels: [{ name: "a", color: "#ff00ff" }, { name: "b", color: "#00ff00" }] } });
}
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
const F = (fn, arg) => page.evaluate(fn, arg);
const box = (sel) => F((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const overlaps = (a, b) => !(a.right <= b.x + 0.5 || a.x >= b.right - 0.5 || a.bottom <= b.y + 0.5 || a.y >= b.bottom - 0.5);
const within = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const isOpen = () => F(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const readout = () => F(() => document.querySelector("[data-fxb-movieline]")?.textContent.trim() ?? null);
const keyState = (dim) => F((dim) => { const w = document.querySelector(`[data-fxb-movie="${dim}"]`); const k = w?.querySelector("[data-fxb-key]"); return w ? { writing: w.classList.contains("writing"), progress: w.getAttribute("data-progress"), on: k?.getAttribute("aria-pressed") === "true", label: k?.getAttribute("data-tip"), hk: k?.getAttribute("data-hk"), dash: w.querySelector(".go")?.getAttribute("stroke-dasharray") ?? null } : null; }, dim);
const atRest = async () => {
  await sleep(450);
  return F(async () => {
    let frames = 0;
    const count = () => { frames++; };
    document.addEventListener("flux-fluximg-frame", count);
    await new Promise((r) => setTimeout(r, 1000));
    document.removeEventListener("flux-fluximg-frame", count);
    return { animations: document.getAnimations().filter((a) => a.playState !== "finished").map((a) => `${a.animationName ?? a.constructor.name}@${a.effect?.target?.className ?? ""}`), frames };
  });
};
async function openBoard(id, onSlide) {
  if (await isOpen()) return;
  await F((id) => window.__flux.fig.selectOnly(id), id);
  const r = await box(`[data-editor-element-id="${id}"]`) ?? await F((id) => { const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id), n = document.querySelector(`svg[data-fluximg="${el.assetId}"]`)?.getBoundingClientRect(); return n ? { cx: n.left + n.width / 2, cy: n.top + n.height / 2 } : null; }, id);
  if (r) await page.mouse.move(r.cx, r.cy);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "the board open", timeout: 10000 });
  if (onSlide) await waitFor(page, () => !!document.querySelector("[data-fxb-step]"), null, { label: "the step card", timeout: 5000 });
}
const closeBoard = async () => { if (await isOpen()) { await F(() => window.__flux.fluximg.live.closeFluximgLive()); await waitForFrame(page); } };
/** The pure planner's words for what the key on `dim` would write (the same module, through the dev handle's import). */
const plannedFacts = (id, dim) => F(async ({ id, dim }) => {
  const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id), m = f.get(f.fluximg.store.fluximgManifests)[el.assetId];
  const mv = await import("/src/lib/fluximg/live/movie.ts");
  const s = mv.movieOf(m, el, dim, f.get(f.fluximg.live.fluximgLive)?.speed ?? 1);
  return s ? { facts: mv.movieFacts(s), from: s.from, to: s.to } : null;
}, { id, dim });

/** The seam: requests recorded, progress pushed by the gate, completion or cancel decided by the gate. */
async function installSeam() {
  await F(() => {
    const seam = window.__movie = { calls: [], cancels: [], progress: null, pending: null };
    window.fig.onImageMovieProgress = (cb) => { seam.progress = cb; return () => { if (seam.progress === cb) seam.progress = null; }; };
    window.fig.exportImageMovie = (req) => new Promise((resolve) => { seam.calls.push(structuredClone(req)); seam.pending = { req, resolve }; });
    window.fig.cancelImageMovie = async (jobId) => { seam.cancels.push(jobId); const p = seam.pending; seam.pending = null; p?.resolve({ ok: false, cancelled: true }); };
  });
}
const seam = () => F(() => ({ calls: window.__movie.calls, cancels: window.__movie.cancels, pending: !!window.__movie.pending }));
const pushProgress = (frame, total) => F(({ frame, total }) => { const s = window.__movie; s.progress?.({ jobId: s.pending.req.jobId, phase: "encoding", frame, total }); }, { frame, total });
const finish = (extra = {}) => F((extra) => { const s = window.__movie, p = s.pending; s.pending = null; p.resolve({ ok: true, path: `${p.req.root}/exports/${p.req.name.replace(/\W+/g, "-")}.mp4`, frames: 8, durationMs: 4000, fps: 2, width: 240, height: 180, bytes: 12345, warnings: [], ...extra }); }, extra);

/** One mode's checks: the key, its hover preview, a press, progress, cancel, the keyboard, completion. */
async function exercise(label, id, onSlide, step) {
  await installSeam();
  await openBoard(id, onSlide);
  await page.mouse.move(5, 940);
  const tKey = await box('[data-fxb-key="movie:t"]'), zKey = await box('[data-fxb-key="movie:z"]');
  const railT = await box('[data-fxb-rail="t"]'), railZ = await box('[data-fxb-rail="z"]');
  h.ok(!!tKey && !!zKey && within(tKey, railT) && within(zKey, railZ), `${label}: a "Movie as MP4" key in each playable rail's own group (time, depth), inside its rail`);
  const clear = async (dim) => {
    const k = await box(`[data-fxb-movie="${dim}"]`), others = [await box(`[data-fxb-rail="${dim}"] [data-fxb-track]`), await box(`[data-fxb-key="project:${dim}"]`), await box(`[data-fxb-rail="${dim}"] [data-fxb-flag]`), await box(`[data-fxb-key="play:${dim}"]`)].filter(Boolean);
    return others.every((o) => !overlaps(k, o));
  };
  h.ok(await clear("t") && await clear("z"), `${label}: clear of the rail's well, its flag, its Play key and its projection key`);
  const st = await keyState("t");
  h.ok(st.label === "Movie as MP4" && st.hk === "⇧R" && !st.on && !st.writing, `${label}: labelled "${st.label}" with its key Shift+R; not lit at rest`);
  await page.screenshot({ path: `${SHOTS}/movie-${onSlide ? "slide" : "figure"}-rest.png` });
  let rest = await atRest();
  h.ok(rest.animations.length === 0 && rest.frames === 0, `${label}: nothing animates at rest (${rest.animations.length} animations, ${rest.frames} live frames in a second)`);

  // Hover: the ghost and the facts; nothing written.
  const before = await F(() => ({ past: window.__flux.fig.historyStats().past, project: JSON.stringify(window.__flux.figures()) }));
  await page.mouse.move(tKey.cx, tKey.cy);
  await waitFor(page, () => !!document.querySelector("[data-fxb-movieline]"), null, { label: "the facts in the readout", timeout: 3000 });
  const plan = await plannedFacts(id, "t"), words = await readout();
  h.ok(!!plan && words === plan.facts && /^\d[\d,]* frames · [\d.]+ (s|min) at [\d.]+ fps · \d+×\d+$/.test(words), `${label}: hovering shows what it would write in the readout: "${words}"`);
  const ghost = await F(() => { const g = document.querySelector('[data-fxb-rail="t"] [data-fxb-walk="ghost"]'); return g ? g.querySelector("line").getAttribute("x1") + ">" + g.querySelector("line").getAttribute("x2") : null; });
  h.ok(!!ghost && !!(await box('[data-fxb-rail="t"] [data-fxb-ghostflag]')), `${label}: …and its walk as a ghost on the time rail (planes ${plan.from + 1} to ${plan.to}), with its end flag`);
  await page.screenshot({ path: `${SHOTS}/movie-${onSlide ? "slide" : "figure"}-hover.png` });
  const after = await F(() => ({ past: window.__flux.fig.historyStats().past, project: JSON.stringify(window.__flux.figures()) }));
  h.ok((await seam()).calls.length === 0 && after.past === before.past && after.project === before.project, `${label}: hovering writes nothing (no request, no undo step, the project unchanged)`);

  // Press: one request; the key is the progress instrument.
  await page.mouse.click(tKey.cx, tKey.cy);
  await waitFor(page, () => window.__movie.calls.length === 1, null, { label: "the request", timeout: 5000 });
  const req = (await seam()).calls[0];
  const wantSlide = onSlide ? await F(() => { const f = window.__flux; return `${f.get(f.slide.deckOverlay).id}/${f.get(f.fig.activeFigureId)}`; }) : undefined;
  h.ok(req.elementId === id && req.dim === "t" && req.from === plan.from && req.to === plan.to && req.slide === wantSlide && req.beatId === (step ?? undefined) && typeof req.jobId === "string" && req.name.length > 0,
    `${label}: a press sends ONE request: element, dimension t, planes ${req.from}..${req.to}${onSlide ? `, slide ${req.slide}` : ""}${step ? `, beat ${req.beatId}` : ""}, name "${req.name}"`);
  h.ok(await F(() => !window.__flux.get(window.__flux.fig.dirty)), `${label}: what is on screen was saved first (nothing dirty)`);
  let k = await keyState("t");
  h.ok(k.writing && k.on && /Writing the movie/.test(k.label), `${label}: the key is lit and says it is writing ("${k.label}")`);
  await pushProgress(3, 8);
  await waitFor(page, () => document.querySelector('[data-fxb-movie="t"]')?.getAttribute("data-progress") === "0.375", null, { label: "the progress on the key", timeout: 3000 });
  k = await keyState("t");
  h.ok(k.dash === "37.5 100" && /3 of 8 frames/.test(k.label), `${label}: its ring fills with the frames written (3 of 8: ${k.dash})`);
  h.ok(/^Writing the movie · 3 of 8 frames/.test(await readout() ?? ""), `${label}: the readout follows it: "${await readout()}"`);
  await page.mouse.move(5, 940);
  await page.screenshot({ path: `${SHOTS}/movie-${onSlide ? "slide" : "figure"}-writing.png` });
  // Live while it writes: the board still answers (a plane step).
  const i0 = await F(() => window.__flux.fluximg.actions.liveContext().view.index.z ?? 0);
  await F(() => window.__flux.fluximg.actions.stepPosition("z", 1));
  await waitForFrame(page);
  const i1 = await F(() => window.__flux.fluximg.actions.liveContext().view.index.z ?? 0);
  h.ok(i1 === i0 + 1, `${label}: the board stays live while the movie is written (depth ${i0} → ${i1})`);
  await F(() => window.__flux.fluximg.actions.stepPosition("z", -1));

  // Press again: cancel.
  await page.mouse.click(tKey.cx, tKey.cy);
  await waitFor(page, () => window.__movie.cancels.length === 1, null, { label: "the cancel", timeout: 3000 });
  h.eq((await seam()).cancels[0], req.jobId, `${label}: pressed again, it cancels (that job)`);
  await waitFor(page, () => !document.querySelector('[data-fxb-movie="t"]')?.classList.contains("writing"), null, { label: "the key back at rest", timeout: 3000 });
  h.ok(/Movie stopped/.test(await readout() ?? ""), `${label}: the readout says it stopped: "${await readout()}"`);

  // Shift+R from the keyboard: the rail in hand (time), to completion.
  await F(() => window.__flux.fluximg.live.armLive("pos:t"));
  await press("r", ["Shift"]);
  await waitFor(page, () => window.__movie.calls.length === 2, null, { label: "the keyboard's request", timeout: 5000 });
  h.ok((await seam()).calls[1].dim === "t", `${label}: Shift+R writes the movie of the rail in hand`);
  await finish();
  await waitFor(page, () => /Saved/.test(document.querySelector("[data-fxb-movieline]")?.textContent ?? ""), null, { label: "the report", timeout: 3000 });
  h.ok(/^Saved · 8 frames · 4\.0 s · [\w-]+\.mp4$/.test(await readout()) && /\/exports\/[\w-]+\.mp4$/.test(await F(() => document.querySelector("[data-fxb-movieline]").getAttribute("data-tip"))), `${label}: completion reports where it went: "${await readout()}" (the full path on its label)`);
  // Refused: the writer's own words.
  await page.mouse.click(zKey.cx, zKey.cy);
  await waitFor(page, () => window.__movie.calls.length === 3, null, { label: "the depth request", timeout: 5000 });
  h.ok((await seam()).calls[2].dim === "z", `${label}: the depth rail's key writes the depth movie`);
  await F(() => { const p = window.__movie.pending; window.__movie.pending = null; p.resolve({ ok: false, error: "The video encoder is not installed, so the movie cannot be written." }); });
  await waitFor(page, () => /not written/.test(document.querySelector("[data-fxb-movieline]")?.textContent ?? ""), null, { label: "the refusal", timeout: 3000 });
  h.ok(await F(() => document.querySelector("[data-fxb-movieline]").classList.contains("bad")), `${label}: a refusal is said in the readout, in the warning colour: "${await readout()}"`);
  await page.mouse.move(5, 940);
  rest = await atRest();
  h.ok(rest.animations.length === 0 && rest.frames === 0, `${label}: nothing animates at rest afterwards either (${rest.animations.length}, ${rest.frames})`);
  await closeBoard();
}

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2000 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fluximg && !!document.querySelector(".canvas-host"), null, { label: "Figure mode with the dev handle", timeout: 15000 });
  await installSeam();
  const place = (files) => F(async (files) => {
    const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
    window.__fluxSeedFluximg("plots/tz.fluximg", files);
    const assetId = f.fluximg.place.fluximgAssetId("tz", Math.random().toString(36).slice(2));
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/tz.fluximg", assetId });
    const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/tz.fluximg");
    let id;
    f.fig.commit((p) => { const s = p.figures.find((x) => x.id === sid); id = f.ops.addFluximg(p, { figureId: sid, asset, x: 200, y: 70, width: 240 }); s.elements.find((e) => e.id === id).view = { furniture: { scalebar: {}, stamp: {} } }; });
    return id;
  }, files);
  const files = bundleFiles("tz_u16");

  // ------------------------------------------------------------------------------------------------------------
  h.section("Figure mode");
  await F(() => { const f = window.__flux; f.fig.commit((p) => { const g = p.figures[0]; g.x = 0; g.y = 0; g.width = 1400; g.height = 1100; }); f.fig.viewport.set({ panX: 240, panY: 110, zoom: 1 }); });
  const FIG = await place(files);
  await waitFor(page, (id) => { const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id); return !!el && !!f.get(f.fluximg.store.fluximgManifests)[el.assetId]; }, FIG, { label: "its manifest", timeout: 15000 });
  await exercise("Figure", FIG, false, null);

  // The layout law with the key, at the narrow widths the live gate uses (an image 150 px wide: the rails at their least).
  for (const width of [150, 320]) {
    await F(({ id, width }) => { const f = window.__flux; f.fig.commit((p) => { const el = p.figures.flatMap((g) => g.elements).find((e) => e.id === id); el.width = width; el.height = width * 36 / 48; }); }, { id: FIG, width });
    await openBoard(FIG, false);
    await page.mouse.move(5, 940); await sleep(120); await waitForFrame(page);
    const parts = await F(() => [...document.querySelectorAll("[data-fxb-console], [data-fxb-rail]")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom }; }));
    const image = await box("[data-fluximg-live]"), host = await box(".canvas-host");
    const keys = await F(() => [...document.querySelectorAll("[data-fxb-movie]")].map((w) => { const r = w.getBoundingClientRect(), rail = w.closest("[data-fxb-rail]").getBoundingClientRect(); return r.left >= rail.left - 0.5 && r.right <= rail.right + 0.5 && r.top >= rail.top - 0.5 && r.bottom <= rail.bottom + 0.5; }));
    h.ok(parts.every((p, i) => parts.every((q, k) => k <= i || !overlaps(p, q))) && parts.every((p) => !overlaps(p, image) && within(p, host)) && keys.length === 2 && keys.every(Boolean),
      `an image ${width} px wide: the board's law holds (nothing covers the image or another instrument, all inside the canvas) and both movie keys stand inside their rails`);
    await closeBoard();
  }

  // ------------------------------------------------------------------------------------------------------------
  h.section("On a slide: Design, then at a step");
  await clickMode(page, "Slide", { settle: 2000 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  await installSeam();
  const SL = await place(files);
  await F(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats = [s.beats[0], { id: "mv1", label: "Step 1", tracks: [] }]; }); f.slide.setEditDestination({ kind: "design" }); f.fig.resetHistory(); });
  await waitFor(page, (id) => { const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id); return !!el && !!f.get(f.fluximg.store.fluximgManifests)[el.assetId]; }, SL, { label: "its manifest", timeout: 15000 });
  await exercise("Slide (Design)", SL, true, null);
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(1); f.slide.editAfterBeat(1); });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.editDestination).kind === "after", null, { label: "Edit after step 1" });
  await exercise("Slide (at step 1)", SL, true, "mv1");

  // ------------------------------------------------------------------------------------------------------------
  h.section("The board's frame budget while a movie is written in another process");
  const encoder = process.env.FLUX_VIDEO_ENCODER || path.resolve("build/video-encoder", `${process.platform}-${process.arch}`, "ffmpeg");
  await openBoard(SL, true);
  const gaps = async () => F(async () => {
    const f = window.__flux;
    f.fluximg.actions.togglePlayback("t", "loop", 30);
    const times = [];
    await new Promise((resolve) => { const start = performance.now(); const tick = (now) => { times.push(now); if (now - start < 2500) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
    f.fluximg.actions.togglePlayback("t");
    const d = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    return { p50: d[Math.floor(d.length * 0.5)], p95: d[Math.floor(d.length * 0.95)], max: d.at(-1), n: d.length };
  });
  if (!existsSync(encoder)) console.log("SKIP (native-encoder: the pinned video encoder is not installed): the frame budget while a real movie is written");
  else {
    const idle = await gaps();
    // A real export of a synthetic stack, out of process, as the app runs it; progress pushed to the key at the real rate.
    const proj = mkdtempSync(path.join(tmpdir(), "fx-movie-gui-load-"));
    const load = spawn(process.execPath, ["--import", "tsx", "-e", `
      import "./scripts/lib/cssStub.mjs";
      const { makeProject } = await import("./scripts/lib/fluximgSlideExportFixture.ts");
      const P = await makeProject({ T: 240, H: 512, W: 512, C: 2 });
      const { exportImageMovie } = await import("./flux-core/fluximgMovie.ts");
      process.stdout.write("ready\\n");
      await exportImageMovie(P.root, P.placed.elementId, { out: P.scratch + "/load.mp4", slide: "talk/" + P.slideId, scale: 2, onProgress: (p) => process.stdout.write("p " + p.frame + " " + p.total + "\\n") });
      process.stdout.write("done\\n");
    `], { env: { ...process.env, FLUX_VIDEO_ENCODER: encoder }, stdio: ["ignore", "pipe", "inherit"] });
    let progressLines = 0, done = false;
    await new Promise((resolve) => load.stdout.on("data", (b) => { const t = String(b); if (t.includes("ready")) resolve(); progressLines += (t.match(/^p /gm) ?? []).length; if (t.includes("done")) done = true; }));
    await page.mouse.click((await box('[data-fxb-key="movie:t"]')).cx, (await box('[data-fxb-key="movie:t"]')).cy);
    await waitFor(page, () => !!window.__movie.pending, null, { label: "a job on the key", timeout: 5000 });
    const pusher = setInterval(() => { pushProgress(Math.min(progressLines, 479), 480).catch(() => {}); }, 150);
    await sleep(300);
    const busy = await gaps();
    clearInterval(pusher);
    load.kill("SIGKILL");
    await F(() => { const p = window.__movie.pending; window.__movie.pending = null; p?.resolve({ ok: false, cancelled: true }); });
    console.log(`  frame gaps of a playing board (ms): no export p50 ${idle.p50.toFixed(1)} p95 ${idle.p95.toFixed(1)} max ${idle.max.toFixed(1)} (${idle.n}); while a movie is written p50 ${busy.p50.toFixed(1)} p95 ${busy.p95.toFixed(1)} max ${busy.max.toFixed(1)} (${busy.n}); the writer reported ${progressLines} frames${done ? " and finished" : ""}`);
    h.ok(busy.n > 0 && progressLines > 0 && busy.p95 <= Math.max(idle.p95 * 1.5, idle.p95 + 8), `the board keeps its frame budget while a movie is written (p95 ${busy.p95.toFixed(1)} ms against ${idle.p95.toFixed(1)} ms without)`);
    void proj;
  }
  await closeBoard();

  h.eq([...errs], [], "no console errors");
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await browser.close();
await h.done();
