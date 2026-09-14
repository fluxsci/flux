"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function createSlideVideoCore({ app, dialog, BrowserWindow, rootFor, fluxCliArgs, fsGuard, approveDir, noteWrite }) {
  const jobs = new Map();
  const safeId = value => typeof value === "string" && value.length > 0 && value.length < 200 && !/[\\/\0]/.test(value) && !value.startsWith(".");
  function cancel(job) { job.cancelled = true; job.child?.stdin.write("cancel\n"); }
  function registerHandlers(ipcMain) {
    ipcMain.handle("slides:cancelVideo", (e, jobId) => {
      const job = jobs.get(e.sender.id);
      if (job?.id === jobId) cancel(job);
    });
    ipcMain.handle("slides:exportVideo", async (e, request) => {
      const root = rootFor(e);
      if (!root || request?.root !== root || !safeId(request?.deckId) || !safeId(request?.slideId) || !safeId(request?.jobId)) return { ok: false, error: "Invalid video export request" };
      if (jobs.has(e.sender.id)) return { ok: false, error: "A video is already exporting in this window" };
      const job = { id: request.jobId, cancelled: false, child: null };
      jobs.set(e.sender.id, job);
      const destroyed = () => cancel(job);
      e.sender.once("destroyed", destroyed);
      const push = progress => { if (!e.sender.isDestroyed()) e.sender.send("slides:videoProgress", { jobId: job.id, ...progress }); };
      try {
        const picked = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
          title: "Export slide video", defaultPath: path.join(root, "exports", `${request.deckId}-${request.slideId}.mp4`), filters: [{ name: "MP4 video", extensions: ["mp4"] }],
        });
        if (picked.canceled || !picked.filePath || job.cancelled) return { ok: false, cancelled: true };
        if (e.sender.isDestroyed() || rootFor(e) !== root) throw new Error("The project changed before video export started");
        const output = picked.filePath;
        if (path.extname(output).toLowerCase() !== ".mp4") throw new Error("Choose a filename ending in .mp4");
        approveDir(e.sender.id, output); fsGuard(output, e.sender.id);
        const { appRoot, argv } = fluxCliArgs();
        const workerRoot = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : appRoot;
        const encoderRoot = app.isPackaged ? path.join(process.resourcesPath, "video-encoder") : path.join(appRoot, "build/video-encoder", `${process.platform}-${process.arch}`);
        const args = [...argv, "export-slide-video", request.deckId, request.slideId, "--root", root, "--out", output];
        for (const [key, flag] of [["stepDelayMs", "step-delay"], ["startHoldMs", "start-hold"], ["endHoldMs", "end-hold"], ["height", "height"], ["fps", "fps"]]) {
          const value = request.options?.[key];
          if (value !== undefined) { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid video setting"); args.push(`--${flag}`, String(value)); }
        }
        push({ phase: "preparing", frame: 0, total: 0 });
        const result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, args, { cwd: app.isPackaged ? workerRoot : appRoot, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FLUX_VIDEO_PROGRESS: "1", FLUX_VIDEO_SAVED: "1",
            FLUX_VIDEO_ELECTRON: process.execPath, FLUX_VIDEO_APP_ROOT: workerRoot, FLUX_VIDEO_ENCODER: path.join(encoderRoot, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") } });
          job.child = child;
          child.stdin.on("error", () => {});
          if (job.cancelled) child.stdin.write("cancel\n");
          let out = "", err = "", buffer = "";
          child.stdout.on("data", bytes => { out = (out + bytes).slice(-1000000); });
          child.stderr.on("data", bytes => {
            buffer += bytes;
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              if (line.startsWith("FLUX_VIDEO ")) { try { push(JSON.parse(line.slice(11))); } catch { /* malformed status is not a completed export */ } }
              else err = (err + line + "\n").slice(-12000);
            }
          });
          child.once("error", reject);
          child.once("close", code => {
            if (code !== 0) return job.cancelled ? resolve({ ok: false, cancelled: true }) : reject(new Error((err + buffer).trim() || `Video export exited ${code}`));
            try {
              const data = JSON.parse(out.trim());
              if (data.path !== output || !fs.existsSync(output)) throw new Error("Video export did not produce the requested file");
              noteWrite(output); resolve({ ok: true, ...data });
            } catch (error) { reject(error); }
          });
        });
        return result;
      } catch (error) { return job.cancelled ? { ok: false, cancelled: true } : { ok: false, error: String(error.message || error) }; }
      finally { jobs.delete(e.sender.id); if (!e.sender.isDestroyed()) e.sender.removeListener("destroyed", destroyed); }
    });
  }
  return { registerHandlers, cancelAll: () => { for (const job of jobs.values()) cancel(job); } };
}
module.exports = { createSlideVideoCore };
