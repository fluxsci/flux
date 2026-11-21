// fluximg stage 2, fix package F1a: the slide PLAYER's laws the review found broken (S2_REVIEW_SLIDES.md A1, B4, C8,
// C10), pinned in a real headless Chrome with the real player (`slide/player/player.ts`, `player/fluximg.ts`,
// `player/fluximgMedia.ts`) and the real image host (`fluximg/slideSurfaces.ts`, WebGL) over a SYNTHETIC plane source.
//
// Pins:
//   - A1. A running image movie runs on across later steps (loop, bounce on its way down, once), as a video clip does;
//     every navigation does what it does to a video: Back (a jump, and an animated rewind) and a jump land it paused
//     where the pure clock stands at the target step; Next resumes it from there; blanking the screen and a hidden
//     document hold it and resume it from where it was held; another slide stops it with no frame loop left.
//   - B4. A camera zoom onto an image is sharp at the camera's RESTING zoom: the canvas is re-rendered once when the
//     move ends (0 or 1 backing reallocations during the move: CSS scales in between), bounded by the crop's own pixels
//     (then the display magnifies with the image's `smooth` setting) and by a pixel cap; one-pixel checker edges at
//     zoom 4 within a small margin of the same picture drawn unzoomed at 4x the size. The still follows the same rule
//     (`crop.zoomedStillScale`).
//   - C8. A Change that scales an image never reallocates the canvas per frame: sized once for the larger end, CSS in
//     between, exact at the ends.
//   - C10. The WebGL context budget is one per document, shared by every host in it (editor preview, Present): a
//     host that needs a slot takes the least recently drawn one another host holds at rest; disposal returns slots; a
//     lost context (`WEBGL_lose_context.loseContext()`) on a live surface comes back with its picture, no exception,
//     and the budget stays right.
//
// Pure tier, prerequisite "chrome". Hermetic (mkdtemp scratch removed at the end, ephemeral port).
// Run: npx tsx scripts/verify-fluximg-slide-player-fixes.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { build } from "esbuild";
import { launch, errors } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { writeFluximg, arraySource } from "../src/lib/fluximg/writer";
import { nodeBundleWriter, nodeZstd } from "../flux-core/fluximgIo";

const h = harness("verify-fluximg-slide-player-fixes");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "fluximg-slide-fixes-"));
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

// ---- two synthetic images -----------------------------------------------------------------------------------------------
// "mv": t 24 planes of 32x32, plane t is flat 40*t (the plane can be read off any pixel).
// "chk": a one-pixel checker 128x128, z 2 planes (sharpness under a camera zoom).
const T = 24, MH = 32, MW = 32;
const mv = new Uint16Array(T * MH * MW);
for (let t = 0; t < T; t++) mv.fill(40 * t, t * MH * MW, (t + 1) * MH * MW);
const mvReport = await writeFluximg(nodeBundleWriter(path.join(scratch, "mv.fluximg")), await nodeZstd(), {
  name: "plane-coded movie", source: arraySource(mv, ["t", "y", "x"], [T, MH, MW], "uint16"),
  axes: { t: { unit: "s", scale: 0.1 } }, channels: [{ name: "g", color: "#ffffff", range: [0, 40 * 23] }],
});
const CK = 128, Z = 2;
const ck = new Uint16Array(Z * CK * CK);
for (let z = 0; z < Z; z++) for (let y = 0; y < CK; y++) for (let x = 0; x < CK; x++) ck[(z * CK + y) * CK + x] = (x + y) & 1 ? 1000 : 0;
const ckReport = await writeFluximg(nodeBundleWriter(path.join(scratch, "chk.fluximg")), await nodeZstd(), {
  name: "checker", source: arraySource(ck, ["z", "y", "x"], [Z, CK, CK], "uint16"),
  axes: { z: { unit: "µm", scale: 1 } }, channels: [{ name: "g", color: "#ffffff", range: [0, 1000] }],
});
h.ok(mvReport.manifest.pixels.levels.length >= 1 && ckReport.manifest.pixels.levels.length >= 1, "two synthetic bundles written by the TS writer");

interface PageData { only: string[] | null; mvManifest: unknown; ckManifest: unknown; mv: string; ck: string; T: number; MH: number; MW: number; CK: number; Z: number }

