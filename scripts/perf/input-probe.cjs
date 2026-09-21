#!/usr/bin/env node
// INPUT probe — a real project, the production bundle, real Electron input.
//
// Measures what the user feels: in FIGURE, pointer sweeps across plots, hover
// boundary flips, rapid click bursts, a press-drag, trackpad and notch wheel
// pans (vertical / horizontal) and ctrl-wheel zoom; in PAPER, trackpad and
// notch scrolling of the real manuscript (with its inline figure / slide
// embeds) and typing. Each phase reports renderer long tasks, rAF frame gaps,
// input→paint, delivered-vs-sent events, CDP Performance deltas (style recalc /
// layout / script ms), per-process CPU and — for Figure — the browser-side
// `cursor-changed` oracle. CSS SCENARIOS are injected `!important` overrides
// that bisect a suspected mechanism without rebuilding (an override that leaves
// computed values unchanged costs nothing — 2026-09-16 this is how the cursor
// firewall regression was isolated in one run). Optional Chrome trace per phase.
//
//   node scripts/perf/input-probe.cjs <projectDir> [--surface=figure|paper|both|slide|all]
//        [--phases=sweep,hover,clicksEmpty,clicksPlot,dragPlot,idle,panSmall,panSmallEmpty,wheelV,wheelH,wheelNotch,zoom,zoomFast,zoomBursts,panFast,panBursts,scrollV,scrollNotch,typing] [--frames]
//        [--ozone=headless|wayland|x11] [--scenarios=base,nocursor,elconst,syscross] [--trace] [--frames] [--grim] [--out=<dir>]
//        [--maximize] [--assert-no-flicker] (use with --phases=zoomDeep --frames)
//
// The project is COPIED to a scratch dir (nothing of the user's is touched);
// HOME/XDG are isolated (no single-instance clash with a running Flux); the
// bundle in dist/ must be current (`npm run build`). Default platform is
// headless: on the owner's live desktop the window gets occluded mid-run (rAF
// stops, input drops) — use wayland/x11 only as a smoke test. Then:
//   node scripts/perf/trace-summary.mjs <out>/trace-<scenario>-<phase>.json
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { analyze: analyzeMarkerFrames } = require('./frame-oracle.cjs');
const repo = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// LAUNCHER (plain Node): copy the project, isolate config, spawn Electron on this file.
// ---------------------------------------------------------------------------
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const src = args.find((a) => !a.startsWith('--'));
  if (!src || !fs.existsSync(path.join(src, 'project.json'))) { console.error('usage: input-probe.cjs <projectDir> [--surface=figure|paper|both|slide|all] [--phases=a,b] [--ozone=headless] [--scenarios=base,...] [--trace] [--out=dir]'); process.exit(2); }
  const ozone = opt('ozone', 'headless');
  const out = path.resolve(opt('out', path.join(repo, 'test-results', `input-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-figure-input-probe-'));
  const project = path.join(scratch, 'project');
  fs.cpSync(path.resolve(src), project, { recursive: true, filter: (p) => !/[\\/]\.meta[\\/](locks|live)([\\/]|$)/.test(p) });
  for (const d of ['home', 'xdg']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'), APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1',
    PROBE_PROJECT: project, PROBE_OUT: out, PROBE_SCENARIOS: opt('scenarios', 'base'), PROBE_SURFACE: opt('surface', 'figure'), PROBE_PHASES: opt('phases', ''), PROBE_TRACE: args.includes('--trace') ? '1' : '0', PROBE_FRAMES: args.includes('--frames') ? '1' : '0', PROBE_MAXIMIZE: args.includes('--maximize') ? '1' : '0' };
  delete env.VITE_DEV_SERVER_URL; delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = [__filename, project];
  if (process.platform === 'linux') electronArgs.push('--no-sandbox', `--ozone-platform=${ozone}`);
  for (const a of (process.env.PROBE_EXTRA_ARGS || '').split(' ').filter(Boolean)) electronArgs.push(a);
  // --grim: sample the REAL display (what the user sees, Wayland compositor + GPU presentation
  // included) over the canvas region while the probe runs, via `grim` in a tight loop.
  const useGrim = args.includes('--grim');
  let grimStop = false, grimRegion = null, grimSamples = [];
  const grimLoop = async () => {
    const { execFile } = require('node:child_process');
    while (!grimStop && grimRegion) {
      const t = Date.now();
      await new Promise((r) => execFile('grim', ['-g', grimRegion.g, '-t', 'ppm', '-'], { encoding: 'buffer', maxBuffer: 64 << 20 }, (err, buf) => {
        if (!err && buf && buf.length > 20) {
          // PPM P6: header "P6\nW H\n255\n" then RGB
          const txt = buf.subarray(0, 40).toString('latin1'); const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(txt);
          if (m) { const w = +m[1], h = +m[2], off = m[0].length; let n = 0, lum = 0, content = 0; for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) { const i = off + (y * w + x) * 3; const l = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]; lum += l; n++; if (Math.abs(l - grimRegion.bgLum) > 18) content++; }
            grimSamples.push({ t, dt: Date.now() - t, mean: +(lum / n).toFixed(1), content: +(content / n).toFixed(4) }); }
        }
        r();
      }));
    }
  };
  const child = spawn(require('electron'), electronArgs, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 400000);
  let stderr = '';
  child.stdout.on('data', (b) => { for (const line of String(b).split('\n')) { if (line.startsWith('PROBE ')) console.log(line); if (useGrim && line.startsWith('PROBE screenRegion ')) { try { grimRegion = JSON.parse(line.slice('PROBE screenRegion '.length)); grimLoop(); } catch {} } } });
  child.stderr.on('data', (b) => { stderr += b; });
  child.on('close', (code) => {
    clearTimeout(timer);
    grimStop = true;
    if (useGrim && grimSamples.length > 5) {
      const s = grimSamples; const contents = s.map((x) => x.content); const med = [...contents].sort((a, b) => a - b)[Math.floor(contents.length / 2)];
      const blanks = [], flashes = [];
      for (let i = 1; i < s.length - 1; i++) { const f = s[i], p = s[i - 1], n = s[i + 1]; if (f.content < Math.min(p.content, n.content) * 0.4 && p.content > med * 0.3) blanks.push({ t: f.t - s[0].t, content: f.content, prev: p.content, next: n.content }); if (Math.abs(f.mean - p.mean) > 20 && Math.abs(f.mean - n.mean) > 20 && Math.sign(f.mean - p.mean) === Math.sign(f.mean - n.mean)) flashes.push({ t: f.t - s[0].t, mean: f.mean, prev: p.mean }); }
      const gaps = s.slice(1).map((x, i) => x.t - s[i].t).sort((a, b) => a - b);
      console.log('PROBE grim ' + JSON.stringify({ samples: s.length, sampleMs: { p50: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * .95)] }, medianContent: +med.toFixed(3), minContent: Math.min(...contents), blanks: blanks.slice(0, 10), flashes: flashes.slice(0, 10) }));
      fs.writeFileSync(path.join(out, 'grim-samples.json'), JSON.stringify(s));
    }
    fs.writeFileSync(path.join(out, 'stderr.log'), stderr);
    fs.rmSync(scratch, { recursive: true, force: true });
    let status = code ?? 1;
    if (args.includes('--assert-no-flicker') && !status) {
      const data = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
      const phases = Object.values(data).flatMap(mode => Object.values(mode).flatMap(scenario => Object.values(scenario).filter(p => p?.label?.endsWith(':zoomDeep'))));
      const warnings = (stderr.match(/tile memory limits exceeded/g) || []).length;
      const passed = phases.length > 0 && warnings === 0 && phases.every(p => p.wheels === 216 && p.framesOracle?.frames > 60 && p.framesOracle.blankFrames.length === 0 && p.framesOracle.flashFrames.length === 0);
      const verdict = { ok: passed, phases: phases.length, tileWarnings: warnings, sampledFrames: phases.map(p => p.framesOracle?.frames) };
      fs.writeFileSync(path.join(out, 'flicker-verdict.json'), JSON.stringify(verdict, null, 2));
      console.log('PROBE flicker-verdict ' + JSON.stringify(verdict));
      if (!passed) status = 1;
    }
    console.log(`input-probe: exit=${status} out=${out}`);
    process.exit(status);
  });
  return;
}

// ---------------------------------------------------------------------------
// ENTRY (inside Electron): drive the real app.
// ---------------------------------------------------------------------------
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
const { app, BrowserWindow, contentTracing } = require('electron');
const out = process.env.PROBE_OUT;
const scenarios = (process.env.PROBE_SCENARIOS || 'base').split(',').filter(Boolean);
const doTrace = process.env.PROBE_TRACE === '1';
const surface = process.env.PROBE_SURFACE || 'figure';
const phaseFilter = (process.env.PROBE_PHASES || '').split(',').filter(Boolean);
const wantPhase = (n) => !phaseFilter.length || phaseFilter.includes(n);
require(path.join(repo, 'electron/main.cjs'));

let win;
let canvasModeRoot = ".figure-mode";
let cursorLog = [], phaseT0 = 0;
const log = (k, v) => console.log('PROBE ' + k + ' ' + JSON.stringify(v));
const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fn(); if (r) return r; } catch {} await sleep(80); } throw Error('Timeout: ' + label); }
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stats = (xs) => ({ n: xs.length, p50: q(xs, .5), p95: q(xs, .95), max: xs.length ? Math.max(...xs) : null });
function cpuSnapshot() { const o = {}; for (const p of app.getAppMetrics()) { const k = p.type === 'Tab' ? 'renderer' : p.type; o[k] = +((o[k] || 0) + p.cpu.percentCPUUsage).toFixed(3); } return o; }
const mouse = (ev) => win.webContents.sendInputEvent(ev);
const wheel = (x, y, dx, dy, modifiers = []) => mouse({ type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, canScroll: true, modifiers });
// A synthetic ctrl+wheel needs the KEY down too (the first events of a wheel gesture
// otherwise latch as a scroll without the modifier): hold Control around zoom bursts.
const ctrlDown = () => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
const ctrlUp = () => win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
let cdpOk = false;
async function cdpMetrics() {
  if (!cdpOk) return null;
  try { const { metrics } = await win.webContents.debugger.sendCommand('Performance.getMetrics'); const o = {}; for (const m of metrics) o[m.name] = m.value; return o; } catch { return null; }
}
const cdpDelta = (a, b) => (a && b) ? { styleMs: +((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(1), layoutMs: +((b.LayoutDuration - a.LayoutDuration) * 1000).toFixed(1), scriptMs: +((b.ScriptDuration - a.ScriptDuration) * 1000).toFixed(1), taskMs: +((b.TaskDuration - a.TaskDuration) * 1000).toFixed(1), layouts: b.LayoutCount - a.LayoutCount, recalcs: b.RecalcStyleCount - a.RecalcStyleCount } : null;
async function click(x, y, hold = 10) { mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x, y }); await sleep(hold); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x, y }); }

// Renderer-side instrumentation: rAF gaps, delivered pointer events, pointerdown→paint,
// long tasks, slow event-timing entries. Installed once per page.
const INSTR = `(()=>{if(window.__p)return 'ok';const p=window.__p={running:false,raf:0,frames:[],moves:0,downs:0,wheels:0,scrolls:0,keys:0,downPaint:[],keyPaint:[],longtasks:[],evts:[]};
window.addEventListener('pointermove',()=>{p.moves++},true);
window.addEventListener('pointerdown',(e)=>{p.downs++;const t0=e.timeStamp;requestAnimationFrame(()=>requestAnimationFrame(()=>p.downPaint.push(performance.now()-t0)))},true);
window.addEventListener('wheel',()=>{p.wheels++},{capture:true,passive:true});
window.addEventListener('scroll',()=>{p.scrolls++},{capture:true,passive:true});
window.addEventListener('keydown',(e)=>{p.keys++;const t0=e.timeStamp;requestAnimationFrame(()=>requestAnimationFrame(()=>p.keyPaint.push(performance.now()-t0)))},true);
try{new PerformanceObserver(l=>{for(const e of l.getEntries())p.longtasks.push(Math.round(e.duration))}).observe({type:'longtask'})}catch{}
try{new PerformanceObserver(l=>{for(const e of l.getEntries())p.evts.push({n:e.name,d:Math.round(e.duration),proc:Math.round(e.processingEnd-e.processingStart)})}).observe({type:'event',durationThreshold:16})}catch{}
p.start=()=>{cancelAnimationFrame(p.raf);p.running=true;p.frames=[];p.moves=0;p.downs=0;p.wheels=0;p.scrolls=0;p.keys=0;p.downPaint=[];p.keyPaint=[];p.longtasks=[];p.evts=[];const loop=t=>{if(!p.running)return;p.frames.push(t);p.raf=requestAnimationFrame(loop)};p.raf=requestAnimationFrame(loop)};
p.stop=()=>{p.running=false;cancelAnimationFrame(p.raf);p.raf=0;const gaps=[];for(let i=1;i<p.frames.length;i++)gaps.push(+(p.frames[i]-p.frames[i-1]).toFixed(1));return {frames:p.frames.length,gaps,moves:p.moves,downs:p.downs,wheels:p.wheels,scrolls:p.scrolls,keys:p.keys,downPaint:p.downPaint.map(x=>+x.toFixed(1)),keyPaint:p.keyPaint.map(x=>+x.toFixed(1)),longtasks:p.longtasks,evts:p.evts}};
return 'installed'})()`;

// CSS scenarios — bisect knobs. `base` is the shipped app.
const SCENARIOS = {
  base: '',
  nocursor: '*,*::before,*::after{cursor:default !important}', // no hardware family anywhere
  syscross: '*,*::before,*::after{cursor:crosshair !important}', // platform crosshair, no image
  noring: '.click-ring{display:none !important}', // no click ring
  elconst: '.canvas-host .el{cursor:var(--cursor-cross-hover) !important}', // the firewall, forced
  noRulers: '.canvas-host .ruler,.canvas-host .ruler-tick,.canvas-host .ruler-label,.canvas-host .ruler-corner{display:none !important}', // rulers out of paint/layout (JS still runs)
  overlayLayer: '.canvas-host .overlay-svg{will-change:transform}', // overlay in its own compositor layer
  noOverlay: '.canvas-host .overlay-svg{display:none !important}', // no overlay at all (diagnostic only)
  clipNone: '.canvas-host .scene-clip{clip-path:none !important}', // diagnostic: is the camera clip forcing layerization?
  svgLayer: '.canvas-host .scene-svg{will-change:transform}', // diagnostic: promote the scene svg root itself
  sceneContain: '.canvas-host .scene{contain:layout style}', // diagnostic: containment on the panned wrapper
  hostOverflow: '.canvas-host{overflow:visible !important}', // diagnostic: host clip off
  geomPrec: '.canvas-host .scene-svg{text-rendering:geometricPrecision}', // SVG text laid out scale-independently (no relayout per zoom tick)
};
async function setScenario(name) {
  const css = SCENARIOS[name]; if (css === undefined) throw Error('unknown scenario ' + name);
  await js(`(()=>{let s=document.getElementById('__probe_css');if(!s){s=document.createElement('style');s.id='__probe_css';document.head.appendChild(s)}s.textContent=${JSON.stringify(css)};return true})()`);
  await sleep(350);
}
async function measure(label, run, traceName) {
  await js('window.__p.start()'); cpuSnapshot(); const m0 = await cdpMetrics(); const t0 = Date.now(); cursorLog = []; phaseT0 = t0;
  if (traceName) await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'blink.user_timing', 'cc', 'input', 'ui', 'viz', 'gpu', 'toplevel', 'latencyInfo', 'benchmark', ...(process.env.PROBE_INVALIDATION === '1' ? ['disabled-by-default-devtools.timeline.invalidationTracking', 'disabled-by-default-blink.invalidation'] : [])], excluded_categories: ['*'] });
  await run();
  const wallMs = Date.now() - t0; const cpu = cpuSnapshot(); const m1 = await cdpMetrics();
  let trace = null; if (traceName) trace = await contentTracing.stopRecording(path.join(out, traceName + '.json'));
  const r = await js('window.__p.stop()');
  // compress the cursor sequence: kind:imageHash × count @ ms since phase start
  const seq = []; for (const c of cursorLog) { const k = c.type + (c.h ? ':' + c.h : ''); if (!seq.length || seq.at(-1).k !== k) seq.push({ k, n: 1, t: c.t }); else seq.at(-1).n++; }
  const res = { label, wallMs, cpu, cdp: cdpDelta(m0, m1), frames: r.frames, gap: stats(r.gaps), gapsOver25: r.gaps.filter((g) => g > 25).length, moves: r.moves, downs: r.downs, wheels: r.wheels, scrolls: r.scrolls, keys: r.keys, downPaint: stats(r.downPaint), keyPaint: stats(r.keyPaint), longtasks: r.longtasks,
    cursorChanges: cursorLog.length, cursorSeq: seq.slice(0, 40).map((s) => `${s.k}x${s.n}@${s.t}`), slowEvents: r.evts.slice(0, 12), trace };
  log('measure', res); return res;
}

// ---------------------------------------------------------------------------
// FRAME DIAGNOSTIC (--frames): samples of the composited frames, measured
// over the canvas host and the whole window. A "blank" frame is one whose
// canvas content fraction collapses against its neighbours (checkerboard /
// unpainted tiles / a layer swap that missed a frame); a "flash" is a whole-
// window luminance jump. Both are what a user calls flicker.
// ---------------------------------------------------------------------------
const wantFrames = process.env.PROBE_FRAMES === '1';
const { nativeImage } = require('electron');
// Frames come from CDP Page.startScreencast (small JPEG samples; frames can be missed —
// beginFrameSubscription copies full bitmaps and starves itself to ~30 fps).
function frameStats(image, region, scale) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap(); // BGRA
  const sx = scale.x, sy = scale.y;
  const stat = (x0, y0, x1, y1, step) => {
    let n = 0, lumSum = 0, content = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, cx = 0, cy = 0;
    for (let y = Math.max(0, Math.floor(y0 * sy)); y < Math.min(height, Math.floor(y1 * sy)); y += step) {
      for (let x = Math.max(0, Math.floor(x0 * sx)); x < Math.min(width, Math.floor(x1 * sx)); x += step) {
        const i = (y * width + x) * 4;
        const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
        lumSum += lum; n++;
        if (Math.abs(lum - region.bgLum) > 18) { content++; cx += x; cy += y; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
    }
    return { n, mean: n ? lumSum / n : 0, content: n ? content / n : 0, cx: content ? cx / content / sx : null, cy: content ? cy / content / sy : null, w: maxX >= 0 ? (maxX - minX) / sx : 0, h: maxY >= 0 ? (maxY - minY) / sy : 0 };
  };
  const c = stat(region.l, region.t, region.r, region.b, 1);
  const w = stat(0, 0, region.winW, region.winH, 2);
  return { t: Date.now(), canvasContent: +c.content.toFixed(4), canvasMean: +c.mean.toFixed(1), cx: c.cx && +c.cx.toFixed(1), cy: c.cy && +c.cy.toFixed(1), bw: +c.w.toFixed(0), bh: +c.h.toFixed(0), winMean: +w.mean.toFixed(1) };
}
function analyzeFrames(frames, requireContent = false) {
  if (frames.length < 6) return { frames: frames.length, note: 'too few frames' };
  const contents = frames.map((f) => f.canvasContent);
  const med = [...contents].sort((a, b) => a - b)[Math.floor(contents.length / 2)];
  // Deep zoom is anchored inside the white figure throughout, even at 5%.
  // Reuse the planted-failure-tested oracle: adjacent-frame comparisons alone
  // miss consecutive, first/last, and entirely blank captures.
  const blanks = requireContent ? analyzeMarkerFrames(frames.map(f => ({ ...f, dark: f.canvasContent }))).blanks : [];
  const flashes = [], reversals = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const f = frames[i], p = frames[i - 1], n = frames[i + 1];
    // a one-frame collapse of canvas content between two frames that both have it
    if (!requireContent && f.canvasContent < Math.min(p.canvasContent, n.canvasContent) * 0.4 && p.canvasContent > med * 0.3) blanks.push({ i, t: f.t - frames[0].t, content: f.canvasContent, prev: p.canvasContent, next: n.canvasContent });
    // a one-frame whole-window luminance flash
    if (Math.abs(f.winMean - p.winMean) > 20 && Math.abs(f.winMean - n.winMean) > 20 && Math.sign(f.winMean - p.winMean) === Math.sign(f.winMean - n.winMean)) flashes.push({ i, t: f.t - frames[0].t, win: f.winMean, prev: p.winMean, next: n.winMean });
    // a one-frame reversal of the content's motion (a stale transform shown for a frame)
    if (f.cy != null && p.cy != null && n.cy != null) {
      const d1 = f.cy - p.cy, d2 = n.cy - f.cy;
      if (Math.abs(d1) > 6 && Math.abs(d2) > 6 && Math.sign(d1) !== Math.sign(d2) && Math.abs(d1 + d2) < Math.max(Math.abs(d1), Math.abs(d2)) * 0.5) reversals.push({ i, t: f.t - frames[0].t, cy: [p.cy, f.cy, n.cy] });
    }
    if (f.bh && p.bh && n.bh) {
      const d1 = f.bh - p.bh, d2 = n.bh - f.bh;
      if (Math.abs(d1) > 8 && Math.abs(d2) > 8 && Math.sign(d1) !== Math.sign(d2) && Math.abs(d1 + d2) < Math.max(Math.abs(d1), Math.abs(d2)) * 0.5) reversals.push({ i, t: f.t - frames[0].t, bh: [p.bh, f.bh, n.bh] });
    }
  }
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t);
  return { frames: frames.length, medianContent: +med.toFixed(3), minContent: +Math.min(...contents).toFixed(3), blankFrames: blanks.slice(0, 12), flashFrames: flashes.slice(0, 12), reversals: reversals.slice(0, 12), frameGap: stats(gaps) };
}
async function measureFrames(label, region, run, traceName) {
  const viewport = { width: region.winW, height: region.winH, dpr: await js('devicePixelRatio') };
  if (!wantFrames || !cdpOk) return measure(label, run, traceName);
  // Renderer-side truth per animation frame: the scene's computed transform, the
  // baked <g> scale and the live animation count — to tell an app-side reversal
  // from a compositor-side one. This is diagnostic, not a completeness proof.
  await js(`(()=>{window.__xf={on:true,rows:[]};const sc=document.querySelector('${canvasModeRoot} .scene');const g=document.querySelector('${canvasModeRoot} .scene-svg > g');const loop=()=>{if(!window.__xf.on)return;const m=getComputedStyle(sc).transform;const mm=/matrix\\(([-\\d.e]+), [-\\d.e]+, [-\\d.e]+, [-\\d.e]+, ([-\\d.e]+), ([-\\d.e]+)\\)/.exec(m);window.__xf.rows.push({t:Math.round(performance.timeOrigin+performance.now()),a:mm?+(+mm[1]).toFixed(4):null,e:mm?Math.round(+mm[2]):null,f:mm?Math.round(+mm[3]):null,g:+(/scale\\(([-\\d.e]+)/.exec(g.getAttribute('transform')||'')||[])[1]||null,anims:document.getAnimations().length,style:sc.style.transform.slice(0,60),proxyLive:!!document.querySelector('${canvasModeRoot} .zoom-proxy.live'),proxyTransform:document.querySelector('${canvasModeRoot} .zoom-proxy.live')?getComputedStyle(document.querySelector('${canvasModeRoot} .zoom-proxy.live')).transform:null});requestAnimationFrame(loop)};requestAnimationFrame(loop)})()`);
  const frames = [];
  const frameDir = path.join(out, `frames-${label.replace(/[^a-z0-9]+/gi, '-')}`);
  if (process.env.PROBE_FRAMES_DUMP === '1') fs.mkdirSync(frameDir, { recursive: true });
  const dbg = win.webContents.debugger;
  const maxW = 480;
  const scale = { x: maxW / region.winW, y: maxW / region.winW };
  const onMsg = (_e, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    try { const bytes = Buffer.from(params.data, 'base64'); const img = nativeImage.createFromBuffer(bytes); const sz = img.getSize(); frames.push(frameStats(img, region, { x: sz.width / region.winW, y: sz.height / region.winH })); if (process.env.PROBE_FRAMES_DUMP === '1') fs.writeFileSync(path.join(frameDir, `${String(frames.length - 1).padStart(4, '0')}.jpg`), bytes); } catch {}
    dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  };
  dbg.on('message', onMsg);
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: maxW, maxHeight: Math.round(maxW * region.winH / region.winW), everyNthFrame: 1 });
  const res = await measure(label, run, traceName);
  await dbg.sendCommand('Page.stopScreencast').catch(() => {});
  dbg.removeListener('message', onMsg);
  void scale;
  res.framesOracle = analyzeFrames(frames, label.endsWith(':zoomDeep'));
  res.framesOracle.viewport = viewport; // after native maximize/monitor transitions settled
  const xf = await js('(()=>{window.__xf.on=false;return window.__xf.rows})()');
  // app-side reversals: the computed scale (a) or pan (e,f) reversing direction between consecutive rAFs while a gesture runs
  let appReversals = 0; for (let i = 2; i < xf.length; i++) { const d1 = xf[i - 1].a - xf[i - 2].a, d2 = xf[i].a - xf[i - 1].a; if (Math.abs(d1) > 1e-4 && Math.abs(d2) > 1e-4 && Math.sign(d1) !== Math.sign(d2)) appReversals++; }
  res.framesOracle.appScaleReversals = appReversals;
  res.framesOracle.gFolds = xf.filter((r, i) => i && r.g !== xf[i - 1].g).map((r) => ({ t: r.t - xf[0].t, g: r.g, a: r.a }));
  log('frames', { label, ...res.framesOracle });
  if (process.env.PROBE_FRAMES_DUMP === '1') { fs.writeFileSync(path.join(out, `frames-${label.replace(/[^a-z0-9]+/gi, '-')}.json`), JSON.stringify(frames)); fs.writeFileSync(path.join(out, `xform-${label.replace(/[^a-z0-9]+/gi, '-')}.json`), JSON.stringify(xf)); }
  return res;
}

async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], 'window');
  win.setSize(1600, 1000); win.setAlwaysOnTop(true); win.show(); win.focus();
  if (process.env.PROBE_MAXIMIZE === '1') { win.maximize(); await wait(() => win.isMaximized(), 'maximized native window'); }
  win.webContents.setBackgroundThrottling(false); // diagnostic run — an occluded window must still tick
  win.webContents.on('cursor-changed', (_e, type, image) => { let h = null; try { if (image && !image.isEmpty()) h = crypto.createHash('md5').update(image.toBitmap()).digest('hex').slice(0, 6); } catch {} cursorLog.push({ t: Date.now() - phaseT0, type, h }); });
  log('boot', { windows: BrowserWindow.getAllWindows().length, title: win.getTitle(), url: win.webContents.getURL().slice(0, 60), argv: process.argv.filter((a) => a.startsWith('--')), chromiumSwitches: ['disable-features', 'enable-features', 'use-vulkan', 'use-angle'].map((k) => k + '=' + (app.commandLine.hasSwitch(k) ? app.commandLine.getSwitchValue(k) : '<unset>')) });
  await wait(() => js("!!document.querySelector('button[aria-label=Figure]')"), 'shell');
  try { win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Performance.enable'); cdpOk = true; } catch (e) { log('cdp', { err: String(e) }); }
  log('gpu', app.getGPUFeatureStatus());
  fs.writeFileSync(path.join(out, 'runtime.json'), JSON.stringify({ versions: process.versions, gpu: app.getGPUFeatureStatus(), viewport: await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'), switches: process.argv.filter(a => a.startsWith('--')) }, null, 2));
  await js(INSTR);
  if (surface === 'paper' || surface === 'both') await paperPhases();
  if (surface === 'figure' || surface === 'both') await figurePhases();
  if (surface === 'all') { await paperPhases(); await figurePhases(); }
  if (surface === 'slide' || surface === 'all') await figurePhases('slide');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
  log('done', { out });
  app.exit(0);
}
const results = {};

// ---------------------------------------------------------------------------
// PAPER: the manuscript the project opens with — scroll it, type into it.
// ---------------------------------------------------------------------------
async function paperPhases() {
  await js("document.querySelector('button[aria-label=Paper]')?.click()");
  await wait(() => js("!!document.querySelector('.cm-editor .cm-content')"), 'paper editor');
  // let embeds (inline figure renders, slide players) mount and the lazy work settle
  let last = -1; for (let i = 0; i < 40; i++) { const n = await js("document.getElementsByTagName('*').length"); if (n === last) break; last = n; await sleep(500); }
  const dom = await js(`({total:document.getElementsByTagName('*').length,cmLines:document.querySelectorAll('.cm-line').length,embeds:document.querySelectorAll('.flux-embed-art').length,embedNodes:[...document.querySelectorAll('.flux-embed-art')].reduce((a,n)=>a+n.getElementsByTagName('*').length,0),slideEmbeds:document.querySelectorAll('.flux-slide-art').length,slideNodes:[...document.querySelectorAll('.flux-slide-art')].reduce((a,n)=>a+n.getElementsByTagName('*').length,0),docLines:window.__fluxView?.state?.doc?.lines??null,scrollH:document.querySelector('.cm-scroller')?.scrollHeight,clientH:document.querySelector('.cm-scroller')?.clientHeight})`);
  log('paperDom', dom);
  const sc = await js("(()=>{const r=document.querySelector('.cm-scroller').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  const R = results.paper = {};
  const tr = (phase) => (doTrace ? `trace-paper-${phase}` : null);
  await js("document.querySelector('.cm-scroller').scrollTop=0"); await sleep(300);
  // 1. trackpad scroll down then up (~5 px/ms)
  if (wantPhase('scrollV')) R.scrollV = await measure('paper:scrollV', async () => { for (let i = 0; i < 60; i++) { wheel(sc.x, sc.y, 0, 40); await sleep(8); } await sleep(200); for (let i = 0; i < 60; i++) { wheel(sc.x, sc.y, 0, -40); await sleep(8); } await sleep(300); }, tr('scrollV'));
  // 2. mouse-wheel notches
  if (wantPhase('scrollNotch')) R.scrollNotch = await measure('paper:scrollNotch', async () => { for (let i = 0; i < 12; i++) { wheel(sc.x, sc.y, 0, 120); await sleep(50); } await sleep(200); for (let i = 0; i < 12; i++) { wheel(sc.x, sc.y, 0, -120); await sleep(50); } await sleep(300); }, tr('scrollNotch'));
  // 3. typing at the end of a long prose line
  if (wantPhase('typing')) {
    const pt = await js("(()=>{const l=[...document.querySelectorAll('.cm-line')].find(n=>n.textContent.length>80&&!n.querySelector('.flux-embed'));if(!l)return null;l.scrollIntoView({block:'center'});const r=l.getBoundingClientRect();return {x:Math.round(r.right-6),y:Math.round(r.y+r.height/2)}})()");
    if (pt) {
      await sleep(200); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x: pt.x, y: pt.y }); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x: pt.x, y: pt.y }); await sleep(300);
      R.typing = await measure('paper:typing', async () => { const text = ' the quick brown fox jumps'; for (const ch of text) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch === ' ' ? 'Space' : ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch === ' ' ? 'Space' : ch }); await sleep(60); } await sleep(400); }, tr('typing'));
      for (let i = 0; i < 4; i++) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] }); await sleep(80); }
    } else log('typing', { skipped: 'no long prose line' });
  }
}

// ---------------------------------------------------------------------------
// FIGURE: the first figure of the project.
// ---------------------------------------------------------------------------
async function figurePhases(mode = 'figure') {
  const modeRoot = canvasModeRoot = mode === 'slide' ? '.slide-mode' : '.figure-mode';
  await js(`(()=>{const b=[...document.querySelectorAll('button[aria-label]')].find(b=>/^${mode === 'slide' ? 'Slides?' : 'Figure'}$/i.test(b.getAttribute('aria-label')));if(!b)throw Error('no mode button');b.click()})()`);
  await wait(() => js(`(()=>{const n=document.querySelector('${modeRoot} .canvas-host');return n&&!n.closest('.mc.hidden')})()`), mode + ' mode');
  if (mode === 'figure') { await wait(() => js("!!document.querySelector('.figrow .item')"), 'figure rows'); await js("document.querySelector('.figrow .item').click()"); }
  await wait(() => js(`document.querySelectorAll('${modeRoot} [data-editor-element-id]').length>0`), 'elements mounted');
  let last = -1; for (let i = 0; i < 60; i++) { const n = await js(`document.querySelectorAll('${modeRoot} [data-editor-element-id] svg *').length`); if (n === last) break; last = n; await sleep(400); } // lazy parse settles
  log('dom', await js(`({mode:'${mode}',elements:document.querySelectorAll('${modeRoot} [data-editor-element-id]').length,plotNodes:document.querySelectorAll('${modeRoot} [data-editor-element-id] svg *').length,total:document.getElementsByTagName('*').length,dpr:devicePixelRatio,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches})`));
  const geo = await js(`(()=>{const root=document.querySelector('${modeRoot}');const h=document.querySelector('${modeRoot} .canvas-host').getBoundingClientRect();
    const plots=[...root.querySelectorAll('[data-editor-element-id]')].filter(n=>n.querySelector('svg')).map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.editorElementId,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}}).filter(p=>p.w>20&&p.h>20&&p.x>h.left+40&&p.x<h.right-40&&p.y>h.top+40&&p.y<h.bottom-40);
    let empty=null;for(let y=h.bottom-30;y>h.top+40&&!empty;y-=20){for(let x=h.right-30;x>h.left+40;x-=20){const el=document.elementFromPoint(x,y);if(el&&el.closest('.canvas-host')&&!el.closest('[data-editor-element-id],.figure-titlebar,.ruler,.overlay-svg')){empty={x,y};break}}}
    return {host:{l:Math.round(h.left),t:Math.round(h.top),r:Math.round(h.right),b:Math.round(h.bottom)},plots:plots.slice(0,4),nplots:plots.length,empty}})()`);
  log('geo', geo);
  log('selection', await js(`(()=>{const s=document.getSelection();const a=s&&s.anchorNode;return {ranges:s?s.rangeCount:0,anchor:a?(a.nodeName+(a.parentElement?'<'+a.parentElement.className.toString().slice(0,30):'')):null,inCanvas:!!(a&&document.querySelector('${modeRoot} .canvas-host')?.contains(a))}})()`));
  if (!geo.plots.length || !geo.empty) throw Error('need at least one on-screen plot and an empty canvas spot');
  const bg = await js(`(()=>{const h=document.querySelector('${modeRoot} .canvas-host');const c=getComputedStyle(h).backgroundColor.match(/[\\d.]+/g)||[240,240,240];return {win:{w:innerWidth,h:innerHeight},lum:0.114*+c[2]+0.587*+c[1]+0.299*+c[0]}})()`);
  const region = { l: geo.host.l + 30, t: geo.host.t + 30, r: geo.host.r - 30, b: geo.host.b - 30, winW: bg.win.w, winH: bg.win.h, bgLum: bg.lum };
  log('frameRegion', region);
  { const b = win.getContentBounds(); const g = `${b.x + region.l},${b.y + region.t} ${region.r - region.l}x${region.b - region.t}`; log('screenRegion', { g, bgLum: region.bgLum, bounds: b }); }
  log('animations', await js("document.getAnimations().map(a=>({target:(a.effect&&a.effect.target&&(a.effect.target.className&&a.effect.target.className.baseVal||a.effect.target.className||a.effect.target.tagName)+'').toString().slice(0,40),props:Object.keys((a.effect&&a.effect.getKeyframes&&a.effect.getKeyframes()[0])||{}).filter(k=>!/offset|computedOffset|easing|composite/.test(k)),state:a.playState}))"));
  const A = geo.plots[0], B = geo.plots[Math.min(1, geo.plots.length - 1)];
  results[mode] = {};
  for (const sc of scenarios) {
    await setScenario(sc);
    mouse({ type: 'mouseMove', x: geo.empty.x, y: geo.empty.y }); await sleep(400);
    const R = results[mode][sc] = {};
    const tr = (phase) => (doTrace ? `trace-${mode}-${sc}-${phase}` : null);
    // 1. sweep across the figure through plots at 125 Hz
    if (wantPhase('sweep')) R.sweep = await measure(`${mode}:${sc}:sweep`, async () => { const y = Math.round((geo.host.t + geo.host.b) / 2), x0 = geo.host.l + 60, x1 = geo.host.r - 60, N = 120; for (let i = 0; i <= N; i++) { mouse({ type: 'mouseMove', x: Math.round(x0 + (x1 - x0) * i / N), y: y + Math.round(Math.sin(i / 9) * 120) }); await sleep(8); } await sleep(300); }, tr('sweep'));
    // 2. hover boundary flips plot ↔ empty
    if (wantPhase('hover')) R.hover = await measure(`${mode}:${sc}:hover`, async () => { for (let i = 0; i < 40; i++) { const p = i % 2 ? A : geo.empty; mouse({ type: 'mouseMove', x: p.x, y: p.y }); await sleep(30); } await sleep(300); }, tr('hover'));
    // 3. rapid clicks on empty canvas
    if (wantPhase('clicksEmpty')) R.clicksEmpty = await measure(`${mode}:${sc}:clicksEmpty`, async () => { mouse({ type: 'mouseMove', x: geo.empty.x, y: geo.empty.y }); await sleep(50); for (let i = 0; i < 12; i++) { await click(geo.empty.x + (i % 3) * 4, geo.empty.y, 40); await sleep(60); } await sleep(500); }, tr('clicksEmpty'));
    // 4. rapid clicks alternating two plots (selection changes)
    if (wantPhase('clicksPlot')) R.clicksPlot = await measure(`${mode}:${sc}:clicksPlot`, async () => { for (let i = 0; i < 12; i++) { const p = i % 2 ? A : B; mouse({ type: 'mouseMove', x: p.x, y: p.y }); await sleep(10); await click(p.x, p.y, 40); await sleep(60); } await sleep(500); }, tr('clicksPlot'));
    // 5. press-drag plot A (real move gesture), then Ctrl+Z
    if (wantPhase('dragPlot')) R.dragPlot = await measure(`${mode}:${sc}:dragPlot`, async () => { mouse({ type: 'mouseMove', x: A.x, y: A.y }); await sleep(150); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x: A.x, y: A.y }); await sleep(150); for (let i = 1; i <= 8; i++) { mouse({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: A.x + i * 5, y: A.y + i * 3 }); await sleep(40); } await sleep(150); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x: A.x + 40, y: A.y + 24 }); await sleep(300); }, tr('dragPlot'));
    if (wantPhase('dragPlot')) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] }); await sleep(250); }
    // 5d. three idle seconds after an edit + undo: whatever lands here (autosave, journal, deferred work) is a hitch the user gets for free
    if (wantPhase('idle')) R.idle = await measure(`${mode}:${sc}:idle`, async () => { await sleep(3000); }, tr('idle'));
    await click(geo.empty.x, geo.empty.y, 10); await sleep(300);
    const cx = Math.round((geo.host.l + geo.host.r) / 2), cy = Math.round((geo.host.t + geo.host.b) / 2);
    mouse({ type: 'mouseMove', x: cx, y: cy }); await sleep(200);
    // 5b. small trackpad pan that stays inside the active figure (no cull change): the steady-state per-frame pan cost
    if (wantPhase('panSmall')) R.panSmall = await measure(`${mode}:${sc}:panSmall`, async () => { for (let k = 0; k < 3; k++) { for (let i = 0; i < 12; i++) { wheel(cx, cy, 0, 25); await sleep(8); } await sleep(120); for (let i = 0; i < 12; i++) { wheel(cx, cy, 0, -25); await sleep(8); } await sleep(120); } await sleep(300); }, tr('panSmall'));
    // 5c. the same small pan with the pointer over EMPTY canvas (no hover churn under a stationary pointer)
    if (wantPhase('panSmallEmpty')) { mouse({ type: 'mouseMove', x: geo.empty.x, y: geo.empty.y }); await sleep(200); R.panSmallEmpty = await measure(`${mode}:${sc}:panSmallEmpty`, async () => { for (let k = 0; k < 3; k++) { for (let i = 0; i < 12; i++) { wheel(geo.empty.x, geo.empty.y, 0, 25); await sleep(8); } await sleep(120); for (let i = 0; i < 12; i++) { wheel(geo.empty.x, geo.empty.y, 0, -25); await sleep(8); } await sleep(120); } await sleep(300); }, tr('panSmallEmpty')); mouse({ type: 'mouseMove', x: cx, y: cy }); await sleep(200); }
    // 6. trackpad pan: down 60×40px then back, then right/left
    if (wantPhase('wheelV')) R.wheelV = await measure(`${mode}:${sc}:wheelV`, async () => { for (let i = 0; i < 60; i++) { wheel(cx, cy, 0, 40); await sleep(8); } await sleep(250); for (let i = 0; i < 60; i++) { wheel(cx, cy, 0, -40); await sleep(8); } await sleep(400); }, tr('wheelV'));
    if (wantPhase('wheelH')) R.wheelH = await measure(`${mode}:${sc}:wheelH`, async () => { for (let i = 0; i < 60; i++) { wheel(cx, cy, 40, 0); await sleep(8); } await sleep(250); for (let i = 0; i < 60; i++) { wheel(cx, cy, -40, 0); await sleep(8); } await sleep(400); }, tr('wheelH'));
    // 7. mouse-wheel notches (120 px, 50 ms apart)
    if (wantPhase('wheelNotch')) R.wheelNotch = await measure(`${mode}:${sc}:wheelNotch`, async () => { for (let i = 0; i < 12; i++) { wheel(cx, cy, 0, 120); await sleep(50); } await sleep(250); for (let i = 0; i < 12; i++) { wheel(cx, cy, 0, -120); await sleep(50); } await sleep(400); }, tr('wheelNotch'));
    // 9. FAST zoom (no pauses: one fold at the end) and zoom in BURSTS (folds + cool-downs between) — the flicker hunt
    // Electron wheel signs are opposite DOM wheel signs: POSITIVE zooms IN.
    // The older phases mostly ran below fit zoom and never exercised a deep
    // baked raster followed by a rapid zoom-out, the owner's reported failure.
    if (wantPhase('zoomDeep')) R.zoomDeep = await measureFrames(`${mode}:${sc}:zoomDeep`, region, async () => {
      ctrlDown();
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 0; i < 36; i++) { wheel(cx, cy, 0, 120, ['control']); await sleep(8); }
        await wait(() => js(`Number(/scale\\(([-\\d.e]+)/.exec(document.querySelector('${modeRoot} .scene-svg > g').getAttribute('transform'))[1]) === 16`), 'deep zoom reached and folded');
        await sleep(250); // include a cold high-resolution raster before revealing the full scene
        for (let i = 0; i < 36; i++) { wheel(cx, cy, 0, -120, ['control']); await sleep(8); }
        await sleep(350);
      }
      ctrlUp(); await sleep(600);
    }, tr('zoomDeep'));
    if (wantPhase('zoomFast')) R.zoomFast = await measureFrames(`${mode}:${sc}:zoomFast`, region, async () => { ctrlDown(); for (let i = 0; i < 30; i++) { wheel(cx, cy, 0, -50, ['control']); await sleep(16); } for (let i = 0; i < 30; i++) { wheel(cx, cy, 0, 50, ['control']); await sleep(16); } ctrlUp(); await sleep(600); }, tr('zoomFast'));
    if (wantPhase('zoomBursts')) R.zoomBursts = await measureFrames(`${mode}:${sc}:zoomBursts`, region, async () => { ctrlDown(); for (let b = 0; b < 4; b++) { for (let i = 0; i < 8; i++) { wheel(cx, cy, 0, -60, ['control']); await sleep(16); } await sleep(320); } for (let b = 0; b < 4; b++) { for (let i = 0; i < 8; i++) { wheel(cx, cy, 0, 60, ['control']); await sleep(16); } await sleep(320); } ctrlUp(); await sleep(600); }, tr('zoomBursts'));
    // 10. FAST pan and pan in bursts (cool-downs → demotion + re-cull between)
    if (wantPhase('panFast')) R.panFast = await measureFrames(`${mode}:${sc}:panFast`, region, async () => { for (let i = 0; i < 40; i++) { wheel(cx, cy, 0, 80); await sleep(8); } for (let i = 0; i < 40; i++) { wheel(cx, cy, 0, -80); await sleep(8); } await sleep(600); }, tr('panFast'));
    if (wantPhase('panBursts')) R.panBursts = await measureFrames(`${mode}:${sc}:panBursts`, region, async () => { for (let b = 0; b < 4; b++) { for (let i = 0; i < 10; i++) { wheel(cx, cy, 0, 60); await sleep(8); } await sleep(320); } for (let b = 0; b < 4; b++) { for (let i = 0; i < 10; i++) { wheel(cx, cy, 0, -60); await sleep(8); } await sleep(320); } await sleep(600); }, tr('panBursts'));
    // 8. ctrl-wheel zoom in then out (residual scale mid-burst, one fold at settle)
    if (wantPhase('zoom')) R.zoom = await measure(`${mode}:${sc}:zoom`, async () => { ctrlDown(); for (let i = 0; i < 10; i++) { wheel(cx, cy, 0, -60, ['control']); await sleep(40); } await sleep(500); for (let i = 0; i < 10; i++) { wheel(cx, cy, 0, 60, ['control']); await sleep(40); } ctrlUp(); await sleep(500); }, tr('zoom'));
  }
}
main().catch((e) => { console.error('PROBE FAIL ' + (e && e.stack || e)); app.exit(1); });
