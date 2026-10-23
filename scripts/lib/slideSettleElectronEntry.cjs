"use strict";
// Real-time + compositor harness for start/settle (lane J): the REAL exported player, its real rAF clock, a real Present click, in
// OFFSCREEN Electron (BrowserWindow show:false, offscreen:true: nothing is ever shown; no dev server, no port). Every frame the
// compositor PRESENTS comes back through webContents' `paint` event as a bitmap, so what is measured is what a viewer would see, not a
// seek. env FLUX_SETTLE_JOB = JSON { html, out, cues: [{ name, slide, from, to, auto }], width, height, stageWidth, restMs, tailMs, maxMs,
// switches, dump }:
//
//   per cue, window A: goTo(slide, from-1) at rest, wait restMs, then the cue starts the way a viewer starts it: a CLICK (sendInputEvent,
//   the Present path: player.next()), or - for an "After previous" cue - by itself, autoDelayMs after the goTo. Recording runs until the cue
//   has landed + tailMs (or the next cue of a chain begins). Window B (same deck): goTo(slide, to) static = the reference render of the end
//   state, goTo(slide, from-1) = the rest before. Per cue (out/settle.json):
//     frames  [{ t, d }]            presented frames: ms from the cue's beatStart, change vs the previous presented frame (stage px^2 / px^2)
//     ticks   [{ t, time, playing, dur }]  the player's own frame events: ms from beatStart, the cue clock it sampled
//     clickToBeatStart, durationMs, firstClockMs (cue clock at the first tick that moved), clickToFirstTickMs, landedAt
//     restBeforeToFirst  first presented frame after the start vs the rest before
//     restAfter          the last presented frame vs window B's static render of the end state
//     postLanding        sum of presented-frame change after the landing frame (until the next cue starts)
//   job.dump = <dir>: also writes <dir>/<n>_{rest,first,land,last,ref}.png for each cue (and all frames with job.dumpAll).
// Frame differences are computed here from BGRA buffers (no image libraries); stage scale k = width / stage width.
const fs = require("node:fs"), path = require("node:path");
const { app, BrowserWindow, nativeImage } = require("electron");
const job = JSON.parse(process.env.FLUX_SETTLE_JOB);
app.setPath("userData", path.join(job.out, "profile"));
// The Present window's own configuration: GPU compositing on, nothing forced to software. (The video worker's switches are for capture.)
for (const [name, value] of job.switches || []) app.commandLine.appendSwitch(name, value);
app.on("window-all-closed", () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
let scale2 = 1;
const DEAD = job.dead ?? 6;   // per-channel dead band, see scripts/lib/slideSettleSweep.ts DEAD_BAND
function diff(a, b) { let d = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const v = Math.abs(a[i + c] - b[i + c]) - DEAD; if (v > 0) d += v; } return d / 765 / scale2; }

async function open(html, w, h) {
  const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = win.webContents;
  wc.setFrameRate(60);
  const rec = { frames: [], last: null, on: false, keep: !!job.dump };
  wc.on("paint", (_e, _dirty, image) => {
    const t = now(), size = image.getSize(), bmp = Buffer.from(image.toBitmap());
    const f = { t, bmp, size, d: 0 };
    if (rec.last && rec.last.bmp.length === bmp.length) f.d = diff(rec.last.bmp, bmp);
    rec.last = f;
    if (rec.on) rec.frames.push(f);
  });
  await win.loadFile(html);
  await sleep(500);
  return { win, wc, rec, ev: js => wc.executeJavaScript(js) };
}
// `hold` parks the player after the seek (pause() cancels the auto-advance timer): a reference render of a chain's step must not play on
const gotoRest = async (w, slide, beat, hold) => { await w.ev(`window.fluxDeck.goTo(${slide}, ${beat});${hold ? " window.fluxDeck.pause();" : ""}`); };
const png = (f, file) => { if (f) fs.writeFileSync(file, nativeImage.createFromBitmap(f.bmp, f.size).toPNG()); };

