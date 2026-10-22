"use strict";
// Offscreen Electron harness for the raster gate. It runs the PRODUCTION `renderVideo` of electron/slideVideoWorker.cjs (same window
// options, same CDP capture loop, same encoder arguments, same Chromium switches) for each job in $FLUX_RASTER_JOBS, with the
// capture window wrapped by a spy that records, after every `fluxVideo.frame(i)`, the camera layer's transform, its will-change hint,
// the keeper's bake count and how many elements under the camera are promoted (will-change: transform) flight layers. No window is ever shown (BrowserWindow show:false, offscreen:true), no dev server, no port.
//   job = { name, html, output, encoder, width, height, framesDir }   results -> <framesDir>/states.json
const fs = require("node:fs"), path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { renderVideo, VIDEO_CAPTURE_SWITCHES } = require("../../electron/slideVideoWorker.cjs");
const jobs = JSON.parse(fs.readFileSync(process.env.FLUX_RASTER_JOBS, "utf8"));
app.setPath("userData", path.join(path.dirname(jobs[0].html), "profile"));
for (const [name, value] of VIDEO_CAPTURE_SWITCHES) app.commandLine.appendSwitch(name, value);
app.on("window-all-closed", () => {});
const STATE = `(() => { const c = document.querySelector(".sl-camera"); return { transform: c ? c.style.transform : "", hint: c ? c.style.willChange : "", bakes: window.fluxVideo.rasterBakes ? window.fluxVideo.rasterBakes() : null, layers: c ? [...c.querySelectorAll("*")].filter(e => e.style && e.style.willChange === "transform").length : 0 }; })()`;
let states = [];
class SpyWindow extends BrowserWindow {
  constructor(options) {
    super(options);
    const wc = this.webContents, run = wc.executeJavaScript.bind(wc);
    wc.executeJavaScript = async (code, ...rest) => {
      const value = await run(code, ...rest);
      if (typeof code === "string" && code.startsWith("window.fluxVideo.frame(")) states.push(await run(STATE));
      return value;
    };
  }
}
(async () => {
  await app.whenReady();
  const out = [];
  for (const job of jobs) {
    states = [];
    process.env.FLUX_RASTER_FRAMES_DIR = job.framesDir;       // inherited by the encoder child the worker spawns
    const started = Date.now();
    const result = await renderVideo(job, { BrowserWindow: SpyWindow, session }, new AbortController().signal);
    fs.mkdirSync(job.framesDir, { recursive: true });
    fs.writeFileSync(path.join(job.framesDir, "states.json"), JSON.stringify(states));
    out.push({ name: job.name, frames: result.frames, ms: Date.now() - started });
  }
  process.stdout.write(`FLUX_RASTER ${JSON.stringify(out)}\n`, () => app.exit(0));
})().catch(error => { process.stderr.write(`[raster harness] ${error && error.stack || error}\n`); app.exit(1); });
