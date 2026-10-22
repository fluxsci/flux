'use strict';
// Native Plots rail probe (run by scripts/verify-plots-rail-electron.cjs): the production
// renderer with the REAL thumbnail worker, watcher, preload and IPC, under a disposable config.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const scratch = process.env.PROBE_SCRATCH, root = process.env.PROBE_PROJECT;
if (!scratch || !root) throw Error('Hermetic probe context required');
require('../../electron/main.cjs');
let win; const checks = [];
const js = (w, code) => Promise.race([w.webContents.executeJavaScript(code, true), new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Renderer did not respond: ' + code.slice(0, 100))), 15000); t.unref(); })]);
const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log('PROBE ' + JSON.stringify(checks.at(-1))); if (!ok) throw Error(label); };
async function wait(fn, label, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fn(); if (r) return r; } catch {} await new Promise((r) => setTimeout(r, 60)); } throw Error('Timeout: ' + label); }
const center = (w, selector) => js(w, `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
async function click(w, selector, count = 1) {
  const p = await center(w, selector);
  for (let c = 1; c <= count; c++) { w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: c, ...p }); w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: c, ...p }); }
}
const key = (w, keyCode, modifiers = []) => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
const saved = () => JSON.parse(fs.readFileSync(path.join(root, 'fig/canvases/c.json'), 'utf8')).figures.find((f) => f.id === 'native-5');
const cacheDir = () => path.join(app.getPath('userData'), 'cache', 'plot-thumbs');
const pngsInCache = () => { try { return fs.readdirSync(cacheDir()).filter((d) => /^[0-9a-f]{2}$/.test(d)).reduce((n, d) => n + fs.readdirSync(path.join(cacheDir(), d)).filter((f) => f.endsWith('.png')).length, 0); } catch { return 0; } };
const workerPids = () => { if (process.platform !== 'linux') return []; try { return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'plotThumbWorker'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
const tile = (suffix) => `[data-plots-gallery] [data-tile$="${suffix}"]`;
const backdropOf = (suffix) => js(win, `document.querySelector(${JSON.stringify(tile(suffix))})?.getAttribute('data-backdrop')`);
const imgLoaded = (suffix) => js(win, `!!document.querySelector(${JSON.stringify(tile(suffix) + ' img')})?.naturalWidth`);
async function scrollTo(suffix) {
  await wait(() => js(win, `(async()=>{const vp=document.querySelector('[data-plots-gallery] .viewport');for(let i=0;i<120;i++){const n=document.querySelector(${JSON.stringify(tile(suffix))});if(n){n.scrollIntoView({block:'center'});return true}vp.scrollTop+=200;await new Promise(r=>setTimeout(r,30))}vp.scrollTop=0;return false})()`), 'scroll to ' + suffix);
}

async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], 'app window'); win.show(); win.focus();
  win.webContents.on('console-message', (_e, d) => { if (d.level === 'error') console.log('PROBE renderer=' + d.message); });
  await wait(() => js(win, "!!document.querySelector('.cm-editor')"), 'initial Paper');
  check(app.getPath('userData').startsWith(scratch + path.sep), 'isolated native config');
  check(win.webContents.getURL().startsWith('file:') && await js(win, '!window.__flux'), 'production file renderer');
  await click(win, 'button[aria-label=Figure]'); await wait(() => js(win, "!!document.querySelector('.figure-mode .canvas-host')"), 'Figure');
  await click(win, '.figrow[data-fig-id="native-5"] .item');
  await wait(() => js(win, "!!document.querySelector('[data-editor-element-id=\"e5-0\"]')"), 'small figure visible');
  // Alt+G through the real input pipeline.
  key(win, 'g', ['alt']);
  await wait(() => js(win, "document.querySelector('[data-left-rail]')?.getAttribute('data-left-rail')==='plots'&&document.activeElement?.hasAttribute('data-plots-search')"), 'Plots rail + search focus');
  check(true, 'native Alt+G shows the Plots rail and focuses its search');
  // Thumbnails from the worker: images load, the disk cache fills, the backdrop law holds.
  for (const [f, want] of [['dark.svg', 'dark'], ['light.svg', 'paper'], ['mixed.svg', 'mid'], ['white_text_only.svg', 'dark'], ['opaque.svg', 'own']]) {
    await scrollTo('/fixtures/' + f);
    await wait(() => imgLoaded('/fixtures/' + f), 'thumbnail ' + f);
    check((await backdropOf('/fixtures/' + f)) === want, `worker-rendered ${f} sits on its ${want} backdrop`);
  }
  await wait(() => pngsInCache() >= 5, 'disk cache');
  check(pngsInCache() >= 5, `thumbnails are cached under userData/cache/plot-thumbs (${pngsInCache()} PNGs)`);
  const workers = workerPids();
  check(process.platform !== 'linux' || workers.length === 1, `exactly one thumbnail worker (a Node child) — ${workers.join(',')}`);
  // Insert by a native double-click; the saved figure gets the plot at true size.
  await scrollTo('/growth.svg');
  const before = saved().elements.length;
  await click(win, tile('/growth.svg') + ' .page', 2);
  await wait(() => saved().elements.length === before + 1, 'double-click insert persisted');
  const placed = saved().elements.at(-1);
  check(placed.type === 'plot' && /plots\/growth\.svg$/.test(placed.source?.svgPath ?? '') && placed.width === 96 && placed.height === 64, 'a native double-click places the plot at its true size (saved to fig/)');
  // Dissections follow; the real watcher feeds live updates (fs:changedBatch).
  await wait(() => js(win, "document.querySelector('[data-dissect-focus]')?.getAttribute('data-dissect-focus')==='growth'"), 'focus growth');
  const count0 = Number(await js(win, "document.querySelector('[data-plots-dissections] .count')?.textContent?.trim()||0"));
  check(count0 === 4, `the Dissections pane lists growth's companion files (${count0})`);
  fs.writeFileSync(path.join(root, 'plots', '_dissections', 'growth', 'by_subject', 's09.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="20pt"><rect width="20" height="20" fill="#ad8301"/></svg>');
  await wait(() => js(win, "document.querySelector('[data-plots-dissections] .count')?.textContent?.trim()==='5'"), 'live dissection via the watcher');
  check(true, 'a file written into the dissection folder appears through the real watcher');
  // A regenerated plot: new bytes on disk → a fresh thumbnail (new version stamp).
  const src0 = await js(win, `document.querySelector(${JSON.stringify(tile('/growth.svg') + ' img')})?.src`);
  fs.writeFileSync(path.join(root, 'plots', 'growth.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="48pt" viewBox="0 0 72 48"><rect width="72" height="48" fill="#24837b"/></svg>');
  await wait(async () => { const s = await js(win, `document.querySelector(${JSON.stringify(tile('/growth.svg') + ' img')})?.src`); return s && s !== src0; }, 'regenerated thumbnail');
  check(true, 'a regenerated plot gets a fresh thumbnail without a refresh');
  // Kill the worker: the next thumbnail still arrives (respawn).
  if (process.platform === 'linux' && workers.length) {
    process.kill(workers[0], 'SIGKILL');
    fs.writeFileSync(path.join(root, 'plots', 'after_kill.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40pt" height="30pt"><rect width="40" height="30" fill="#ce5d97"/></svg>');
    await scrollTo('/after_kill.svg');
    await wait(() => imgLoaded('/after_kill.svg'), 'thumbnail after a worker kill', 25000);
    check(workerPids().length === 1 && workerPids()[0] !== workers[0], 'a killed worker is respawned and serves the next thumbnail');
  }
  // The burst: 1,500 plots flung end to end (the lighttable lesson) — the app and worker survive.
  await js(win, "(async()=>{const vp=document.querySelector('[data-plots-gallery] .viewport');for(let i=0;i<60;i++){vp.scrollTop+=vp.scrollHeight/60;await new Promise(r=>setTimeout(r,16))}for(let i=0;i<30;i++){vp.scrollTop-=vp.scrollHeight/30;await new Promise(r=>setTimeout(r,16))}return true})()");
  await scrollTo('/burst/p1499.svg');
  await wait(() => imgLoaded('/burst/p1499.svg'), 'the last burst plot renders', 30000);
  check(!win.webContents.isCrashed() && workerPids().length <= 1, 'flinging 1,500 plots end to end: the app and the worker survive');
  // Index persistence: the per-root index is on disk (next open lays out instantly).
  await wait(() => fs.readdirSync(cacheDir()).some((f) => f.startsWith('index-')), 'index written');
  check(true, 'the per-root index (sizes, analysis) persists in the cache');
  fs.writeFileSync(path.resolve(__dirname, '../../test-results/plots-rail-native.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.resolve(__dirname, '../../test-results/plots-rail-native.json'), JSON.stringify(checks, null, 2));
}
app.whenReady().then(() => main().then(() => { fs.writeSync(1, 'PROBE result=PASS\n'); process.exit(0); }).catch(async (e) => {
  try { if (win && !win.isDestroyed()) fs.writeFileSync(path.resolve(__dirname, '../../test-results/plots-rail-native-failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
  fs.writeSync(2, `PROBE failure=${e?.stack ?? e}\n`); process.exit(1);
}));
setTimeout(() => { fs.writeSync(2, 'PROBE failure=timeout\n'); process.exit(2); }, 170000);