async function pageRun(D: PageData): Promise<unknown> {
  const FX = (window as any).FX;
  const out: Record<string, unknown> = {};
  const run = (name: string) => !D.only || D.only.includes(name);
  const fromB64 = (s: string) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Uint16Array(u.buffer); };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
  const images: Record<string, { manifest: any; data: Uint16Array; maps: any; plane: number; bundle: string }> = {
    mv: { manifest: D.mvManifest, data: fromB64(D.mv), maps: FX.pixelMaps(D.mvManifest), plane: D.MH * D.MW, bundle: "fig/assets/mv.fluximg" },
    chk: { manifest: D.ckManifest, data: fromB64(D.ck), maps: FX.pixelMaps(D.ckManifest), plane: D.CK * D.CK, bundle: "fig/assets/chk.fluximg" },
  };
  const byBundle = (b: string) => Object.values(images).find((i) => i.bundle === b)!;
  function makeSource() {
    return {
      manifest: (id: string) => images[id]?.manifest,
      need: (id: string) => (images[id] ? Promise.resolve(images[id].manifest) : Promise.reject(new Error(`no bundle for ${id}`))),
      bundle: (id: string) => images[id]?.bundle,
      identity: (id: string) => `${id}-sha`,
      planes: {
        plane: (bundle: string, level: number, leading: number[]) => Promise.resolve().then(() => {
          const im = byBundle(bundle), m = im.manifest, w = m.pixels.shape.at(-1), hh = m.pixels.shape.at(-2);
          return { key: FX.planeKey(bundle, level, leading), width: w, height: hh, dtype: "uint16", data: im.data.slice(leading[0] * im.plane, (leading[0] + 1) * im.plane), map: im.maps[leading[1] ?? 0] ?? im.maps[0] };
        }),
        projection: () => Promise.reject(new Error("no projections here")),
        layer: () => Promise.reject(new Error("no layers here")),
      },
      still: () => Promise.reject(new Error("no stills in the live host")),
      stillNow: () => undefined,
      resolveLut: () => null,
    };
  }
  const theme = FX.FLUX_DARK;
  const mountOf = (w = 1280, hh = 720) => { const m = document.createElement("div"); m.style.cssText = `position:relative;width:${w}px;height:${hh}px`; document.body.append(m); return m; };
  const newPlayer = (deck: any, extra: Record<string, unknown> = {}, host = FX.createFluximgSlideHost(makeSource())) => {
    const mount = mountOf();
    const player = FX.createPlayer(mount, deck, { theme, mode: "present", reducedMotion: false, fluximg: host, fluximgManifest: (id: string) => images[id]?.manifest, pixelScale: 1, ...extra });
    return { host, mount, player };
  };
  let rafs = 0;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { rafs++; return realRaf(cb); };
  // Backing reallocations of the live image canvases (a width or height that changes), for B4 and C8.
  // (a width and a height set in one task are one reallocation)
  const reallocs = { n: 0 }, inTask = new Set<HTMLCanvasElement>();
  for (const k of ["width", "height"] as const) {
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k)!;
    Object.defineProperty(HTMLCanvasElement.prototype, k, { configurable: true, get: d.get, set(this: HTMLCanvasElement, v: number) {
      if (this.dataset.slideFluximg !== undefined && d.get!.call(this) !== v && v > 0 && !inTask.has(this)) { reallocs.n++; inTask.add(this); setTimeout(() => inTask.delete(this), 0); }
      d.set!.call(this, v);
    } });
  }
  (window as any).__T = { newPlayer, images, sleep, frame, reallocs, theme, mountOf, makeSource };

  // ---- A1: a running movie across steps and navigations -----------------------------------------------------------------
  if (run("movie")) {
    const movieDeck = (playback: Record<string, unknown>) => ({
      schemaVersion: "0.8.0", id: "d", title: "movie", created: "", modified: "", stage: { width: 640, height: 360 }, theme: "flux-dark",
      defaults: { transition: "none" }, assets: [],
      slides: [
        { id: "s0", elements: [
            { type: "fluximg", id: "im", x: 20, y: 20, width: 160, height: 160, rotation: 0, assetId: "mv", view: { index: { t: 0 } }, playback },
            { type: "rect", id: "box", x: 300, y: 100, width: 80, height: 60, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
          ],
          beats: [
            { id: "b0", tracks: [] },
            { id: "b1", tracks: [{ id: "go", target: "im", preset: "videoStart", start: 0, duration: 0 }] },
            { id: "b2", tracks: [{ id: "mvbox", target: "box", preset: "transform", start: 0, duration: 1000, easing: "linear", to: { state: { x: 500 } } }] },
            { id: "b3", tracks: [{ id: "hold", target: "im", preset: "videoPause", start: 0, duration: 0 }] },
          ] },
        { id: "s1", elements: [{ type: "rect", id: "r", x: 100, y: 100, width: 200, height: 100, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 }], beats: [{ id: "c0", tracks: [] }] },
      ],
    });
    /** The plane the image shows now: the override the movie put on its binding (null: the step's own plane). */
    const planeOf = (P: any): number | null => { const b = FX.fluximgBindingOf(P.mount.querySelector("[data-slide-fluximg-root]")); return b?.__override ? b.__override.index : null; };
    const spy = (P: any) => { const b = FX.fluximgBindingOf(P.mount.querySelector("[data-slide-fluximg-root]")); if (!b || b.__spied) return; const set = b.setIndexOverride.bind(b); b.__spied = true; b.setIndexOverride = (o: any) => { b.__override = o; set(o); }; };
    const PERIOD = 100;
    /** Where the pure clock of a movie stands `ms` after its Start (loop over `n` planes, bounce, once). */
    const expected = (mode: string, n: number, ms: number) => FX.playbackPlane(ms, n * PERIOD, mode, n).plane;
    const near = (a: number | null, b: number, n: number, mode: string) => a !== null && (mode === "loop" ? Math.min(Math.abs(a - b), n - Math.abs(a - b)) : Math.abs(a - b)) <= 1;
    const modes: Array<[string, Record<string, unknown>, number]> = [["loop", { dim: "t", mode: "loop", fps: 10 }, 24], ["bounce", { dim: "t", mode: "bounce", fps: 10, from: 0, to: 6 }, 6], ["once", { dim: "t", mode: "once", fps: 10 }, 24]];
    const across: unknown[] = [];
    for (const [mode, playback, n] of modes) {
      const P = newPlayer(movieDeck(playback));
      P.player.goTo(0, 0);
      await P.player.readyMedia(); await sleep(50); spy(P);
      P.player.next();                                     // step 1: Start
      const t0 = performance.now();
      // a bounce is sampled on its way DOWN when the next step begins (6 planes: up 0..5 in 500 ms, then down)
      await sleep(mode === "bounce" ? 720 : 550);
      P.player.next();                                     // step 2: a box moves, no image command
      const tNext = performance.now();
      const samples: Array<{ at: number; got: number | null; want: number; restart: number }> = [];
      for (let i = 0; i < 12; i++) {
        await frame();
        const at = performance.now() - t0;
        samples.push({ at: Math.round(at), got: planeOf(P), want: expected(mode, n, at), restart: expected(mode, n, performance.now() - tNext) });
        await sleep(55);
      }
      const ok = samples.filter((s) => near(s.got, s.want, n, mode)).length;
      across.push({ mode, ok, of: samples.length, first: samples[0], seq: samples.map((s) => `${s.got}/${s.want}`).join(" ") });
      P.player.destroy(); P.host.dispose(); P.mount.remove();
    }
    out.across = across;
    // C7 in the live host: a 10-plane-a-second movie at rest draws each plane from one timer at its boundary (no frame
    // loop); a 50-plane-a-second one runs on animation frames (a boundary is never more than two frames away).
    {
      const cost: Record<string, unknown> = {};
      for (const fps of [10, 50]) {
        const C = newPlayer(movieDeck({ dim: "t", mode: "loop", fps }));
        C.player.goTo(0, 0); await C.player.readyMedia(); await sleep(50); spy(C);
        C.player.next(); await sleep(200);
        const p0 = planeOf(C), r0 = rafs; let changes = 0, last = p0;
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) { await sleep(10); const p = planeOf(C); if (p !== last) { changes++; last = p; } }
        cost[fps] = { rafs: rafs - r0, changes };
        C.player.destroy(); C.host.dispose(); C.mount.remove();
      }
      out.cost = cost;
    }

    // Every navigation, on the loop movie.
    const P = newPlayer(movieDeck({ dim: "t", mode: "loop", fps: 10 }), { backAnimates: true });
    const nav: Record<string, unknown> = {};
    P.player.goTo(0, 0); await P.player.readyMedia(); await sleep(50); spy(P);
    P.player.next(); await sleep(420);
    // Blank (the host pauses media) holds it; unblanking resumes from the plane it held.
    P.player.setMediaPaused(true); await frame(); const held = planeOf(P); await sleep(450); const stillHeld = planeOf(P);
    P.player.setMediaPaused(false); await sleep(30); const resumed = planeOf(P); await sleep(320); const ranOn = planeOf(P);
    nav.blank = { held, stillHeld, resumed, ranOn };
    // A hidden document holds it the same way.
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")!;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"));
    await frame(); const hHeld = planeOf(P); const r0 = rafs; await sleep(450); const hRafs = rafs - r0; const hStill = planeOf(P);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange"));
    await sleep(30); const hResumed = planeOf(P);
    delete (document as any).hidden; void hidden;
    nav.hidden = { held: hHeld, still: hStill, resumed: hResumed, rafs: hRafs };
    // Next into step 2 (the box Change), then an animated Back mid-Change: the movie lands at once where the jump lands
    // it (step 1's pure clock: the Start's first plane, paused), as a video does, while the box rewinds.
    P.player.next(); await sleep(400);
    const beforeBack = planeOf(P);
    P.player.prev();
    await frame(); const rewinding = P.player.state?.().reversing ?? null; const atBack = planeOf(P); await sleep(150); const duringRewind = planeOf(P);
    await sleep(900); const landed = planeOf(P); const st = P.player.state?.();
    nav.back = { beforeBack, rewinding, atBack, duringRewind, landed, mediaPaused: st?.mediaPaused, mediaPlaying: st?.mediaPlaying };
    // Next from there: the movie runs on from where Back left it.
    P.player.next(); await sleep(350); nav.nextAfterBack = planeOf(P);
    // A jump to step 2's end: paused where the pure clock stands with no waits (Start + step 2's 1000 ms = plane 10).
    P.player.goTo(0, 2); await sleep(30); const j1 = planeOf(P); await sleep(300); const j2 = planeOf(P);
    nav.jump = { j1, j2, state: P.player.state?.() };
    // Next to step 3 (Pause): held; then Back (a jump: step 3 has no duration) lands on step 2's paused plane.
    P.player.next(); await sleep(60); const p1 = planeOf(P); await sleep(400); const p2 = planeOf(P);
    P.player.prev(); await sleep(60); const bp = planeOf(P);
    nav.pause = { p1, p2, back: bp };
    // Another slide: no frame loop; back on the movie's slide at step 2: paused at the pure clock's plane.
    P.player.next(); await sleep(60); P.player.next(); await sleep(60); P.player.next(); await sleep(100);
    const q0 = rafs; await sleep(400); nav.otherSlide = { rafs: rafs - q0, index: P.player.state?.().slide };
    P.player.goTo(0, 2); await sleep(50); spy(P); P.player.goTo(0, 2); await sleep(50);
    nav.returned = planeOf(P);
    P.player.destroy(); P.host.dispose(); P.mount.remove();
    out.nav = nav;
  }
  window.requestAnimationFrame = realRaf;
  return out;
}

