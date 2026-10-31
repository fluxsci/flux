'use strict';
// Boot the real application. Only the OS directory picker is deterministic;
// project opening, window creation, preload, IPC and workers are production code.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const scratch = process.env.PROBE_SCRATCH, repo = process.env.PROBE_APP_ROOT, root = process.env.PROBE_PROJECT;
if (!scratch || !repo || !root || process.env.FLUX_NO_MIGRATE !== '1') throw Error('Isolated figure raster context required');
app.disableHardwareAcceleration();
const children = [], spawn = cp.spawn;
cp.spawn = function(exe, args, options) {
  const child = spawn.call(this, exe, args, options);
  if (args?.some(a => /figureRasterWorker.bundle.mjs$/.test(a))) children.push(child);
  return child;
};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.PROBE_SECOND_PROJECT] });
require(path.join(repo, 'electron/main.cjs'));
const checks = [], windows = [];
const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log('PROBE check=' + JSON.stringify(checks.at(-1))); if (!ok) throw Error(label); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label) { const start = Date.now(); let last; while (Date.now() - start < 25000) { try { const result = await fn(); if (result) return result; } catch (e) { last = e.message; } await sleep(40); } throw Error(`Timeout: ${label} ${last || ''}`); }
const js = (win, code) => win.webContents.executeJavaScript(code, true);
async function click(win, selector) {
  const p = await js(win, `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
}
async function main() {
  const first = await wait(() => BrowserWindow.getAllWindows()[0], 'initial window'); windows.push(first);
  await wait(() => js(first, "!!document.querySelector('.cm-editor') && !!window.fig"), 'real preload and initial project');
  check(await js(first, "typeof window.fig.rasterizeFigure === 'function' && typeof window.fig.cancelFigureRaster === 'function'"), 'figure raster methods are exposed by the real preload');
  check(app.getPath('userData').startsWith(scratch + path.sep), 'actual main config is isolated');
  check(first.webContents.getURL().startsWith('file:') && await js(first, '!window.__flux'), 'production bundle with the actual sandboxed preload');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'fig/canvases/c.json'), 'utf8'));
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'fig/index.json'), 'utf8')).assets;
  const figure = saved.figures.find(f => f.id === 'native-5');
  const req = (rid, project = root, id = figure.id) => ({ rid, root: project, assets, figure: { ...figure, id }, scale: 1, width: 320, height: 240 });
  const result = await js(first, `(async()=>{
    const r=await window.fig.rasterizeFigure(${JSON.stringify(req('native-png'))});if(r.error)throw Error(r.error);
    const image=new Image();image.src=URL.createObjectURL(new Blob([r.png],{type:'image/png'}));await image.decode();
    const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
    const p=Array.from(ctx.getImageData(20,18,1,1).data);URL.revokeObjectURL(image.src);
    return{width:image.naturalWidth,height:image.naturalHeight,pixel:p,signature:Array.from(r.png.slice(0,8)),ms:r.ms};
  })()`);
  check(result.width === 320 && result.height === 240, 'preload PNG dimensions are exact');
  check(JSON.stringify(result.pixel) === JSON.stringify([67,133,190,255]), 'preload PNG has the authored content pixel');
  check(JSON.stringify(result.signature) === JSON.stringify([137,80,78,71,13,10,26,10]), 'preload transports PNG bytes without base64');
  const region = await js(first, `(async()=>{const r=await window.fig.rasterizeFigure(${JSON.stringify({ ...req('native-region'), figure: { ...figure, background: undefined, elements: [] }, region: { x: 64, y: 48, w: 160, h: 120 }, backdrop: '#12ab34' })});if(r.error)throw Error(r.error);const i=new Image();i.src=URL.createObjectURL(new Blob([r.png],{type:'image/png'}));await i.decode();const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);URL.revokeObjectURL(i.src);return{w:c.width,h:c.height,p:[...ctx.getImageData(0,0,1,1).data]}})()`);
  check(region.w === 320 && region.h === 240 && JSON.stringify(region.p) === '[18,171,52,255]', 'region and opaque backdrop round-trip through actual preload/IPC/worker');
  await js(first, 'window.fig.newWindow()');
  const second = await wait(() => BrowserWindow.getAllWindows().find(w => w.id !== first.id), 'second real app window'); windows.push(second);
  second.show(); second.focus();
  await wait(() => js(second, "!!document.querySelector('button.open')"), 'second Home');
  await click(second, 'button.open');
  await wait(() => js(second, "!!document.querySelector('.cm-editor')"), 'second scratch project opens via native input');
  const worker = children[0]; check(!!worker?.pid, 'real first-window worker was observed');
  if (process.platform !== 'win32') worker.kill('SIGSTOP');
  else throw Error('Queue independence probe requires POSIX process suspension');
  await js(first, `window.__heldDone=false;window.__held=window.fig.rasterizeFigure(${JSON.stringify(req('native-held', root, 'held'))}).then(r=>{window.__heldDone=true;return r});window.__queued=window.fig.rasterizeFigure(${JSON.stringify(req('native-queued', root, 'queued'))});true`);
  const other = await js(second, `window.fig.rasterizeFigure(${JSON.stringify(req('native-second', process.env.PROBE_SECOND_PROJECT))})`);
  check(!!other.png && !other.error && !(await js(first, 'window.__heldDone')), 'second project renders while first-window worker and queue are blocked');
  const wrongRoot = await js(second, `window.fig.rasterizeFigure(${JSON.stringify(req('native-wrong-root'))})`);
  check(/root mismatch/.test(wrongRoot.error), 'one window cannot submit the other project root');
  await js(first, "window.fig.cancelFigureRaster('native-held')");
  check((await js(first, 'window.__held')).cancelled === true, 'actual preload cancels a running decode');
  check(!!(await js(first, 'window.__queued')).png, 'queued job renders through a respawn after cancellation');
  check(children.length === 3, 'two windows own distinct workers and cancelled worker was replaced');
  const out = process.env.PROBE_OUTPUT;
  fs.writeFileSync(path.join(out, 'window.png'), (await first.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'runtime.json'), JSON.stringify({ checks, result, electron: process.versions.electron, chrome: process.versions.chrome, display: process.env.DISPLAY, gpuFeatures: app.getGPUFeatureStatus(), userData: app.getPath('userData') }, null, 2));
}
function finish(code) { console.log('PROBE result=' + JSON.stringify({ ok: code === 0, checks })); for (const child of children) try { child.kill('SIGKILL'); } catch {} for (const win of windows) if (!win.isDestroyed()) win.destroy(); app.exit(code); }
app.whenReady().then(main).then(() => finish(0), e => { console.error(e); finish(1); });
