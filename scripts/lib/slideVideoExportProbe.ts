/** Isolated production-bundle gate; launched by verify-slide-video-electron. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { videoFixture } from "./slideVideoFixture";
import type { Deck } from "../../src/lib/slide/types";
import { buildScaffoldTree } from "../../src/lib/project/scaffoldTree";
import { exportSlideVideo } from "../../flux-core/slideVideo";
import { TestProcessScope } from "./testProcess.mjs";

const require = createRequire(import.meta.url), repo = process.cwd();
require("./nestedVideoTestLaunch.cjs").installNestedVideoTestLaunch();
const scratch = process.env.PROBE_SCRATCH!, root = path.join(scratch, "export-project");
assert.ok(scratch && process.env.HOME?.startsWith(scratch), "isolated machine state required");
const artifacts = path.join(repo, "test-results/slide-video");
const encoder = path.join(repo, "build/video-encoder", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const scope = new TestProcessScope();
async function save(deck: Deck) {
  const tree = buildScaffoldTree({ title: "Video coverage" }, deck);
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, bytes] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), bytes); }
}
function decode(file: string, width: number, height: number) {
  const result = spawnSync(encoder, ["-hide_banner", "-i", file, "-vf", `scale=${width}:${height}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 100 * 1024 * 1024, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr.toString());
  return { bytes: result.stdout, log: result.stderr.toString(), frame: width * height * 3 };
}
try {
  const deck = videoFixture();
  const rect = deck.slides[0].elements[0];
  const series = (dest: boolean) => Array.from({ length: 1200 }, (_, i) => ({ index: i, svgId: `p${i}`, x: 3 + i % 40 * 2.4, y: (dest ? 65 : 15) + Math.floor(i / 40) * .7 }));
  const plots = Object.fromEntries([false, true].map(dest => {
    const points = series(dest);
    return [dest ? "destination" : "initial", {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${points.map(p => `<circle id="${p.svgId}" cx="${p.x}" cy="${100-p.y}" r=".65" fill="#0000ff"/>`).join("")}</svg>`,
      manifest: { spec: "fluxplot", schemaVersion: "0.2.0", plotType: "scatter", svg: "", size: { width: 100, height: 100, unit: "px" }, axes: [{ x: { scale: "linear", domain: [0,100], anchors: [{ data: 0, svg: 0 }, { data: 100, svg: 100 }] }, y: { scale: "linear", domain: [0,100], anchors: [{ data: 0, svg: 100 }, { data: 100, svg: 0 }] } }], series: [{ id: "dots", points }] },
    }];
  }));
  deck.slides[0] = { id: "complex", elements: [
    { ...rect, id: "source", x: 40, y: 180, fill: "#ff0000" },
    { ...rect, id: "copy", x: 999, y: 999 },
    { id: "plot", type: "plot", assetId: "initial", x: 310, y: 30, width: 280, height: 240, rotation: 0 },
    { id: "line", type: "path", x: 40, y: 300, width: 200, height: 10, rotation: 0, d: "M 0 5 L 200 5", fill: "none", stroke: "#00aa00", strokeWidth: 5 },
  ], beats: [
    { id: "base", tracks: [] },
    { id: "change", tracks: [
      { id: "morph", target: "plot", preset: "transform", to: { assetId: "destination" }, duration: 400, easing: "linear" },
      { id: "move", target: "source", preset: "transform", to: { state: { x: 100 } }, duration: 400, easing: "linear" },
    ] },
    { id: "draw", advance: "with-prev", tracks: [{ id: "stroke", target: "line", preset: "drawOn", duration: 400, easing: "linear" }] },
    { id: "birth", advance: "auto", autoDelayMs: 125, tracks: [{ id: "ghost", target: "copy", ghostFrom: "source", preset: "transform", to: { state: { x: 240, y: 220 } }, duration: 400, easing: "linear" }] },
    { id: "camera", tracks: [{ id: "zoom", target: "@camera", preset: "camera", to: { x: 300, y: 170, zoom: 1.1 }, duration: 400, easing: "linear" }] },
  ] };
  deck.assets = Object.keys(plots).map(id => ({ id, name: id, kind: "svg", path: `assets/${id}.svg`, naturalWidth: 100, naturalHeight: 100 }));
  // Unrelated slide/asset must never leak into a single-slide export or warnings.
  deck.assets.push({ id: "unrelated", name: "Unrelated missing image", kind: "png", path: "assets/missing.png" });
  await save(deck);
  for (const [id, plot] of Object.entries(plots)) {
    await fs.writeFile(path.join(root, `slides/video-deck/assets/${id}.svg`), plot.svg);
    await fs.writeFile(path.join(root, `slides/video-deck/assets/${id}.fluxplot.json`), JSON.stringify(plot.manifest));
  }
  const before = await fs.readFile(path.join(root, "slides/video-deck/deck.json"));
  const complexFile = path.join(artifacts, "complex-motion.mp4");
  const complex = await exportSlideVideo(root, deck.id, "complex", { out: complexFile, refreshSources: false, height: 720, fps: 30, startHoldMs: 100, endHoldMs: 100, stepDelayMs: 100 });
  assert.equal(complex.frames, 49); assert.deepEqual(complex.warnings, []);
  assert.ok(before.equals(await fs.readFile(path.join(root, "slides/video-deck/deck.json"))), "read-only saved export preserves authored deck bytes");
  const d = decode(complexFile, 640, 360); assert.equal(d.bytes.length, 49 * d.frame);
  const pixel = (frame: number, x: number, y: number) => [...d.bytes.subarray(frame*d.frame+(y*640+x)*3, frame*d.frame+(y*640+x)*3+3)];
  const centroid = (frame: number) => {
    let sum = 0, count = 0;
    for (let y=30; y<275; y++) for (let x=310; x<590; x++) { const [r,g,b] = pixel(frame,x,y); if (b>140 && b>r+60 && b>g+60) { sum += y; count++; } }
    assert.ok(count > 2500, `frame ${frame}: dense plot remains painted`); return sum/count;
  };
  const initial = centroid(0), middle = centroid(9), end = centroid(16);
  assert.ok(initial-middle>40 && middle-end>40, "1200 semantic points morph through the midpoint to their destination");
  assert.ok(pixel(0,100,305).every(c=>c>245), "draw-on starts hidden");
  assert.ok(pixel(16,100,305)[1]>110 && pixel(16,100,305)[0]<30, "draw-on reaches full stroke");
  assert.ok(pixel(0,255,235).every(c=>c>245), "unborn ghost is hidden");
  assert.ok(pixel(32,255,235)[0]>230 && pixel(32,255,235)[1]<30, "ghost is born from its source and reaches its destination");
  assert.ok(!d.bytes.subarray(34*d.frame,35*d.frame).equals(d.bytes.subarray(48*d.frame,49*d.frame)), "camera motion changes the final view");
  console.log("PROBE complex MP4: 1200-point data morph, simultaneous draw-on, ghost, authored auto delay, camera and unchanged source PASS");

  const still = videoFixture(); still.slides[0] = { id: "still", elements: [], background: "#ff00ff", beats: [{ id: "base", tracks: [] }] }; still.stage = { width: 360, height: 640 };
  await save(still);
  const portraitFile = path.join(artifacts, "portrait.mp4");
  const portrait = await exportSlideVideo(root, still.id, "still", { out: portraitFile, height: 720, fps: 30, startHoldMs: 0, endHoldMs: 0 });
  assert.equal(portrait.frames, 1); const p = decode(portraitFile, 40, 72); assert.match(p.log, /406x720/); assert.equal(p.bytes.length, p.frame);
  for (let i=0; i<p.bytes.length; i+=3) assert.ok(p.bytes[i]>245 && p.bytes[i+1]<10 && p.bytes[i+2]>245, "portrait fills every pixel including even-width margin");
  still.stage = { width: 640, height: 360 }; await save(still);
  const fourK = path.join(artifacts, "4k.mp4");
  await exportSlideVideo(root, still.id, "still", { out: fourK, height: 2160, fps: 60, startHoldMs: 0, endHoldMs: 0 });
  assert.match(decode(fourK, 64, 36).log, /3840x2160/);
  console.log("PROBE portrait/4K MP4: exact dimensions, static slides, zero holds and valid single-frame files PASS");

  const protectedOut = path.join(scratch, "preserve.mp4"), sentinel = Buffer.from("existing movie"); await fs.writeFile(protectedOut, sentinel);
  await assert.rejects(exportSlideVideo(root, still.id, "absent", { out: protectedOut }), /Slide not found/);
  const originalEncoder = process.env.FLUX_VIDEO_ENCODER;
  process.env.FLUX_VIDEO_ENCODER = path.join(scratch, "missing-encoder");
  await assert.rejects(exportSlideVideo(root, still.id, "still", { out: protectedOut }), /encoder is missing/);
  process.env.FLUX_VIDEO_ENCODER = process.execPath; // Real child fails to encode, exercising cleanup after capture starts.
  await assert.rejects(exportSlideVideo(root, still.id, "still", { out: protectedOut, startHoldMs: 0, endHoldMs: 0 }), /option|encoder|pipe|write/i);
  if (originalEncoder === undefined) delete process.env.FLUX_VIDEO_ENCODER; else process.env.FLUX_VIDEO_ENCODER = originalEncoder;
  assert.ok(sentinel.equals(await fs.readFile(protectedOut)), "all failures preserve previous output");
  assert.ok(!(await fs.readdir(scratch)).some(n=>n.startsWith(".preserve.mp4.tmp-")), "failed jobs remove partial files");
  console.log("PROBE missing slide/encoder and encoder crash: recoverable errors, preserved output and no partial files PASS");

  // Real packaged launch semantics: an Electron app with its own resources/app,
  // no default_app, node_modules or TypeScript sources. macOS clones cost no
  // duplicate disk blocks; other platforms copy the small runtime tree.
  const original = require("electron") as string;
  let packaged: string, resources: string;
  if (process.platform === "darwin") {
    const app = path.resolve(original, "../../.."), copy = path.join(scratch, "VideoProbe.app");
    assert.equal(spawnSync("/bin/cp", ["-cR", app, copy]).status, 0);
    packaged = path.join(copy, "Contents/MacOS/Electron"); resources = path.join(copy, "Contents/Resources");
  } else {
    const copy = path.join(scratch, "packaged"); await fs.cp(path.dirname(original), copy, { recursive: true });
    packaged = path.join(copy, path.basename(original)); resources = path.join(copy, "resources");
  }
  await fs.rm(path.join(resources, "default_app.asar"), { force: true });
  const app = path.join(resources, "app"); await fs.mkdir(path.join(app, "electron"), { recursive: true }); await fs.mkdir(path.join(app, "dist"));
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ name: "flux-video-probe", version: "1.0.0", main: "electron/entry.cjs" }));
  for (const name of ["entry.cjs", "slideVideoWorker.cjs", "slideAudioGraph.cjs"]) await fs.copyFile(path.join(repo,"electron",name),path.join(app,"electron",name));
  for (const name of ["flux-cli.mjs", "slide-export-assets.json"]) await fs.copyFile(path.join(repo,"dist",name),path.join(app,"dist",name));
  const child = scope.spawn(path.join(app, "dist/flux-cli.mjs"), ["export-slide-video", still.id, "still", "--root", root, "--out", path.join(artifacts,"packaged.mp4"), "--start-hold", "0", "--end-hold", "0", "--height", "720"], { nodeArgs: [], deadlineMs: 90000,
    env: { ...process.env, FLUX_VIDEO_ELECTRON: packaged, FLUX_VIDEO_APP_ROOT: app, FLUX_VIDEO_ENCODER: encoder } });
  assert.equal((await scope.waitExit(child)).code, 0, child.stderr); assert.equal(JSON.parse(child.stdout).frames, 1);
  assert.match(decode(path.join(artifacts,"packaged.mp4"),64,36).log, /1280x720/);
  console.log("PROBE packaged startup and production CLI: source-free capture and encoding PASS");
  const unpacked = path.join(resources, "app.asar.unpacked");
  await fs.cp(app, unpacked, { recursive: true });
  await fs.mkdir(path.join(resources, "video-encoder"));
  await fs.copyFile(encoder, path.join(resources,"video-encoder",path.basename(encoder)));
  const launcher = path.join(scratch, "launch.cjs");
  await fs.writeFile(launcher, "const c=require('node:child_process').spawn(process.env.PROBE_EXECUTABLE,process.argv.slice(2),{stdio:'inherit'});c.on('error',e=>{console.error(e);process.exit(1)});c.on('exit',code=>process.exit(code??1));");
  const packagedEnv = { ...process.env, PROBE_EXECUTABLE: packaged, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["FLUX_VIDEO_ELECTRON", "FLUX_VIDEO_APP_ROOT", "FLUX_VIDEO_ENCODER"]) delete packagedEnv[key];
  const automatic = scope.spawn(launcher, [path.join(unpacked, "dist/flux-cli.mjs"), "export-slide-video", still.id, "still", "--root", root, "--out", path.join(artifacts,"packaged-cli.mp4"), "--start-hold", "0", "--end-hold", "0", "--height", "720"], { nodeArgs: [], deadlineMs: 90000, env: packagedEnv });
  assert.equal((await scope.waitExit(automatic)).code, 0, automatic.stderr);
  assert.equal(JSON.parse(automatic.stdout).frames, 1);
  console.log("PROBE installed Electron-as-Node CLI: runtime and encoder discovered without overrides PASS");
} finally { await scope.dispose(); }
