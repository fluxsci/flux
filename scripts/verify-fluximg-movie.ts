// fluximg stage 2, W10: an image's movie as a FILE (pure tier; the encoder-backed checks skip with one line without it).
//
// One image element played along one dimension, written as an H.264 MP4 (flux-core/fluximgMovie.ts) from the plan
// `fluximg/moviePlan.ts` defines on top of the deck clips' planners, drawn and encoded by the deck clips' baker. Pins:
//   A. the plan: frame count, order and rate for once / bounce / a sub-range / speed / fps / blend, against
//      hand-computed lists; the defaults (playback dimension and range, natural rate, 12 fps); refusals; the size rules
//      (legibility floor, the 2160 cap, even sides by matte); the board's facts agree with the plan;
//   B. the written file: codec, pixel format, even size, frame count, duration within one frame, faststart order, the
//      slide-video colour tags;
//   C. decoded frames (first, middle, last) against the element as Flux draws it (the static composer's SVG with the
//      reference still, rasterized by resvg) within the deck clips' bound; the time stamp reads each frame's own time;
//      the scale bar's length in pixels; styled label layers drawn; a crop respected; a mirrored element;
//   D. cancel removes the partial file;  E. no encoder: a clean refusal that names the reason;
//   F. memory stays bounded on a stack larger than the decoded-piece budget (peak RSS of a child process); export speed;
//   G. the verb end to end (CLI-shaped registry call) for an image on a figure and on a slide (Design and a step);
//   H. the same request twice writes the same bytes.
//
// Run: npx tsx scripts/verify-fluximg-movie.ts   (FLUX_VIDEO_ENCODER=<pinned ffmpeg> to use another encoder)
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { harness } from "./lib/harness.mjs";
import { tsxRun } from "./lib/tsxRun.mjs";
import { Resvg } from "@resvg/resvg-js";
import { makeProject, V0, CELLS } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-movie");
const P = await makeProject();
const MP = await import("../src/lib/fluximg/moviePlan");
const CP = await import("../src/lib/fluximg/clipPlan");
const { resolveView } = await import("../src/lib/fluximg/viewOps");
const { fluximgReader } = await import("../flux-core/fluximgRender");
const { fluximgResolvedAsset } = await import("../src/lib/fluximg/place");
const { renderStill } = await import("../src/lib/fluximg/still");
const { fluximgStaticSvg, fluximgIdPrefix } = await import("../src/lib/fluximg/static");
const { scalebarGeometry } = await import("../src/lib/fluximg/furniture");
const { pngDataUrl } = await import("../flux-core/fluximgPng");
const { resolveFluximgLut } = await import("../flux-core/fluximgRender");
const { colormapLut, ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
const Movie = await import("../flux-core/fluximgMovie");
const { imageClipEncoder } = await import("../flux-core/fluximgClip");
await ensureColormapLuts();

const assetId: string = P.placed.assetId, elementId: string = P.placed.elementId;
const manifest = JSON.parse(await fs.readFile(path.join(P.root, "fig/assets", `${assetId}.fluximg`, "fluximg.json"), "utf8"));
const asset = fluximgResolvedAsset(assetId, manifest);
const reader = await fluximgReader(P.root, asset);
/** The deck clips' bound (CRF 15, 4:2:0, BT.709 limited) for decoded frames against their reference. */
const BOUND = { mean: 2.0, max: 128, luma: 40 };
const extra: string[] = [];
let figureEl = "";
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const src = (o: Partial<import("../src/lib/fluximg/moviePlan").MovieSource> = {}) => ({ view: V0, crop: null, width: 320, height: 240, ...o });

try {
  // ------------------------------------------------------------------------------------------------------------------
  h.section("A. the plan");
  {
    const plan = (o: import("../src/lib/fluximg/moviePlan").MovieOptions = {}, s = src(), decorated = true) => {
      const st = MP.resolveMovie(manifest, s, o, decorated);
      const p = MP.planMovieClip(manifest, { view: resolveView(manifest, s.view as any), crop: st.crop }, { view: s.view as any, crop: s.crop }, st);
      return { st, p, planes: p.frames.map((f) => f.frame.a.view.index[st.dim]), sum: MP.movieSummary(st) };
    };
    const d = plan();
    h.ok(d.st.dim === "t" && d.st.from === 0 && d.st.to === 24 && d.st.mode === "once", "defaults: the time axis, all 24 planes, once");
    h.eq(d.planes, range(0, 24), "once: one frame per plane, in order");
    h.ok(d.p.rate === "1000000/100000" && d.p.fps === 10 && d.p.durationMs === 2400, "the data's own rate (t in 0.1 s steps: 10 planes a second), an exact rational; 2.4 s");
    h.eq(plan({ mode: "bounce", from: 2, to: 6 }).planes, [2, 3, 4, 5, 4, 3, 2], "bounce 2..6: there and back, ending on the first plane again (7 frames)");
    h.eq(plan({ from: 5, to: 9 }).planes, [5, 6, 7, 8], "a sub-range: planes from (inclusive) to (exclusive)");
    const sp = plan({ speed: 2 });
    h.ok(sp.p.rate === "1000000/50000" && sp.p.fps === 20 && sp.p.durationMs === 1200 && sp.planes.length === 24, "speed 2: 20 planes a second, 1.2 s, the same 24 frames");
    const fp = plan({ fps: 4, speed: 2 });
    h.ok(fp.p.fps === 8 && fp.p.rate === "1000000/125000" && fp.p.durationMs === 3000, "fps 4 replaces the data's rate, speed still applies: 8 a second");
    // Blend: the Change "Play through" with Blend planes writes, linear, sampled on the 60 Hz clock.
    const bl = plan({ blend: true, from: 0, to: 4 });
    const hand = range(0, 19).map((j) => { const p = j / 6, a = Math.floor(p), w = p - a; return w > 1e-9 ? `${a}>${a + 1}@${w.toFixed(3)}` : `${a}`; });
    const got = bl.p.frames.map((f) => f.frame.blend && f.frame.blend.weight > 1e-9 ? `${f.frame.a.view.index.t}>${f.frame.blend.other}@${f.frame.blend.weight.toFixed(3)}` : `${f.frame.a.view.index.t}`);
    h.eq(got, hand, "blend 0..4 at 10 a second: 19 frames at 60 fps, plane k at 0.1 k s, each pair crossfaded by the clock");
    h.ok(bl.p.fps === 60 && bl.p.rate === "60" && Math.abs(bl.p.durationMs - 19000 / 60) < 1e-6, "blend runs at 60 fps (a crossfade is continuous)");
    const bb = plan({ blend: true, from: 0, to: 4, mode: "bounce" });
    h.ok(bb.p.frames.length === 37 && bb.p.frames[18].frame.a.view.index.t === 3 && bb.p.frames[36].frame.a.view.index.t === 0, "blend bounce: the walk back appended (37 frames, the turn at plane 3, ending at 0)");
    const cases = [d, plan({ mode: "bounce", from: 2, to: 6 }), sp, fp, bl, bb, plan({ blend: true, from: 3, to: 4 })];
    h.ok(cases.every((c) => c.sum.frames === c.p.frames.length && Math.abs(c.sum.durationMs - c.p.durationMs) < 1e-6 && Math.abs(c.sum.fps - c.p.fps) < 1e-9), "the board's summary (frames, rate, length) equals the plan in every case");
    h.eq(MP.movieFacts(d.st), "24 frames · 2.4 s at 10 fps · 320×240", "the facts in the board's words");
    // Defaults from the element's playback setting, and the rate when the axis has none.
    const pb = plan({}, src({ playback: { dim: "t", mode: "loop", from: 2, to: 8, fps: 5 } }));
    h.ok(pb.st.from === 2 && pb.st.to === 8 && pb.p.fps === 10, "the playback's range is the default; the data's own rate wins over the playback's fps");
    const plain = structuredClone(manifest); delete plain.axes.t.unit;
    const r12 = MP.resolveMovie(plain, src(), {}), r5 = MP.resolveMovie(plain, src({ playback: { dim: "t", mode: "loop", fps: 5 } }), {});
    h.ok(r12.planeRate === 12 && r5.planeRate === 5, "an axis without a rate: the playback's fps, else 12 planes a second");
    const refuse = (o: any, re: RegExp) => { try { MP.resolveMovie(manifest, src(), o); return false; } catch (e) { return e instanceof MP.MovieRequestError && re.test((e as Error).message); } };
    h.ok(refuse({ dim: "z" }, /not a dimension this image can play \(t\)/) && refuse({ from: 24 }, /from must be a whole plane 0\.\.23/) && refuse({ from: 5, to: 5 }, /to must be a whole plane after from/)
      && refuse({ speed: 0 }, /speed/) && refuse({ fps: -1 }, /fps/) && refuse({ mode: "loop" }, /once or bounce/) && refuse({ scale: 40 }, /scale/), "requests that do not fit are refused, saying what would");
    // Size.
    const sz = (o: any, s = src(), deco = true) => MP.resolveMovie(manifest, s, o, deco);
    const raised = sz({}), bare = sz({}, src(), false), three = sz({ scale: 3 }, src(), false);
    h.ok(raised.raised && raised.picture.width === 320 && raised.picture.height === 240 && raised.width === 320, "with furniture: never below the element's box (64 x 48 at 5x = 320 x 240)");
    h.ok(!bare.raised && bare.width === 64 && bare.height === 48 && three.width === 192 && three.height === 144, "without: the image's own pixels times scale (64 x 48; 192 x 144)");
    const odd = sz({}, src({ crop: { x: 3, y: 2, width: 33, height: 25 } }), false);
    h.ok(odd.picture.width === 33 && odd.picture.height === 25 && odd.width === 34 && odd.height === 26, "odd sides: the picture is drawn at 33 x 25 and the file is 34 x 26 (one pixel of matte, never stretched)");
    const big = structuredClone(manifest); big.pixels.shape = [24, 2, 3000, 4000];
    const capped = MP.resolveMovie(big, src({ width: 400, height: 300 }), { scale: 2 });
    h.ok(capped.capped && capped.width === 2160 && capped.height === 1620, "the longest side is capped at 2160 (4000 x 3000 at 2x -> 2160 x 1620)");
    const skew = sz({}, src({ width: 320, height: 100 }));
    h.ok(Math.abs(skew.box.height - 240) < 1e-9, "a box off the picture's aspect lays the furniture out at the picture's aspect (no stretched words)");
    h.eq(MP.movieFileName("Cells / day 3: växt"), "Cells-day-3-vaxt.mp4", "a safe default file name from the image's name");
  }

  // ------------------------------------------------------------------------------------------------------------------
  h.section("A2. static exports say how to get the movie");
  {
    const { IMAGE_STILL_NOTE } = await import("../src/lib/slide/imageExport");
    const refusal = /its element will show a placeholder|missing from the export|no parts tree/;
    h.ok(/Movie as MP4/.test(IMAGE_STILL_NOTE) && /\(Shift\+R\)/.test(IMAGE_STILL_NOTE) && !/\.\s/.test(IMAGE_STILL_NOTE) && !refusal.test(IMAGE_STILL_NOTE), `the PDF / PowerPoint note is one sentence naming the board key: "${IMAGE_STILL_NOTE}"`);
    const src2 = await fs.readFile("src/lib/slide/export/deckPptx.ts", "utf8") + await fs.readFile("src/lib/slide/export/deckPdf.ts", "utf8");
    h.eq((src2.match(/warnings\.push\(IMAGE_STILL_NOTE\)/g) ?? []).length, 2, "PowerPoint and PDF each push it once per export (the guards stand)");
  }

  // ------------------------------------------------------------------------------------------------------------------
  const encoder = await imageClipEncoder();
  if (!encoder) console.log("SKIP (native-encoder: the pinned video encoder is not installed; npm run fetch:video-encoder): B-H, the written movie");
  else await encoded(encoder.path);
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(async () => { await fs.rm(P.scratch, { recursive: true, force: true }); for (const d of extra) await fs.rm(d, { recursive: true, force: true }); });

// =====================================================================================================================

/** The file's stream as ffmpeg reads it, its top-level boxes and its decoded frames (rgb24, full range). */
function probe(ffmpeg: string, file: string) {
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  return info;
}
async function boxes(file: string): Promise<string[]> {
  const b = await fs.readFile(file), out: string[] = [];
  for (let i = 0; i + 8 <= b.length;) { let size = b.readUInt32BE(i); const type = b.toString("latin1", i + 4, i + 8); if (size === 1) size = Number(b.readBigUInt64BE(i + 8)); out.push(type); if (size < 8) break; i += size; }
  return out;
}
function decode(ffmpeg: string, file: string, w: number, hh: number): Uint8Array[] {
  const out = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  const fb = w * hh * 3, frames: Uint8Array[] = [];
  for (let i = 0; i + fb <= out.stdout.length; i += fb) frames.push(out.stdout.subarray(i, i + fb));
  return frames;
}
/** Mean and max channel error of a decoded frame against an RGBA reference, over a rectangle (default: all). */
function diff(rgb: Uint8Array, rgba: Uint8Array | Uint8ClampedArray, w: number, r?: { x: number; y: number; w: number; h: number }): { max: number; mean: number } {
  const rr = r ?? { x: 0, y: 0, w, h: rgb.length / 3 / w };
  let max = 0, sum = 0, n = 0;
  for (let y = rr.y; y < rr.y + rr.h; y++) for (let x = rr.x; x < rr.x + rr.w; x++) {
    const p = (y * w + x) * 3, q = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) { const e = Math.abs(rgb[p + k] - rgba[q + k]); if (e > max) max = e; sum += e; n++; }
  }
  return { max, mean: sum / Math.max(1, n) };
}

/**
 * The element as Flux draws it at rest, independently of the movie code: the static composer's markup (the reference
 * still as a PNG, the layers, the names, the furniture) over the matte, rasterized by resvg at the picture's size, and
 * mirrored as the canvas mirrors it. `patch` edits the markup (a wrong stamp, no layers) for the negative checks.
 */
/** Where references `a` and `b` differ (by more than 60 summed over RGB), how far the decoded frame is from each. */
function masked(rgb: Uint8Array, a: Uint8Array, b: Uint8Array): { a: number; b: number; n: number } {
  let ea = 0, eb = 0, n = 0;
  for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
    if (Math.abs(a[q] - b[q]) + Math.abs(a[q + 1] - b[q + 1]) + Math.abs(a[q + 2] - b[q + 2]) <= 60) continue;
    for (let k = 0; k < 3; k++) { ea += Math.abs(rgb[p + k] - a[q + k]); eb += Math.abs(rgb[p + k] - b[q + k]); }
    n++;
  }
  return { a: ea / Math.max(1, 3 * n), b: eb / Math.max(1, 3 * n), n };
}
/** The largest luma (BT.709 Y') error: 4:2:0 halves chroma, so a one-pixel colour edge carries a large per-channel error
 *  that no codec setting removes; luma is what the eye reads as detail. */
