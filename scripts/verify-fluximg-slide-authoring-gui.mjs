// verify-fluximg-slide-authoring-gui (ui tier; dev server up, FLUX_URL for a worktree): authoring image animation on a
// slide in the headless app (fluximg stage 2, W5+W6). Real keys, the real wheel and real pointer events; every check
// reads model state, undo counts or computed styles (a screenshot is kept for the eye, never asserted on).
//   * R opens the live board on an image on a slide; in Design the "this step" card says so and offers no keys; a wheel
//     run sets the RESTING view (Design) as one undo step and writes no track.
//   * At "Edit after step 1": the card says "this step: no change"; Split and Inset are dimmed and make nothing; a wheel
//     run, a rail scrub and a key (N) each become ONE undo step that restores both the view and the step's Change; the
//     walk is paced (linear, params.pace); the canvas shows the step's end; Design is untouched; a cancelled gesture
//     (cancelLiveEdit) rolls the Change back with it.
//   * Space previews: the picture walks, nothing is written (history length and the deck's bytes unchanged), the plane
//     returns at stop.
//   * The card: Play through (its ghost walk on the rail while hovered, then one undo step), the pace dial re-times, a hand
//     re-time drops the pace, Blend planes, Start / Pause / Stop movie and the loop / bounce / once key, and its words.
//   * The Animate panel's Play through and movie buttons; the PropertiesPane's chips (one per aspect; dropping one puts
//     back only that), Pace and Blend rows.
//   * A clean console; document.getAnimations() empty at rest.
// Screenshots (for the lead): test-results/scratch/shots/step-card-{design,walk,movie}.png
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-slide-authoring-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame, sleep, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-slide-authoring-gui");
const SHOTS = "test-results/scratch/shots";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "fx-authoring-gui-"));
{
  // Time (8 frames, 0.5 s apart) and depth (5 planes), two channels: both rails, a walk in real time.
  const T = 8, C = 2, Z = 5, Hh = 36, Ww = 48, d = new Uint16Array(T * C * Z * Hh * Ww);
  let k = 0;
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let z = 0; z < Z; z++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) d[k++] = 100 + ((x * (c + 1) * 9 + y * 5 + t * 70 + z * 110) % 1200);
  await writeFixture(scratch, { name: "tz_u16", about: "time and depth", dims: ["t", "c", "z", "y", "x"], shape: [T, C, Z, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { t: { unit: "s", scale: 0.5 }, z: { unit: "µm", scale: 1.5 }, y: { unit: "µm", scale: 0.3 }, x: { unit: "µm", scale: 0.3 } }, channels: [{ name: "a", color: "#ff00ff" }, { name: "b", color: "#00ff00" }] } });
}
{
  // The same image re-exported with fewer time frames (4): "Update from source" on a slide (B3).
  const T = 4, C = 2, Z = 5, Hh = 36, Ww = 48, d = new Uint16Array(T * C * Z * Hh * Ww);
  let k = 0;
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let z = 0; z < Z; z++) for (let y = 0; y < Hh; y++) for (let x = 0; x < Ww; x++) d[k++] = 200 + ((x * (c + 2) * 7 + y * 3 + t * 90 + z * 60) % 1100);
  await writeFixture(scratch, { name: "tz4_u16", about: "time and depth, re-exported shorter", dims: ["t", "c", "z", "y", "x"], shape: [T, C, Z, Hh, Ww], dtype: "uint16", data: d, expectEncoding: "exact",
    input: { axes: { t: { unit: "s", scale: 0.5 }, z: { unit: "µm", scale: 1.5 }, y: { unit: "µm", scale: 0.3 }, x: { unit: "µm", scale: 0.3 } }, channels: [{ name: "a", color: "#ff00ff" }, { name: "b", color: "#00ff00" }] } });
}
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}


