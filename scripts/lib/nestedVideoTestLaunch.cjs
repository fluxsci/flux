"use strict";
// Test-owned adaptation for real native/packaged video launches. Production
// deliberately discovers its own Electron executable at each CLI hop, so an
// environment executable shim alone cannot cover the GUI or installed CLI.
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const marker = "FLUX_TEST_NESTED_VIDEO_LAUNCH";
const preload = `--require ${JSON.stringify(__filename)}`;
const installed = Symbol.for("flux.test.nestedVideoLaunch");

function optedIn(env) {
  return env.FLUX_ELECTRON_NO_SANDBOX === "1" || env.FLUX_PRIVATE_DISPLAY === "1" || !!env.FLUX_XVFB;
}

function adaptVideoTestSpawn(command, args, options = {}, platform = process.platform) {
  const env = options.env || process.env;
  if (!optedIn(env)) return { command, args, options };
  if (env.FLUX_SLIDE_VIDEO_WORKER === "1") {
    const nextArgs = [...args];
    if (env.FLUX_ELECTRON_NO_SANDBOX === "1" && !nextArgs.includes("--no-sandbox")) nextArgs.push("--no-sandbox");
    if (platform === "linux" && (env.FLUX_PRIVATE_DISPLAY === "1" || env.FLUX_XVFB) && !nextArgs.some(arg => arg.startsWith("--ozone-platform="))) nextArgs.push("--ozone-platform=x11");
    const nextEnv = { ...env };
    // Desktop Electron must not receive our Node-only preload. Preserve any
    // caller-owned NODE_OPTIONS, and never replace the executable under test.
    delete nextEnv[marker];
    if (nextEnv.NODE_OPTIONS?.includes(preload)) {
      nextEnv.NODE_OPTIONS = nextEnv.NODE_OPTIONS.replace(preload, "").trim();
      if (!nextEnv.NODE_OPTIONS) delete nextEnv.NODE_OPTIONS;
    }
    return { command, args: nextArgs, options: { ...options, env: nextEnv } };
  }
  if (!args.includes("export-slide-video")) return { command, args, options };
  const nextEnv = { ...env, [marker]: "1" };
  if (!nextEnv.NODE_OPTIONS?.includes(preload)) nextEnv.NODE_OPTIONS = [nextEnv.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  return { command, args, options: { ...options, env: nextEnv } };
}

function installNestedVideoTestLaunch() {
  if (!optedIn(process.env) || childProcess[installed]) return;
  const spawn = childProcess.spawn;
  childProcess[installed] = true;
  childProcess.spawn = function (command, args = [], options = {}) {
    // Preserve the standard spawn(command, options) overload as well.
    if (!Array.isArray(args)) return spawn.call(this, command, args);
    const next = adaptVideoTestSpawn(command, args, options);
    return spawn.call(this, next.command, next.args, next.options);
  };
  syncBuiltinESMExports();
}

module.exports = { adaptVideoTestSpawn, installNestedVideoTestLaunch };
if (process.env[marker] === "1") installNestedVideoTestLaunch();
