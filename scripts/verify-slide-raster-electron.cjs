#!/usr/bin/env node
"use strict";
// WP 1.8 crisp stage + WP 1.1 video colour, measured on the PRODUCTION video worker in OFFSCREEN Electron (BrowserWindow show:false,
// offscreen:true: no window, no dev server, no port). Headless Chrome cannot see this defect class (software raster re-rasterises
// every will-change layer), so the gate drives Electron. The probe does the work (scripts/lib/slideRasterElectronProbe.ts).
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
async function main() {
  const repo = path.resolve(__dirname, ".."), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-raster-"));
  const { TestProcessScope } = await import("./lib/testProcess.mjs"); const scope = new TestProcessScope();
  const env = { ...process.env, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", PROBE_SCRATCH: scratch };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.mkdir(env.HOME, { recursive: true });
    assert.notEqual(process.platform, "win32", "the raster harness spawns an executable encoder shim (POSIX only)");
    const probe = scope.spawn(path.join(__dirname, "lib/slideRasterElectronProbe.ts"), [], { env, cwd: repo, deadlineMs: 450000 });
    probe.child.stdout.on("data", bytes => { for (const line of String(bytes).split("\n")) if (line.startsWith("PROBE ")) console.log(line); });
    const status = await scope.waitExit(probe);
    assert.equal(status.code, 0, (probe.stdout + probe.stderr).slice(-12000));
    assert.match(probe.stdout, /SLIDE RASTER ELECTRON: PASS/);
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-slide-raster-electron");
  try { await main(); h.ok(true, "offscreen Electron: landed/in-flight sharpness vs fresh renders, bounded re-bakes, hint never cleared, plain decks never bake, BT.709 tagged colour, no join pop"); }
  catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