app.whenReady().then(async () => {
  fs.mkdirSync(job.out, { recursive: true });
  if (job.dump) fs.mkdirSync(job.dump, { recursive: true });
  const A = await open(job.html, job.width, job.height), B = await open(job.html, job.width, job.height);
  const stageW = await A.ev(`(() => { const c = document.querySelector('.sl-camera'); return c.parentElement.getBoundingClientRect().width })()`);
  scale2 = (stageW / job.stageWidth) ** 2;
  const gpu = await app.getGPUFeatureStatus();
  // main (hrtime) clock -> the page's performance.now(): the median of a few round trips
  const offs = []; for (let i = 0; i < 9; i++) { const t1 = now(), p = await A.ev(`performance.now()`), t2 = now(); offs.push(p - (t1 + t2) / 2); }
  offs.sort((a, b) => a - b); const offset = offs[4];
  const toPage = hr => hr + offset;
  const results = { gpu, stageWidth: stageW, cues: [] };
  await A.ev(`(() => { window.__ticks = []; window.__click = 0; window.__starts = []; window.__endAt = 0;
    document.addEventListener('click', () => { window.__click = performance.now(); }, true);
    window.fluxDeck.on('beatStart', () => { window.__starts.push(performance.now()); });
    window.fluxDeck.on('frame', s => window.__ticks.push([performance.now(), s.time, s.playing, s.duration]));
    window.fluxDeck.on('beatEnd', () => { window.__endAt = performance.now(); }); })()`);
  let n = 0;
  for (const cue of job.cues) {
    const res = { ...cue }; n++;
    const tag = String(n).padStart(3, "0");
    try {
      // the reference renders, in window B
      await gotoRest(B, cue.slide, cue.from - 1, true); await sleep(job.restMs); const restB = B.rec.last;
      await gotoRest(B, cue.slide, cue.to, true); await sleep(job.restMs); const ref = B.rec.last;
      // window A at the rest before the cue
      await gotoRest(A, cue.slide, cue.from - 1); await sleep(cue.auto ? 0 : job.restMs);
      await A.ev(`window.__endAt = 0; window.__starts = []; window.__ticks = []; window.__click = 0`);
      const restBefore = cue.auto ? restB : A.rec.last;
      A.rec.frames = []; A.rec.on = true;
      const x = Math.round(job.width * 0.6), y = Math.round(job.height * 0.5);
      if (!cue.auto) {
        A.wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        A.wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      } else await A.ev(`window.fluxDeck.goTo(${cue.slide}, ${cue.from - 1})`);
      // wait for the landing, then the tail
      const t0 = now(); let ended = 0;
      while (now() - t0 < (job.maxMs || 8000)) { await sleep(25); ended = await A.ev(`window.__endAt || 0`); if (ended) break; }
      await sleep(job.tailMs);
      A.rec.on = false;
      const log = await A.ev(`({ ticks: window.__ticks, click: window.__click, starts: window.__starts, endAt: window.__endAt })`);
      const start = log.starts[0] ?? log.click, nextStart = log.starts[1] ?? Infinity;
      const rel = pt => pt - start;
      res.clickToBeatStart = cue.auto ? null : start - log.click;
      res.ticks = log.ticks.map(([t, time, playing, dur]) => ({ t: rel(t), time, playing, dur })).filter(t => t.t < rel(nextStart));
      const frames = A.rec.frames.map(f => ({ ...f, tp: rel(toPage(f.t)) }));
      res.frames = frames.map(f => ({ t: f.tp, d: f.d }));
      const moving = res.ticks.filter(t => t.playing && t.time > 0);
      res.durationMs = res.ticks.length ? res.ticks[0].dur : 0;
      res.firstClockMs = moving.length ? moving[0].time : null;
      res.clickToFirstTickMs = moving.length ? moving[0].t + (res.clickToBeatStart ?? 0) : null;
      res.landedAt = log.endAt ? rel(log.endAt) : null;
      const inCue = frames.filter(f => f.tp < rel(nextStart));
      const lastF = inCue[inCue.length - 1];
      const firstMoving = frames.find(f => f.tp >= 0);
      res.restBeforeToFirst = firstMoving && restBefore ? diff(restBefore.bmp, firstMoving.bmp) : null;
      res.restAfter = lastF && ref ? diff(lastF.bmp, ref.bmp) : null;
      const after = inCue.filter(f => res.landedAt != null && f.tp > res.landedAt + 20);
      res.postLanding = after.reduce((s, f) => s + f.d, 0);
      res.postLandingFrames = after.filter(f => f.d > 0.05).length;
      if (job.dump) {
        const land = [...inCue].reverse().find(f => res.landedAt != null && f.tp <= res.landedAt + 20);
        png(restBefore, `${job.dump}/${tag}_rest.png`); png(firstMoving, `${job.dump}/${tag}_first.png`); png(land, `${job.dump}/${tag}_land.png`); png(lastF, `${job.dump}/${tag}_last.png`); png(ref, `${job.dump}/${tag}_ref.png`);
        if (job.dumpAll) { fs.mkdirSync(`${job.dump}/${tag}`, { recursive: true }); frames.forEach((f, i) => png(f, `${job.dump}/${tag}/f${String(i).padStart(3, "0")}.png`)); }
      }
    } catch (e) { res.error = String(e && e.stack || e); }
    A.rec.frames = [];
    results.cues.push(res);
  }
  fs.writeFileSync(path.join(job.out, "settle.json"), JSON.stringify(results));
  process.stdout.write(`FLUX_SETTLE ${results.cues.length}\n`, () => app.exit(0));
}).catch(error => { process.stderr.write(`[settle harness] ${error && error.stack || error}\n`); app.exit(1); });
