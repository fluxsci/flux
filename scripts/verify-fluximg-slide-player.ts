// fluximg stage 2, W2: how the slide PLAYER shows and animates an N-dimensional image, in a real headless Chrome.
//
// One page bundles the real player (`slide/player/player.ts`, `render.ts`, `transform.ts`, `player/fluximg.ts`) with the
// real image host (`fluximg/slideSurfaces.ts`: one shared WebGL renderer, a 2D canvas per surface) over a SYNTHETIC
// plane source: the planes of a small bundle written here with the TS writer (its manifest and layer files are the
// real ones), served from memory, optionally late (a deliberately slow decode). The reference is the law itself:
// `render.renderView` of the picture `viewTween` says a frame shows, plus a straight per-component lerp for mixes.
//
// Pins: at rest an image is its still (a static render shows the still's exact pixels and allocates no GPU; the live
// player's resting frame is the resting picture); a Change through time shows exactly the plane the plan says at
// sampled times; contrast, crop, an intensity layer fading in, a two-picture mix and a plane blend match the CPU
// reference; the last frame is the element's own picture; reverse and random seeks are pure (same pixels as a fresh
// player seeked there); capture `settled()` is exact under a slow decode, and before it the canvas keeps the newest
// complete earlier frame (never blank, never a blend); no animation frame is requested at rest, nor when late planes
// land; a slide without images creates no controller; the overlay's DOM nodes are the same objects before and after a
// tween (updated, not rebuilt); leaving the slide and destroying the player free the GL textures.
//
// Pure tier, prerequisite "chrome". Hermetic: the bundle and the page script live in a mkdtemp directory removed at
// the end; the server listens on an ephemeral port.
// Run: npx tsx scripts/verify-fluximg-slide-player.ts
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

const h = harness("verify-fluximg-slide-player");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "fluximg-slide-player-"));

// ---- the synthetic image: t, c, y, x uint16, a label layer, a vector layer, an intensity layer -----------------------
const T = 24, C = 2, H = 48, W = 64;
const data = new Uint16Array(T * C * H * W);
for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
  data[((t * C + c) * H + y) * W + x] = 50 + ((x * (c + 1) * 13 + y * 7 + t * 97 + c * 500) % 4000);
const labels = new Uint16Array(H * W);
const blob = (l: number, y0: number, x0: number, hh: number, ww: number) => { for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) labels[y * W + x] = l; };
blob(1, 4, 6, 6, 8); blob(2, 20, 30, 8, 6); blob(3, 34, 44, 5, 12); blob(4, 10, 50, 7, 7);
const glow = new Uint16Array(H * W);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) glow[y * W + x] = (x * 17 + y * 29) % 1000;
const report = await writeFluximg(nodeBundleWriter(path.join(scratch, "img.fluximg")), await nodeZstd(), {
  name: "slide movie", source: arraySource(data, ["t", "c", "y", "x"], [T, C, H, W], "uint16"),
  axes: { t: { unit: "s", scale: 0.1 }, y: { unit: "µm", scale: 0.5 }, x: { unit: "µm", scale: 0.5 } },
  channels: [{ name: "a", color: "#ff00ff", range: [100, 3000] }, { name: "b", color: "#00ff00", range: [100, 3500] }],
  layers: [
    { kind: "labels", id: "cells", name: "cells", data: labels, visible: true, key: "label", table: { key: "label", columns: { label: [1, 2, 3, 4], kind: ["x", "y", "x", "z"] } } },
    { kind: "vector", id: "marks", name: "marks", count: 2, body: '<circle id="marks/p" data-key="p" cx="12.5" cy="30.5" r="3"/><line id="marks/q" data-key="q" x1="40" y1="5" x2="60" y2="20"/>', visible: true },
    { kind: "intensity", id: "glow", name: "glow", data: glow, dtype: "uint16", color: "#ffd400", range: [0, 1000], opacity: 0.6, visible: false },
  ],
});
const manifest = report.manifest;
const layerText: Record<string, string> = {}, tables: Record<string, unknown> = {};
for (const l of manifest.layers) if (l.kind === "labels") { layerText[l.outlines] = await readFile(path.join(scratch, "img.fluximg", l.outlines), "utf8"); tables[l.table] = JSON.parse(await readFile(path.join(scratch, "img.fluximg", l.table), "utf8")); }
  else if (l.kind === "vector") layerText[l.path] = await readFile(path.join(scratch, "img.fluximg", l.path), "utf8");
