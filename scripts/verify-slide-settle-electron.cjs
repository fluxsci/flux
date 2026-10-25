#!/usr/bin/env node
"use strict";
// Start/settle in the real-time + compositor domain (lane J): the exported player, a real click, the frames the GPU compositor PRESENTED,
// in OFFSCREEN Electron (BrowserWindow show:false, offscreen:true: no window, no dev server, no port). Headless Chrome cannot see this
// defect class (it re-rasterises every will-change layer and has no compositor timing), so the gate drives Electron; the probe does the
// work (scripts/lib/slideSettleElectronProbe.ts).
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
async function main() {
  const repo = path.resolve(__dirname, ".."), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-settle-"));
  const { TestProcessScope } = await import("./lib/testProcess.mjs"); const scope = new TestProcessScope();
  const env = { ...process.env, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "xdg"), APPDATA: path.join(scratch, "appdata"), FLUX_NO_MIGRATE: "1", PROBE_SCRATCH: scratch };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.mkdir(env.HOME, { recursive: true });
    const probe = scope.spawn(path.join(__dirname, "lib/slideSettleElectronProbe.ts"), [], { env, cwd: repo, deadlineMs: 3600000 });
    probe.child.stdout.on("data", bytes => { for (const line of String(bytes).split("\n")) if (line.startsWith("PROBE ")) console.log(line); });
    const status = await scope.waitExit(probe);
    assert.equal(status.code, 0, (probe.stdout + probe.stderr).slice(-12000));
    assert.match(probe.stdout, /SLIDE SETTLE ELECTRON: PASS/);
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-slide-settle-electron");
  try { await main(); h.ok(true, "offscreen Electron, real clicks: first moving frame one frame after frame 0, no long frame at landing, landing frame equals the static render, nothing changes after it, landing steps like its neighbours, an interrupt settles without a jump; the same at devicePixelRatio 1.25 (a fractionally scaled display)"); }
  catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