// ---- B4 and C8: sizes, sharpness and reallocations (screenshots are taken from Node between page steps) ------------------
const STAGE = { width: 640, height: 360 };
const ckDeck = (els: unknown[], beats: unknown[]) => ({ schemaVersion: "0.8.0", id: "z", title: "zoom", created: "", modified: "", stage: STAGE, theme: "flux-dark", defaults: { transition: "none" }, assets: [], slides: [{ id: "z0", elements: els, beats }] });
const CHK = (box: { x: number; y: number; width: number; height: number }, smooth = false) => ({ type: "fluximg", id: "ck", ...box, rotation: 0, assetId: "chk", view: { index: { z: 0 }, smooth } });
/** Zoom 4 onto the checker, centred on it (the camera's view is 160x90 stage px of the 160x160 image). */
const zoomDeck = (smooth = false) => ckDeck([CHK({ x: 240, y: 100, width: 160, height: 160 }, smooth)], [{ id: "y0", tracks: [] }, { id: "y1", tracks: [{ id: "cam", target: "@camera", preset: "camera", start: 0, duration: 600, easing: "linear", to: { x: 320, y: 180, zoom: 4 } }] }]);
/** The same picture unzoomed at 4x the size: the box 640x640, its centre on the stage's centre. */
const bigDeck = (smooth = false) => ckDeck([CHK({ x: 0, y: -140, width: 640, height: 640 }, smooth)], [{ id: "y0", tracks: [] }]);
/** A Change that scales the image (160 -> 320, then back). */
const scaleDeck = () => ckDeck([CHK({ x: 20, y: 20, width: 160, height: 160 })], [{ id: "y0", tracks: [] },
  { id: "y1", tracks: [{ id: "grow", target: "ck", preset: "transform", start: 0, duration: 800, easing: "linear", to: { state: { width: 320, height: 320 } } }] },
  { id: "y2", tracks: [{ id: "shrink", target: "ck", preset: "transform", start: 0, duration: 800, easing: "linear", to: { state: { width: 160, height: 160 } } }] }]);

