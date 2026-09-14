"use strict";
// Standalone Electron process. Capture and PNG compression never run in the
// editor or its main process. One frame in flight provides encoder backpressure.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function deadline(promise, label, ms = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function renderVideo(job, { BrowserWindow, session }, signal, progress = () => {}) {
  let win, encoder, closed;
  const audioOutput = `${job.output}.audio.mp4`;
  let stderr = "", rendererError = "";
  const cancelled = () => { if (signal.aborted) throw new Error("Video export cancelled"); };
  const abort = () => { if (encoder && encoder.exitCode === null) encoder.kill("SIGKILL"); if (win && !win.isDestroyed()) win.destroy(); };
  signal.addEventListener("abort", abort);
  try {
    cancelled();
    const ses = session.fromPartition(`video-${process.pid}-${Date.now()}`);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // Capture can read its exact HTML and explicitly materialized video files.
    // It receives no project/directory grant and cannot fetch network resources.
    const { pathToFileURL } = require("node:url");
    const url = pathToFileURL(job.html).href;
    const allowed = new Set([url, ...Object.values(job.mediaFiles ?? {}).map(file => pathToFileURL(file).href)]);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) && !/^(data|blob):/.test(details.url) }));
    win = new BrowserWindow({ show: false, width: job.width, height: job.height, useContentSize: true,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, next) => { if (next !== url) event.preventDefault(); });
    win.webContents.on("render-process-gone", (_event, detail) => { rendererError = `Capture renderer stopped: ${detail.reason}`; abort(); });
    await deadline(win.loadFile(job.html), "Loading slide");
    const wc = win.webContents;
    wc.debugger.attach("1.3");
    // Explicit pixel dimensions, independent of Retina/display scale.
    await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: job.width, height: job.height, deviceScaleFactor: 1, mobile: false });
    const info = await deadline(wc.executeJavaScript("window.fluxVideoReady"), "Preparing slide assets");
    cancelled();
    if (info.width !== job.width || info.height !== job.height || !Number.isInteger(info.frames) || info.frames < 1 || info.frames > 108000) throw new Error("Invalid capture plan");
    encoder = spawn(job.encoder, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "image2pipe", "-vcodec", "png", "-framerate", String(info.fps), "-i", "pipe:0",
      "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2",
      "-movflags", "+faststart", "-f", "mp4", job.output], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    closed = new Promise((resolve, reject) => {
      encoder.once("error", reject);
      encoder.once("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Video encoder exited ${code}`)));
    });
    // Rejection remains observed while the next screenshot is being rendered.
    closed.catch(() => {});
    encoder.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-12000); });
    encoder.stdin.on("error", () => {});
    let lastProgress = 0;
    for (let frame = 0; frame < info.frames; frame++) {
      cancelled();
      if (rendererError) throw new Error(rendererError);
      await deadline(wc.executeJavaScript(`window.fluxVideo.frame(${frame})`), "Rendering frame");
      // CDP capture forces a compositor commit after the synchronous seek.
      const capture = await deadline(wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: true }), "Capturing frame");
      cancelled();
      if (encoder.exitCode !== null || encoder.stdin.destroyed) { await closed; throw new Error("Video encoder stopped before the final frame"); }
      await deadline(new Promise((resolve, reject) => encoder.stdin.write(Buffer.from(capture.data, "base64"), error => error ? reject(error) : resolve())), "Encoding frame");
      if (frame === 0 || frame === info.frames - 1 || Date.now() - lastProgress > 150) {
        progress({ phase: "rendering", frame: frame + 1, total: info.frames }); lastProgress = Date.now();
      }
    }
    progress({ phase: "encoding", frame: info.frames, total: info.frames });
    encoder.stdin.end(); await deadline(closed, "Finishing MP4", 60000); cancelled();
    const audio = (info.audio ?? []).filter(segment => job.mediaHasAudio?.[segment.assetId] === true);
    if (audio.length) {
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", job.output];
      const filters = [];
      audio.forEach((segment, i) => {
        const file = job.mediaFiles?.[segment.assetId];
        if (!file || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs) throw new Error("Invalid video audio segment");
        if (segment.loop) args.push("-stream_loop", "-1");
        args.push("-ss", String((segment.offsetMs ?? 0) / 1000), "-t", String((segment.endMs - segment.startMs) / 1000), "-i", file);
        filters.push(`[${i + 1}:a]aresample=48000,atrim=duration=${(segment.endMs - segment.startMs) / 1000},asetpts=PTS-STARTPTS,adelay=${Math.round(segment.startMs * 48)}S:all=1[a${i}]`);
      });
      filters.push(`${audio.map((_segment, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:duration=longest:normalize=0,alimiter=limit=0.98:latency=1,apad=whole_dur=${info.durationMs / 1000},atrim=duration=${info.durationMs / 1000}[audio]`);
      args.push("-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[audio]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(info.durationMs / 1000), "-movflags", "+faststart", audioOutput);
      stderr = "";
      encoder = spawn(job.encoder, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      closed = new Promise((resolve, reject) => {
        encoder.once("error", reject);
        encoder.once("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Audio encoder exited ${code}`)));
      });
      encoder.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-12000); });
      await deadline(closed, "Finishing video audio", Math.max(60000, info.durationMs)); cancelled();
      await fs.rename(audioOutput, job.output);
    }
    const file = await fs.open(job.output, "r+");
    try { await file.sync(); } finally { await file.close(); }
    return { frames: info.frames, durationMs: info.durationMs, warnings: info.issues.map(issue => issue.reason) };
  } finally {
    signal.removeEventListener("abort", abort); abort();
    await closed?.catch(() => {});
    await fs.rm(audioOutput, { force: true }).catch(() => {});
  }
}
module.exports = { renderVideo };

// Electron's ESM bootstrap does not make a CJS entry require.main in Electron 43.
if (process.env.FLUX_SLIDE_VIDEO_WORKER === "1") {
  const { app, BrowserWindow, session } = require("electron");
  const controller = new AbortController();
  process.stdin.on("data", () => controller.abort());
  process.stdin.on("end", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  const emit = message => process.stdout.write(`FLUX_VIDEO ${JSON.stringify(message)}\n`);
  (async () => {
    const job = JSON.parse(require("node:fs").readFileSync(process.env.FLUX_VIDEO_JOB, "utf8"));
    app.setPath("userData", path.join(path.dirname(job.html), "profile"));
    app.commandLine.appendSwitch("force-color-profile", "srgb");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    await Promise.race([app.whenReady(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Video renderer did not start")), 20000))]);
    app.dock?.hide();
    const watchdog = setTimeout(() => controller.abort(), 60 * 60 * 1000);
    try { emit({ result: await renderVideo(job, { BrowserWindow, session }, controller.signal, emit) }); app.exit(0); }
    finally { clearTimeout(watchdog); }
  })().catch(error => { emit({ error: String(error.message || error), cancelled: controller.signal.aborted }); app.exit(1); });
}
