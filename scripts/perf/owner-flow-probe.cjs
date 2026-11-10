#!/usr/bin/env node
// OWNER-FLOW probe — "is the figure editor instant on THIS project?"
//
// The input probe (input-probe.cjs) measures gestures on a settled canvas. This one measures what
// that leaves out, on a real project and the production bundle with real Electron input:
//   1. OPEN: every long task from navigation to a quiet canvas, with an ipcMain ledger (calls, handler
//      ms, bytes per channel), renderer heap, process memory and every toast that appeared.
//   2. Each gesture AND THE SETTLE AFTER IT (default 3.5 s): the owner's lag is "just after a settle
//      after zooming/panning", which is deferred work (picture requests, proxy captures, autosave),
//      not the gesture.
//
//   node scripts/perf/owner-flow-probe.cjs <projectDir> [--figure=<n|id>] [--phases=a,b] [--out=dir]
//        [--ozone=headless|x11|wayland] [--profile=open,zoomIn,…] [--trace=open,…] [--settle=3500]
//        [--shots] [--rounds=2] [--in-place]
//   phases: hover, pan, zoomIn, panZoomed, zoomOut, zoomDeep (+panDeep, zoomDeepOut), select, drag, nudge, idle, switchFigure,
//           leave (+return: click another figure, sample this one's picture, click back)
//
// The project is COPIED to a scratch dir and HOME/XDG are isolated; nothing of the user's is touched.
// A CPU profile is symbolicated by scripts/perf/profile-summary.mjs through dist's hidden sourcemaps.
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const repo = path.resolve(__dirname, '..', '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const src = args.find((a) => !a.startsWith('--'));
  if (!src || !fs.existsSync(path.join(src, 'project.json'))) { console.error('usage: owner-flow-probe.cjs <projectDir> [--figure=n] [--phases=a,b] [--out=dir]'); process.exit(2); }
  const out = path.resolve(opt('out', path.join(repo, 'test-results', `owner-flow-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-owner-flow-'));
  // --in-place: open <projectDir> itself (a DISPOSABLE copy you made) so state the app writes — source
  // proofs, picture and display caches, applied source updates — is there for the next run: the second open.
  const inPlace = args.includes('--in-place');
  const project = inPlace ? path.resolve(src) : path.join(scratch, 'project');
  const t0 = Date.now();
  if (!inPlace) fs.cpSync(path.resolve(src), project, { recursive: true, filter: (p) => !/[\\/]\.meta[\\/](locks|live)([\\/]|$)/.test(p) });
  for (const d of ['home', 'xdg']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'), APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1',
    OFP_PROJECT: project, OFP_OUT: out, OFP_FIGURE: opt('figure', '1'), OFP_PHASES: opt('phases', ''), OFP_PROFILE: opt('profile', ''), OFP_TRACE: opt('trace', ''),
    OFP_SETTLE: opt('settle', '3500'), OFP_SHOTS: args.includes('--shots') ? '1' : '0', OFP_ROUNDS: opt('rounds', '1'), OFP_WIDTH: opt('width', '1600'), OFP_HEIGHT: opt('height', '1000'), OFP_ZOOM_NOTCHES: opt('notches', '8') };
  delete env.VITE_DEV_SERVER_URL; delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = [__filename, project];
  if (process.platform === 'linux') electronArgs.push('--no-sandbox', `--ozone-platform=${opt('ozone', 'headless')}`);
  const child = spawn(require('electron'), electronArgs, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`OFP launch pid=${child.pid} copyMs=${Date.now() - t0} out=${out}`);
  const timer = setTimeout(() => child.kill('SIGKILL'), +opt('timeout', '600000'));
  let stderr = '';
  child.stdout.on('data', (b) => { for (const line of String(b).split('\n')) if (line.startsWith('OFP ')) console.log(line); });
  child.stderr.on('data', (b) => { stderr += b; });
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.writeFileSync(path.join(out, 'stderr.log'), stderr);
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(`owner-flow-probe: exit=${code ?? 1} out=${out}`);
    process.exit(code ?? 1);
  });
  return;
}

// ---------------------------------------------------------------------------------------------
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
const { app, BrowserWindow, contentTracing, ipcMain } = require('electron');
const out = process.env.OFP_OUT;
const list = (s) => (s || '').split(',').filter(Boolean);
const phaseFilter = list(process.env.OFP_PHASES), profiled = list(process.env.OFP_PROFILE), traced = list(process.env.OFP_TRACE);
const wantPhase = (n) => !phaseFilter.length || phaseFilter.includes(n);
const SETTLE = +process.env.OFP_SETTLE, NOTCHES = +process.env.OFP_ZOOM_NOTCHES;
const log = (k, v) => console.log('OFP ' + k + ' ' + JSON.stringify(v));

// ipcMain ledger. Sizes are counted without serializing: strings by length, views by byteLength,
// arrays/objects one level deep — a 30 MB manifest must not cost a second stringify to be measured.
const ledger = new Map();
const size = (v, depth = 0) => {
  if (v == null) return 0; if (typeof v === 'string') return v.length; if (v.byteLength != null) return v.byteLength;
  if (typeof v !== 'object' || depth > 2) return 8;
  let n = 0; for (const k of Object.keys(v)) n += size(v[k], depth + 1); return n;
};
const record = (channel, ms, a, r) => { const e = ledger.get(channel) || { n: 0, ms: 0, maxMs: 0, argB: 0, resB: 0, maxResB: 0, maxArgB: 0 }; e.n++; e.ms += ms; e.maxMs = Math.max(e.maxMs, ms); e.argB += a; e.resB += r; e.maxResB = Math.max(e.maxResB, r); e.maxArgB = Math.max(e.maxArgB, a); ledger.set(channel, e); };
{ const handle = ipcMain.handle.bind(ipcMain);
  // Per-path rows for the fs channels: WHICH file was read 40 times is the finding, not the total.
  const paths = new Map();
  const pathRow = (channel, file, bytes) => { const k = channel + ' ' + String(file).replace(process.env.OFP_PROJECT, '').replace(/^.*\/(home|xdg)\//, '~/'); const e = paths.get(k) || { n: 0, bytes: 0 }; e.n++; e.bytes += bytes; paths.set(k, e); };
  global.__ofpTakePaths = () => { const rows = [...paths].map(([k, v]) => ({ k, n: v.n, MB: +(v.bytes / 1048576).toFixed(2) })); paths.clear(); return { byBytes: rows.slice().sort((a, b) => b.MB - a.MB).slice(0, 25), byCalls: rows.slice().sort((a, b) => b.n - a.n).slice(0, 15), files: rows.length, repeatedMB: +rows.reduce((a, r) => a + (r.n > 1 ? r.MB * (r.n - 1) / r.n : 0), 0).toFixed(1) }; };
  // Calls that move ≥ 1 MB, in order, on the main process clock (ms since this process started).
  const big = []; global.__ofpTakeBig = () => big.splice(0);
  ipcMain.handle = (channel, fn) => handle(channel, async (event, ...args) => { const t = performance.now(); let r; try { r = await fn(event, ...args); return r; } finally { const a = size(args), b = size(r); record(channel, performance.now() - t, a, b); if (/^fs:(read|write)/.test(channel) && typeof args[0] === 'string') pathRow(channel, args[0], a + b); if (a + b >= 1048576) big.push({ t: Math.round(t), ms: Math.round(performance.now() - t), ch: channel, MB: +((a + b) / 1048576).toFixed(1), path: typeof args[0] === 'string' ? args[0].replace(process.env.OFP_PROJECT, '') : undefined }); } }); }
const takeLedger = () => { const o = Object.fromEntries([...ledger].sort((a, b) => b[1].resB + b[1].argB - a[1].resB - a[1].argB).map(([k, v]) => [k, { n: v.n, ms: +v.ms.toFixed(1), maxMs: +v.maxMs.toFixed(1), argMB: +(v.argB / 1048576).toFixed(2), resMB: +(v.resB / 1048576).toFixed(2), maxResMB: +(v.maxResB / 1048576).toFixed(2), maxArgMB: +(v.maxArgB / 1048576).toFixed(2) }])); ledger.clear(); return o; };

require(path.join(repo, 'electron/main.cjs'));

let win, cdp = false;
const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fn(); if (r) return r; } catch {} await sleep(50); } throw Error('Timeout: ' + label); }
const mouse = (ev) => win.webContents.sendInputEvent(ev);
const wheel = (x, y, dx, dy, modifiers = []) => mouse({ type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, canScroll: true, modifiers });
const key = (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };
const memory = () => { const o = {}; for (const p of app.getAppMetrics()) { const k = p.type === 'Tab' ? 'renderer' : p.type; o[k] = Math.round((o[k] || 0) + p.memory.workingSetSize / 1024); } return o; };

// Renderer instrumentation. Long tasks are observed BUFFERED so the tasks of the load itself are kept.
const INSTR = `(()=>{if(window.__o)return 'ok';const o=window.__o={tasks:[],frames:[],on:false,raf:0,downPaint:[],keyPaint:[],wheelPaint:[],toasts:[],marks:[]};
try{new PerformanceObserver(l=>{for(const e of l.getEntries())o.tasks.push({s:Math.round(e.startTime),d:Math.round(e.duration)})}).observe({type:'longtask',buffered:true})}catch{}
const paint=(arr,e)=>{const t0=e.timeStamp;requestAnimationFrame(()=>requestAnimationFrame(()=>arr.push(+(performance.now()-t0).toFixed(1))))};
window.addEventListener('pointerdown',e=>paint(o.downPaint,e),true);window.addEventListener('keydown',e=>paint(o.keyPaint,e),true);
window.addEventListener('wheel',e=>paint(o.wheelPaint,e),{capture:true,passive:true});
const seen=new WeakSet();new MutationObserver(()=>{for(const n of document.querySelectorAll('.toasts .toast'))if(!seen.has(n)){seen.add(n);o.toasts.push({t:Math.round(performance.now()),text:n.textContent.replace(/\\s+/g,' ').trim().slice(0,400)})}}).observe(document.body,{childList:true,subtree:true});
o.start=()=>{o.t0=performance.now();o.frames=[];o.downPaint.length=0;o.keyPaint.length=0;o.wheelPaint.length=0;o.on=true;const loop=t=>{if(!o.on)return;o.frames.push(t);o.raf=requestAnimationFrame(loop)};o.raf=requestAnimationFrame(loop)};
o.mark=name=>o.marks.push({name,t:performance.now()});
o.stop=()=>{o.on=false;cancelAnimationFrame(o.raf);const t1=performance.now();const gaps=[];for(let i=1;i<o.frames.length;i++)gaps.push({at:+(o.frames[i-1]-o.t0).toFixed(0),ms:+(o.frames[i]-o.frames[i-1]).toFixed(1)});
 return{t0:o.t0,t1,frames:o.frames.length,gaps,tasks:o.tasks.filter(t=>t.s+t.d>=o.t0&&t.s<=t1).map(t=>({at:Math.round(t.s-o.t0),d:t.d})),downPaint:o.downPaint.slice(),keyPaint:o.keyPaint.slice(),wheelPaint:o.wheelPaint.slice(),marks:o.marks.splice(0).map(m=>({name:m.name,at:Math.round(m.t-o.t0)})),heapMB:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null}};
return 'installed'})()`;

const results = { phases: {} };
async function cdpMetrics() { if (!cdp) return null; try { const { metrics } = await win.webContents.debugger.sendCommand('Performance.getMetrics'); const o = {}; for (const m of metrics) o[m.name] = m.value; return o; } catch { return null; } }
const startProfile = async () => { const d = win.webContents.debugger; await d.sendCommand('Profiler.enable'); await d.sendCommand('Profiler.setSamplingInterval', { interval: 200 }); await d.sendCommand('Profiler.start'); };
const stopProfile = async (name) => { const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop'); fs.writeFileSync(path.join(out, `profile-${name}.cpuprofile`), JSON.stringify(profile)); };
const startTrace = () => contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'blink.user_timing', 'cc', 'viz', 'gpu', 'toplevel', 'loading', 'disabled-by-default-devtools.timeline.frame'], excluded_categories: ['*'] });

/** One phase: the gesture, then `settle` ms of doing nothing. `gestureEnd` splits the two in the report. */
async function phase(name, run, { settle = SETTLE } = {}) {
  const profile = cdp && profiled.includes(name), trace = traced.includes(name);
  ledger.clear();
  const m0 = await cdpMetrics();
  if (profile) await startProfile();
  if (trace) await startTrace();
  await js('window.__o.start()');
  let error = null;
  try { await run(); } catch (e) { error = String(e?.stack || e); }
  await js("window.__o.mark('gestureEnd')");
  await sleep(settle);
  const r = await js('window.__o.stop()');
  if (trace) await contentTracing.stopRecording(path.join(out, `trace-${name}.json`));
  if (profile) await stopProfile(name);
  const m1 = await cdpMetrics();
  const split = r.marks.find((m) => m.name === 'gestureEnd')?.at ?? Math.round(r.t1 - r.t0);
  const part = (lo, hi) => { const gaps = r.gaps.filter((g) => g.at >= lo && g.at < hi).map((g) => g.ms), tasks = r.tasks.filter((t) => t.at >= lo - 5 && t.at < hi);
    return { frames: gaps.length, gapP95: q(gaps, .95), gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null, gapsOver33: gaps.filter((g) => g > 33.4).length, gapsOver100: gaps.filter((g) => g > 100).length, longTasks: tasks.map((t) => t.d), longTaskMs: tasks.reduce((a, t) => a + t.d, 0), worstAt: tasks.length ? tasks.reduce((a, t) => (t.d > a.d ? t : a)).at : null }; };
  const res = { name, wallMs: Math.round(r.t1 - r.t0), gestureMs: split, gesture: part(0, split), settle: part(split, Infinity),
    downPaint: { p95: q(r.downPaint, .95), max: r.downPaint.length ? Math.max(...r.downPaint) : null, n: r.downPaint.length }, keyPaint: { p95: q(r.keyPaint, .95), max: r.keyPaint.length ? Math.max(...r.keyPaint) : null, n: r.keyPaint.length }, wheelPaint: { p95: q(r.wheelPaint, .95), max: r.wheelPaint.length ? Math.max(...r.wheelPaint) : null, n: r.wheelPaint.length },
    taskMs: m0 && m1 ? Math.round((m1.TaskDuration - m0.TaskDuration) * 1000) : null, scriptMs: m0 && m1 ? Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000) : null, layoutMs: m0 && m1 ? Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000) : null,
    heapMB: r.heapMB, ipc: takeLedger(), marks: r.marks, ...(error ? { error } : {}) };
  (results.phases[name] ??= []).push(res);
  log('phase', { name, gestureMs: res.gestureMs, gesture: res.gesture, settle: res.settle, down: res.downPaint, key: res.keyPaint, wheel: res.wheelPaint, taskMs: res.taskMs, scriptMs: res.scriptMs, heapMB: res.heapMB, ipcTop: Object.entries(res.ipc).slice(0, 4).map(([k, v]) => `${k}×${v.n} ${v.ms}ms ${v.argMB}/${v.resMB}MB`), error });
  if (process.env.OFP_SHOTS === '1') fs.writeFileSync(path.join(out, `shot-${name}-${results.phases[name].length}.png`), (await win.webContents.capturePage()).toPNG());
  return res;
}

const ROOT = '.figure-mode';
const sceneState = () => js(`(()=>{const root=document.querySelector('${ROOT}');if(!root)return null;const h=root.querySelector('.canvas-host').getBoundingClientRect();
  const figs=[...root.querySelectorAll('[data-annotation-figure]')].map(g=>{const bg=g.querySelector('.figure-bg');const r=(bg||g).getBoundingClientRect();return{id:g.getAttribute('data-annotation-figure'),mode:g.getAttribute('data-atlas-mode'),raster:!!g.querySelector('[data-figure-raster]'),live:g.querySelectorAll('[data-editor-element-id]').length,active:!!g.querySelector('.figure-bg.active'),inView:r.right>h.left&&r.left<h.right&&r.bottom>h.top&&r.top<h.bottom&&r.width>0,box:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]}});
  const g=root.querySelector('.scene-svg > g');
  return{host:{l:Math.round(h.left),t:Math.round(h.top),r:Math.round(h.right),b:Math.round(h.bottom)},figs,elements:root.querySelectorAll('[data-editor-element-id]').length,nodes:root.querySelectorAll('.scene-svg *').length,images:root.querySelectorAll('.scene-svg image').length,imageDetails:root.querySelectorAll('.scene-svg image.image-detail').length,hrefMB:+([...root.querySelectorAll('.scene-svg image')].reduce((n,i)=>n+(i.getAttribute('href')||'').length,0)/1048576).toFixed(2),maxHrefMB:+(Math.max(0,...[...root.querySelectorAll('.scene-svg image')].map(i=>(i.getAttribute('href')||'').length))/1048576).toFixed(2),zoom:Number(/scale\\(([-\\d.e]+)/.exec(g?.getAttribute('transform')||'')?.[1]),proxy:!!root.querySelector('.zoom-proxy.live,.zoom-proxy-coarse.live')}})()`);
const elementRects = () => js(`(()=>{const h=document.querySelector('${ROOT} .canvas-host').getBoundingClientRect();return [...document.querySelectorAll('${ROOT} [data-editor-element-id]')].map(n=>{const r=n.getBoundingClientRect();return{id:n.dataset.editorElementId,tag:n.querySelector('image')?'image':n.querySelector('svg')?'plot':n.querySelector('text,foreignObject')?'text':'other',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}}).filter(p=>p.w>24&&p.h>16&&p.x>h.left+30&&p.x<h.right-30&&p.y>h.top+30&&p.y<h.bottom-30)})()`);

async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], 'window');
  win.setContentSize(+process.env.OFP_WIDTH, +process.env.OFP_HEIGHT); win.show(); win.focus();
  const tBoot = Date.now(), tBootPerf = performance.now();
  try { win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Performance.enable'); cdp = true; } catch (e) { log('cdp', { err: String(e) }); }
  if (cdp && profiled.includes('open')) await startProfile();
  if (traced.includes('open')) await startTrace();
  await wait(() => js("!!document.querySelector('button[aria-label=Figure]')"), 'shell');
  await js(INSTR); await js('window.__o.start()');
  const tShell = Date.now();
  await js(`(()=>{const b=[...document.querySelectorAll('button[aria-label]')].find(b=>/^Figure$/i.test(b.getAttribute('aria-label')));b.click()})()`);
  await wait(() => js(`(()=>{const n=document.querySelector('${ROOT} .canvas-host');return n&&!n.closest('.mc.hidden')})()`), 'figure mode');
  await wait(() => js("!!document.querySelector('.figrow .item')"), 'figure rows', 120000);
  const tRows = Date.now();
  const want = process.env.OFP_FIGURE;
  const index = JSON.parse(fs.readFileSync(path.join(process.env.OFP_PROJECT, 'fig/index.json'), 'utf8'));
  const row = /^\d+$/.test(want) ? Math.min(index.figures.length, +want) - 1 : index.figures.findIndex((f) => f.id === want);
  if (row < 0) throw Error('no such figure: ' + want);
  await js(`(()=>{const rows=[...document.querySelectorAll('.figrow .item')];const r=rows[${row}];r.scrollIntoView({block:'center'});r.click();return rows.length})()`);
  await wait(() => js(`document.querySelectorAll('${ROOT} [data-editor-element-id]').length>0`), 'elements mounted', 120000);
  const tMounted = Date.now();
  // Quiet = 2 s with no long task and no change in mounted nodes or figure modes (≤ 90 s).
  let last = '', quietSince = Date.now(), timeline = [];
  for (const t0 = Date.now(); Date.now() - t0 < 90000;) {
    const s = await sceneState(), tasks = await js('window.__o.tasks.length');
    const sig = `${s.elements}|${s.nodes}|${tasks}|${s.figs.filter((f) => f.inView).map((f) => f.mode + (f.raster ? 'p' : '') + (f.live ? 'd' : '')).join(',')}`;
    if (sig !== last) { last = sig; quietSince = Date.now(); timeline.push({ t: Date.now() - tBoot, elements: s.elements, nodes: s.nodes, tasks, inView: s.figs.filter((f) => f.inView).map((f) => `${f.mode}${f.raster ? '+png' : ''}${f.live ? '+dom' + f.live : ''}`) }); }
    if (Date.now() - quietSince > 2000) break;
    await sleep(100);
  }
  const tQuiet = Date.now() - 2000;
  if (traced.includes('open')) await contentTracing.stopRecording(path.join(out, 'trace-open.json'));
  if (cdp && profiled.includes('open')) await stopProfile('open');
  const openFrames = await js('window.__o.stop()');
  const openGaps = openFrames.gaps.filter((g) => g.ms > 50);
  const openTasks = await js('window.__o.tasks.slice()');
  const open = { shellMs: tShell - tBoot, figureRowsMs: tRows - tBoot, elementsMountedMs: tMounted - tBoot, quietMs: tQuiet - tBoot,
    frozenMs: Math.round(openGaps.reduce((a, g) => a + g.ms, 0)), gapsOver50: openGaps.length, gapsOver100: openGaps.filter((g) => g.ms > 100).length, gapMax: openGaps.length ? Math.max(...openGaps.map((g) => g.ms)) : 0, worstGaps: openGaps.slice().sort((a, b) => b.ms - a.ms).slice(0, 10),
    longTasks: openTasks.length, longTaskMs: openTasks.reduce((a, t) => a + t.d, 0), worst: openTasks.slice().sort((a, b) => b.d - a.d).slice(0, 12), over100: openTasks.filter((t) => t.d > 100).length, over1000: openTasks.filter((t) => t.d > 1000).length,
    heapMB: await js('performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null'), memoryMB: memory(), toasts: await js('window.__o.toasts.slice()'), ipc: takeLedger(), ipcPaths: global.__ofpTakePaths(), ipcBig: global.__ofpTakeBig(), clock: { boot: Math.round(tBootPerf), shell: Math.round(tBootPerf + tShell - tBoot), rows: Math.round(tBootPerf + tRows - tBoot), mounted: Math.round(tBootPerf + tMounted - tBoot), quiet: Math.round(tBootPerf + tQuiet - tBoot) }, timeline, scene: await sceneState() };
  results.open = open;
  log('openPaths', open.ipcPaths);
  log('open', { ...open, ipcPaths: undefined, ipcBig: undefined, ipc: Object.entries(open.ipc).slice(0, 10).map(([k, v]) => `${k}×${v.n} ${v.ms}ms arg ${v.argMB}MB res ${v.resMB}MB (max ${v.maxResMB})`), timeline: timeline.length, scene: { ...open.scene, figs: open.scene.figs.filter((f) => f.inView) } });
  fs.writeFileSync(path.join(out, 'open.png'), (await win.webContents.capturePage()).toPNG());

  const rounds = +process.env.OFP_ROUNDS, s0 = await sceneState();
  for (let round = 0; round < rounds; round++) {
    const s = await sceneState();
    const active = s.figs.find((f) => f.active) ?? s.figs.find((f) => f.inView);
    const cx = Math.round((s.host.l + s.host.r) / 2), cy = Math.round((s.host.t + s.host.b) / 2);
    let rects = await elementRects();
    const target = rects.find((r) => r.tag === 'image') ?? rects.find((r) => r.tag === 'plot') ?? rects[0];
    log('target', { round, target, elements: rects.length, active: active?.id, zoom: s.zoom });
    if (!target) throw Error('no on-screen element to act on');
    mouse({ type: 'mouseMove', x: cx, y: cy }); await sleep(200);

    if (wantPhase('hover')) await phase('hover', async () => { for (let i = 0; i <= 100; i++) { mouse({ type: 'mouseMove', x: Math.round(s.host.l + 60 + (s.host.r - s.host.l - 120) * i / 100), y: cy + Math.round(Math.sin(i / 8) * 120) }); await sleep(8); } }, { settle: 1000 });
    if (wantPhase('pan')) await phase('pan', async () => { for (let i = 0; i < 30; i++) { wheel(cx, cy, 0, -16); await sleep(17); } for (let i = 0; i < 30; i++) { wheel(cx, cy, 0, 16); await sleep(17); } });
    if (wantPhase('zoomIn')) await phase('zoomIn', async () => { mouse({ type: 'mouseMove', x: target.x, y: target.y }); await sleep(50); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' }); for (let i = 0; i < NOTCHES; i++) { wheel(target.x, target.y, 0, 120, ['control']); await sleep(30); } win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' }); });
    if (wantPhase('panZoomed')) await phase('panZoomed', async () => { for (let i = 0; i < 30; i++) { wheel(cx, cy, -18, -8); await sleep(17); } for (let i = 0; i < 30; i++) { wheel(cx, cy, 18, 8); await sleep(17); } });
    if (wantPhase('zoomOut')) await phase('zoomOut', async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' }); for (let i = 0; i < NOTCHES; i++) { wheel(target.x, target.y, 0, -120, ['control']); await sleep(30); } win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' }); });
    // Deep zoom into the target image: past its tier cap a DETAIL of the visible part must arrive, sharp, with no freeze.
    if (wantPhase('zoomDeep')) {
      const deep = NOTCHES * 2 + 2;
      const zoomBy = async (n, dir) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' }); for (let i = 0; i < n; i++) { wheel(target.x, target.y, 0, dir * 120, ['control']); await sleep(30); } win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' }); };
      await phase('zoomDeep', async () => { mouse({ type: 'mouseMove', x: target.x, y: target.y }); await sleep(50); await zoomBy(deep, 1); });
      const st = await sceneState(); log('deep', { zoom: st.zoom, images: st.images, imageDetails: st.imageDetails, hrefMB: st.hrefMB, maxHrefMB: st.maxHrefMB });
      results.deep = st;
      fs.writeFileSync(path.join(out, `deep-${round}.png`), (await win.webContents.capturePage()).toPNG());
      await phase('panDeep', async () => { for (let i = 0; i < 20; i++) { wheel(cx, cy, -20, -6); await sleep(17); } });
      const st2 = await sceneState(); log('deepPanned', { imageDetails: st2.imageDetails, hrefMB: st2.hrefMB, maxHrefMB: st2.maxHrefMB });
      await phase('zoomDeepOut', async () => { await zoomBy(deep, -1); });
      const st3 = await sceneState(); log('deepOut', { zoom: st3.zoom, imageDetails: st3.imageDetails, hrefMB: st3.hrefMB, maxHrefMB: st3.maxHrefMB });
    }
    rects = await elementRects();
    const el = rects.find((r) => r.id === target.id) ?? rects[0];
    if (wantPhase('select')) await phase('select', async () => { for (let i = 0; i < 8; i++) { const p = rects[i % Math.min(rects.length, 4)]; mouse({ type: 'mouseMove', x: p.x, y: p.y }); await sleep(20); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x: p.x, y: p.y }); await sleep(30); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x: p.x, y: p.y }); await sleep(90); } }, { settle: 1500 });
    if (wantPhase('drag')) { await phase('drag', async () => {
      mouse({ type: 'mouseMove', x: el.x, y: el.y }); await sleep(120); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x: el.x, y: el.y }); await sleep(80);
      let lx = el.x, ly = el.y; for (let i = 1; i <= 120; i++) { const th = (i / 120) * 2 * Math.PI; lx = Math.round(el.x + 90 * Math.sin(th) + 40 * i / 120); ly = Math.round(el.y + 50 * Math.sin(2 * th) + 25 * i / 120); mouse({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: lx, y: ly }); await sleep(8); }
      await sleep(60); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x: lx, y: ly });
    }); key('z', ['control']); await sleep(600); }
    if (wantPhase('nudge')) { await phase('nudge', async () => {
      mouse({ type: 'mouseMove', x: el.x, y: el.y }); await sleep(40); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x: el.x, y: el.y }); await sleep(30); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x: el.x, y: el.y }); await sleep(250);
      for (let i = 0; i < 12; i++) { key(i % 2 ? 'Left' : 'Right'); await sleep(70); }
    }); }
    if (wantPhase('idle')) await phase('idle', async () => {}, { settle: 4000 });
    if (wantPhase('switchFigure')) {
      const other = (await sceneState()).figs.find((f) => f.inView && !f.active && f.box[2] > 60);
      if (other) await phase('switchFigure', async () => { const x = other.box[0] + other.box[2] / 2, y = other.box[1] + other.box[3] / 2; mouse({ type: 'mouseMove', x, y }); await sleep(60); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x, y }); await sleep(30); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x, y }); });
      else log('switchFigure', { skipped: 'no other figure in view' });
    }
  }
  // Leave the figure, look at its PICTURE, come back: a pictured figure must show its images (2026-11-09: the
  // owner's Figure 22 was pictured as nine grey boxes). Samples the picture's pixels where the target image is.
  if (wantPhase('leave')) {
    const before = await sceneState(), home = before.figs.find((f) => f.active), other = before.figs.find((f) => f.inView && !f.active && f.box[2] > 60);
    const rects = await elementRects(), img = rects.find((r) => r.tag === 'image');
    if (home && other && img) {
      const click = async (x, y) => { mouse({ type: 'mouseMove', x, y }); await sleep(60); mouse({ type: 'mouseDown', button: 'left', clickCount: 1, x, y }); await sleep(30); mouse({ type: 'mouseUp', button: 'left', clickCount: 1, x, y }); };
      const cx = Math.round(other.box[0] + other.box[2] / 2), cy = Math.round(Math.max(s0.host.t + 20, Math.min(s0.host.b - 20, other.box[1] + other.box[3] / 2)));
      await phase('leave', async () => { await click(cx, cy); });
      const sample = async () => { const image = await win.webContents.capturePage({ x: img.x - 6, y: img.y - 6, width: 12, height: 12 }), b = image.toBitmap(); let r = 0, g = 0, bl = 0; for (let i = 0; i < b.length; i += 4) { bl += b[i]; g += b[i + 1]; r += b[i + 2]; } const n = b.length / 4; return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)]; };
      const left = await sceneState(), pictured = left.figs.find((f) => f.id === home.id);
      results.leave = { figure: home.id, mode: pictured?.mode, raster: pictured?.raster, live: pictured?.live, rgbAtImage: await sample(), placeholders: await js(`document.querySelectorAll('${ROOT} .scene-svg rect[fill="#eee"]').length`) };
      fs.writeFileSync(path.join(out, 'left.png'), (await win.webContents.capturePage()).toPNG());
      await phase('return', async () => { await click(img.x, img.y); });
      results.leave.rgbBack = await sample();
      log('leave', results.leave);
    } else log('leave', { skipped: 'needs an active figure with an image and another figure in view' });
  }
  results.end = { memoryMB: memory(), heapMB: await js('performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null'), toasts: await js('window.__o.toasts.slice()'), scene: await sceneState() };
  log('end', { memoryMB: results.end.memoryMB, heapMB: results.end.heapMB, toasts: results.end.toasts });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(0);
}
app.whenReady().then(() => main().catch((e) => { log('fail', { error: String(e?.stack || e) }); try { fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ...results, error: String(e?.stack || e) }, null, 1)); } catch {} app.exit(1); }));