async function zoomStep(deck: unknown, animate: boolean): Promise<unknown> {
  const T = (window as any).__T, FX = (window as any).FX;
  for (const m of document.querySelectorAll("[data-zoom-mount]")) m.remove();
  (window as any).__P?.player.destroy(); (window as any).__P?.host.dispose();
  const P = T.newPlayer(deck); (window as any).__P = P; P.mount.dataset.zoomMount = "";
  P.mount.style.cssText = "position:absolute;left:0;top:0;width:640px;height:360px";
  P.player.goTo(0, 0); await P.player.readyMedia(); await P.player.captureMedia([], Infinity); await T.sleep(60);
  const c0 = P.mount.querySelector("canvas[data-slide-fluximg]");
  const before = c0 ? [c0.width, c0.height] : null;
  const r0 = T.reallocs.n;
  let during: number[] = [];
  if (animate) {
    P.player.next();
    const t0 = performance.now();
    while (performance.now() - t0 < 800) { await T.frame(); const c = P.mount.querySelector("canvas[data-slide-fluximg]"); during.push(c.width); }
    await T.sleep(150);
  }
  const moved = T.reallocs.n - r0;
  await P.player.captureMedia([], Infinity); await T.sleep(60);
  const c = P.mount.querySelector("canvas[data-slide-fluximg]");
  const b = FX.fluximgBindingOf(P.mount.querySelector("[data-slide-fluximg-root]"));
  return { before, after: [c.width, c.height], reallocs: moved, rendering: c.style.imageRendering, live: b.probe().live, widths: [...new Set(during)], camera: P.mount.querySelector("[data-slide-fluximg-root]").closest("div[style*='transform-origin']")?.style.transform ?? "" };
}
async function scaleRun(deck: unknown): Promise<unknown> {
  const T = (window as any).__T;
  (window as any).__P?.player.destroy(); (window as any).__P?.host.dispose();
  for (const m of document.querySelectorAll("[data-zoom-mount]")) m.remove();
  const P = T.newPlayer(deck); (window as any).__P = P;
  P.player.goTo(0, 0); await P.player.readyMedia(); await P.player.captureMedia([], Infinity); await T.sleep(60);
  const out: Record<string, unknown> = {};
  for (const step of [1, 2]) {
    const r0 = T.reallocs.n, widths: number[] = [];
    P.player.next();
    const t0 = performance.now();
    while (performance.now() - t0 < 1000) { await T.frame(); widths.push(P.mount.querySelector("canvas[data-slide-fluximg]").width); }
    out[step] = { reallocs: T.reallocs.n - r0, widths: [...new Set(widths)], end: P.mount.querySelector("canvas[data-slide-fluximg]").width };
  }
  return out;
}
/** Mean absolute horizontal step of the grey level over a window (a one-pixel checker's edge energy). */
function edgeEnergy(png: { width: number; height: number; rgba: Uint8Array }): number {
  let sum = 0, n = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x + 1 < png.width; x++) { const i = (y * png.width + x) * 4; sum += Math.abs(png.rgba[i] - png.rgba[i + 4]); n++; }
  return sum / n;
}

