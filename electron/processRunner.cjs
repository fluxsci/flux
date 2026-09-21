"use strict";
// Shared Node/Electron child owner: EOF stdin, bounded output, truthful signal
// status and process-tree cancellation. Interactive consumers opt into inherit.
const { spawn } = require("node:child_process");
const { resolveSpawn } = require("./execResolve.cjs");
async function runProcess(invocation, options = {}) {
  const { executable, argv = [], cwd, envDelta = {} } = invocation;
  if (typeof executable !== "string" || !executable || executable.includes("\0") || !Array.isArray(argv) || argv.some(x => typeof x !== "string" || x.includes("\0"))) throw new Error("Invalid process invocation");
  if (typeof cwd !== "string" || !(await require("node:fs/promises").stat(cwd)).isDirectory()) throw new Error("Process working directory does not exist");
  const timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
  const cap = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(cap) || cap < 0) throw new Error("Invalid process bounds");
  const rs = resolveSpawn(executable, [...argv]);
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), outDropped = 0, errDropped = 0;
    let status = "exited", spawnError = null, settled = false, escalation = null;
    const inherited = options.stdio === "inherit";
    const grouped = process.platform !== "win32" && !inherited;
    const child = spawn(rs.command, rs.args, { cwd, env: { ...process.env, ...envDelta }, stdio: inherited ? "inherit" : ["ignore", "pipe", "pipe"], detached: grouped, windowsHide: !inherited, windowsVerbatimArguments: rs.windowsVerbatimArguments });
    const terminate = force => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => {});
        } else if (grouped) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        else child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch { /* group already reaped */ }
    };
    const cancel = why => {
      if (settled || status !== "exited") return;
      status = why; terminate(false);
      escalation = setTimeout(() => terminate(true), options.killGraceMs ?? 1500);
      escalation.unref?.();
    };
    const timer = setTimeout(() => cancel("timeout"), timeoutMs); timer.unref?.();
    const abort = () => cancel("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.on("data", data => {
      try { options.onOutput?.("stdout", data); } catch (error) { spawnError = error; cancel("output-error"); }
      const joined = Buffer.concat([stdout, data]); outDropped += Math.max(0, joined.length - cap); stdout = joined.subarray(Math.max(0, joined.length - cap));
    });
    child.stderr?.on("data", data => {
      try { options.onOutput?.("stderr", data); } catch (error) { spawnError = error; cancel("output-error"); }
      const joined = Buffer.concat([stderr, data]); errDropped += Math.max(0, joined.length - cap); stderr = joined.subarray(Math.max(0, joined.length - cap));
    });
    child.once("error", error => { spawnError = error; status = "spawn-error"; });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (escalation) clearTimeout(escalation);
      // The parent may exit on TERM while descendants survive; reap the group.
      if (status === "cancelled" || status === "timeout" || status === "output-error") terminate(true);
      options.signal?.removeEventListener("abort", abort);
      if (signal && status === "exited") status = "signal";
      resolve({ status, code: code === null || (status !== "exited" && code === 0) ? -1 : code, signal: signal || null,
        stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") + (spawnError ? `\n${spawnError.message}` : ""),
        truncated: { stdout: outDropped, stderr: errDropped } });
    });
  });
}
module.exports = { runProcess };