function lumaMax(rgb: Uint8Array, rgba: Uint8Array | Uint8ClampedArray): number {
  let max = 0;
  for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
    const e = Math.abs(0.2126 * (rgb[p] - rgba[q]) + 0.7152 * (rgb[p + 1] - rgba[q + 1]) + 0.0722 * (rgb[p + 2] - rgba[q + 2]));
    if (e > max) max = e;
  }
  return max;
}

async function referenceFrame(el: any, index: number, s: any, matte: string, patch: (svg: string) => string = (x) => x, layers = true): Promise<Uint8Array> {
  const view = { ...(el.view ?? {}), index: { ...(el.view?.index ?? {}), t: index } };
  const rv = resolveView(manifest, view);
  const still = await renderStill(reader, { view, crop: s.crop, outWidth: s.picture.width, outHeight: s.picture.height }, { resolveLut: resolveFluximgLut });
  const layerSvg: Record<string, string> = {}, tables: Record<string, any> = {};
  if (layers) for (const l of manifest.layers) {
    if (l.kind === "labels") { layerSvg[l.id] = await reader.readText(l.outlines); if (l.table) tables[l.id] = await reader.readTable(l.table); }
    if (l.kind === "vector") layerSvg[l.id] = await reader.readText(l.path);
  }
  let inner = fluximgStaticSvg({ manifest, view: rv, crop: s.crop, box: s.box, stillHref: pngDataUrl(still.rgba, still.width, still.height), layerSvg, tables, idPrefix: fluximgIdPrefix(el.id), flipX: !!el.flipX, flipY: !!el.flipY, insets: [], resolveLut: (n: string) => colormapLut(n)?.lut ?? null });
  inner = patch(inner);
  const { width: bw, height: bh } = s.box;
  const mirror = el.flipX || el.flipY ? `translate(${el.flipX ? bw : 0} ${el.flipY ? bh : 0}) scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1})` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.picture.width}" height="${s.picture.height}" viewBox="0 0 ${bw} ${bh}" preserveAspectRatio="none"><rect x="0" y="0" width="${bw}" height="${bh}" fill="${matte}"/>${mirror ? `<g transform="${mirror}">${inner}</g>` : inner}</svg>`;
  return new Resvg(svg).render().pixels;
}