// ---- bundle, serve, run -------------------------------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const js = req.url === "/fx.js";
    res.setHeader("Content-Type", js ? "text/javascript" : "text/html");
    res.end(js ? await readFile(path.join(scratch, "fx.js")) : '<!doctype html><html><head><link rel="icon" href="data:,"><style>body{margin:0}</style></head><body></body></html>');
  } catch { res.statusCode = 404; res.end(); }
});
let browser: Awaited<ReturnType<typeof launch>>["browser"] | null = null;
try {
  await build({
    absWorkingDir: root, bundle: true, format: "iife", globalName: "FX", platform: "browser", target: "es2022", outfile: path.join(scratch, "fx.js"), logLevel: "silent",
    stdin: {
      resolveDir: root, loader: "ts", sourcefile: "fluximg-slide-player-fixes-entry.ts",
      contents: [
        `export { createPlayer } from "./src/lib/slide/player/player";`,
        `export { fluximgBindingOf } from "./src/lib/slide/player/fluximg";`,
        `export { createFluximgSlideHost, slideHostStats } from "./src/lib/fluximg/slideSurfaces";`,
        `export { pixelMaps } from "./src/lib/fluximg/still";`,
        `export { planeKey } from "./src/lib/fluximg/service";`,
        `export { playbackPlane } from "./src/lib/slide/mediaTimeline";`,
        `export { FLUX_DARK } from "./src/lib/slide/theme";`,
      ].join("\n"),
    },
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`;
  const launched = await launch({ width: 1280, height: 720 });
  browser = launched.browser;
  const page = launched.page;
  await page.goto(origin);
  await page.evaluate("window.__name = (value) => value");
  await page.addScriptTag({ url: `${origin}fx.js` });
  const b64 = (a: Uint16Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
  const r = await page.evaluate(pageRun as (d: PageData) => Promise<any>, { only: only ? [...only] : null, mvManifest: mvReport.manifest, ckManifest: ckReport.manifest, mv: b64(mv), ck: b64(ck), T, MH, MW, CK, Z } as PageData) as any;

  if (!only || only.has("zoom")) {
    const { decodePng } = await import("../flux-core/fluximgPng");
    const shot = async () => decodePng(new Uint8Array(await page.screenshot({ clip: { x: 170, y: 30, width: 300, height: 300 }, type: "png" })));
    const z = await page.evaluate(zoomStep as (d: unknown, a: boolean) => Promise<any>, zoomDeck(), true) as any;
    const zoomed = edgeEnergy(await shot());
    const big = await page.evaluate(zoomStep as (d: unknown, a: boolean) => Promise<any>, bigDeck(), false) as any;
    const ref = edgeEnergy(await shot());
    const zs = await page.evaluate(zoomStep as (d: unknown, a: boolean) => Promise<any>, zoomDeck(true), true) as any;
    const zSmooth = edgeEnergy(await shot());
    const bs = await page.evaluate(zoomStep as (d: unknown, a: boolean) => Promise<any>, bigDeck(true), false) as any;
    const refSmooth = edgeEnergy(await shot());
    h.section("B4: a camera zoom onto an image is sharp where the camera rests");
    h.ok(z.live && z.before?.[0] === 160 && z.after[0] === 128 && z.after[1] === 128, `the canvas is re-rendered for the resting zoom, at the crop's own pixels where the zoom magnifies them (${z.before?.join("x")} -> ${z.after.join("x")}; the 128 px checker shown at 640 px)`);
    h.ok(z.reallocs <= 1, `${z.reallocs} backing reallocation(s) during the camera move (sizes seen while it flies: ${z.widths.join(", ")})`);
    h.eq(z.rendering, "pixelated", "the display magnifies a not-smooth image's true pixels (image-rendering: pixelated, as the editor's element)");
    h.ok(zoomed >= 0.9 * ref, `one-pixel checker edges at zoom 4 (energy ${zoomed.toFixed(1)}) within 10 % of the same picture drawn unzoomed at 4x the size (${ref.toFixed(1)})`);
    h.ok(zs.rendering === "" && Math.abs(zSmooth - refSmooth) <= 0.15 * refSmooth, `a smooth image is magnified smoothly (edge energy ${zSmooth.toFixed(1)} vs ${refSmooth.toFixed(1)} unzoomed at 4x)`);
    void big; void bs;
    const sc = await page.evaluate(scaleRun as (d: unknown) => Promise<any>, scaleDeck()) as any;
    h.section("C8: a Change that scales an image keeps one canvas size while it moves");
    h.ok(sc[1].reallocs <= 2 && sc[1].end === 320, `160 -> 320: ${sc[1].reallocs} reallocation(s) over the Change (sizes: ${sc[1].widths.join(", ")}), exact at the end (${sc[1].end})`);
    h.ok(sc[2].reallocs <= 2 && sc[2].end === 160, `320 -> 160: ${sc[2].reallocs} reallocation(s) (sizes: ${sc[2].widths.join(", ")}), exact at the end (${sc[2].end})`);
  }
  if (r.across) {
    h.section("A1: a running movie runs on across later steps");
    for (const a of r.across) h.ok(a.ok >= a.of - 1, `${a.mode}: when step 2 begins the movie keeps its clock (${a.ok}/${a.of} samples on the clock since Start; shown/clock: ${a.seq})`);
    h.ok(r.cost[10].rafs === 0 && r.cost[10].changes >= 9, `a 10-plane-a-second movie at rest: ${r.cost[10].changes} planes drawn in 1 s with ${r.cost[10].rafs} animation callbacks (one timer per plane)`);
    h.ok(r.cost[50].rafs >= 40 && r.cost[50].changes >= 40, `a 50-plane-a-second movie runs on animation frames (${r.cost[50].rafs} callbacks, ${r.cost[50].changes} planes in 1 s)`);
    const n = r.nav;
    h.section("A1: every navigation does to a movie what it does to a video");
    h.ok(n.blank.held !== null && n.blank.held === n.blank.stillHeld, `blanking the screen holds the movie (plane ${n.blank.held} -> ${n.blank.stillHeld})`);
    h.ok(n.blank.resumed !== null && Math.abs(n.blank.resumed - n.blank.held) <= 1 && n.blank.ranOn !== n.blank.resumed, `unblanking resumes from the held plane and runs on (${n.blank.resumed} -> ${n.blank.ranOn})`);
    h.ok(n.hidden.held === n.hidden.still && n.hidden.rafs === 0, `a hidden document holds the movie with no frame loop (${n.hidden.held} -> ${n.hidden.still}, ${n.hidden.rafs} callbacks)`);
    h.ok(n.hidden.resumed !== null && Math.abs(n.hidden.resumed - n.hidden.held) <= 1, `shown again it resumes from where it was held (${n.hidden.resumed})`);
    h.ok(n.back.rewinding === true && n.back.atBack === 0 && n.back.duringRewind === 0, `an animated Back mid-step lands the movie at once where the jump does (step 1: its first plane) while the step rewinds (was ${n.back.beforeBack}; at Back ${n.back.atBack}, during ${n.back.duringRewind})`);
    h.ok(n.back.landed === 0 && n.back.mediaPaused === true && !n.back.mediaPlaying, "after the rewind lands the movie is paused there (the seek's pause, as a video's)");
    h.ok(n.nextAfterBack !== null && n.nextAfterBack >= 2 && n.nextAfterBack <= 5, `Next from there runs it on from that plane (${n.nextAfterBack} after 350 ms)`);
    h.ok(n.jump.j1 === 10 && n.jump.j2 === 10 && n.jump.state?.mediaPaused === true, `a jump to step 2's end lands paused on the pure clock's plane (Start + 1000 ms = 10: ${n.jump.j1}, ${n.jump.j2})`);
    h.ok(n.pause.p1 === n.pause.p2 && n.pause.p1 === 10 && n.pause.back === 10, `Pause holds it (${n.pause.p1} -> ${n.pause.p2}); Back over the Pause lands on step 2's plane (${n.pause.back})`);
    h.ok(n.otherSlide.index === 1 && n.otherSlide.rafs === 0, `on another slide nothing runs (${n.otherSlide.rafs} callbacks over 400 ms)`);
    h.eq(n.returned, 10, "back on the movie's slide at step 2 it stands paused on the pure clock's plane");
  }
  h.eq(errors(page), [], "no page errors");
} catch (error) {
  h.fail(String((error as Error).stack ?? error));
} finally {
  await browser?.close();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
await h.done();
