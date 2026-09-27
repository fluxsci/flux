#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { adaptVideoTestSpawn } = require("./lib/nestedVideoTestLaunch.cjs");

async function main() {
  let checks = 0;
  const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const executable = "/fixture/real packaged µ Electron", args = ["worker.cjs", "job with spaces.json"];
  const normal = { env: { FLUX_SLIDE_VIDEO_WORKER: "1" }, cwd: "/fixture", stdio: "pipe" };
  const unchanged = adaptVideoTestSpawn(executable, args, normal, "linux");
  check(unchanged, { command: executable, args, options: normal }, "ordinary production launch is unchanged");
  assert.strictEqual(unchanged.args, args); assert.strictEqual(unchanged.options, normal); checks++;
  const sandbox = adaptVideoTestSpawn(executable, args, { ...normal, env: { ...normal.env, FLUX_ELECTRON_NO_SANDBOX: "1" } }, "linux");
  check(sandbox.command, executable, "real packaged executable is preserved");
  check(sandbox.args, [...args, "--no-sandbox"], "sandbox opt-in does not opt into a display override");
  const privateDisplay = adaptVideoTestSpawn(executable, args, { env: { ...normal.env, FLUX_PRIVATE_DISPLAY: "1" } }, "linux");
  check(privateDisplay.args, [...args, "--ozone-platform=x11"], "private display does not disable sandbox without opt-in");
  const both = { env: { ...normal.env, FLUX_PRIVATE_DISPLAY: "1", FLUX_ELECTRON_NO_SANDBOX: "1" } };
  check(adaptVideoTestSpawn(executable, [...args, "--no-sandbox", "--ozone-platform=x11"], both, "linux").args, [...args, "--no-sandbox", "--ozone-platform=x11"], "test flags are deduplicated");
  check(adaptVideoTestSpawn(executable, args, both, "darwin").args, [...args, "--no-sandbox"], "private Linux display does not affect macOS");
  check(adaptVideoTestSpawn(executable, ["other-command"], both, "linux").command, executable, "capture path remains actual executable");
  const unrelated = { env: { FLUX_ELECTRON_NO_SANDBOX: "1" }, stdio: "inherit" };
  check(adaptVideoTestSpawn("node", ["other-command"], unrelated), { command: "node", args: ["other-command"], options: unrelated }, "unrelated children receive no hook or flags");
  const hop = adaptVideoTestSpawn(executable, ["cli.mjs", "export-slide-video"], { env: { FLUX_ELECTRON_NO_SANDBOX: "1", NODE_OPTIONS: "--trace-warnings" } });
  assert.match(hop.options.env.NODE_OPTIONS, /^--trace-warnings --require /); checks++;
  const cleaned = adaptVideoTestSpawn(executable, args, { env: { ...hop.options.env, FLUX_SLIDE_VIDEO_WORKER: "1" } });
  check(cleaned.options.env.NODE_OPTIONS, "--trace-warnings", "desktop worker retains caller Node options but removes only test preload");
  check(cleaned.options.env.FLUX_TEST_NESTED_VIDEO_LAUNCH, undefined, "desktop worker receives no test preload marker");

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-video-launch-"));
  const { TestProcessScope } = await import("./lib/testProcess.mjs"), scope = new TestProcessScope();
  try {
    const unusual = path.join(scratch, "nested launch 'µ"); await fs.mkdir(unusual);
    const helper = path.join(unusual, "adapter.cjs"); await fs.copyFile(path.join(__dirname, "lib/nestedVideoTestLaunch.cjs"), helper);
    const copied = require(helper);
    const capture = path.join(unusual, "capture.cjs"), cli = path.join(unusual, "cli.cjs"), launcher = path.join(unusual, "launcher.cjs");
    await fs.writeFile(capture, `console.log(JSON.stringify({args:process.argv.slice(2),nodeOptions:process.env.NODE_OPTIONS,marker:process.env.FLUX_TEST_NESTED_VIDEO_LAUNCH}));`);
    await fs.writeFile(cli, `const c=require('node:child_process').spawn(process.execPath,[${JSON.stringify(capture)},'actual-job.json'],{env:{...process.env,FLUX_SLIDE_VIDEO_WORKER:'1'},stdio:'inherit'});c.on('error',()=>process.exit(2));c.on('close',code=>process.exit(code??1));`);
    await fs.writeFile(launcher, `const c=require('node:child_process').spawn(process.execPath,[${JSON.stringify(cli)},'export-slide-video'],{stdio:'inherit'});c.on('error',()=>process.exit(2));c.on('close',code=>process.exit(code??1));`);
    const baseEnv = { ...process.env, NODE_OPTIONS: "--trace-warnings" };
    for (const name of ["FLUX_ELECTRON_NO_SANDBOX", "FLUX_PRIVATE_DISPLAY", "FLUX_XVFB", "FLUX_TEST_NESTED_VIDEO_LAUNCH", "FLUX_SLIDE_VIDEO_WORKER", "ELECTRON_RUN_AS_NODE"]) delete baseEnv[name];
    for (const optIn of [false, true]) {
      const env = { ...baseEnv, ...(optIn ? { FLUX_ELECTRON_NO_SANDBOX: "1", FLUX_PRIVATE_DISPLAY: "1" } : {}) };
      const next = copied.adaptVideoTestSpawn(process.execPath, [launcher, "export-slide-video"], { env });
      const child = scope.spawn(launcher, ["export-slide-video"], { nodeArgs: [], env: next.options.env, deadlineMs: 5000 });
      check((await scope.waitExit(child)).code, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      check(result.args, ["actual-job.json", ...(optIn ? ["--no-sandbox", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])] : [])], `real two-hop CLI launch ${optIn ? "propagates explicit test settings" : "preserves ordinary argv"}`);
      check(result.nodeOptions, "--trace-warnings", "real capture receives only caller-owned Node options");
      check(result.marker, undefined, "real capture receives no preload marker");
    }
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
  console.log(`PASS ${checks} native-video test-launch assertions`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
