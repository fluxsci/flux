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
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
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
} catch (e) {
  h.fail(`threw: ${e?.stack ?? e}`);
  await page.screenshot({ path: `${SHOTS}/authoring-gui-failure.png` }).catch(() => {});
} finally {
  h.eq(errs.filter((e) => !/favicon/.test(e)), [], "no console errors");
  await browser.close();
}
await h.done();
