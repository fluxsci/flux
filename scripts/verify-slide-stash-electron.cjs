"use strict";
// Production acceptance uses its own project, configuration, and virtual display.
// Build elsewhere with `vite build --outDir /tmp/flux-slide-stash-build`, then set
// FLUX_STASH_BUILD to that directory. The user's running dist is never replaced.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");

async function fixture(root) {
  const { buildScaffoldTree } = await import("../src/lib/project/scaffoldTree.ts");
  const { createDeck } = await import("../src/lib/slide/ops.ts");
  const deck = createDeck({ id: "stash-deck", title: "Show hidden acceptance", withTitleSlide: false });
  deck.stage = { width: 640, height: 360 }; deck.background = "#ffffff";
  deck.assets = [{ id: "large-image", name: "Disappeared image", kind: "png", path: "assets/large.png", naturalWidth: 160, naturalHeight: 90 }];
  const rect = (id, x, y, width, height, fill) => ({ id, name: id, type: "rect", x, y, width, height, rotation: 0, fill, stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  deck.slides = [{ id: "stash-slide", name: "Edit after disappearing", elements: [
    rect("underneath", 90, 100, 160, 120, "#4385be"),
    { id: "disappeared-large", name: "Disappeared large image", type: "image", assetId: "large-image", x: 50, y: 70, width: 260, height: 190, rotation: 0 },
    { id: "disappeared-text", name: "Disappeared text", type: "text", x: 350, y: 100, width: 250, height: 80, rotation: 0, text: "Disappear and keep working", fontFamily: "Gelasio", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "fixed" },
  ], beats: [
    { id: "base", tracks: [] },
    { id: "disappear", tracks: ["disappeared-large", "disappeared-text"].map((target, i) => ({ id: `exit-${i}`, target, preset: "fadeOut", duration: 100, easing: "linear" })) },
    { id: "later", tracks: [] },
  ] }, { id: "other-slide", name: "Another slide", elements: [], beats: [{ id: "other-base", tracks: [] }] }];
  const tree = buildScaffoldTree({ title: "Show hidden acceptance" }, deck);
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, text] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text); }
  await fs.copyFile(path.join(__dirname, "fixtures/slide-video-clips/poster.png"), path.join(root, "slides/stash-deck/assets/large.png"));
}

async function main() {
  const repo = path.resolve(__dirname, ".."), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-stash-"));
  const root = path.join(scratch, "project"), config = path.join(scratch, "config"), output = path.join(repo, "test-results/slide-stash-native");
  const appRoot = path.resolve(process.env.FLUX_STASH_APP_ROOT || repo);
  const build = path.resolve(process.env.FLUX_STASH_BUILD || path.join(appRoot, "dist"));
  const { TestProcessScope } = await import("./lib/testProcess.mjs"), scope = new TestProcessScope();
  const env = { ...process.env, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), XDG_CACHE_HOME: path.join(scratch, "cache"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", PROBE_PROJECT: root, PROBE_SCRATCH: scratch, PROBE_ARTIFACTS: output, PROBE_BUILD: build, PROBE_APP_ROOT: appRoot, DCONF_PROFILE: "/dev/null" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.access(path.join(build, "index.html"));
    for (const dir of [env.HOME, path.join(config, "FluxLib"), path.join(env.XDG_CONFIG_HOME, "flux"), path.join(scratch, "capture"), output]) await fs.mkdir(dir, { recursive: true });
    const preferences = JSON.stringify({ fluxConfigPath: config, captureDir: path.join(scratch, "capture") });
    await fs.writeFile(path.join(env.XDG_CONFIG_HOME, "flux/preferences.json"), preferences);
    // fluxPaths uses these locations on macOS / Windows too.
    if (process.platform === "darwin") { await fs.mkdir(path.join(env.HOME, "Library/Application Support/flux"), { recursive: true }); await fs.writeFile(path.join(env.HOME, "Library/Application Support/flux/preferences.json"), preferences); }
    if (process.platform === "win32") { await fs.mkdir(path.join(env.APPDATA, "flux"), { recursive: true }); await fs.writeFile(path.join(env.APPDATA, "flux/preferences.json"), preferences); }
    const setup = scope.spawn(__filename, ["--fixture", root], { env }); assert.equal((await scope.waitExit(setup)).code, 0, setup.stderr);
    if (process.platform === "linux") {
      const displayFile = path.join(scratch, "display");
      const display = scope.spawn(__filename, ["--display", process.env.FLUX_XVFB || "Xvfb", displayFile], { env, readyLine: "DISPLAY READY", nodeArgs: [], deadlineMs: 240000 });
      await display.ready;
      env.DISPLAY = `:${(await fs.readFile(displayFile, "utf8")).trim()}`;
      delete env.WAYLAND_DISPLAY;
      env.PROBE_VIRTUAL_DISPLAY = "1";
    } else if (process.env.FLUX_STASH_ALLOW_DESKTOP !== "1") {
      throw new Error("This test uses native window focus on this platform. Set FLUX_STASH_ALLOW_DESKTOP=1 only when a separate test desktop is available.");
    }
    for (const phase of ["edit", "reopen"]) {
      const native = scope.spawn(require.resolve("electron/cli.js"), [path.join(__dirname, "lib/slideStashNativeEntry.cjs"), root, ...(process.platform === "linux" ? ["--ozone-platform=x11", "--no-sandbox", "--disable-gpu"] : [])], { env: { ...env, PROBE_PHASE: phase }, cwd: repo, nodeArgs: [], deadlineMs: 180000 });
      native.child.stdout.on("data", bytes => { for (const line of String(bytes).split("\n")) if (line.startsWith("PROBE ")) console.log(line); });
      const status = await scope.waitExit(native);
      await fs.writeFile(path.join(output, `${phase}.log`), native.stdout + native.stderr);
      assert.equal(status.code, 0, (native.stdout + native.stderr).slice(-14000));
    }
    assert.deepEqual(await fs.readFile(path.join(root, "slides/stash-deck/assets/large.png")), await fs.readFile(path.join(__dirname, "fixtures/slide-video-clips/poster.png")), "Show hidden toggles and native save/reopen preserve original image bytes");
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[2] === "--fixture") fixture(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
else if (process.argv[2] === "--display") {
  // Child and virtual server share TestProcessScope's process group. Stdin EOF
  // also tears down the server if the parent test is unexpectedly interrupted.
  const child = require("node:child_process").spawn(process.argv[3], ["-displayfd", "1", "-screen", "0", "1600x1100x24", "-nolisten", "tcp", "-extension", "GLX"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.pipe(process.stderr);
  child.stdout.once("data", async data => { await fs.writeFile(process.argv[4], String(data).trim()); console.log("DISPLAY READY"); });
  child.on("error", error => { console.error("Xvfb unavailable; set FLUX_XVFB to a local executable:", error.message); process.exitCode = 1; process.stdin.destroy(); });
  child.on("exit", code => process.exit(code ?? 1));
  process.stdin.resume(); process.stdin.on("end", () => child.kill()); process.stdin.on("close", () => child.kill());
} else import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-slide-stash-electron");
  try { await main(); h.ok(true, "production native Show hidden, click-through, selection, endpoint edits, persistence, playback and input budget"); }
  catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
