"use strict";
// Cancellation for the Electron worker processes (3D posters, slide video).
//
// POSIX: the parent writes "cancel" on stdin, and stdin's end means the parent died.
// Windows: an Electron main process's stdin is not readable there; it emits "end" at once and
// never delivers data, which cancelled every worker as it started (2026-10-19). So on win32 the
// worker watches the parent's pid instead; an explicit cancel still lands, because the parent
// force-kills the worker tree three seconds after asking.
function watchCancellation(controller, { platform = process.platform, parentPid = process.ppid, pollMs = 1000 } = {}) {
  process.on("SIGTERM", () => controller.abort());
  if (platform !== "win32") {
    process.stdin.on("data", () => controller.abort());
    process.stdin.on("end", () => controller.abort());
    return;
  }
  const alive = () => { try { process.kill(parentPid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  const timer = setInterval(() => { if (!alive()) { clearInterval(timer); controller.abort(); } }, pollMs);
  timer.unref?.();
  controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
module.exports = { watchCancellation };