const glowLayer = manifest.layers.find((l) => l.id === "glow")!;
h.ok(manifest.pixels.levels.length === 1 && glowLayer.kind === "intensity", "a synthetic bundle written by the TS writer (one level, every layer kind)");

// ---- the deck: Design + one Change per kind of thing an image can do --------------------------------------------------
// The label layer is styled by a column of its table (W4 styleBy): colour by category.
const CELLS = { visible: true, styleBy: { color: { column: "kind" } } };
const base = { layers: { cells: CELLS, marks: { visible: true } }, furniture: { stamp: {}, scalebar: {} } };
const view = (patch: Record<string, unknown>) => structuredClone({ ...base, ...patch });
const V0 = view({ index: { t: 0 } });
const V1 = view({ index: { t: 20 } });                                                                       // walk the time axis
const V2 = view({ index: { t: 20 }, channels: [{ range: [600, 2200] }, { range: [300, 1800], gamma: 1.6, norm: "gamma" }] }); // contrast
const CROP3 = { x: 16, y: 12, width: 32, height: 24 };                                                        // zoom in (crop)
const V4 = view({ index: { t: 20 }, channels: [{ range: [600, 2200], color: "#00ffff" }, { range: [300, 1800], gamma: 1.6, norm: "gamma" }],
  layers: { cells: { ...CELLS, opacity: 0.25 }, marks: { visible: true }, glow: { visible: true, opacity: 0.6 } } });     // colour switch (two pictures), layer fades
const V5 = structuredClone(V4); (V5 as { index: Record<string, number> }).index = { t: 4 };                     // blend walk back
const track = (id: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, target: "im", preset: "transform", start: 0, duration: 1000, easing: "linear", to: { state }, ...extra });
const deck = {
  schemaVersion: "0.7.0", id: "d", title: "images", created: "", modified: "", stage: { width: 640, height: 360 }, theme: "flux-dark",
  defaults: { transition: "none" }, assets: [],
  slides: [
    { id: "s0", elements: [{ type: "fluximg", id: "im", x: 40, y: 20, width: 320, height: 240, rotation: 0, assetId: "img", view: V0 }],
      beats: [
        { id: "b0", tracks: [] },
        { id: "b1", tracks: [track("walk", { view: V1 })] },
        { id: "b2", tracks: [track("contrast", { view: V2 })] },
        { id: "b3", tracks: [track("zoom", { crop: CROP3 })] },
        { id: "b4", tracks: [track("switch", { view: V4 })] },
        { id: "b5", tracks: [track("blend", { view: V5 }, { params: { blend: true } })] },
      ] },
    { id: "s1", elements: [{ type: "rect", id: "r", x: 100, y: 100, width: 200, height: 100, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 }], beats: [{ id: "c0", tracks: [] }] },
  ],
};

// ---- the page ---------------------------------------------------------------------------------------------------------
interface PageData { manifest: typeof manifest; layerText: Record<string, string>; tables: Record<string, any>; data: string; glow: string; deck: typeof deck; T: number; C: number; H: number; W: number }