async function encoded(ffmpeg: string) {
  const slide = `talk/${P.slideId}`, matte = "#000000";
  const deck = await P.slidesCore.loadDeck(P.root, "talk");
  const slideEl = () => deck.slides[0].elements.find((e: any) => e.id === elementId) as any;
  await P.slidesCore.mutateDeck(P.root, "talk", "movie", (d: any) => { const e = d.slides[0].elements.find((x: any) => x.id === elementId); e.view = { ...V0, layers: { cells: CELLS, marks: { visible: true } } }; });
  const el = (await P.slidesCore.loadDeck(P.root, "talk")).slides[0].elements.find((e: any) => e.id === elementId) as any;
  void slideEl;

  // ----------------------------------------------------------------------------------------------------------------
  h.section("B. the written file");
  const file = path.join(P.scratch, "movie.mp4");
  const r = await Movie.exportImageMovie(P.root, elementId, { out: file, slide, scale: 6 });
  const info = probe(ffmpeg, file);
  const st = MP.resolveMovie(manifest, { view: el.view, crop: el.crop, width: el.width, height: el.height, playback: el.playback }, { scale: 6 });
  h.ok(/Video: h264 \(High\)/.test(info) && /yuv420p\(tv, bt709\/bt709\/iec61966-2-1/.test(info), "H.264 (High), yuv420p, limited range, tagged BT.709 / sRGB transfer (the slide-video colour tags)");
  const worker = (await import("../electron/slideVideoWorker.cjs" as string)) as { VIDEO_COLOR_TAGS: string[] };
  h.ok(["bt709", "iec61966-2-1", "tv"].every((t) => (worker.VIDEO_COLOR_TAGS ?? []).join(" ").includes(t)), "the same tags the slide video writes (slideVideoWorker VIDEO_COLOR_TAGS)");
  h.ok(r.width === 384 && r.height === 288 && r.width % 2 === 0 && r.height % 2 === 0 && new RegExp(`, ${r.width}x${r.height}[ ,]`).test(info), `the size is the plan's (${r.width} x ${r.height}, even)`);
  const frames = decode(ffmpeg, file, r.width, r.height);
  h.ok(frames.length === 24 && r.frames === 24, `24 frames decoded (one per plane), and the report says so`);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const secs = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : NaN;
  h.ok(Math.abs(secs - 2.4) <= 0.1 + 1e-9 && r.durationMs === 2400 && /\b10 fps\b/.test(info), `2.4 s at 10 fps, within one frame (read ${secs} s)`);
  const order = await boxes(file);
  h.ok(order.indexOf("moov") >= 0 && order.indexOf("moov") < order.indexOf("mdat"), `faststart: moov before mdat (${order.join(" ")})`);
  h.ok(!/Audio:/.test(info) && st.width === r.width, "no audio track");

  // ----------------------------------------------------------------------------------------------------------------
  h.section("C. the frames are the element as Flux draws it");
  for (const k of [0, 11, 23]) {
    const ref = await referenceFrame(el, k, st, matte);
    if (process.env.MOVIE_DUMP) { const { encodePng } = await import("../flux-core/fluximgPng") as any; const rgba = new Uint8ClampedArray(r.width * r.height * 4); for (let i = 0, j = 0; i < frames[k].length; i += 3, j += 4) { rgba[j] = frames[k][i]; rgba[j + 1] = frames[k][i + 1]; rgba[j + 2] = frames[k][i + 2]; rgba[j + 3] = 255; } await fs.writeFile(`test-results/scratch/shots/dec-${k}.png`, Buffer.from(pngDataUrl(rgba, r.width, r.height).split(",")[1], "base64")); await fs.writeFile(`test-results/scratch/shots/ref-${k}.png`, Buffer.from(pngDataUrl(new Uint8ClampedArray(ref), r.width, r.height).split(",")[1], "base64")); void encodePng; }
    const d = diff(frames[k], ref, r.width), y = lumaMax(frames[k], ref);
    h.ok(d.mean <= BOUND.mean && y <= BOUND.luma, `frame ${k} (plane ${k}) against the static composer's picture of plane ${k}: mean ${d.mean.toFixed(3)}/255, max luma ${y.toFixed(0)}/255, max channel ${d.max}/255 (bound mean ${BOUND.mean}, luma ${BOUND.luma})`);
  }
  {
    // The stamp reads each frame's own time: against the same picture with the next plane's stamp text, the band
    // where the stamp stands is much closer to its own.
    const rv = (k: number) => resolveView(manifest, { ...el.view, index: { t: k } });
    const { positionText } = await import("../src/lib/fluximg/furniture");
    let right = 0;
    const seen: string[] = [];
    for (const k of [0, 11, 22]) {
      const own = await referenceFrame(el, k, st, matte);
      const wrongText = positionText(manifest.axes.t, k + 1, 24), ownText = positionText(manifest.axes.t, k, 24);
      const wrong = await referenceFrame(el, k, st, matte, (svg) => svg.replace(`>t ${ownText}<`, `>t ${wrongText}<`));
      const m = masked(frames[k], own, wrong);
      seen.push(`${k}: ${m.a.toFixed(1)} vs ${m.b.toFixed(1)} over ${m.n} px`);
      if (m.n >= 8 && m.b > 3 * m.a) right++;
      void rv;
    }
    h.eq(right, 3, `the time stamp advances with the frames: frames 0, 11 and 22 read their own time, not the next plane's (where the two texts differ: ${seen.join("; ")})`);
    const g = scalebarGeometry(manifest, rv(0), st.crop, st.box)!;
    const k = st.picture.width / st.box.width, row = Math.round((g.y + g.height / 2) * k), x0 = Math.floor(g.x * k) - 4, x1 = Math.ceil((g.x + g.width) * k) + 4;
    let run = 0;
    for (let x = x0; x <= x1; x++) { const p = (row * r.width + x) * 3, lum = (frames[0][p] + frames[0][p + 1] + frames[0][p + 2]) / 3; if (lum > 190) run++; }
    const want = (g.length / manifest.axes.x.scale) * st.scale;
    h.ok(Math.abs(run - want) <= 2, `the scale bar is ${run} px long: ${g.length} ${g.unit} at ${manifest.axes.x.scale} ${g.unit} a pixel times ${st.scale} = ${want} px`);
    // Styled label layers are drawn: over an object's outline the frame is the styled picture, not the bare one.
    const withL = await referenceFrame(el, 0, st, matte), without = await referenceFrame(el, 0, st, matte, (x) => x, false);
    const ml = masked(frames[0], withL, without), a = ml.a, b = ml.b;
    h.ok(ml.n > 200 && b > 2 * a, `styled label outlines and vectors are drawn (where they lie, ${ml.n} px, one-pixel lines softened by 4:2:0: ${a.toFixed(2)} from the styled picture, ${b.toFixed(2)} from the bare one)`);
  }
  {
    // A crop and a mirror, on a figure element.
    const placed = await P.call("place_image", { figureId: "fig-1", bundlePath: "plots/movie.fluximg", name: "Figure movie", x: 20, y: 20, width: 320, crop: { x: 16, y: 12, width: 32, height: 24 }, view: { ...V0, layers: { cells: CELLS, marks: { visible: true } } } });
    const { mutateFigModel } = await import("../flux-core/model");
    await mutateFigModel(P.root, "flip", ({ project }: any) => { for (const f of project.figures) for (const e of f.elements) if (e.id === placed.elementId) e.flipX = true; return {}; });
    const { loadFigModel } = await import("../flux-core/model");
    const fe = (await loadFigModel(P.root)).project.figures.flatMap((f: any) => f.elements).find((e: any) => e.id === placed.elementId);
    const ff = path.join(P.scratch, "figure.mp4");
    const fr = await Movie.exportImageMovie(P.root, placed.elementId, { out: ff, from: 3, to: 6 });
    const fs2 = MP.resolveMovie(manifest, { view: fe.view, crop: fe.crop, width: fe.width, height: fe.height }, { from: 3, to: 6 });
    const ffr = decode(ffmpeg, ff, fr.width, fr.height);
    const ref = await referenceFrame(fe, 4, fs2, "#ffffff");
    const d = diff(ffr[1], ref, fr.width);
    h.ok(fr.frames === 3 && ffr.length === 3 && d.mean <= BOUND.mean && lumaMax(ffr[1], ref) <= BOUND.luma, `a cropped, mirrored image on a figure (over the figure's white): frame 1 is plane 4 as drawn, cropped and mirrored (mean ${d.mean.toFixed(3)}, max ${d.max})`);
    const unflipped = await referenceFrame({ ...fe, flipX: false }, 4, fs2, "#ffffff");
    h.ok(diff(ffr[1], unflipped, fr.width).mean > 3 * d.mean, "and it is the mirrored picture, not the plain one");
    figureEl = placed.elementId;
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("D. cancel removes the partial file");
  {
    const ac = new AbortController(), cf = path.join(P.scratch, "cancel", "c.mp4");
    let err: unknown;
    try { await Movie.exportImageMovie(P.root, elementId, { out: cf, slide, scale: 6, signal: ac.signal, onProgress: (p) => { if (p.phase === "encoding" && p.frame >= 2) ac.abort(); } }); } catch (e) { err = e; }
    h.ok((err as Error)?.name === "AbortError" && /cancelled/.test((err as Error).message), "a cancelled export rejects (Movie export cancelled)");
    h.eq(await fs.readdir(path.dirname(cf)).catch(() => []), [], "and leaves nothing behind: no movie, no partial file");
    let failed: unknown;
    const bad = path.join(P.scratch, "fail", "f.mp4");
    try { await Movie.exportImageMovie(P.root, elementId, { out: bad, slide, settings: { crf: 15, gop: 15, preset: "no-such-preset" } }); } catch (e) { failed = e; }
    h.ok(!!failed && (await fs.readdir(path.dirname(bad)).catch(() => [])).length === 0, "a failed encode leaves nothing behind either");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("E. no encoder: a clean refusal");
  {
    const saved = process.env.FLUX_VIDEO_ENCODER;
    process.env.FLUX_VIDEO_ENCODER = path.join(P.scratch, "no-such-encoder", "ffmpeg");
    try {
      let err: any;
      try { await Movie.exportImageMovie(P.root, elementId, { out: path.join(P.scratch, "none.mp4"), slide }); } catch (e) { err = e; }
      h.ok(err?.name === "ValidationError" && err.message === Movie.NO_ENCODER_MESSAGE, `refused with the reason: "${err?.message}"`);
      h.ok(!(await fs.stat(path.join(P.scratch, "none.mp4")).catch(() => null)), "and nothing written");
    } finally { if (saved === undefined) delete process.env.FLUX_VIDEO_ENCODER; else process.env.FLUX_VIDEO_ENCODER = saved; }
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("F. bounded memory on a stack larger than the decoded-piece budget; export speed");
  {
    const Q = await makeProject({ T: 300, H: 512, W: 512, C: 2 });
    extra.push(Q.scratch);
    await Q.slidesCore.mutateDeck(Q.root, "talk", "movie", (d: any) => { const e = d.slides[0].elements.find((x: any) => x.type === "fluximg"); e.view = { ...V0, layers: { cells: CELLS, marks: { visible: true } } }; });
    const run = (budget: string) => {
      const out = spawnSync(process.execPath, ["--import", "tsx", "scripts/lib/fluximgMovieProbe.ts", Q.root, Q.placed.elementId, `talk/${Q.slideId}`, path.join(Q.scratch, `big-${budget}.mp4`), budget], { encoding: "utf8", env: process.env, maxBuffer: 1 << 26 });
      if (out.status !== 0) throw new Error(out.stderr);
      return JSON.parse(out.stdout.trim().split("\n").at(-1)!);
    };
    const stackMiB = (300 * 2 * 512 * 512 * 2) / 2 ** 20;
    const small = run(String(32 * 2 ** 20)), dflt = run("-");
    const mib = (b: number) => (b / 2 ** 20).toFixed(0);
    h.ok(small.frames === 300 && small.peak - small.rssStart < 160 * 2 ** 20, `a ${stackMiB.toFixed(0)} MiB stack with a 32 MiB piece budget: RSS grew ${mib(small.peak - small.rssStart)} MiB (bound 160), peak ${mib(small.maxRSS)} MiB`);
    h.ok(dflt.peak - dflt.rssStart < (256 + 160) * 2 ** 20, `with the default 256 MiB budget: RSS grew ${mib(dflt.peak - dflt.rssStart)} MiB (bound 416), peak ${mib(dflt.maxRSS)} MiB`);
    console.log(`  speed: 512 x 512 two-channel uint16 + label layer, ${dflt.frames} frames at ${dflt.width} x ${dflt.height} in ${(dflt.ms / 1000).toFixed(2)} s = ${(dflt.frames / (dflt.ms / 1000)).toFixed(1)} frames/s (read ${dflt.stats.readMs.toFixed(0)} ms, draw ${dflt.stats.renderMs.toFixed(0)} ms, overlay ${dflt.stats.overlayMs.toFixed(0)} ms, encoder wait ${dflt.stats.encodeWaitMs.toFixed(0)} ms); 32 MiB budget: ${(small.frames / (small.ms / 1000)).toFixed(1)} frames/s`);
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("G. the verb end to end");
  {
    const fig = await P.call("export_image_movie", { elementId: figureEl, out: path.join(P.scratch, "verb-figure.mp4"), mode: "bounce", from: 0, to: 4 });
    h.ok(fig.frames === 7 && (await fs.stat(fig.path)).size === fig.bytes && fig.mode === "bounce", `on a figure: ${fig.frames} frames (bounce 0..4), ${fig.width} x ${fig.height}, ${fig.bytes} bytes`);
    const sl = await P.call("export_image_movie", { elementId, slide, out: path.join(P.scratch, "verb-slide.mp4"), speed: 2, fps: 5 });
    h.ok(sl.frames === 24 && sl.fps === 10 && Math.abs(sl.durationMs - 2400) < 1e-6, `on a slide: ${sl.frames} frames at ${sl.fps} fps (fps 5 x speed 2), ${sl.durationMs} ms`);
    // A step: the image as it stands after it (its contrast), on the CLI's flag form.
    await P.slidesCore.mutateDeck(P.root, "talk", "beat", (d: any) => { const s = d.slides[0]; s.beats = [s.beats[0], { id: "b1", tracks: [{ id: "c1", target: elementId, preset: "transform", start: 0, duration: 500, easing: "linear", to: { state: { view: { ...el.view, channels: [{ range: [600, 2200] }, { range: [300, 1800] }] } } } }] }]; });
    const beat = await P.call("export_image_movie", { elementId, slide, beatId: "b1", out: path.join(P.scratch, "verb-step.mp4"), from: 0, to: 2, scale: 6 });
    const bf = decode(ffmpeg, beat.path, beat.width, beat.height);
    const stepEl = { ...el, view: { ...el.view, channels: [{ range: [600, 2200] }, { range: [300, 1800] }] } };
    const d = diff(bf[0], await referenceFrame(stepEl, 0, st, matte), beat.width), dDesign = diff(bf[0], await referenceFrame(el, 0, st, matte), beat.width);
    h.ok(d.mean <= BOUND.mean && dDesign.mean > 3 * d.mean, `with beat: the image as it stands after that step (mean ${d.mean.toFixed(3)} from the step's picture, ${dDesign.mean.toFixed(3)} from Design's)`);
    let refused = "";
    try { await P.call("export_image_movie", { elementId, slide, out: path.join(P.scratch, "x.mov") }); } catch (e) { refused = String(e); }
    h.ok(/ending in \.mp4/.test(refused), "an output that is not .mp4 is refused");
    // The CLI itself (the bundled flux-cli is built separately; the source entry runs the same registry).
    const [cmd, args] = tsxRun(path.resolve("flux-cli.ts"), ["export-image-movie", elementId, "--slide", slide, "--out", path.join(P.scratch, "cli.mp4"), "--from", "2", "--to", "5", "--root", P.root]);
    const cli = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
    const json = (() => { try { return JSON.parse(cli.stdout.trim().split("\n").at(-1) ?? ""); } catch { return null; } })();
    h.ok(cli.status === 0 && json?.frames === 3 && /✓ wrote the movie of image/.test(cli.stderr) && /3 frames · 0\.30 s at 10 fps/.test(cli.stderr), `flux export-image-movie runs headless and reports file, frames, duration, size and rate (${cli.stderr.trim().split("\n")[1] ?? cli.stderr.trim()})`);
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("H. the same request twice writes the same bytes");
  {
    const a = await Movie.exportImageMovie(P.root, elementId, { out: path.join(P.scratch, "same-a.mp4"), slide, from: 0, to: 6 });
    const b = await Movie.exportImageMovie(P.root, elementId, { out: path.join(P.scratch, "same-b.mp4"), slide, from: 0, to: 6 });
    const [x, y] = await Promise.all([fs.readFile(a.path), fs.readFile(b.path)]);
    h.ok(x.length > 0 && Buffer.compare(x, y) === 0, `byte-identical (${x.length} bytes)`);
  }
}
