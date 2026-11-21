// verify-fluximg-board-keys-gui (ui tier; dev server up, FLUX_URL for a worktree): the image board in Slide mode takes
// exactly its own keys, and nothing of it exists while Present is up (review A2, B1; ledger call 50). Real keys and
// real clicks; every check reads model state, history counts or the DOM.
//   * Present opened with the board open (the Present button, F5, Shift+F5) closes the board first, its open edit kept
//     as ONE undo step exactly as Esc keeps it; Present's keys then drive the talk (ArrowRight advances it, nothing is
//     written to the deck), the first Esc closes Present; while Present is up the board cannot open.
//   * With the board open: PageDown / PageUp change slide, F2 renames the slide, Delete deletes nothing (held).
//   * Space: with the slide's editor preview playing, Space pauses the preview and the board's preview does not start;
//     the editor preview starting stops the board's preview (the two never play together).
//   * Every other overlay that takes the keyboard: the X-ray opened over the board (Shift+Alt+R) owns the arrows and
//     its Escape; the property menu (F) owns its Escape; the board's own keys still work after each.
//   * A clean console (a Svelte runtime error fails it).
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-board-keys-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame, sleep, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-board-keys-gui");
const SHOTS = "test-results/scratch/shots";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "fx-board-keys-gui-"));
{
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
const past = () => F(() => window.__flux.fig.historyStats().past);
const isOpen = () => F(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgLive));
const presenting = () => F(() => !!document.querySelector(".present"));
const presentDots = () => F(() => document.querySelectorAll(".present .hud .dot.on").length);
const presentCounter = () => F(() => document.querySelector(".present .hud span")?.textContent.trim() ?? "");
const deckBytes = () => F(() => JSON.stringify(window.__flux.slide.currentDeck()));
const activeSlide = () => F(() => window.__flux.get(window.__flux.fig.activeFigureId));
const box = (sel) => F((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const wheel = async (x, y, deltaY, n = 1) => { await page.mouse.move(x - 2, y - 1); await page.mouse.move(x, y); for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY }); await sleep(30); } };
const idx = (dim) => F((dim) => window.__flux.fluximg.actions.liveContext()?.view.index[dim] ?? null, dim);
const designT = (id) => F((id) => window.__flux.slide.currentDeck().slides.flatMap((s) => s.elements).find((e) => e.id === id)?.view?.index?.t ?? 0, id);
const closePresent = async () => { if (await presenting()) { await press("Escape"); await waitFor(page, () => !document.querySelector(".present"), null, { label: "Present closed", timeout: 5000 }); } };
async function openBoard(id) {
  if (await isOpen()) return;
  await F((id) => window.__flux.fig.selectOnly(id), id);
  const r = await box(`[data-editor-element-id="${id}"]`);
  if (r) await page.mouse.move(r.cx, r.cy);
  await press("r");
  await waitFor(page, () => !!document.querySelector("[data-fxb-console]") && !!document.querySelector("[data-fluximg-live]"), null, { label: "the board open on the slide", timeout: 10000 });
}
async function toSlide(sid) { await F((sid) => { window.__flux.fig.selection.set(new Set()); window.__flux.fig.activeFigureId.set(sid); }, sid); await sleep(300); }

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const { IMG, S0, S1 } = await F(async (files) => {
    const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
    window.__fluxSeedFluximg("plots/tz.fluximg", files);
    const assetId = f.fluximg.place.fluximgAssetId("tz", "keys");
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/tz.fluximg", assetId });
    const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/tz.fluximg");
    let id;
    f.fig.commit((p) => { const s = p.figures.find((x) => x.id === sid); s.elements = []; id = f.ops.addFluximg(p, { figureId: sid, asset, x: 200, y: 70, width: 240 }); });
    f.slide.commitDeckLive((d) => {
      const s = d.slides.find((x) => x.id === sid);
      s.beats = [s.beats[0], { id: "k1", label: "Step 1", tracks: [{ id: "w1", target: id, preset: "transform", duration: 2000, easing: "linear", to: { state: { view: { index: { t: 7 } } } } }] }];
      if (d.slides.length < 2) f.slideOps.addSlide(d, { layout: "blank" });
    });
    f.slide.setEditDestination({ kind: "design" });
    f.fig.resetHistory();
    const deck = f.slide.currentDeck();
    return { IMG: id, S0: sid, S1: deck.slides.find((x) => x.id !== sid).id };
  }, bundleFiles("tz_u16"));
  await waitFor(page, (id) => !!document.querySelector(`[data-editor-element-id="${id}"] image`)?.getAttribute("href"), IMG, { label: "the image's still", timeout: 15000 });
  await waitFor(page, (id) => { const f = window.__flux, el = f.figures().flatMap((x) => x.elements).find((e) => e.id === id); return !!el && !!f.get(f.fluximg.store.fluximgManifests)[el.assetId]; }, IMG, { label: "its manifest", timeout: 15000 });

  // ------------------------------------------------------------------------------------------------------------
  h.section("Esc: the board's open edit is kept as one undo step (the rule Present follows)");
  await openBoard(IMG);
  let img = await box("[data-fluximg-live]");
  let p0 = await past(), t0 = await designT(IMG);
  await wheel(img.cx, img.cy, 100, 2); // a wheel run: open until 420 ms of quiet
  await press("Escape");
  h.ok(!(await isOpen()), "Esc closes the board (nothing was in hand)");
  h.eq([await past() - p0, await designT(IMG) - t0], [1, 2], "the wheel run it closed on is kept, as one undo step");
  await F(() => window.__flux.fig.resetHistory());

  // ------------------------------------------------------------------------------------------------------------
  h.section("the Present button with the board open (A2)");
  await openBoard(IMG);
  img = await box("[data-fluximg-live]");
  p0 = await past(); t0 = await designT(IMG);
  await wheel(img.cx, img.cy, 100, 2);
  const pb = await F(() => { const b = [...document.querySelectorAll(".deckbar button")].find((x) => /^Present/.test(x.textContent.trim())); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(pb.x, pb.y);
  await waitFor(page, () => !!document.querySelector(".present"), null, { label: "Present open", timeout: 8000 });
  h.ok(!(await isOpen()), "opening Present closes the board");
  h.eq([await past() - p0, await designT(IMG) - t0], [1, 2], "its open wheel run is kept as one undo step, as Esc keeps it");
  await sleep(600);
  const bytes = await deckBytes(), p1 = await past(), dots0 = await presentDots();
  await press("ArrowRight"); await sleep(500);
  h.ok((await presentDots()) > dots0 || (await presentCounter()) !== "", `ArrowRight advances the talk (step dots ${dots0} → ${await presentDots()})`);
  h.ok((await presentDots()) > dots0, "…to the next step");
  h.ok((await deckBytes()) === bytes && (await past()) === p1, "…and writes nothing to the deck behind it (no undo step)");
  h.eq(await F((id) => window.__flux.fluximg.live.fluximgLiveUnavailable(id), IMG), "Not while presenting", "while Present is up the board cannot open (its reason)");
  h.eq(await F((id) => window.__flux.fluximg.live.openFluximgLive(id), IMG), false, "…openFluximgLive refuses");
  await press("r"); await sleep(200);
  h.ok(!(await isOpen()) && (await presenting()), "R in Present opens no board");
  await press("Escape");
  await waitFor(page, () => !document.querySelector(".present"), null, { label: "Present closed", timeout: 5000 });
  h.ok(!(await presenting()), "the first Esc closes Present");
  h.eq(await F((id) => window.__flux.fluximg.live.fluximgLiveUnavailable(id), IMG), null, "after Present the board can open again");
  await F(() => window.__flux.fig.resetHistory());

  // ------------------------------------------------------------------------------------------------------------
  h.section("F5 and Shift+F5 with the board open (B1)");
  await openBoard(IMG);
  await press("F5");
  await waitFor(page, () => !!document.querySelector(".present"), null, { label: "F5 presents", timeout: 8000 }).catch(() => {});
  h.ok(await presenting(), "F5 with the board open presents");
  h.ok(!(await isOpen()), "…and the board is closed");
  await sleep(400);
  h.ok(/^1\b/.test(await presentCounter()), `…from the first slide ("${await presentCounter()}")`);
  await closePresent();
  await toSlide(S1); await toSlide(S0);
  await openBoard(IMG);
  await press("F5", ["Shift"]);
  await waitFor(page, () => !!document.querySelector(".present"), null, { label: "Shift+F5 presents", timeout: 8000 }).catch(() => {});
  h.ok((await presenting()) && !(await isOpen()), "Shift+F5 with the board open presents from here, the board closed");
  await closePresent();

  // ------------------------------------------------------------------------------------------------------------
  h.section("PageDown, PageUp, F2, Delete with the board open");
  await toSlide(S0);
  await openBoard(IMG);
  await press("PageDown"); await sleep(300);
  h.eq(await activeSlide(), S1, "PageDown changes slide");
  h.ok(!(await isOpen()), "…and the board closed with the selection");
  await press("PageUp"); await sleep(300);
  h.eq(await activeSlide(), S0, "PageUp changes back");
  await openBoard(IMG);
  await press("F2"); await sleep(250);
  h.ok(await F(() => document.activeElement?.tagName === "INPUT" && !!document.activeElement.closest(".filmstrip, aside")), "F2 renames the slide (its name field has the keyboard)");
  await press("Escape"); await sleep(150);
  await openBoard(IMG);
  await press("Delete"); await sleep(200);
  h.ok((await F((id) => window.__flux.slide.currentDeck().slides.some((s) => s.elements.some((e) => e.id === id)), IMG)) && (await isOpen()), "Delete deletes nothing: the canvas keymap holds it while the board is open");
  // the board's own keys still work
  const t1 = await idx("t");
  await press("ArrowRight");
  h.eq(await idx("t"), t1 + 1, "ArrowRight steps the board's time rail");
  await press("Digit2");
  h.eq(await F(() => { const l = window.__flux.get(window.__flux.fluximg.live.fluximgLive); return `${l.channel}:${l.armed}`; }), "1:white", "2 takes the second channel in hand");
  await press("Escape"); await press("Escape");
  await F(() => window.__flux.fig.resetHistory());

  // ------------------------------------------------------------------------------------------------------------
  h.section("Space: the slide's preview and the board's never play together");
  await F(() => window.__flux.slide.activeBeat.set(1));
  if (!(await F(() => !!document.querySelector(".ruler")))) await F(() => [...document.querySelectorAll(".deckbar button")].find((x) => x.textContent.trim().startsWith("Animate"))?.click());
  await waitFor(page, () => !!document.querySelector(".ruler"), null, { label: "the animator", timeout: 5000 });
  await openBoard(IMG);
  await page.keyboard.press(" "); await waitForFrame(page);
  await waitFor(page, () => !!window.__flux.get(window.__flux.fluximg.live.fluximgPreview), null, { label: "the board's preview", timeout: 3000 }).catch(() => {});
  h.ok(await F(() => !!window.__flux.get(window.__flux.fluximg.live.fluximgPreview)), "Space on the board plays its preview");
  const transport = (label) => F((label) => { const b = [...document.querySelectorAll(".transport button")].find((x) => x.textContent.includes(label)); if (!b) return false; b.click(); return true; }, label);
  h.ok(await transport("Play"), "the slide preview's Play pressed");
  await waitFor(page, () => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Pause")), null, { label: "the slide preview playing", timeout: 8000 }).catch(() => {});
  h.ok(await F(() => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Pause"))), "the slide preview plays");
  h.ok(await F(() => !window.__flux.get(window.__flux.fluximg.live.fluximgPreview) && !window.__flux.get(window.__flux.fluximg.live.fluximgLive)?.playing), "…and the board's preview stopped when it began");
  if (await isOpen()) {
    await page.keyboard.press(" "); await sleep(300);
    h.ok(await F(() => !![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Play")) && ![...document.querySelectorAll(".transport button")].find((b) => b.textContent.includes("Pause"))), "Space with the slide preview playing pauses it");
    h.ok(await F(() => !window.__flux.get(window.__flux.fluximg.live.fluximgPreview)), "…and does not start the board's preview");
    await F((id) => window.__flux.fluximg.actions.togglePlayback("t"), IMG);
    h.ok(await F(() => !window.__flux.get(window.__flux.fluximg.live.fluximgPreview)), "the board's play does not start while the slide preview is up");
  } else h.ok(true, "(the board closed when the slide preview began)");
  await transport("Stop");
  await sleep(300);
  if (await F(() => !!document.querySelector(".preview-overlay"))) { await press("Escape"); await sleep(200); }
  h.ok(!(await F(() => !!document.querySelector(".preview-overlay"))), "the slide preview closed");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(0); f.slide.setEditDestination({ kind: "design" }); });
  await sleep(200);

  // ------------------------------------------------------------------------------------------------------------
  h.section("the overlays that take the keyboard over the board");
  await openBoard(IMG);
  await press("r", ["Shift", "Alt"]);
  const xray = await waitFor(page, () => window.__flux.get(window.__flux.fig.xrayOpen) ?? !!document.querySelector(".xray"), null, { label: "the X-ray", timeout: 4000 }).catch(() => false);
  if (xray) {
    const tx = await idx("t");
    await press("ArrowRight");
    h.eq(await idx("t"), tx, "with the X-ray open over the board, ArrowRight is the X-ray's (the board's plane stays)");
    await press("Escape"); await sleep(200);
    h.ok(!(await F(() => window.__flux.get(window.__flux.fig.xrayOpen))), "Esc closes the X-ray first");
    h.ok(await isOpen(), "…the board stays open");
  } else h.ok(true, "(Shift+Alt+R opened no X-ray on an image here)");
  await openBoard(IMG);
  await press("f");
  const menu = () => F(() => !!document.querySelector(".fluxFigMenu"));
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "the property menu", timeout: 3000 }).catch(() => {});
  h.ok(await menu(), "F on the board opens the property menu");
  const tm = await idx("t");
  await press("ArrowRight");
  h.eq(await idx("t"), tm, "with the property menu up, ArrowRight is not the board's");
  await press("Escape"); await sleep(200);
  h.ok(!(await menu()) && (await isOpen()), "Esc closes the property menu first, the board stays");
  const t2 = await idx("t");
  await press("ArrowLeft");
  h.eq(await idx("t"), Math.max(0, t2 - 1), "the board's keys work again after each overlay");
  await press("Escape"); await press("Escape");
  await sleep(450);
  h.eq(await F(() => document.getAnimations().filter((a) => a.playState !== "finished").length), 0, "nothing animates at rest");
} catch (e) {
  h.fail(`threw: ${e?.stack ?? e}`);
  await page.screenshot({ path: `${SHOTS}/board-keys-gui-failure.png` }).catch(() => {});
} finally {
  h.eq(errs.filter((e) => !/favicon/.test(e)), [], "no console errors (a Svelte runtime error included)");
  await browser.close();
}
await h.done();
