"use strict";
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
(async () => {
  const { harness } = await import("./lib/harness.mjs"), { TestProcessScope } = await import("./lib/testProcess.mjs");
  const h = harness("verify-slide-video-media-electron"), scope = new TestProcessScope(), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-media-native-"));
  const root = path.join(scratch, "project"), artifacts = path.resolve("test-results/slide-video-clips");
  try {
    await fs.mkdir(path.join(root, "plots/_videos"), { recursive: true }); await fs.mkdir(path.join(root, "slides/test.deck"), { recursive: true }); await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(root, "slides/test.deck/deck.json"), JSON.stringify({ assets: [] }));
    await fs.copyFile(path.resolve("scripts/fixtures/slide-video-clips/moving-box.mp4"), path.join(root, "plots/_videos/original.mp4"));
    const env = { ...process.env, PROBE_PROJECT: root, PROBE_SCRATCH: scratch, PROBE_PORTABLE: path.join(artifacts, "portable-paper.html"), HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata") }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    await fs.mkdir(env.HOME, { recursive: true });
    const headless = scope.spawn(path.join(__dirname, "lib/slideVideoMediaCoreProbe.ts"), [], { env, deadlineMs: 60000 });
    headless.child.stdout.on("data", bytes => process.stdout.write(bytes)); const coreResult = await scope.waitExit(headless);
    await fs.writeFile(path.join(artifacts, "media-headless.log"), headless.stdout + headless.stderr); assert.equal(coreResult.code, 0, headless.stdout + headless.stderr);
    const child = scope.spawn(require.resolve("electron/cli.js"), [path.join(__dirname, "lib/slideVideoMediaNative.cjs"), ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])], { nodeArgs: [], env, deadlineMs: 100000 });
    child.child.stdout.on("data", bytes => process.stdout.write(bytes)); const result = await scope.waitExit(child);
    await fs.writeFile(path.join(artifacts, "media-native.log"), child.stdout + child.stderr); assert.equal(result.code, 0, child.stdout + child.stderr);
    h.ok(true, "real MP4/ProRes MOV normalization, pixel seeks/playback, AAC signal, bounded previews, range streams, project isolation, cancellation and original preservation");
  } catch (error) { console.error(error); h.fail(String(error)); }
  finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
  await h.done();
})();
