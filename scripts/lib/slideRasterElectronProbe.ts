/** WP 1.8 / WP 1.1 raster + colour probe: production video worker in OFFSCREEN Electron (show:false); launched by verify-slide-raster-electron.cjs.
 *  Measures with gradient energy (sum of squared luminance gradients) against a fresh render of the same pose: 1.000 = exact. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { exportSlideVideoHtml } from "../../src/lib/slide/export/exportDeck";
import { videoSize } from "../../src/lib/slide/video";
import type { Deck } from "../../src/lib/slide/types";
import { cameraDeck, restingDeck, plainDeck, joinDeck, swatchDeck, FLEXOKI_SWATCHES, SWATCH_GRID, ZOOM_POSE, ZOOM4_POSE, ZOOM10_POSE, PAN_POSE, type Pose } from "./slideRasterDecks";

const require = createRequire(import.meta.url), repo = process.cwd();
const worker = require("../../electron/slideVideoWorker.cjs") as { VIDEO_COLOR_FILTER: string; VIDEO_COLOR_TAGS: string[]; VIDEO_CAPTURE_SWITCHES: string[][] };
const scratch = process.env.PROBE_SCRATCH!;
assert.ok(scratch && process.env.HOME?.startsWith(scratch), "isolated machine state required");
const ffmpeg = path.join(repo, "build/video-encoder", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const tee = path.join(repo, "scripts/lib/slideRasterTeeEncoder.cjs"), entry = path.join(repo, "scripts/lib/slideRasterElectronEntry.cjs");
const electron = require("electron") as string;
const OPTS = { height: 720 as const, fps: 60 as const, startHoldMs: 200, stepDelayMs: 200, endHoldMs: 500 };
const STILL = { height: 720 as const, fps: 60 as const, startHoldMs: 0, stepDelayMs: 0, endHoldMs: 0 };
const probe = (message: string) => console.log(`PROBE ${message}`);

interface State { transform: string; hint: string; bakes: number | null; layers: number }
interface Capture { name: string; frames: number; dir: string; mp4: string; states: State[] }
interface Job { name: string; deck: Deck; slide: string; options: typeof OPTS | typeof STILL }

async function runJobs(label: string, jobs: Job[]): Promise<Map<string, Capture>> {
  const base = await fs.mkdtemp(path.join(scratch, `${label}-`)), list = [];
  for (const job of jobs) {
    const dir = path.join(base, job.name); await fs.mkdir(dir, { recursive: true });
    const deck = { ...job.deck, slides: job.deck.slides.filter((s) => s.id === job.slide) }; assert.equal(deck.slides.length, 1, `slide ${job.slide}`);
    const html = path.join(dir, "capture.html"); await fs.writeFile(html, await exportSlideVideoHtml({ deck } as never, job.options));
    list.push({ name: job.name, html, output: path.join(dir, `${job.name}.mp4`), encoder: tee, mediaFiles: {}, mediaHasAudio: {}, ...videoSize(deck.stage, job.options.height), framesDir: path.join(dir, "frames") });
  }
  const jobsFile = path.join(base, "jobs.json"); await fs.writeFile(jobsFile, JSON.stringify(list));
  const env: NodeJS.ProcessEnv = { ...process.env, FLUX_RASTER_JOBS: jobsFile, FLUX_RASTER_REAL_FFMPEG: ffmpeg };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.FLUX_SLIDE_VIDEO_WORKER;
  const args = [entry, ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []), ...(env.FLUX_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])];
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(electron, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${label}: Electron harness timed out`)); }, 420000);
    child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); code === 0 && out.includes("FLUX_RASTER") ? resolve() : reject(new Error(`${label}: harness exit ${code}\n${(out + err).slice(-4000)}`)); });
  });
  probe(`${label}: ${list.length} capture(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const captures = new Map<string, Capture>();
  for (const job of list) {
    const states = JSON.parse(await fs.readFile(path.join(job.framesDir, "states.json"), "utf8")) as State[];
    const files = (await fs.readdir(job.framesDir)).filter((f) => /^f\d+\.png$/.test(f));
    assert.equal(files.length, states.length, `${job.name}: every frame captured`);
    captures.set(job.name, { name: job.name, frames: states.length, dir: job.framesDir, mp4: job.output, states });
  }
  return captures;
}

// ---- image metrics (frames decoded by the pinned ffmpeg) ----------------------------------------------------------------
interface Raw { w: number; h: number; rgb: Buffer }
function decodePng(file: string): Promise<Raw> {
  const probed = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(probed.status, 0, String(probed.stderr));
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }), m = /(\d{2,5})x(\d{2,5})/.exec(info.stderr.split("Video:")[1] ?? "");
  assert.ok(m, `dimensions of ${file}`);
  return Promise.resolve({ w: Number(m![1]), h: Number(m![2]), rgb: probed.stdout });
}
const frame = (c: Capture, i: number) => decodePng(path.join(c.dir, `f${String(i).padStart(4, "0")}.png`));
const luma = (a: Raw): Float64Array => { const l = new Float64Array(a.w * a.h); for (let i = 0; i < l.length; i++) l[i] = (a.rgb[3 * i] * 299 + a.rgb[3 * i + 1] * 587 + a.rgb[3 * i + 2] * 114) / 1000; return l; };
function energy(a: Raw): number {
  const l = luma(a); let sum = 0;
  for (let y = 0; y < a.h - 1; y++) for (let x = 0; x < a.w - 1; x++) { const i = y * a.w + x, gx = l[i + 1] - l[i], gy = l[i + a.w] - l[i]; sum += gx * gx + gy * gy; }
  return sum;
}
const ratio = (a: Raw, ref: Raw): number => energy(a) / energy(ref);
function meanAbsDiff(a: Raw, b: Raw): number { assert.equal(a.rgb.length, b.rgb.length); let s = 0; for (let i = 0; i < a.rgb.length; i++) s += Math.abs(a.rgb[i] - b.rgb[i]); return s / a.rgb.length; }
function changedPixels(a: Raw, b: Raw, threshold = 40): number { let n = 0; for (let i = 0; i < a.w * a.h; i++) if (Math.max(Math.abs(a.rgb[3 * i] - b.rgb[3 * i]), Math.abs(a.rgb[3 * i + 1] - b.rgb[3 * i + 1]), Math.abs(a.rgb[3 * i + 2] - b.rgb[3 * i + 2])) > threshold) n++; return n; }
function poseOf(transform: string): Pose {
  const n = transform.match(/-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
  if (!n || n.length < 3) return { x: 320, y: 180, zoom: 1 };
  return { x: (320 - n[0]) / n[2], y: (180 - n[1]) / n[2], zoom: n[2] };
}

const cam = cameraDeck(), plain = plainDeck(), join = joinDeck(), swatches = swatchDeck();
const A = await runJobs("scenes", [
  ...["cam_zoom", "cam_zoom4", "cam_zoom10", "cam_pan", "cam_move", "txt_cam"].map((slide): Job => ({ name: slide, deck: cam, slide, options: OPTS })),
  ...plain.slides.map((s): Job => ({ name: s.id, deck: plain, slide: s.id, options: OPTS })),
  { name: "rect_to_ellipse", deck: join, slide: "rect_to_ellipse", options: OPTS },
  { name: "swatches", deck: swatches, slide: "swatches", options: STILL },
  { name: "ref_zoom", deck: restingDeck("ref_zoom", ZOOM_POSE), slide: "ref_zoom", options: STILL },
  { name: "ref_zoom4", deck: restingDeck("ref_zoom4", ZOOM4_POSE), slide: "ref_zoom4", options: STILL },
  { name: "ref_zoom10", deck: restingDeck("ref_zoom10", ZOOM10_POSE), slide: "ref_zoom10", options: STILL },
  { name: "ref_pan", deck: restingDeck("ref_pan", PAN_POSE), slide: "ref_pan", options: STILL },
]);
const cap = (name: string): Capture => A.get(name)!;

// ---- R1: a camera zoom/pan at rest is as sharp as a fresh render of that pose --------------------------------------------
for (const [slide, ref] of [["cam_zoom", "ref_zoom"], ["cam_zoom4", "ref_zoom4"], ["cam_zoom10", "ref_zoom10"], ["cam_pan", "ref_pan"]] as const) {
  const last = await frame(cap(slide), cap(slide).frames - 1), fresh = await frame(cap(ref), 0);
  const e = ratio(last, fresh), d = meanAbsDiff(last, fresh);
  probe(`R1 ${slide} landed vs fresh render: energy ${e.toFixed(3)}, mean abs diff ${d.toFixed(3)} (HEAD without the keeper: ~0.37 / 0.67)`);
  assert.ok(e >= 0.995 && d <= 0.05, `${slide}: landed frame is as sharp as a fresh render (energy ${e.toFixed(3)}, diff ${d.toFixed(3)})`);
}

// ---- R2: in flight, frames sit on fresh renders of their own pose ---------------------------------------------------------
const inflight: { slide: string; frame: number; pose: Pose }[] = [];
for (const slide of ["txt_cam", "cam_zoom10"]) {
  const c = cap(slide), first = c.states[0].transform, final = c.states.at(-1)!.transform;
  const moving = c.states.map((s, i) => [s, i] as const).filter(([s]) => s.transform !== first && s.transform !== final).map(([, i]) => i);
  assert.ok(moving.length >= 20, `${slide}: the camera flight spans frames (${moving.length})`);
  for (const f of [0.25, 0.5, 0.75]) { const i = moving[Math.floor(moving.length * f)]; inflight.push({ slide, frame: i, pose: poseOf(c.states[i].transform) }); }
}
const B = await runJobs("inflight-refs", inflight.map((f, k): Job => ({ name: `ref_${k}`, deck: restingDeck(`ref_${k}`, f.pose, f.slide === "txt_cam" ? "text" : "scene"), slide: `ref_${k}`, options: STILL })));
for (const [k, f] of inflight.entries()) {
  const e = ratio(await frame(cap(f.slide), f.frame), await frame(B.get(`ref_${k}`)!, 0));
  probe(`R2 ${f.slide} frame ${f.frame} (zoom ${f.pose.zoom.toFixed(2)}) vs fresh render of its pose: energy ${e.toFixed(3)}`);
  assert.ok(e >= 0.98, `${f.slide} frame ${f.frame}: in-flight frame is as sharp as a fresh render of its pose (${e.toFixed(3)})`);
}

// ---- R3: bakes happen exactly when the pose does, and the compositor hint never leaves ON -----------------------------------
for (const slide of ["cam_zoom", "cam_zoom10", "cam_pan", "txt_cam"]) {
  const c = cap(slide), changes = c.states.filter((s, i) => i > 0 && s.transform !== c.states[i - 1].transform).length, bakes = c.states.at(-1)!.bakes ?? -1;
  probe(`R3 ${slide}: ${bakes} re-bakes for ${changes} pose changes in ${c.frames} frames`);
  assert.ok(bakes >= 1 && bakes <= changes, `${slide}: re-bakes (${bakes}) are bounded by pose changes (${changes}) and happen at all`);
  assert.deepEqual([...new Set(c.states.map((s) => s.hint))], ["transform"], `${slide}: the camera layer's will-change hint is ON after every frame (the pan-clears-the-hint guard itself is pinned in verify-slide-raster-pure.ts, C1b)`);
}

// ---- R3b: a slide that zooms paints element flights IN PLACE in capture; slides that do not keep their held flight layers -------
{
  const peak = (name: string) => Math.max(...cap(name).states.map((s) => s.layers));
  probe(`R3b promoted flight layers under the camera: cam_move (zooms) ${peak("cam_move")}, txt_move (no camera) ${peak("txt_move")}`);
  assert.equal(peak("cam_move"), 0, "cam_move: a flight inside a zooming camera is painted in place (no promoted layer keeps a pre-zoom raster)");
  assert.ok(peak("txt_move") >= 1, "txt_move: a slide that never zooms keeps its held flight layer (byte-identical frames)");
}

// ---- R4: decks without a camera never bake (their frames are byte-identical to the pre-keeper renderer) --------------------------
for (const s of plain.slides) {
  const c = cap(s.id);
  assert.equal(c.states.at(-1)!.bakes, 0, `${s.id}: no re-bake for a deck without a camera`);
  assert.deepEqual([...new Set(c.states.map((x) => x.transform))], [""], `${s.id}: camera layer untouched`);
}
probe(`R4 ${plain.slides.map((s) => s.id).join(", ")}: 0 re-bakes, camera layer untouched`);

// ---- R5: colour ------------------------------------------------------------------------------------------------------------
{
  const sw = cap("swatches");
  const log = spawnSync(ffmpeg, ["-hide_banner", "-i", sw.mp4], { encoding: "utf8" }).stderr;
  assert.match(log, /yuv420p\(tv, bt709\/bt709\/iec61966-2-1/, "the stream is tagged BT.709 limited range, sRGB transfer");
  const args = JSON.parse(await fs.readFile(path.join(sw.dir, "encoder-args.json"), "utf8")) as string[];
  assert.ok(args.includes(worker.VIDEO_COLOR_FILTER) && args.indexOf("-vf") === args.indexOf(worker.VIDEO_COLOR_FILTER) - 1, "the worker encodes with VIDEO_COLOR_FILTER");
  assert.ok(!args.includes("-pix_fmt"), "no bare -pix_fmt (that is the untagged BT.601 conversion)");
  assert.deepEqual(args.slice(args.indexOf("-colorspace"), args.indexOf("-colorspace") + worker.VIDEO_COLOR_TAGS.length), worker.VIDEO_COLOR_TAGS, "the worker passes VIDEO_COLOR_TAGS");
  const decoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", sw.mp4, "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(decoded.status, 0, String(decoded.stderr));
  const { width: w, height: h } = videoSize({ width: 640, height: 360 }, STILL.height); assert.equal(decoded.stdout.length, w * h * 3);
  const k = STILL.height / 360, g = SWATCH_GRID; let worst = 0, sum = 0;
  FLEXOKI_SWATCHES.forEach((hex, i) => {
    const px = Math.round((g.x0 + (i % g.cols) * (g.size + g.gap) + g.size / 2) * k), py = Math.round((g.y0 + Math.floor(i / g.cols) * (g.size + g.gap) + g.size / 2) * k);
    for (let ch = 0; ch < 3; ch++) { const err = Math.abs(decoded.stdout[(py * w + px) * 3 + ch] - parseInt(hex.slice(1 + 2 * ch, 3 + 2 * ch), 16)); worst = Math.max(worst, err); sum += err; }
  });
  probe(`R5 18 Flexoki swatches decoded as BT.709: max channel error ${worst}, mean ${(sum / 54).toFixed(2)} (untagged BT.601 encode: 15 / 5.33)`);
  assert.ok(worst <= 3, `swatch colours survive the video round trip (max channel error ${worst})`);
  const source = await fs.readFile(path.join(repo, "electron/slideVideoWorker.cjs"), "utf8");
  assert.ok(source.includes('"disable-lcd-text"') && worker.VIDEO_CAPTURE_SWITCHES.some(([name]) => name === "disable-lcd-text"), "disable-lcd-text is set for every capture (insurance; not behaviourally testable in the real path)");
}

// ---- R6: a stroked rect Becoming an ellipse does not pop at the layer swap ------------------------------------------------------
{
  const c = cap("rect_to_ellipse"), first = await frame(c, 0);
  let start = -1;
  for (let i = 1; i < c.frames && start < 0; i++) if (!(await frame(c, i)).rgb.equals(first.rgb)) start = i;
  assert.ok(start > 0, "the Become starts moving");
  const swap = changedPixels(await frame(c, start - 1), await frame(c, start));
  probe(`R6 rect -> ellipse: pixels changed (>40) entering the first moving frame ${start} (the layer swap): ${swap} (HEAD: 145)`);
  assert.ok(swap <= 10, `no join pop at the swap (${swap} changed pixels)`);
}
console.log("SLIDE RASTER ELECTRON: PASS");
