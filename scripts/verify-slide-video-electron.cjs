#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
async function main() {
  const repo = path.resolve(__dirname, ".."), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-video-native-"));
  const root = path.join(scratch, "project"), artifacts = path.join(repo, "test-results/slide-video");
  const { TestProcessScope } = await import("./lib/testProcess.mjs"); const scope = new TestProcessScope();
  const output = path.join(artifacts, "smooth-motion.mp4");
  const env = { ...process.env, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", PROBE_PROJECT: root, PROBE_SCRATCH: scratch, PROBE_VIDEO: output, PROBE_SCREENSHOT: path.join(artifacts, "settings.png"), PROBE_METRICS: path.join(artifacts, "native.json") };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.mkdir(env.HOME, { recursive: true }); await fs.mkdir(artifacts, { recursive: true });
    const fixture = scope.spawn(path.join(__dirname, "lib/slideVideoFixture.ts"), [root], { env });
    assert.equal((await scope.waitExit(fixture)).code, 0, fixture.stderr);
    const native = scope.spawn(require.resolve("electron/cli.js"), [path.join(__dirname, "lib/slideVideoNativeEntry.cjs"), root, ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []), ...(env.FLUX_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])], { env, cwd: repo, nodeArgs: [], deadlineMs: 240000 });
    native.child.stdout.on("data", bytes => { for (const line of String(bytes).split("\n")) if (line.startsWith("PROBE ")) console.log(line); });
    const status = await scope.waitExit(native);
    await fs.writeFile(path.join(artifacts, "native.log"), native.stdout + native.stderr);
    assert.equal(status.code, 0, (native.stdout + native.stderr).slice(-12000));
    const encoder = path.join(repo, "build/video-encoder", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    // Decode EVERY frame of the actual H.264 movie. This catches capture repeats,
    // stale compositor frames, clipping, timing errors and wrong slide selection.
    const decode = spawnSync(encoder, ["-hide_banner", "-i", output, "-vf", "scale=320:180,showinfo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 100 * 1024 * 1024 });
    assert.equal(decode.status, 0, decode.stderr.toString());
    const bytes = 320 * 180 * 3, count = decode.stdout.length / bytes;
    assert.equal(count, 165, "constant 60fps at exactly 2.75 seconds");
    assert.match(decode.stderr.toString(), /1920x1080/); assert.match(decode.stderr.toString(), /60 fps/); assert.match(decode.stderr.toString(), /h264/);
    const pixel = (frame, x, y) => [...decode.stdout.subarray(frame * bytes + (y * 320 + x) * 3, frame * bytes + (y * 320 + x) * 3 + 3)];
    const left = frame => { for (let x = 0; x < 200; x++) { const [r,g,b] = pixel(frame,x,50); if (r > 200 && g < 40 && b < 40) return x; } return -1; };
    for (let frame = 0; frame < count; frame++) {
      const expected = 20 + 100 * Math.max(0, Math.min(1, (frame / 60 - .5)));
      assert.ok(Math.abs(left(frame) - expected) <= 1.5, `frame ${frame}: smooth position ${left(frame)} near ${expected}`);
      assert.ok(pixel(frame, 10, 170).every(c => c > 245), `frame ${frame}: full slide painted through lower edge`);
    }
    assert.equal(new Set(Array.from({ length: 60 }, (_, i) => left(i + 30))).size, 60, "all 60 moving frames have distinct positions, with no dropped or repeated frames");
    assert.ok(pixel(0, 210, 50).every(c => c > 245), "future simultaneous entrance is initially hidden");
    const mid = pixel(60, 210, 50); assert.ok(mid[0] > 110 && mid[0] < 145 && mid[2] > 240, "simultaneous entrance is exactly half visible at motion midpoint");
    assert.ok(pixel(100, 210, 50)[0] < 10, "entrance completes with the movement");
    const textPatch = frame => { const rows = []; for (let y=95;y<128;y++) rows.push(decode.stdout.subarray(frame*bytes+(y*320+20)*3,frame*bytes+(y*320+210)*3)); return Buffer.concat(rows); };
    assert.ok(!textPatch(0).equals(textPatch(164)), "numeric text animation reaches a visibly changed endpoint");
    const frameTimes = [...decode.stderr.toString().matchAll(/\bn:\s*(\d+)\s+pts:\s*\d+\s+pts_time:([\d.]+)/g)];
    assert.equal(frameTimes.length, 165);
    for (const [, n, t] of frameTimes) assert.ok(Math.abs(Number(t) - Number(n)/60) < .00002, `frame ${n}: exact MP4 presentation timestamp`);
    console.log("SLIDE VIDEO ELECTRON: PASS (native flow, responsiveness, cancellation, all 165 decoded frames and timestamps)");
    const probe = scope.spawn(path.join(__dirname, "lib/slideVideoExportProbe.ts"), [], { env, cwd: repo, deadlineMs: 240000 });
    probe.child.stdout.on("data", bytes => process.stdout.write(bytes));
    const probeStatus = await scope.waitExit(probe);
    await fs.writeFile(path.join(artifacts, "coverage.log"), probe.stdout + probe.stderr);
    assert.equal(probeStatus.code, 0, (probe.stdout + probe.stderr).slice(-12000));
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-slide-video-electron");
  try { await main(); h.ok(true, "native export, decoded-frame motion/timing, responsiveness, cancellation, complex animation, resolution, failure cleanup and packaged launch"); }
  catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
