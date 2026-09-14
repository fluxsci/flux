"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
async function main() {
  const repo = path.resolve(__dirname, ".."), appRoot = path.resolve(process.env.FLUX_GALLERY_APP_ROOT || repo);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-gallery-preview-"));
  const root = path.join(scratch, "project"), output = path.join(repo, "test-results/gallery-preview-native");
  const { TestProcessScope } = await import("./lib/testProcess.mjs"), scope = new TestProcessScope();
  const env = { ...process.env, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), XDG_CACHE_HOME: path.join(scratch, "cache"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", DCONF_PROFILE: "/dev/null", PROBE_PROJECT: root, PROBE_SCRATCH: scratch, PROBE_ARTIFACTS: output, PROBE_APP_ROOT: appRoot };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.access(path.join(appRoot, "dist/index.html"));
    const config = path.join(scratch, "config"), capture = path.join(scratch, "capture");
    const prefs = process.platform === "darwin" ? path.join(env.HOME, "Library/Application Support/flux") : process.platform === "win32" ? path.join(env.APPDATA, "flux") : path.join(env.XDG_CONFIG_HOME, "flux");
    for (const folder of [env.HOME, prefs, path.join(config, "FluxLib"), capture, output]) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(prefs, "preferences.json"), JSON.stringify({ fluxConfigPath: config, captureDir: capture }));
    const fixture = scope.spawn(path.join(__dirname, "verify-slide-stash-electron.cjs"), ["--fixture", root], { env });
    assert.equal((await scope.waitExit(fixture)).code, 0, fixture.stderr);
    await fs.mkdir(path.join(root, "plots/study"), { recursive: true });
    await fs.mkdir(path.join(root, "plots/_dissections/study/source/by_subject"), { recursive: true });
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="white"/><circle cx="320" cy="180" r="95" fill="#4385be"/><text x="320" y="320" text-anchor="middle" font-size="28">Source preview</text></svg>';
    await fs.writeFile(path.join(root, "plots/study/source.svg"), image);
    await fs.writeFile(path.join(root, "plots/_dissections/study/source/by_subject/subject.svg"), image.replace("Source preview", "Subject detail"));
    await fs.copyFile(path.join(__dirname, "fixtures/slide-video-clips/moving-box.mp4"), path.join(root, "plots/study/source.mp4"));
    const baseline = await fs.readFile(path.join(root, "slides/stash-deck/deck.json"));
    if (process.platform === "linux") {
      const displayFile = path.join(scratch, "display");
      const display = scope.spawn(path.join(__dirname, "verify-slide-stash-electron.cjs"), ["--display", process.env.FLUX_XVFB || "Xvfb", displayFile], { env, readyLine: "DISPLAY READY", nodeArgs: [], deadlineMs: 180000 });
      await display.ready; env.DISPLAY = `:${(await fs.readFile(displayFile, "utf8")).trim()}`;
      delete env.WAYLAND_DISPLAY; env.PROBE_VIRTUAL_DISPLAY = "1";
    } else if (process.env.FLUX_GALLERY_ALLOW_DESKTOP !== "1") throw new Error("Use a separate test desktop and set FLUX_GALLERY_ALLOW_DESKTOP=1 to permit native focus.");
    const native = scope.spawn(require.resolve("electron/cli.js"), [path.join(__dirname, "lib/galleryPreviewNativeEntry.cjs"), root, "--mute-audio", ...(process.platform === "linux" ? ["--ozone-platform=x11", "--no-sandbox", "--disable-gpu"] : [])], { env, nodeArgs: [], deadlineMs: 120000 });
    native.child.stdout.on("data", data => { for (const line of String(data).split("\n")) if (line.startsWith("PROBE ")) console.log(line); });
    const status = await scope.waitExit(native);
    await fs.writeFile(path.join(output, "native.log"), native.stdout + native.stderr);
    assert.equal(status.code, 0, (native.stdout + native.stderr).slice(-16000));
    assert.deepEqual(await fs.readFile(path.join(root, "slides/stash-deck/deck.json")), baseline, "previewing never imports or changes the saved deck");
    assert.equal(await fs.readFile(path.join(root, "plots/study/source.svg"), "utf8"), image);
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-gallery-preview-electron");
  try { await main(); h.ok(true, "built app image/dissection previews, pinned native video playback and capability release without project changes"); }
  catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