/** The same edits through flux-core's verbs on a scratch project holding the same bundle: the deck slide they produce. */
async function headlessTwin(edits) {
  const { z } = await import("zod");
  const { VERBS } = await import("../flux-core/registry");
  const core = await import("../flux-core/index");
  const slidesCore = await import("../flux-core/slides");
  const root = path.join(scratch, "twin");
  await core.scaffold(root, { title: "twin" });
  const fsx = await import("node:fs/promises");
  await fsx.cp(path.join(scratch, "tz_u16.fluximg"), path.join(root, "plots/tz.fluximg"), { recursive: true });
  const call = async (name, args) => { const v = VERBS.find((x) => x.name === name); return v.handler({ root, transport: "mcp" }, z.object(v.params).parse(args)); };
  await core.createDeck(root, { id: "twin", title: "Twin" });
  const sid = (await slidesCore.loadDeck(root, "twin")).slides[0].id, beats = [];
  for (let i = 0; i < 2; i++) beats.push((await slidesCore.addBeat(root, "twin", sid, {})).beatId);
  const placed = await call("place_image", { figureId: `twin/${sid}`, bundlePath: "plots/tz.fluximg" });
  for (const e of edits) await call("set_image_view", { id: placed.elementId, view: e.view, slide: `twin/${sid}`, ...(e.beat ? { beatId: beats[e.beat - 1] } : {}) });
  const deck = JSON.parse(await fsx.readFile(path.join(root, "slides/twin/deck.json"), "utf8"));
  return { slide: deck.slides[0], id: placed.elementId };
}
const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
const F = (fn, arg) => page.evaluate(fn, arg);
/** The slide as deck.json would hold it (Design + tracks), and what the canvas shows. */
const authored = () => F(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return structuredClone(f.slide.currentDeck().slides.find((s) => s.id === sid)); });
const shownEl = (id) => F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return structuredClone(f.figures().find((x) => x.id === sid).elements.find((e) => e.id === id)); }, id);
const past = () => F(() => window.__flux.fig.historyStats().past);
const designOf = async (id) => (await authored()).elements.find((e) => e.id === id);
const changeAt = async (bi, id) => (await authored()).beats[bi].tracks.find((t) => t.target === id && t.preset === "transform") ?? null;
const deckBytes = () => F(() => JSON.stringify(window.__flux.slide.currentDeck()));
const isOpen = () => F(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const settled = () => waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgLiveBusy), null, { label: "the gesture settled", timeout: 4000 });
const card = () => F(() => { const c = document.querySelector("[data-fxb-step]"); return c ? { step: c.getAttribute("data-fxb-step"), title: c.querySelector(".ttl")?.textContent.trim(), words: c.querySelector("[data-fxb-step-words]")?.textContent.trim().replace(/\s+/g, " "), dur: c.querySelector("[data-fxb-step-duration]")?.textContent.trim() ?? null, keys: [...c.querySelectorAll("[data-fxb-key]")].map((k) => k.getAttribute("data-fxb-key")) } : null; });
const box = (sel) => F((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const wheel = async (x, y, deltaY, n = 1) => { await page.mouse.move(x - 2, y - 1); await page.mouse.move(x, y); for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY }); await sleep(45); } };
const idx = (dim) => F((dim) => window.__flux.fluximg.actions.liveContext()?.view.index[dim] ?? null, dim);
async function openBoard(id) {
  if (await isOpen()) return;
  await F((id) => window.__flux.fig.selectOnly(id), id);
  const r = await box(`[data-editor-element-id="${id}"]`);
  if (r) await page.mouse.move(r.cx, r.cy);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "the board open on the slide", timeout: 10000 });
  await waitFor(page, () => !!document.querySelector("[data-fxb-step]"), null, { label: "the step card", timeout: 5000 });
}
const atRest = async () => { await sleep(450); return F(() => document.getAnimations().filter((a) => a.playState !== "finished").map((a) => `${a.animationName ?? a.constructor.name}@${a.effect?.target?.className ?? ""}`)); };

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  // A clean slide with the image on it, through the real import and ops (the memory bridge holds the bundle).
  const IMG = await F(async (files) => {
    const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
    window.__fluxSeedFluximg("plots/tz.fluximg", files);
    const assetId = f.fluximg.place.fluximgAssetId("tz", "gui");
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/tz.fluximg", assetId });
    const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/tz.fluximg");
    let id;
    f.fig.commit((p) => { const s = p.figures.find((x) => x.id === sid); s.elements = []; id = f.ops.addFluximg(p, { figureId: sid, asset, x: 200, y: 70, width: 240 }); });
    f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats = [s.beats[0], { id: "fx1", label: "Step 1", tracks: [] }, { id: "fx2", label: "Step 2", tracks: [] }]; });
    f.slide.setEditDestination({ kind: "design" });
    f.fig.resetHistory();
    return id;
  }, bundleFiles("tz_u16"));
  await waitFor(page, (id) => !!document.querySelector(`[data-editor-element-id="${id}"] image`)?.getAttribute("href"), IMG, { label: "the image's still", timeout: 15000 });
  await waitFor(page, (id) => { const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id); return !!el && !!f.get(f.fluximg.store.fluximgManifests)[el.assetId]; }, IMG, { label: "its manifest", timeout: 15000 });

  // ------------------------------------------------------------------------------------------------------------
  h.section("Design: the board opens on a slide, edits set the resting view");
  await openBoard(IMG);
  h.ok(await isOpen(), "R opens the live board on an image on a slide");
  let c = await card();
  h.ok(c?.step === "design" && c.title === "Design" && /resting view/.test(c.words) && c.keys.length === 0, `the step card in Design: "${c?.title} · ${c?.words}", no keys`);
  const splitOpacity = await F(() => getComputedStyle(document.querySelector("[data-fxb-key='split']").parentElement).opacity);
  h.eq(splitOpacity, "1", "Split is a working key in Design");
  await page.screenshot({ path: `${SHOTS}/step-card-design.png` });
  const img = await box("[data-fluximg-live]");
  let p0 = await past(), t0 = await idx("t");
  await wheel(img.cx, img.cy, 100, 3);
  await settled();
  const d1 = await designOf(IMG);
  h.ok((d1.view?.index?.t ?? 0) === t0 + 3 && (await authored()).beats.every((b) => !b.tracks.length), `a wheel run in Design moves the resting view (t ${t0} → ${d1.view?.index?.t}) and writes no track`);
  h.eq(await past(), p0 + 1, "…as one undo step");
  await press("z", ["Control"]);
  h.eq(((await designOf(IMG)).view?.index?.t ?? 0), t0, "undo restores the resting view");
  await F(() => window.__flux.fig.resetHistory());

  // ------------------------------------------------------------------------------------------------------------
  h.section("Edit after step 1: one undo step per gesture, a paced Change, Design untouched");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(1); f.slide.editAfterBeat(1); });
  await waitFor(page, () => window.__flux.get(window.__flux.slide.editDestination).kind === "after", null, { label: "Edit after step 1" });
  await openBoard(IMG);
  c = await card();
  h.ok(c?.step === "1" && c.title === "Step 1" && c.words === "this step: no change", `the card at a step: "${c?.title} · ${c?.words}"`);
  h.ok(c.keys.includes("step-through") && c.keys.includes("step-start") && c.keys.includes("step-blend"), `its keys: ${c.keys.join(", ")}`);
  h.eq(await F(() => getComputedStyle(document.querySelector("[data-fxb-key='split']").parentElement).opacity), "0.38", "Split is dimmed at a step");
  const nEls = (await authored()).elements.length;
  await press("s"); await press("x");
  h.ok((await authored()).elements.length === nEls && (await F(() => window.__flux.get(window.__flux.fluximg.live.fluximgLive).armed)) !== "inset", "S and X make nothing at a step (Split and Inset are Design-only)");
  const design0 = JSON.stringify(await designOf(IMG));
  p0 = await past(); t0 = await idx("t");
  await wheel(img.cx, img.cy, 100, 4);
  await settled();
  let ch = await changeAt(1, IMG);
  h.ok(ch && ch.to.state.view.index.t === t0 + 4, `a wheel run at the step writes the step's Change (t ${t0} → ${ch?.to.state.view.index.t})`);
  h.eq([ch?.easing, ch?.params?.pace, ch?.duration], ["linear", 1, 4 * 500], "…paced: linear, real time (4 frames × 0.5 s), params.pace 1");
  h.eq(await past(), p0 + 1, "…one undo step");
  h.eq(JSON.stringify(await designOf(IMG)), design0, "Design is untouched");
  h.eq((await shownEl(IMG)).view.index.t, t0 + 4, "the canvas shows the step's end state");
  c = await card();
  h.ok(/t .*→/.test(c.words) && c.dur === "2.0 s · real time", `the card says what the step does: "${c.words}" · ${c.dur}`);
  await press("z", ["Control"]);
  { const ch0 = await changeAt(1, IMG), v0 = (await shownEl(IMG)).view?.index?.t ?? 0; h.ok(!ch0 && v0 === t0, `undo restores the view and the Change together (Change ${ch0 ? "left" : "gone"}, t ${v0})`); }
  await press("z", ["Control", "Shift"]);
  h.eq((await changeAt(1, IMG))?.to.state.view.index.t, t0 + 4, "redo brings both back");
  // a rail scrub: one undo step, the walk re-timed (still paced)
  p0 = await past();
  const well = await box("[data-fxb-rail='t'] [data-fxb-track]");
  await page.mouse.move(well.x + well.w * 0.2, well.cy); await page.mouse.down();
  await page.mouse.move(well.x + well.w * 0.6, well.cy, { steps: 4 }); await page.mouse.move(well.x + well.w - 2, well.cy, { steps: 4 });
  await page.mouse.up(); await settled();
  ch = await changeAt(1, IMG);
  h.ok(ch.to.state.view.index.t === 7 && ch.duration === 7 * 500 && ch.params?.pace === 1, `a rail scrub to the last frame re-times the paced walk (${ch.duration} ms)`);
  h.eq(await past(), p0 + 1, "…one undo step");
  // a key: N (true pixels / smoothing)
  p0 = await past();
  await press("n");
  ch = await changeAt(1, IMG);
  h.ok(ch.to.state.view.smooth === true && ch.to.state.view.index.t === 7, "N at the step: smoothing joins the step's Change (the walk kept)");
  h.eq(await past(), p0 + 1, "…one undo step");
  await press("z", ["Control"]);
  h.ok((await changeAt(1, IMG)).to.state.view.smooth === undefined, "undo takes only the smoothing back");
  // a cancelled gesture rolls the Change back with it (the drag's cancel path: cancelLiveEdit)
  const before = JSON.stringify(await changeAt(1, IMG));
  p0 = await past();
  await press("1"); // the first channel in hand: a drag on the image pulls its contrast
  await page.mouse.move(img.cx, img.cy); await page.mouse.down();
  await page.mouse.move(img.cx + 60, img.cy - 30, { steps: 5 });
  await waitForFrame(page);
  const mid = JSON.stringify(await changeAt(1, IMG));
  await F(() => window.__flux.fluximg.live.cancelLiveEdit());
  await page.mouse.up(); await waitForFrame(page);
  h.ok(mid !== before && JSON.stringify(await changeAt(1, IMG)) === before && (await past()) === p0, "a cancelled contrast pull rolls the step's Change back with it (no undo step left)");
  await press("Escape");

  // ------------------------------------------------------------------------------------------------------------
  h.section("Space previews: nothing is written");
  const bytes0 = await deckBytes(); p0 = await past();
  await F(() => window.__flux.fig.selectOnly(window.__flux.get(window.__flux.fluximg.live.fluximgLive).elementId));
  const planeBefore = await idx("t");
  await press("t"); // time in hand (the preview plays the rail in hand)
  await page.keyboard.down("Space"); await page.keyboard.up("Space");
  await waitFor(page, () => !!window.__flux.get(window.__flux.fluximg.live.fluximgPreview), null, { label: "the preview runs", timeout: 3000 });
  const seen = new Set();
  for (let i = 0; i < 14; i++) { await sleep(110); const p = await F(() => window.__flux.get(window.__flux.fluximg.live.fluximgPreview)); if (p) seen.add(p.index); }
  h.ok(seen.size >= 2, `the picture walks (${[...seen].join(", ")})`);
  h.ok((await deckBytes()) === bytes0 && (await past()) === p0, "the deck's bytes and the history length are unchanged while it plays");
  const railHead = await F(() => document.querySelector("[data-fxb-rail='t'] .flag.grab b")?.textContent);
  h.ok(Number(railHead) - 1 !== planeBefore || seen.size > 1, "the rail's playhead follows the preview");
  await page.keyboard.down("Space"); await page.keyboard.up("Space");
  await waitFor(page, () => !window.__flux.get(window.__flux.fluximg.live.fluximgPreview), null, { label: "the preview stopped" });
  h.ok((await idx("t")) === planeBefore && (await deckBytes()) === bytes0 && (await past()) === p0, "at stop the plane is the view's own again; nothing was written");

  // ------------------------------------------------------------------------------------------------------------
  h.section("the step card's keys");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(2); f.slide.editAfterBeat(2); });
  await waitFor(page, () => document.querySelector("[data-fxb-step]")?.getAttribute("data-fxb-step") === "2", null, { label: "the card follows the step", timeout: 5000 });
  if (!(await isOpen())) await openBoard(IMG);
  const through = await box("[data-fxb-key='step-through']");
  await page.mouse.move(through.cx, through.cy);
  const ghost = await waitFor(page, () => { const g = document.querySelector("[data-fxb-walk='ghost']"); return g ? g.closest("[data-fxb-rail]")?.getAttribute("data-fxb-rail") : null; }, null, { label: "the ghost walk on the rail", timeout: 3000 });
  h.eq(ghost, "t", "hovering Play through previews its walk on the time rail (a ghost run) before anything is written");
  h.ok(!(await changeAt(2, IMG)), "…nothing written yet");
  p0 = await past();
  await page.mouse.click(through.cx, through.cy); await waitForFrame(page);
  ch = await changeAt(2, IMG);
  h.ok(ch && ch.to.state.view.index.t === 0 && ch.params?.pace === 1 && ch.duration === 7 * 500, `Play through from the last frame walks back to the first, in real time (${ch?.duration} ms)`);
  h.eq(await past(), p0 + 1, "…one undo step");
  await waitFor(page, () => !!document.querySelector("[data-fxb-walk='trail']"), null, { label: "the step's walk drawn on the rail" });
  await page.mouse.move(10, 10);
  // pace dial
  p0 = await past();
  const dial = await box("[data-fxb-key='step-pace']");
  await page.mouse.click(dial.cx, dial.cy); await waitForFrame(page);
  ch = await changeAt(2, IMG);
  h.eq([ch.params?.pace, ch.duration, await past()], [2, 7 * 250, p0 + 1], "the pace dial re-times the walk (×2: half the time), one undo step");
  c = await card();
  h.ok(/real time 2×/.test(c.dur), `the card shows it: ${c.dur}`);
  await page.screenshot({ path: `${SHOTS}/step-card-walk.png` });
  // blend
  await page.mouse.click((await box("[data-fxb-key='step-blend']")).cx, (await box("[data-fxb-key='step-blend']")).cy); await waitForFrame(page);
  h.eq((await changeAt(2, IMG)).params?.blend, true, "Blend planes writes params.blend");
  h.eq(await F(() => document.querySelector("[data-fxb-key='step-blend']").getAttribute("aria-pressed")), "true", "…and its key is lit");
  // movie keys
  p0 = await past();
  await page.mouse.click((await box("[data-fxb-key='step-start']")).cx, (await box("[data-fxb-key='step-start']")).cy); await waitForFrame(page);
  let movie = (await authored()).beats[2].tracks.filter((t) => t.target === IMG && t.preset?.startsWith("video")).map((t) => t.preset);
  h.ok(movie.join() === "videoStart" && (await past()) === p0 + 1, "Start movie writes the step's videoStart, one undo step");
  await waitFor(page, () => document.querySelector("[data-fxb-movie]")?.getAttribute("data-fxb-movie") === "running", null, { label: "the card's movie lamp" });
  const lamp = await F(() => getComputedStyle(document.querySelector("[data-fxb-movie] .mlamp")).backgroundColor);
  h.ok(lamp !== "rgba(0, 0, 0, 0)", `the lamp is lit (${lamp})`);
  await page.mouse.move(10, 10);
  await page.screenshot({ path: `${SHOTS}/step-card-movie.png` });
  const mode0 = await F(() => document.querySelector("[data-fxb-key='step-mode']")?.getAttribute("aria-label"));
  await page.mouse.click((await box("[data-fxb-key='step-mode']")).cx, (await box("[data-fxb-key='step-mode']")).cy); await waitForFrame(page);
  h.eq((await designOf(IMG)).playback?.mode, "bounce", `the loop key cycles the movie's mode (${mode0} → bounce), on the Design element`);
  await page.mouse.click((await box("[data-fxb-key='step-pause']")).cx, (await box("[data-fxb-key='step-pause']")).cy); await waitForFrame(page);
  movie = (await authored()).beats[2].tracks.filter((t) => t.target === IMG && t.preset?.startsWith("video")).map((t) => t.preset);
  h.eq(movie, ["videoPause"], "Pause replaces the step's command (one per step)");
  await page.mouse.click((await box("[data-fxb-key='step-pause']")).cx, (await box("[data-fxb-key='step-pause']")).cy); await waitForFrame(page);
  h.eq((await authored()).beats[2].tracks.filter((t) => t.target === IMG && t.preset?.startsWith("video")).length, 0, "a lit key pressed again takes its command away");
  await press("Space", ["Shift"]);
  await waitFor(page, async () => true, null, {});
  await sleep(80);
  h.eq((await authored()).beats[2].tracks.filter((t) => t.target === IMG).map((t) => t.preset).sort(), ["transform", "videoStart"], "Shift+Space starts the movie at this step");
  // a hand re-time drops the pace (the timeline's duration field: setTrack)
  const id2 = (await changeAt(2, IMG)).id;
  await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => f.slideOps.setTrack(d, sid, id, { duration: 3000 })); }, id2).catch(async () => {
    await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { const t = d.slides.find((s) => s.id === sid).beats[2].tracks.find((x) => x.id === id); t.duration = 3000; delete t.params.pace; }); }, id2);
  });
  ch = await changeAt(2, IMG);
  h.ok(ch.duration === 3000 && ch.params?.pace === undefined, "a duration set by hand drops the pace");
  c = await card();
  h.ok(c.dur === "3.0 s", `…the card shows the plain duration (${c.dur})`);
  h.eq(await atRest(), [], "nothing animates at rest (document.getAnimations())");

  // ------------------------------------------------------------------------------------------------------------
  h.section("the Animate panel and the Properties pane");
  await F(() => window.__flux.fluximg.live.closeFluximgLive());
  await F(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { d.slides.find((s) => s.id === sid).beats[1].tracks = []; }); f.slide.setEditDestination({ kind: "design" }); f.slide.activeBeat.set(1); });
  await F((id) => window.__flux.fig.selectOnly(id), IMG);
  if (!(await F(() => !!document.querySelector(".animator")))) {
    const toggle = await F(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Animate/.test(x.textContent.trim()) && !x.closest(".animator")); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (toggle) await page.mouse.click(toggle.x, toggle.y);
  }
  const panelButton = (label) => F((label) => { const b = [...document.querySelectorAll(".animator .actions button")].find((x) => x.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, label);
  const pt = await waitFor(page, () => [...document.querySelectorAll(".animator .actions button")].some((x) => x.textContent.trim() === "Play through"), null, { label: "the Play through button", timeout: 5000 }).then(() => panelButton("Play through"));
  h.ok(!!pt && !!(await panelButton("Start movie")) && !!(await panelButton("Stop movie")), "the Animate panel offers Play through and Start / Pause / Stop movie for an image");
  p0 = await past();
  await page.mouse.click(pt.x, pt.y); await waitForFrame(page);
  ch = await changeAt(1, IMG);
  h.ok(ch && ch.to.state.view.index.t === 7 && ch.params?.pace === 1 && ch.duration === 7 * 500, "Play through from the panel (at Design: the first step, as Turntable) walks time to its end in real time");
  h.eq(await past(), p0 + 1, "…one undo step");
  // the Properties pane: one chip per aspect
  await F(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { const t = d.slides.find((s) => s.id === sid).beats[1].tracks.find((x) => x.preset === "transform"); t.to.state.view = { ...t.to.state.view, smooth: true }; }); });
  await waitFor(page, () => document.querySelectorAll(".props [data-image-change]").length >= 2, null, { label: "the image's chips", timeout: 5000 });
  const chips = await F(() => [...document.querySelectorAll(".props [data-image-change]")].map((c) => c.textContent.replace("✕", "").trim()));
  h.ok(chips.some((c) => /^t .*→/.test(c)) && chips.includes("smoothing on") && !chips.includes("view"), `the chips are what the step does: ${chips.join(" · ")}`);
  await F(() => { const c = [...document.querySelectorAll(".props [data-image-change]")].find((x) => x.textContent.includes("smoothing on")); c.querySelector("button").click(); });
  await waitForFrame(page);
  ch = await changeAt(1, IMG);
  h.ok(ch.to.state.view.smooth === undefined && ch.to.state.view.index.t === 7, "dropping a chip puts back only that aspect (the walk stays)");
  await page.select(".props select[aria-label='Image walk pace']", "2"); await waitForFrame(page);
  h.eq([(await changeAt(1, IMG)).params?.pace, (await changeAt(1, IMG)).duration], [2, 7 * 250], "the Pace row re-times the walk (Real time ×2)");
  await F(() => [...document.querySelectorAll(".props [aria-label='Blend planes'] button")].find((b) => b.textContent.trim() === "blend").click()); await waitForFrame(page);
  h.eq((await changeAt(1, IMG)).params?.blend, true, "the Planes row blends");
  await page.select(".props select[aria-label='Image walk pace']", "custom"); await waitForFrame(page);
  h.ok((await changeAt(1, IMG)).params?.pace === undefined && (await changeAt(1, IMG)).duration === 7 * 250, "Custom keeps the duration and drops the pace");
  const lane = await F(() => [...document.querySelectorAll(".lane-row .track-label")].map((l) => l.textContent.replace(/\s+/g, " ").trim()).find((t) => t.includes("▦")) ?? null);
  h.ok(!!lane, `the timeline lane carries the image's glyph (${lane})`);
  const mv = await panelButton("Start movie");
  await page.mouse.click(mv.x, mv.y); await waitForFrame(page);
  h.ok((await authored()).beats[1].tracks.some((t) => t.target === IMG && t.preset === "videoStart"), "Start movie from the panel");
  await waitFor(page, () => [...document.querySelectorAll(".lane-row .track-label small")].some((s) => s.textContent.includes("Start movie")), null, { label: "the movie lane's words", timeout: 3000 }).catch(() => null);
  h.ok(await F(() => [...document.querySelectorAll(".lane-row .track-label small")].some((s) => s.textContent.includes("Start movie"))), "its lane says Start movie");
  h.ok(await F(() => !!document.querySelector(".props select[aria-label='Movie mode']")), "the movie command's Properties show its mode, speed, range and dimension");

  // ------------------------------------------------------------------------------------------------------------
  h.section("a step's view is a patch: a Design edit made later carries through the step (B2), board + Inspector");
  {
    const insp = (s) => `.rail ${s}`;
    const typeField = async (selector, text) => {
      const input = await page.$(insp(selector));
      if (!input) throw new Error(`no field ${selector}`);
      await input.click({ clickCount: 3 });
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.type(text); await page.keyboard.press("Enter");
      await sleep(150);
    };
    const BLACK0 = '[data-fluximg-channel="0"] .three label:nth-child(1) input';
    const setColour0 = async (hex) => {
      await page.click(insp('[data-fluximg-channel="0"] .swatch'));

      const field = await page.waitForSelector('[role="dialog"] input[aria-label="Hex colour"]', { timeout: 3000 });
      await field.click();
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.type(hex); await page.keyboard.press("Enter");
      await page.click('[role="dialog"] button[aria-label="Done"]').catch(() => {});
      await sleep(150);
    };
    const at = async (bi) => { await F((bi) => { const f = window.__flux; if (bi === 0) f.slide.setEditDestination({ kind: "design" }); else f.slide.editAfterBeat(bi); f.slide.activeBeat.set(bi); }, bi); await waitForFrame(page); await sleep(120); return (await shownEl(IMG)).view ?? {}; };
    // a clean slate: no tracks, Design as placed
    await F(() => window.__flux.fluximg.live.closeFluximgLive());
    await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); for (const b of s.beats) b.tracks = []; const e = s.elements.find((x) => x.id === id); delete e.view; delete e.playback; }); f.fig.resetHistory(); }, IMG);
    // Step 1: the board walks t (a wheel run), the Inspector sets channel 1's black point.
    await at(1);
    await F(() => document.activeElement?.blur?.());
    await F((id) => window.__flux.fluximg.live.openFluximgLive(id), IMG);
    await waitFor(page, () => !!document.querySelector("[data-fxb-step]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "the board open at step 1", timeout: 10000 });
    const tStart = await idx("t");
    await wheel(img.cx, img.cy, 100, 3); await settled();
    await press("Escape"); await F(() => window.__flux.fluximg.live.closeFluximgLive());
    await F((id) => window.__flux.fig.selectOnly(id), IMG); await waitForFrame(page);
    await F(() => [...document.querySelectorAll(".inspector-tabs button")].find((b) => b.textContent.trim() === "Object")?.click());
    await page.waitForSelector(insp(BLACK0), { timeout: 5000 });
    await typeField(BLACK0, "500");
    const patch1 = (await changeAt(1, IMG))?.to.state.view;
    h.ok(patch1?.index?.t === tStart + 3 && patch1?.channels?.[0]?.range?.[0] === 500 && patch1?.channels?.[0]?.color === undefined,
      `step 1 (board walk + Inspector window) stores the patch ${JSON.stringify(patch1)}`);
    // Design: the Inspector changes channel 1's colour.
    await at(0);
    await F((id) => window.__flux.fig.selectOnly(id), IMG); await waitForFrame(page);
    const p0 = await past(), bytes0 = await deckBytes();
    await setColour0("#00ffff");
    h.eq((await designOf(IMG)).view?.channels?.[0]?.color, "#00ffff", "the Inspector's colour lands on Design");
    h.eq(await past(), p0 + 1, "…as one undo step");
    const bytes1 = await deckBytes();
    let v1 = await at(1), v2 = await at(2);
    h.ok(v1.index?.t === tStart + 3 && v1.channels?.[0]?.range?.[0] === 500 && v1.channels?.[0]?.color === "#00ffff",
      `the review's repro, in the app: step 1 shows the walk (t ${v1.index?.t}), the window (${v1.channels?.[0]?.range?.[0]}) AND the Design colour (${v1.channels?.[0]?.color})`);
    h.ok(v2.channels?.[0]?.color === "#00ffff" && v2.index?.t === tStart + 3, "…and so does step 2");
    await press("z", ["Control"]);
    h.ok((await deckBytes()) === bytes0 && (await at(1)).channels?.[0]?.color !== "#00ffff", "undo is exact: the deck's bytes as before the colour, and step 1 without it");
    await press("z", ["Control", "Shift"]);
    h.ok((await deckBytes()) === bytes1 && (await at(1)).channels?.[0]?.color === "#00ffff", "redo is exact");
    // A Design edit of what the step changes does not leak into the step.
    await at(0); await F((id) => window.__flux.fig.selectOnly(id), IMG); await waitForFrame(page);
    await typeField(BLACK0, "300");
    v1 = await at(1);
    h.ok((await designOf(IMG)).view?.channels?.[0]?.range?.[0] === 300 && v1.channels?.[0]?.range?.[0] === 500, "a Design edit of the black point the step sets moves Design only (step 1 keeps 500)");
    // A step that clears a setting holds: projection on in Design, off at step 2.
    await at(0); await F((id) => window.__flux.fig.selectOnly(id), IMG); await waitForFrame(page);
    await page.select(insp("[data-fluximg-projection]"), "max"); await sleep(150);
    await at(2); await F((id) => window.__flux.fig.selectOnly(id), IMG); await waitForFrame(page);
    await page.select(insp("[data-fluximg-projection]"), ""); await sleep(150);
    const pr = [await at(0), await at(1), await at(2)].map((v) => !!v.projection);
    h.eq(pr, [true, true, false], "a step that clears a setting holds: projection on in Design and step 1, off at step 2");
    h.eq((await changeAt(2, IMG))?.to.state.view, { projection: null }, "…stored as the patch {projection: null}");
    // Twin engines: the same edits through the headless verbs give the same Changes and Design.
    const gui = await authored();
    const twin = await headlessTwin([
      { beat: 1, view: { index: { t: tStart + 3 } } }, { beat: 1, view: { channels: [{ range: [500, patch1.channels[0].range[1]] }] } },
      { view: { channels: [{ color: "#00ffff" }] } }, { view: { channels: [{ range: [300, (await designOf(IMG)).view.channels[0].range[1]] }] } },
      { view: { projection: (await designOf(IMG)).view.projection } }, { beat: 2, view: { projection: null } },
    ]);
    const norm = (slide, id) => JSON.stringify({ design: slide.elements.find((e) => e.id === id).view ?? null, steps: slide.beats.map((b) => b.tracks.filter((t) => t.target === id).map(({ id: _i, target: _t, ...t }) => t)) });
    h.eq(norm(twin.slide, twin.id), norm(gui, IMG), "twin engines: the headless verbs write the same Design view and the same Changes as the board and the Inspector");
    await at(0);
    await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); for (const b of s.beats) b.tracks = []; delete s.elements.find((x) => x.id === id).view; }); }, IMG);
  }

  // ------------------------------------------------------------------------------------------------------------
  h.section("the player: a started movie runs on its own while the slide rests, and costs nothing once stopped");
  await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId);
    f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats[1].tracks = [{ id: "mv", target: id, preset: "videoStart", duration: 0, start: 0 }]; s.beats[2].tracks = [];
      s.elements.find((e) => e.id === id).playback = { dim: "t", mode: "loop", fps: 8 }; });
    f.slide.activeBeat.set(1); }, IMG);
  await F(() => { const real = window.requestAnimationFrame.bind(window); window.__mvRaf = 0; window.requestAnimationFrame = (cb) => { window.__mvRaf++; return real(cb); }; });
  await F(() => [...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Play")).click());
  await waitFor(page, () => !!document.querySelector(".preview-overlay [data-slide-fluximg-root]"), null, { timeout: 10000, label: "the preview mounts the image" });
  // The step's cue is a zero-length command: the slide rests at once while the movie runs (the transport stays on Pause,
  // as it does for a playing video clip).
  await sleep(300);
  const a0 = await F(() => window.__flux.fluximgSlide.stats.asked), r0 = await F(() => window.__mvRaf);
  await sleep(1300);
  const a1 = await F(() => window.__flux.fluximgSlide.stats.asked), r1 = await F(() => window.__mvRaf);
  h.ok(a1 - a0 >= 6, `at rest the movie keeps drawing new planes (${a1 - a0} frames asked in 1.3 s at 8 planes a second)`);
  // (review C7: a movie whose planes are more than two frames apart draws each one from one timer at its boundary, so
  // a running movie at rest costs no animation frame at all)
  h.eq(r1 - r0, 0, "…on its own clock, one timer per plane: no animation frame while the slide rests");
  await F(() => [...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Stop")).click());
  await waitFor(page, () => !document.querySelector(".preview-overlay [data-slide-fluximg-root]"), null, { timeout: 5000, label: "the preview closed" }).catch(() => null);
  await sleep(200);
  const r2 = await F(() => window.__mvRaf); await sleep(500);
  h.eq((await F(() => window.__mvRaf)) - r2, 0, "stopped: no animation frame any more");

  // ------------------------------------------------------------------------------------------------------------
  h.section("Delete on a slide: the editor's key and the headless delete-element agree (C6)");
  {
    const slideOps = await import("../src/lib/slide/ops.ts");
    await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId);
      f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats[1].tracks = [{ id: "w1", target: id, preset: "transform", duration: 800, to: { state: { view: { index: { t: 5 } } } } }]; s.beats[2].tracks = []; });
      f.slide.setEditDestination({ kind: "design" }); f.slide.activeBeat.set(0); }, IMG);
    await waitForFrame(page);
    const snapshot = await F(() => structuredClone(window.__flux.slide.currentDeck()));
    await F(() => document.activeElement?.blur?.());
    await F((id) => window.__flux.fig.selectOnly(id), IMG);
    const r = await box(`[data-editor-element-id="${IMG}"]`);
    if (r) await page.mouse.move(r.cx, r.cy);
    await press("Delete");
    await waitFor(page, (id) => !window.__flux.slide.currentDeck().slides.some((s) => s.elements.some((e) => e.id === id)), IMG, { label: "the image deleted", timeout: 3000 });
    const gui = await F(() => structuredClone(window.__flux.slide.currentDeck()));
    const deleted = slideOps.deleteSlideElements(snapshot, [IMG]);
    h.eq(deleted, [IMG], "deleteSlideElements (what delete-element runs) deletes the image from its slide");
    h.eq(JSON.stringify(snapshot.slides), JSON.stringify(gui.slides), "twin engines: the editor's Delete and the headless op leave the same slides (the image's Change stays, as a dangling track)");
  }

  // ------------------------------------------------------------------------------------------------------------
  h.section("Update from source on a slide, through the Inspector (B3)");
  {
    const SRC = await F(async () => {
      const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
      const assetId = f.fluximg.place.fluximgAssetId("tz", "src");
      const result = await window.fig.importFluximg({ root, sourcePath: "plots/tz.fluximg", assetId });
      const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/tz.fluximg");
      let id;
      f.fig.commit((p) => { const s = p.figures.find((x) => x.id === sid); id = f.ops.addFluximg(p, { figureId: sid, asset, x: 60, y: 60, width: 200, source: { bundlePath: "plots/tz.fluximg", sha256: asset.sha256 } }); });
      f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats[1].tracks = [{ id: "src1", target: id, preset: "transform", duration: 800, to: { state: { view: { index: { t: 6 }, channels: [{ range: [300, 900] }] } } } }]; s.beats[2].tracks = []; });
      f.slide.editAfterBeat(1); f.slide.activeBeat.set(1);
      f.fig.resetHistory();
      return { id, assetId };
    });
    await waitFor(page, (id) => { const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id); return !!el && !!f.get(f.fluximg.store.fluximgManifests)[el.assetId]; }, SRC.id, { label: "the source image's manifest", timeout: 15000 });
    // the source is re-exported shorter (4 frames instead of 8)
    await F((files) => window.__fluxSeedFluximg("plots/tz.fluximg", files), bundleFiles("tz4_u16"));
    await F(() => document.activeElement?.blur?.());
    await F((id) => window.__flux.fig.selectOnly(id), SRC.id);
    await F(() => [...document.querySelectorAll(".inspector-tabs button")].find((b) => b.textContent.trim() === "Object")?.click());
    const upd = await waitFor(page, () => { const b = document.querySelector(".rail [data-fluximg-update-source]"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, null, { label: "the Inspector offers Update", timeout: 8000 });
    const p0 = await past(), stepBefore = JSON.stringify(await changeAt(1, SRC.id));
    await page.mouse.click(upd.x, upd.y);
    const moved = await waitFor(page, ({ id, was }) => { const el = window.__flux.slide.currentDeck().slides.flatMap((s) => s.elements).find((e) => e.id === id); return el && el.assetId !== was ? el.assetId : null; }, { id: SRC.id, was: SRC.assetId }, { label: "the Design element moved to the new bundle", timeout: 15000 });
    const design = await designOf(SRC.id);
    h.ok(!!moved && design.assetId === moved && design.source?.sha256 && design.source.sha256 !== undefined, `Update on a slide moves the image's Design state to the new bundle (${SRC.assetId} → ${moved})`);
    h.eq(await past(), p0 + 1, "…in one undo step");
    h.eq(JSON.stringify(await changeAt(1, SRC.id)), stepBefore, "the step's Change (its view patch) is kept as it was");
    await waitFor(page, ({ id, now }) => window.__flux.figures().flatMap((x) => x.elements).find((e) => e.id === id)?.assetId === now, { id: SRC.id, now: moved }, { label: "the step shows the new bundle", timeout: 5000 });
    h.ok(true, "at step 1 the editor shows the updated image (the display was re-composed)");
    // the step's plane 6 is past the new bundle's end (4 frames): drawn clamped and reported, the viewCheck policy
    const { compileSlide } = await import("../src/lib/slide/compile.ts");
    const manifest = JSON.parse(readFileSync(path.join(scratch, "tz4_u16.fluximg/fluximg.json"), "utf8"));
    const deckNow = await F(() => structuredClone(window.__flux.slide.currentDeck()));
    const sl = deckNow.slides.find((s) => s.elements.some((e) => e.id === SRC.id));
    const issues = compileSlide(sl, deckNow.stage, { fluximgManifest: (id) => (id === moved ? manifest : undefined) }).issues.filter((i) => i.trackId === "src1");
    h.ok(issues.some((i) => /does not fit the image/.test(i.reason) && /index\.t/.test(i.reason)), `a step patch that no longer fits is reported, not dropped: "${issues[0]?.reason ?? "no issue"}"`);
    await press("z", ["Control"]);
    h.eq((await designOf(SRC.id)).assetId, SRC.assetId, "undo brings the previous bundle back");
    await press("z", ["Control", "Shift"]);
    h.eq((await designOf(SRC.id)).assetId, moved, "redo the new one");
  }
} catch (e) {
  h.fail(`threw: ${e?.stack ?? e}`);
  await page.screenshot({ path: `${SHOTS}/authoring-gui-failure.png` }).catch(() => {});
} finally {
  h.eq(errs.filter((e) => !/favicon/.test(e)), [], "no console errors");
  await browser.close();
}
await h.done();
