"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
async function main() {
  const repo = path.resolve(__dirname, ".."), appRoot = path.resolve(process.env.FLUX_METADATA_APP_ROOT || repo);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-figure-metadata-"));
  const root = path.join(scratch, "project"), output = process.env.FLUX_OUT || path.join(repo, "test-results/figure-metadata-native");
  const { TestProcessScope } = await import("./lib/testProcess.mjs"), scope = new TestProcessScope();
  const env = { ...process.env, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), XDG_CACHE_HOME: path.join(scratch, "cache"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", DCONF_PROFILE: "/dev/null", PROBE_PROJECT: root, PROBE_SCRATCH: scratch, PROBE_ARTIFACTS: output, PROBE_APP_ROOT: appRoot };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.access(path.join(appRoot, "dist/index.html"));
    const config = path.join(scratch, "config"), capture = path.join(scratch, "capture");
    const prefs = process.platform === "darwin" ? path.join(env.HOME, "Library/Application Support/flux") : process.platform === "win32" ? path.join(env.APPDATA, "flux") : path.join(env.XDG_CONFIG_HOME, "flux");
    for (const folder of [env.HOME, prefs, path.join(config, "FluxLib"), capture, output]) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(prefs, "preferences.json"), JSON.stringify({ fluxConfigPath: config, captureDir: capture }));
    const fixture = scope.spawn(path.join(__dirname, "lib/metadataFixture.ts"), [root], { env, nodeArgs:["--import","tsx"] });
    assert.equal((await scope.waitExit(fixture)).code, 0, fixture.stderr);
    const baseline = await fs.readFile(path.join(root,"slides/meta-deck/deck.json"));
    if (process.platform === "linux") {
      const displayFile = path.join(scratch, "display");
      const display = scope.spawn(path.join(__dirname, "verify-slide-stash-electron.cjs"), ["--display", process.env.FLUX_XVFB || "Xvfb", displayFile], { env, readyLine: "DISPLAY READY", nodeArgs: [], deadlineMs: 180000 });
      await display.ready; env.DISPLAY = `:${(await fs.readFile(displayFile, "utf8")).trim()}`;
      delete env.WAYLAND_DISPLAY; env.PROBE_VIRTUAL_DISPLAY = "1";
    } else if (process.env.FLUX_METADATA_ALLOW_DESKTOP !== "1") throw new Error("Use a separate test desktop and set FLUX_METADATA_ALLOW_DESKTOP=1 to permit native focus.");
    const native = scope.spawn(require.resolve("electron/cli.js"), [path.join(__dirname, "lib/metadataNativeEntry.cjs"), root, "--mute-audio", ...(process.platform === "linux" ? ["--ozone-platform=x11", "--no-sandbox", "--disable-gpu"] : [])], { env, nodeArgs: [], deadlineMs: 120000 });
    native.child.stdout.on("data", data => { for (const line of String(data).split("\n")) if (line.startsWith("PROBE ")) console.log(line); });
    const status = await scope.waitExit(native);
    await fs.writeFile(path.join(output, "native.log"), native.stdout + native.stderr);
    assert.equal(status.code, 0, (native.stdout + native.stderr).slice(-16000));
    assert.deepEqual(await fs.readFile(path.join(root,"slides/meta-deck/deck.json")),baseline,"metadata never alters Slide data");
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-figure-metadata-electron");
  try { await main(); h.ok(true, "built app cold and resident saves, native pin/dock/close, custom families, reload and untouched deck"); }
  catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
