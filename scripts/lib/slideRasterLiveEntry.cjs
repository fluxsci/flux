"use strict";
// Offscreen Electron harness for scripts/perf/slide-raster-probe.mts: the REAL exported player with its real rAF clock, one window per
// scenario (BrowserWindow show:false, offscreen:true: nothing is ever shown, no dev server, no port). env FLUX_RASTER_LIVE = JSON
//   { html, htmlText, out, zoom, pan, still }  (slide indices into `html`'s deck / `htmlText`'s deck)
// Screenshots go to <out>/<name>.png, measurements to <out>/live.json.
const fs = require("node:fs"), path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { VIDEO_CAPTURE_SWITCHES } = require("../../electron/slideVideoWorker.cjs");
const job = JSON.parse(process.env.FLUX_RASTER_LIVE);
app.setPath("userData", path.join(job.out, "profile"));
for (const [name, value] of VIDEO_CAPTURE_SWITCHES) app.commandLine.appendSwitch(name, value);
app.on("window-all-closed", () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open(html, w, h) {
  const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(html); const wc = win.webContents; wc.debugger.attach("1.3");
  const resize = (width, height) => wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await resize(w, h); await sleep(600);
  const shot = async name => { const c = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: true }); fs.writeFileSync(path.join(job.out, name + ".png"), Buffer.from(c.data, "base64")); };
  return { win, wc, resize, shot, ev: js => wc.executeJavaScript(js) };
}
const bakes = ev => ev(`window.fluxDeck.rasterBakes ? window.fluxDeck.rasterBakes() : -1`);
const hint = `document.querySelector('.sl-camera').style.willChange`;
const inject = n => `(()=>{const c=document.querySelector('.sl-camera'); const s=document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('width','640');s.setAttribute('height','360');s.style.position='absolute'; const f=document.createDocumentFragment(); for(let i=0;i<${n};i++){const p=document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('d','M'+(i%600)+' '+((i*7)%340)+'l3 2l-2 3z'); p.setAttribute('fill','#888'); f.appendChild(p);} s.appendChild(f); c.appendChild(s);})()`;
app.whenReady().then(async () => {
  fs.mkdirSync(job.out, { recursive: true }); const res = {};
  // L1 + L6: a 900 ms zoom, then rest. Bakes: 0 at load, 1 after the beat; first screenshot after `playing` turns false is already sharp.
  {
    const { win, ev, shot } = await open(job.html, 1280, 720);
    await ev(`window.fluxDeck.goTo(${job.zoom},0,{animate:false})`); await sleep(500);
    const atLoad = await bakes(ev), hints = [await ev(hint)];
    await ev(`window.fluxDeck.play({slide:${job.zoom},fromBeat:1,toBeat:1})`);
    const t0 = Date.now(); let endAt = null, landed = false, n = 0; const log = [];
    while (Date.now() - t0 < 6000) {
      const st = await ev(`(()=>{const s=window.fluxDeck.state(); return [s.playing, s.time, ${hint}, window.fluxDeck.rasterBakes ? window.fluxDeck.rasterBakes() : -1]})()`);
      hints.push(st[2]); log.push([Date.now() - t0, ...st]);
      if (!st[0] && !landed) { await shot("land_first"); landed = true; endAt = Date.now() - t0; }
      if (landed && Date.now() - t0 - endAt > 900) break;
      n++;
    }
    await sleep(300); await shot("land_rest");
    res.landing = { atLoad, afterBeat: await bakes(ev), hints: [...new Set(hints)], endAt, polls: n };
    win.destroy();
    const fresh = await open(job.html, 1280, 720);
    await fresh.ev(`window.fluxDeck.goTo(${job.zoom},1,{animate:false})`); await sleep(700); await fresh.shot("land_fresh"); fresh.win.destroy();
  }
  // L2: an exported text deck resized 800x450 -> 1000x563 -> 1400x788 -> 1920x1080 (steps, like a drag)
  {
    const a = await open(job.htmlText, 800, 450);
    await a.ev(`window.fluxDeck.goTo(${job.still},0,{animate:false})`); await sleep(400);
    for (const [w, h] of [[1000, 563], [1400, 788], [1920, 1080]]) { await a.resize(w, h); await sleep(900); }
    await a.shot("resize_final"); res.resizeBakes = await bakes(a.ev); a.win.destroy();
    const b = await open(job.htmlText, 1920, 1080);
    await b.ev(`window.fluxDeck.goTo(${job.still},0,{animate:false})`); await sleep(700); await b.shot("resize_fresh"); b.win.destroy();
  }
  // L3: a scrub (20 seeks inside the debounce window) bakes nothing until the stage is at rest
  {
    const { win, ev } = await open(job.html, 1280, 720);
    await ev(`window.fluxDeck.goTo(${job.zoom},0,{animate:false})`); await sleep(400);
    const before = await bakes(ev), during = [];
    for (let i = 1; i <= 20; i++) { await ev(`window.fluxDeck.seek(${job.zoom},1,${i * 45})`); await sleep(5); if (i % 5 === 0) during.push(await bakes(ev)); }
    const atLast = await bakes(ev); await sleep(500);
    res.scrub = { before, during, atLast, after500: await bakes(ev) };
    win.destroy();
  }
  // L4: the node ceiling; N plain nodes under the camera layer, then the zoom plays
  res.ceiling = {};
  for (const n of [10000, 29000, 31000, 60000]) {
    const { win, ev } = await open(job.html, 1280, 720);
    await ev(`window.fluxDeck.goTo(${job.zoom},0,{animate:false})`); await sleep(300);
    await ev(inject(n)); await sleep(500);
    await ev(`window.fluxDeck.play({slide:${job.zoom},fromBeat:1,toBeat:1})`); await sleep(2000);
    res.ceiling[n] = { nodes: await ev(`document.querySelector('.sl-camera').getElementsByTagName('*').length`), bakes: await bakes(ev) };
    win.destroy();
  }
  // L7: the real bake stall with 29 000 nodes (rAF gaps while the zoom lands and re-bakes)
  {
    const { win, ev } = await open(job.html, 1280, 720);
    await ev(`window.fluxDeck.goTo(${job.zoom},0,{animate:false})`); await sleep(300);
    await ev(inject(29000)); await sleep(500);
    await ev(`window.__gaps=[];window.__run=true;(()=>{let l=performance.now();(function t(){const n=performance.now();window.__gaps.push(n-l);l=n;if(window.__run)requestAnimationFrame(t)})()})()`);
    await ev(`window.fluxDeck.play({slide:${job.zoom},fromBeat:1,toBeat:1})`); await sleep(2000);
    const gaps = await ev(`window.__run=false;window.__gaps`);
    res.stall = { maxGapMs: Math.max(...gaps.slice(5)), gapsOver34: gaps.slice(5).filter(x => x > 34).length, frames: gaps.length, bakes: await bakes(ev) };
    win.destroy();
  }
  // L5: a pan-only beat never clears the camera's compositor hint (HEAD: ["transform", ""])
  {
    const { win, ev } = await open(job.html, 1280, 720);
    await ev(`window.fluxDeck.goTo(${job.pan},0,{animate:false})`); await sleep(300);
    const seen = [await ev(hint)];
    await ev(`window.fluxDeck.play({slide:${job.pan},fromBeat:1,toBeat:1})`);
    for (let i = 0; i < 20; i++) { await sleep(100); seen.push(await ev(hint)); }
    res.pan = { hints: [...new Set(seen)], bakes: await bakes(ev) };
    win.destroy();
  }
  fs.writeFileSync(path.join(job.out, "live.json"), JSON.stringify(res, null, 1));
  process.stdout.write(`FLUX_RASTER_LIVE ${JSON.stringify(res)}\n`, () => app.exit(0));
}).catch(error => { process.stderr.write(`[raster live] ${error && error.stack || error}\n`); app.exit(1); });
