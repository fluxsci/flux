'use strict';
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path');
const { qualifiedNativeBounds, assertFocusedWindow } = require('./nativeWindowQualification.cjs');
const scratch = process.env.MODEL3D_NATIVE_SCRATCH, root = process.env.MODEL3D_NATIVE_ROOT, out = process.env.MODEL3D_NATIVE_ARTIFACTS;
if (!scratch || !root?.startsWith(scratch + path.sep) || !out) throw Error('Owned native scratch required');
if (process.platform === 'linux' && (process.env.FLUX_PRIVATE_DISPLAY !== '1' || !process.argv.includes('--ozone-platform=x11'))) throw Error('Explicit private X11 required');
require('../../electron/entry.cjs');
let win, qualified = false, receipt = {}, runtime = {}, errors = [];
const js = expression => win.webContents.executeJavaScript(expression, true);
const evaluate = (fn, arg) => js(`(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function focus() {
  const observation = await js('({visible:document.visibilityState,focused:document.hasFocus()})');
  assertFocusedWindow(win, [observation]);
}
async function wait(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (qualified) await focus();
    if (await fn()) return;
    await delay(25);
  }
  throw Error('Timeout: ' + label);
}
async function click(selector, prefix) {
  await focus();
  const point = await evaluate(({ selector, prefix }) => {
    const target = [...document.querySelectorAll(selector)].find(n => !prefix || n.textContent.trim().startsWith(prefix));
    if (!target) throw Error('Missing native control: ' + selector);
    const rect = target.getBoundingClientRect(), x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    if (!rect.width || !rect.height || !target.contains(document.elementFromPoint(x, y))) throw Error('Native control is covered');
    return { x, y };
  }, { selector, prefix });
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
}
async function main() {
  await fs.mkdir(out, { recursive: true });
  await wait(() => (win = BrowserWindow.getAllWindows()[0]), 'production window');
  runtime.displaySnapshot = { displays: screen.getAllDisplays().map(d => ({ bounds: d.bounds, workArea: d.workArea })), primary: screen.getPrimaryDisplay() };
  // Snapshot survives failure. Zero display must never be replaced by invented bounds.
  win.setBounds(qualifiedNativeBounds(runtime.displaySnapshot.displays, runtime.displaySnapshot.primary, 1440, 1040));
  win.show(); win.setAlwaysOnTop(true); app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(async () => win.isVisible() && win.isFocused() && await js('document.hasFocus()'), 'initial native focus'); qualified = true;
  await wait(() => js("!!document.querySelector('button[aria-label=Slide]')&&!!document.querySelector('.cm-editor')"), 'production app initialized');
  if (!app.getPath('userData').startsWith(scratch + path.sep)) throw Error('Real user state refused');
  if (!await js("location.protocol==='file:'&&!window.__flux&&!!window.fig")) throw Error('Actual production preload required');
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  runtime = { ...runtime, versions: process.versions, gpuFeatures: app.getGPUFeatureStatus(), gpuInfo: await app.getGPUInfo('complete'), bounds: win.getBounds(), contentBounds: win.getContentBounds() };
  await click('button[aria-label=Slide]');
  await wait(() => js("!!document.querySelector('.deckbar')&&!!document.querySelector('[data-editor-element-id=scale-single-model] image[data-model3d-poster]')"), 'saved canonical model deck and first decoded poster', 90000);
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'slide-scale-fixture.json'), 'utf8'));
  const { runSlideModelScaleCohort } = await import('./slideModel3dScaleCohort.mjs');
  receipt = await runSlideModelScaleCohort({ evaluate, wait, present: () => click('.deckbar button', 'Present'),
    press: async key => { await focus(); const keyCode = key === 'ArrowRight' ? 'Right' : key; win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); },
    screenshot: async name => { await focus(); await fs.writeFile(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); },
  }, fixture, { hardware: true, gpuFeatures: runtime.gpuFeatures });
  if (!receipt.ok) throw Object.assign(Error(receipt.error), { code: receipt.errorCode });
  if (errors.length) throw Error('Production renderer errors: ' + errors.join('; '));
}
async function finish(error) {
  qualified = false;
  if (error) { errors.push(String(error.stack || error)); console.error(error); }
  if (win && !win.isDestroyed()) {
    receipt.lastObservation = await js('window.__slideModelScaleProbe?.read()').catch(() => null);
    if (error) await fs.writeFile(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {});
  }
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify({ ...receipt, ok: !error, status: error?.code === 'NATIVE_DISPLAY_UNAVAILABLE' ? 'capability-blocked' : error ? 'failed' : 'passed', runtime, errors }, null, 2));
  console.log('PROBE result=' + (error ? 'FAIL' : 'PASS')); app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish(), finish);
process.stdin.resume(); process.stdin.on('end', () => app.exit(1)); process.stdin.on('close', () => app.exit(1));