async function pageRun(D: PageData): Promise<unknown> {
  const FX = (window as any).FX;
  const out: Record<string, unknown> = {};
  const fromB64 = (s: string) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Uint16Array(u.buffer); };
  const data = fromB64(D.data), glow = fromB64(D.glow), { manifest, T, C, H, W } = D;
  const maps = FX.pixelMaps(manifest), glowEntry = manifest.layers.find((l: any) => l.id === "glow");
  const glowMap = FX.valueMaps(glowEntry.dtype, glowEntry.encoding, 1, null)[0];
  const planeData = (t: number, c: number) => data.slice(((t * C + c) * H) * W, ((t * C + c) * H + H) * W);
  const resolveLut = () => null;
  const BUNDLE = "fig/assets/img.fluximg";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A plane source over memory. `delay.ms` > 0: every plane arrives late (a deliberately slow decode).
  function makeSource(delay: { ms: number }, counts: { planes: number }) {
    const late = <V>(v: () => V): Promise<V> => delay.ms ? sleep(delay.ms).then(v) : Promise.resolve().then(v);
    return {
      manifest: (id: string) => (id === "img" ? manifest : undefined),
      need: (id: string) => (id === "img" ? Promise.resolve(manifest) : Promise.reject(new Error("unknown"))),
      bundle: (id: string) => (id === "img" ? BUNDLE : undefined),
      identity: () => "img-sha",
      planes: {
        plane: (bundle: string, level: number, leading: number[]) => late(() => { counts.planes++; return { key: FX.planeKey(bundle, level, leading), width: W, height: H, dtype: "uint16", data: planeData(leading[0], leading[1]), map: maps[leading[1]] }; }),
        projection: () => Promise.reject(new Error("no projections here")),
        layer: (bundle: string, id: string, f: number) => late(() => ({ key: FX.layerKey(bundle, id, f), width: W, height: H, dtype: "uint16", data: glow.slice(), map: glowMap })),
      },
      still: () => Promise.reject(new Error("no stills in the live host")),
      stillNow: () => undefined,
      resolveLut,
    };
  }
  // The law: renderView of a picture (all planes at level 0 here).
  function reference(pic: any, w: number, h: number): Uint8ClampedArray {
    const rv = pic.view;
    return FX.renderView({
      width: W, height: H,
      channels: rv.channels.map((c: any, i: number) => ({ plane: { data: planeData(rv.index.t, i), map: maps[i] }, view: c, table: FX.channelTable(c, resolveLut) })),
      layers: rv.layers.filter((l: any) => l.kind === "intensity" && l.visible && l.opacity > 0).map((l: any) => ({ plane: { data: glow, map: glowMap }, range: l.range ?? glowEntry.range, table: FX.channelTable({ color: l.color, lut: l.lut, invert: false }, resolveLut), opacity: l.opacity, opacityFromValue: l.opacityFromValue })),
      composite: rv.composite, solo: rv.solo, background: rv.background, smooth: rv.smooth, crop: pic.crop, outWidth: w, outHeight: h,
    });
  }
  const lerp = (a: Uint8ClampedArray, b: Uint8ClampedArray, w: number) => { const o = new Uint8ClampedArray(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.round(a[i] * (1 - w) + b[i] * w); return o; };
  const neighbour = (p: any, bl: any) => (p.view.projection?.dim === bl.dim && bl.end ? { crop: p.crop, view: { ...p.view, projection: { ...p.view.projection, [bl.end]: bl.other } } } : { crop: p.crop, view: { ...p.view, index: { ...p.view.index, [bl.dim]: bl.other } } });
  /** The CPU reference of a whole frame: a, b mixed by `mix`, then the blend neighbour(s) at their weight. */
  function frameReference(f: any, w: number, h: number): Uint8ClampedArray {
    const one = (p: any) => (f.b && f.mix > 0 ? lerp(reference(p.a, w, h), reference(p.b, w, h), f.mix) : reference(p.a, w, h));
    const here = one({ a: f.a, b: f.b });
    if (!f.blend || !(f.blend.weight > 0)) return here;
    const there = one({ a: neighbour(f.a, f.blend), b: f.b ? neighbour(f.b, f.blend) : null });
    return lerp(here, there, f.blend.weight);
  }
  const diff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let max = 0, over = 0; if (a.length !== b.length) return { max: 999, over: -1 }; for (let i = 0; i < a.length; i += 4) { let worst = 0; for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(a[i + k] - b[i + k])); max = Math.max(max, worst); if (worst > 1) over++; } return { max, over }; };
  // The surface's canvas holds a transferred bitmap: read it back through a 2D copy.
  const pixels = (mount: HTMLElement) => {
    const c = mount.querySelector<HTMLCanvasElement>("canvas[data-slide-fluximg]")!;
    if (!c.width || !c.height) return new Uint8ClampedArray(0);
    const k = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height }).getContext("2d")!;
    k.drawImage(c, 0, 0);
    return k.getImageData(0, 0, c.width, c.height).data;
  };
  const binding = (mount: HTMLElement) => FX.fluximgBindingOf(mount.querySelector("[data-slide-fluximg-root]"));
  const theme = FX.FLUX_DARK;
  const deck = D.deck;
  const slide = deck.slides[0];
  const plan = (beat: number) => {
    const t = slide.beats[beat].tracks[0];
    const pre = FX.transformPreState(slide, "im", beat), end = FX.transformEndState(pre, t);
    return { plan: FX.planViewTween(manifest, { view: pre.view, crop: pre.crop }, { view: end.view, crop: end.crop }, { blend: t.params?.blend === true }), pre, end };
  };
  const mountOf = () => { const m = document.createElement("div"); document.body.append(m); return m; };
  const layerTextOf = (_: string, p: string) => D.layerText[p];
  const tableOf = (_: string, p: string) => D.tables[p];
  const newPlayer = (delay = { ms: 0 }) => {
    const counts = { planes: 0 }, host = FX.createFluximgSlideHost(makeSource(delay, counts)), mount = mountOf();
    const player = FX.createPlayer(mount, deck, { theme, mode: "present", reducedMotion: false, fluximg: host, fluximgManifest: () => manifest, fluximgLayerText: layerTextOf, fluximgTable: tableOf });
    return { host, mount, player, counts, delay };
  };
  const at = async (P: any, beat: number, ms: number) => { P.player.seek(0, beat, ms); await P.player.captureMedia([], ms); };

  // 1. A static render: the still, exactly, and no GPU ------------------------------------------------------------------
  {
    const stills = new Map<string, string>();
    const stillOf = (_: string, pic: any, w: number, h: number) => {
      const key = `${w}x${h}|${FX.pixelKey(manifest, pic.view, pic.crop, w, h)}`;
      if (!stills.has(key)) { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d")!.putImageData(new ImageData(reference(pic, w, h), w, h), 0, 0); stills.set(key, c.toDataURL("image/png")); }
      return stills.get(key);
    };
    const host = mountOf();
    FX.renderStaticAt(host, slide, deck.stage, 2, { theme, fluximgManifest: () => manifest, fluximgStill: stillOf, fluximgLayerText: layerTextOf, fluximgTable: tableOf });
    const image = host.querySelector("[data-fluximg-still] image");
    const canvas = host.querySelector<HTMLCanvasElement>("canvas[data-slide-fluximg]")!;
    const end2 = plan(2).plan.end;
    const size = FX.tieredStillSize(end2.crop, { width: 320, height: 240 }, 2);
    const img = new Image(); img.src = image?.getAttribute("href") ?? ""; await img.decode().catch(() => {});
    const c = document.createElement("canvas"); c.width = size.width; c.height = size.height; const k = c.getContext("2d")!; k.drawImage(img, 0, 0);
    out.static = { image: !!image, canvas: [canvas.width, canvas.height, canvas.style.display], size: [size.width, size.height], diff: diff(k.getImageData(0, 0, size.width, size.height).data, reference(end2, size.width, size.height)), overlayGroups: host.querySelectorAll("g[data-layer]").length };
    host.remove();
  }

  // 2. The live player: rest, the walk, contrast, crop, layer fade + mix, blend, the end ------------------------------
  const P = newPlayer();
  let rafs = 0;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { rafs++; return realRaf(cb); };
  const OUT = [320, 240];
  {
    await at(P, 0, Infinity);
    const b = binding(P.mount);
    const rest = { view: FX.resolveView(manifest, slide.elements[0].view), crop: FX.clampCrop(manifest, undefined) };
    out.rest = { live: b.probe().live, size: [P.mount.querySelector("canvas")!.width, P.mount.querySelector("canvas")!.height], diff: diff(pixels(P.mount), reference(rest, OUT[0], OUT[1])), still: P.mount.querySelector("[data-fluximg-still]")!.getAttribute("style") };
  }
  const sampled: any[] = [];
  const check = async (beat: number, raws: number[], tol: number, name: string) => {
    const { plan: pl } = plan(beat);
    for (const raw of raws) {
      await at(P, beat, raw * 1000);
      const f = pl.frame(raw, raw);
      const d = diff(pixels(P.mount), frameReference(f, OUT[0], OUT[1]));
      sampled.push({ name, beat, raw, t: f.a.view.index.t, mix: f.b ? f.mix : 0, blend: f.blend, ...d, ok: d.max <= tol });
    }
  };
  await check(1, [0, 0.05, 0.26, 0.5, 0.74, 0.99, 1], 1, "walk t 0 to 20");
  await check(2, [0.3, 0.7], 1, "contrast");
  await check(3, [0.25, 0.6], 1, "crop");
  await check(4, [0.2, 0.5, 0.8], 2, "colour switch + layer fades");
  await check(5, [0.13, 0.4, 0.77], 2, "plane blend");
  out.sampled = sampled;
  // The last frame of each Change is the element's own picture at that step (its state, resolved by the manifest).
  out.ends = [];
  for (const beat of [1, 2, 3, 4, 5]) {
    await at(P, beat, Infinity);
    const { end } = plan(beat);
    (out.ends as unknown[]).push({ beat, ...diff(pixels(P.mount), reference({ view: FX.resolveView(manifest, end.view), crop: FX.clampCrop(manifest, end.crop) }, OUT[0], OUT[1])) });
  }
  // Layer opacity in the overlay follows the frame (beat 4: cells 1 -> 0.25).
  {
    await at(P, 4, 500);
    const f = plan(4).plan.frame(0.5, 0.5);
    const g = P.mount.querySelector('g[data-layer="cells"]');
    out.layerFade = { attr: g?.getAttribute("opacity") ?? "1", want: f.overlay.view.layers.find((l: any) => l.id === "cells").opacity };
  }
  // A styled label layer in a playing slide: every object's computed stroke is the at-rest element's (static.ts, the
  // same composition the element at rest and every export draw).
  {
    await at(P, 1, 500);
    const pre = FX.transformPreState(slide, "im", 1), rv = FX.resolveView(manifest, pre.view);
    const cellsLayer = manifest.layers.find((l: any) => l.id === "cells");
    const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg"); document.body.append(holder);
    holder.innerHTML = FX.fluximgStaticSvg({ manifest, view: rv, crop: FX.clampCrop(manifest, null), box: { width: 320, height: 240 }, stillHref: null, layerSvg: { cells: D.layerText[cellsLayer.outlines] }, idPrefix: "rest-", tables: { cells: D.tables[cellsLayer.table] } });
    const stroke = (root: Element) => Object.fromEntries([...root.querySelectorAll('[data-layer="cells"] [data-key]')].map((n) => [n.getAttribute("data-key"), getComputedStyle(n).stroke]));
    out.styled = { rest: stroke(holder), playing: stroke(P.mount) };
    holder.remove();
  }
  // The overlay is updated, not rebuilt, across a zoom.
  {
    await at(P, 3, 0); const before = binding(P.mount).probe().overlay as Element[];
    const tf0 = P.mount.querySelector('g[data-layer="cells"]')?.getAttribute("transform");
    await at(P, 3, 500); await at(P, 3, 1000);
    const after = binding(P.mount).probe().overlay as Element[];
    const tf1 = P.mount.querySelector('g[data-layer="cells"]')?.getAttribute("transform");
    out.overlay = { same: before.length === after.length && before.every((n, i) => n === after[i] && n.isConnected), count: before.length, moved: tf0 !== tf1 };
  }
  // 3. Purity: reverse and random seeks show what a fresh player seeked there shows -------------------------------------
  {
    const order: Array<[number, number]> = [[1, 900], [1, 200], [5, 600], [1, 650], [3, 100], [5, 50], [1, 0]];
    const purity: unknown[] = [];
    for (const [beat, ms] of order) {
      await at(P, beat, ms);
      const mine = pixels(P.mount);
      const F = newPlayer();
      await at(F, beat, ms);
      purity.push({ beat, ms, ...diff(mine, pixels(F.mount)) });
      F.player.destroy(); F.host.dispose(); F.mount.remove();
    }
    out.purity = purity;
  }
  // 4. No animation frame at rest -------------------------------------------------------------------------------------------
  {
    await at(P, 2, Infinity);
    const r0 = rafs; await sleep(300);
    out.restRafs = rafs - r0;
  }
  // 5. A slow decode: the newest complete earlier frame, then exactly the asked one (settled), with no rAF ------------------
  {
    const S = newPlayer({ ms: 0 });
    await at(S, 1, 200);
    const before = pixels(S.mount);
    S.delay.ms = 150;
    const r0 = rafs;
    S.player.seek(0, 1, 800);                                  // planes for t 16 are not decoded yet
    const b = binding(S.mount), pend = b.probe().pending;
    const during = pixels(S.mount);
    const t0 = performance.now();
    await S.player.captureMedia([], 800);
    const waited = performance.now() - t0;
    const f = plan(1).plan.frame(0.8, 0.8);
    out.slow = { pending: pend, kept: diff(during, before), exact: diff(pixels(S.mount), frameReference(f, OUT[0], OUT[1])), waited, rafs: rafs - r0 };
    // and a scrub that lands while nothing is playing: the late planes draw by themselves, with no frame loop
    S.player.seek(0, 1, 450);
    await sleep(400);
    out.slowScrub = { pending: binding(S.mount).probe().pending, exact: diff(pixels(S.mount), frameReference(plan(1).plan.frame(0.45, 0.45), OUT[0], OUT[1])), rafs: rafs - r0 };
    S.player.destroy(); S.host.dispose(); S.mount.remove();
  }
  // 6. Leaving for a slide without images: no controller there, and the GPU is given back ------------------------------
  {
    await at(P, 2, Infinity);
    const showing = P.host.stats();
    P.player.goTo(1, 0);
    await sleep(50);
    const left = P.host.stats();
    P.player.goTo(0, 2);
    await P.player.captureMedia([], Infinity);
    const back = P.host.stats();
    P.player.destroy();
    const destroyed = P.host.stats();
    out.gpu = { showing, left, back, destroyed, imagesOnPlain: document.querySelectorAll("[data-slide-fluximg-root]").length };
  }
  window.requestAnimationFrame = realRaf;
  return out;
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
      resolveDir: root, loader: "ts", sourcefile: "fluximg-slide-player-entry.ts",
      contents: [
        `export { createPlayer, renderStaticAt } from "./src/lib/slide/player/player";`,
        `export { fluximgBindingOf } from "./src/lib/slide/player/fluximg";`,
        `export { createFluximgSlideHost } from "./src/lib/fluximg/slideSurfaces";`,
        `export { planViewTween } from "./src/lib/fluximg/viewTween";`,
        `export { renderView } from "./src/lib/fluximg/render";`,
        `export { channelTable } from "./src/lib/fluximg/lut";`,
        `export { resolveView, pixelKey } from "./src/lib/fluximg/viewOps";`,
        `export { clampCrop, tieredStillSize, pixelMaps } from "./src/lib/fluximg/still";`,
        `export { valueMaps } from "./src/lib/fluximg/encoding";`,
        `export { planeKey, layerKey } from "./src/lib/fluximg/service";`,
        `export { transformPreState, transformEndState } from "./src/lib/slide/tween";`,
        `export { FLUX_DARK } from "./src/lib/slide/theme";`,
        `export { fluximgStaticSvg } from "./src/lib/fluximg/static";`,
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
  const r = await page.evaluate(pageRun as (d: PageData) => Promise<any>, { manifest, layerText, tables, data: b64(data), glow: b64(glow), deck, T, C, H, W } as PageData) as any;

  h.section("at rest: the still");
  h.ok(r.static.image, "a static render (no host) shows the still as an <image>");
  h.eq(r.static.canvas.slice(0, 2), [0, 0], "a static render allocates no canvas backing store (no GPU)");
  h.ok(r.static.diff.max === 0, `the static still is exactly the step's picture drawn by the law (${r.static.size.join("x")}, max diff ${r.static.diff.max})`);
  h.ok(r.static.overlayGroups >= 2, `the static render carries the vector overlay (${r.static.overlayGroups} layer groups)`);
  h.ok(r.rest.live && r.rest.diff.max <= 1, `the live player at rest draws the resting picture (max diff ${r.rest.diff.max}, ${r.rest.size.join("x")})`);

  h.section("a Change, frame by frame, against the law");
  for (const s of r.sampled) h.ok(s.ok, `${s.name} raw ${s.raw}: t ${s.t}${s.mix ? ` mix ${(+s.mix).toFixed(2)}` : ""}${s.blend ? ` blend ${s.blend.other}@${(+s.blend.weight).toFixed(2)}` : ""}: max diff ${s.max} (${s.over} px over 1)`);
  for (const e of r.ends) h.ok(e.max <= 1, `beat ${e.beat}: the last frame is the element's own picture at that step (max diff ${e.max})`);
  h.ok(Math.abs(Number(r.layerFade.attr) - r.layerFade.want) < 1e-3, `a label layer's opacity follows the frame (${r.layerFade.attr} = ${(+r.layerFade.want).toFixed(4)})`);
  {
    const keys = Object.keys(r.styled.rest), colours = new Set(Object.values(r.styled.rest));
    h.ok(keys.length === 4 && colours.size === 3 && keys.every((k) => r.styled.playing[k] === r.styled.rest[k]), `a styled label layer mid-tween: each object's computed stroke is the at-rest element's (${keys.map((k) => `${k} ${r.styled.playing[k]}`).join(", ")})`);
  }
  h.ok(r.overlay.same && r.overlay.moved, `the overlay's ${r.overlay.count} nodes are the same objects before and after a zoom, and its layer transform moved`);

  h.section("purity");
  for (const p of r.purity) h.ok(p.max === 0, `seek beat ${p.beat} at ${p.ms} ms after other seeks = a fresh player seeked there (max diff ${p.max})`);

  h.section("no frame loop");
  h.eq(r.restRafs, 0, "no animation frame is requested at rest");

  h.section("a slow decode (planes 150 ms late)");
  h.ok(r.slow.pending, "a frame whose planes are late reports pending");
  h.ok(r.slow.kept.max === 0, "meanwhile the canvas keeps the newest complete earlier frame (not blank, not a blend)");
  h.ok(r.slow.exact.max <= 1 && r.slow.waited >= 100, `capture's settled() waits ${r.slow.waited.toFixed(0)} ms and then the frame is exact (max diff ${r.slow.exact.max})`);
  h.ok(!r.slowScrub.pending && r.slowScrub.exact.max <= 1, `a parked scrub draws its exact frame when the late planes land (max diff ${r.slowScrub.exact.max})`);
  h.eq(r.slowScrub.rafs, 0, "late planes are drawn without any animation frame");

  h.section("GPU and controllers");
  h.ok(r.gpu.showing.textures > 0 && r.gpu.showing.listeners === 1, `showing: ${r.gpu.showing.textures} textures, one controller listening`);
  h.eq([r.gpu.left.textures, r.gpu.left.liveSurfaces, r.gpu.left.listeners, r.gpu.left.surfaces], [0, 0, 0, 0], "on a slide without images: no textures, no surfaces, no controller");
  h.ok(r.gpu.back.textures > 0, "back on the image slide, it draws again");
  h.eq([r.gpu.destroyed.textures, r.gpu.destroyed.surfaces, r.gpu.destroyed.listeners], [0, 0, 0], "destroying the player frees every texture and surface");
  h.eq(errors(page), [], "no page errors");
} catch (error) {
  h.fail(String((error as Error).stack ?? error));
} finally {
  await browser?.close();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
await h.done();
