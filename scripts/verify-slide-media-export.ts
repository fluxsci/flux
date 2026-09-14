#!/usr/bin/env -S npx tsx
// Actual isolated Electron capture and MP4 muxing, including decoded pixels and audio.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { TestProcessScope } from "./lib/testProcess.mjs";

if (!process.env.FLUX_MEDIA_PROBE) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-media-export-"));
  const scope = new TestProcessScope();
  try {
    const child = scope.spawn(fileURLToPath(import.meta.url), [], { deadlineMs: 180000, env: { ...process.env, FLUX_MEDIA_PROBE: scratch, HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: path.join(scratch, "config"), APPDATA: path.join(scratch, "appdata") } });
    const result = await scope.waitExit(child); process.stdout.write(child.stdout); process.stderr.write(child.stderr);
    assert.equal(result.code, 0, "isolated slide media export gate");
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
} else {
  const scratch = process.env.FLUX_MEDIA_PROBE;
  assert.equal(process.env.HOME, scratch);
  const { exportSlideVideo } = await import("../flux-core/slideVideo");
  const { createDeck } = await import("../src/lib/slide/ops");
  const { buildScaffoldTree } = await import("../src/lib/project/scaffoldTree");
  const root = path.join(scratch, "project"), artifacts = path.resolve("test-results/slide-media");
  await fs.mkdir(artifacts, { recursive: true });
  const encoder = path.resolve("build/video-encoder", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const deck = createDeck({ withTitleSlide: false }); deck.id = "media-deck"; deck.stage = { width: 320, height: 180 }; deck.background = "#ffffff"; deck.defaults.transition = "none";
  deck.assets = [{ id: "movie", name: "Moving box", kind: "mp4", path: "assets/movie.mp4", naturalWidth: 160, naturalHeight: 90, durationMs: 1200, hasAudio: true }, { id: "poster", name: "Poster", kind: "png", path: "assets/poster.png", naturalWidth: 160, naturalHeight: 90 }];
  deck.slides = [{ id: "clip-slide", elements: [{ id: "clip", type: "video", assetId: "movie", posterAssetId: "poster", durationMs: 1200, x: 40, y: 40, width: 160, height: 90, rotation: 0 }], beats: [
    { id: "base", tracks: [] }, { id: "appear", tracks: [{ target: "clip", preset: "fade", duration: 200, easing: "linear" }] },
    { id: "start", tracks: [{ target: "clip", preset: "videoStart" }] },
    { id: "pause", tracks: [{ target: "clip", preset: "videoPause", start: 100 }] },
    { id: "restart", tracks: [{ target: "clip", preset: "videoStart" }] },
  ] }];
  const tree = buildScaffoldTree({ title: "Media export acceptance" }, deck);
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, bytes] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), bytes); }
  const deckPath = path.join(root, "slides/media-deck/deck.json");
  await fs.copyFile(new URL("./fixtures/slide-video-clips/moving-box.mp4", import.meta.url), path.join(root, "slides/media-deck/assets/movie.mp4"));
  await fs.copyFile(new URL("./fixtures/slide-video-clips/poster.png", import.meta.url), path.join(root, "slides/media-deck/assets/poster.png"));
  const before = await fs.readFile(deckPath);
  const output = path.join(artifacts, "clips-with-audio.mp4");
  const result = await exportSlideVideo(root, deck.id, "clip-slide", { out: output, refreshSources: false, height: 720, fps: 30, startHoldMs: 100, stepDelayMs: 200, endHoldMs: 200 });
  assert.equal(result.frames, 72); assert.equal(result.durationMs, 2400); assert.deepEqual(result.warnings, []);
  assert.deepEqual(await fs.readFile(deckPath), before, "export leaves authored source bytes unchanged");
  const decoded = spawnSync(encoder, ["-hide_banner", "-i", output, "-vf", "scale=320:180,showinfo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 25 * 1024 * 1024, timeout: 30000 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(decoded.stdout.length, 72 * 320 * 180 * 3);
  const frameBytes = 320 * 180 * 3;
  const redAt = (frame: number) => {
    const offset = frame * frameBytes + 80 * 320 * 3;
    for (let x = 0; x < 320; x++) { const i = offset + x * 3; if (decoded.stdout[i] > 150 && decoded.stdout[i + 1] < 110 && decoded.stdout[i + 2] < 110) return x; }
    return -1;
  };
  assert.equal(redAt(0), -1, "clip is absent before its appearance");
  const samples = [[12, 60], [19, 68], [26, 84], [45, 100], [71, 152]];
  for (const [frame, expected] of samples) assert.ok(Math.abs(redAt(frame) - expected) <= 3, `frame ${frame}: expected clip square x=${expected}, received ${redAt(frame)}`);
  assert.equal(redAt(25), redAt(28), "paused clip retains the same decoded frame");
  const sourceFrames = spawnSync(encoder, ["-hide_banner", "-loglevel", "error", "-i", path.resolve("scripts/fixtures/slide-video-clips/moving-box.mp4"), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 3 * 1024 * 1024, timeout: 30000 });
  assert.equal(sourceFrames.status, 0, sourceFrames.stderr.toString());
  for (let frame = 9; frame < 72; frame++) {
    const sourceFrame = frame < 15 ? 0 : frame < 24 ? frame - 15 : frame < 30 ? 9 : Math.min(35, frame - 30);
    const offset = sourceFrame * 160 * 90 * 3 + 40 * 160 * 3;
    let sourceLeft = -1;
    for (let x = 0; x < 160; x++) { const i = offset + x * 3; if (sourceFrames.stdout[i] > 150 && sourceFrames.stdout[i + 1] < 110 && sourceFrames.stdout[i + 2] < 110) { sourceLeft = x; break; } }
    assert.ok(sourceLeft >= 0 && Math.abs(redAt(frame) - (sourceLeft + 40)) <= 1, `encoded frame ${frame} paints exact source frame ${sourceFrame}`);
  }
  let movingFrames = 0;
  for (let frame = 31; frame < 65; frame++) if (redAt(frame) !== redAt(frame - 1)) movingFrames++;
  assert.equal(movingFrames, 34, `every moving source frame advances smoothly (${movingFrames} changing frames)`);
  const times = [...decoded.stderr.toString().matchAll(/n:\s*\d+\s+pts:\s*\d+\s+pts_time:([\d.]+)/g)].map(m => Number(m[1]));
  assert.equal(times.length, 72);
  times.forEach((t, i) => assert.ok(Math.abs(t - i / 30) < .00001, `constant frame timestamp ${i}`));
  const pcm = spawnSync(encoder, ["-hide_banner", "-loglevel", "error", "-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { maxBuffer: 2 * 1024 * 1024, timeout: 30000 });
  assert.equal(pcm.status, 0, pcm.stderr.toString());
  const rms = (from: number, to: number) => {
    let energy = 0, count = 0;
    for (let i = Math.floor(from * 48000); i < Math.floor(to * 48000) && i * 4 + 4 <= pcm.stdout.length; i++) { energy += pcm.stdout.readFloatLE(i * 4) ** 2; count++; }
    return Math.sqrt(energy / count);
  };
  for (const [from, to] of [[.05, .09], [.35, .45], [.85, .95], [2.25, 2.35]]) assert.ok(rms(from, to) < .001, `silence before Start/after Pause/end (${from}s)`);
  for (const [from, to] of [[.55, .65], [.7, .75], [1.05, 1.15], [2.05, 2.15]]) assert.ok(rms(from, to) > .04, `audible clip is synchronized at ${from}s`);
  console.log("  ok: actual MP4 has exact duration and all 72 regular timestamps");
  console.log("  ok: decoded clip pixels reveal, play, pause, restart and finish smoothly");
  console.log("  ok: AAC audio starts and pauses at the same exact timeline positions");
  const sixtyFile = path.join(artifacts, "clips-60fps.mp4");
  const sixty = await exportSlideVideo(root, deck.id, "clip-slide", { out: sixtyFile, refreshSources: false, height: 720, fps: 60, startHoldMs: 100, stepDelayMs: 200, endHoldMs: 200 });
  assert.equal(sixty.frames, 144); assert.equal(sixty.durationMs, 2400);
  const sixtyDecoded = spawnSync(encoder, ["-hide_banner", "-i", sixtyFile, "-vf", "scale=320:180,showinfo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 30 * 1024 * 1024, timeout: 30000 });
  assert.equal(sixtyDecoded.status, 0, sixtyDecoded.stderr.toString());
  assert.equal(sixtyDecoded.stdout.length, 144 * frameBytes);
  for (let frame = 18; frame < 144; frame++) {
    const sourceFrame = frame < 30 ? 0 : frame < 48 ? Math.floor((frame - 30) / 2) : frame < 60 ? 9 : Math.min(35, Math.floor((frame - 60) / 2));
    const sourceOffset = sourceFrame * 160 * 90 * 3 + 40 * 160 * 3, outputOffset = frame * frameBytes + 80 * 320 * 3;
    const left = (buffer: Buffer, offset: number, width: number) => { for (let x = 0; x < width; x++) { const i = offset + x * 3; if (buffer[i] > 150 && buffer[i + 1] < 110 && buffer[i + 2] < 110) return x; } return -1; };
    const expected = left(sourceFrames.stdout, sourceOffset, 160) + 40;
    assert.ok(Math.abs(left(sixtyDecoded.stdout, outputOffset, 320) - expected) <= 1, `60fps frame ${frame} paints exact source frame ${sourceFrame}`);
  }
  const sixtyTimes = [...sixtyDecoded.stderr.toString().matchAll(/n:\s*\d+\s+pts:\s*\d+\s+pts_time:([\d.]+)/g)].map(m => Number(m[1]));
  assert.equal(sixtyTimes.length, 144); sixtyTimes.forEach((t, i) => assert.ok(Math.abs(t - i / 60) < .00001, `60fps timestamp ${i}`));
  console.log("  ok: 60fps output samples every source frame exactly, including repeated frames and final hold");
  (deck.slides[0].elements[0] as { muted?: boolean }).muted = true;
  await fs.writeFile(deckPath, JSON.stringify(deck));
  const mutedFile = path.join(artifacts, "muted-clip.mp4");
  await exportSlideVideo(root, deck.id, "clip-slide", { out: mutedFile, refreshSources: false, height: 720, fps: 30, startHoldMs: 0, stepDelayMs: 0, endHoldMs: 0 });
  const mutedInfo = spawnSync(encoder, ["-hide_banner", "-i", mutedFile], { timeout: 30000 });
  assert.ok(!/Audio:/.test(mutedInfo.stderr.toString()), "muted clips produce no audio stream");
  console.log("  ok: muted clips remain silent in exported MP4");
  const protectedFile = path.join(scratch, "protected.mp4"), original = Buffer.from("previous output"); await fs.writeFile(protectedFile, original);
  const controller = new AbortController();
  await assert.rejects(exportSlideVideo(root, deck.id, "clip-slide", { out: protectedFile, refreshSources: false, signal: controller.signal, onProgress: p => { if (p.phase === "rendering" && p.frame > 2) controller.abort(); } }), /cancelled/i);
  assert.deepEqual(await fs.readFile(protectedFile), original);
  assert.ok(!(await fs.readdir(scratch)).some(name => name.startsWith(".protected.mp4")), "cancelled capture releases output intermediates");
  console.log("  ok: cancelling a decoded-video export preserves the previous MP4 and cleans up");
  await fs.writeFile(path.join(root, "slides/media-deck/assets/movie.mp4"), "damaged media bytes");
  await assert.rejects(exportSlideVideo(root, deck.id, "clip-slide", { out: protectedFile, refreshSources: false }), /decode|video clip|source/i);
  assert.deepEqual(await fs.readFile(protectedFile), original);
  assert.ok(!(await fs.readdir(scratch)).some(name => name.startsWith(".protected.mp4")), "decoder errors release output intermediates");
  console.log("  ok: a damaged cached clip reports a decoder error and preserves previous output");
  console.log("\nSLIDE MEDIA EXPORT: PASS");
}
