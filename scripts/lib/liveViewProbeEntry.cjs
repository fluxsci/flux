'use strict';
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const scratch = process.env.PROBE_SCRATCH, root = process.env.PROBE_PROJECT;
if (!scratch || !root) throw Error('Hermetic probe context required');
require('../../electron/main.cjs');
const checks = [], errors = [], artifacts = path.resolve(__dirname, '../../test-results');
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const check = (ok, label) => {
  checks.push({ ok: !!ok, label }); console.log('PROBE ' + JSON.stringify(checks.at(-1)));
  if (!ok) throw Error(label);
};
async function wait(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch { /* still mounting */ }
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error('Timeout: ' + label);
}
async function click(selector) {
  const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing control');const b=el.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
const key = (keyCode, modifiers = []) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
};
async function main() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], 'owner window'); win.show(); win.focus();
  win.webContents.on('console-message', (_e, d) => { if (d.level === 'error') errors.push(d.message); });
  await wait(() => js("!!document.querySelector('.cm-editor')"), 'Paper loaded');
  check(app.getPath('userData').startsWith(scratch + path.sep), 'native state isolated');
  check(win.webContents.getURL().startsWith('file:') && await js('!window.__flux'), 'production renderer without dev handles');
  const bridgeFile = path.join(root, '.meta/live/bridge.json');
  const info = await wait(() => fs.existsSync(bridgeFile) && JSON.parse(fs.readFileSync(bridgeFile, 'utf8')), 'live bridge');
  const sessions = path.join(root, '.meta/live/sessions'); fs.mkdirSync(sessions, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, 'native-heron.json'), JSON.stringify({ v: 1, id: 'native-heron', name: 'heron', display: 'codex · cli · heron',
    client: 'codex', product: 'codex', surface: 'cli', pid: process.pid, host: 'fixture', startedAt: now, heartbeatAt: now, live: true, watching: true }));
  const capture = async (maxEdge = 800) => {
    const response = await fetch(`${info.url}/capture`, { method: 'POST', headers: { authorization: `Bearer ${info.token}`,
      'content-type': 'application/json', 'x-flux-client': 'codex', 'x-flux-session': 'native-heron' }, body: JSON.stringify({ maxEdge }) });
    return { status: response.status, body: await response.json() };
  };
  // A marker in this window proves the returned PNG captures the actual renderer.
  await js("(()=>{const n=document.createElement('div');n.id='live-view-marker';n.style.cssText='position:fixed;left:0;top:0;width:64px;height:64px;background:rgb(12,200,90);z-index:99999;pointer-events:none';document.body.appendChild(n)})()");
  await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const result = await capture();
  check(result.status === 200 && result.body.stamp.surface === 'paper' && result.body.stamp.projectRoot === root, 'capture returns current project and Paper stamp');
  const bytes = Buffer.from(result.body.png, 'base64'); fs.writeFileSync(path.join(artifacts, 'live-view-native.png'), bytes);
  const image = nativeImage.createFromBuffer(bytes), size = image.getSize(), viewport = await js('({width:innerWidth,height:innerHeight})');
  check(!image.isEmpty() && Math.max(size.width, size.height) <= 800, 'real PNG decodes and long edge respects maxEdge');
  check(Math.abs(size.width / size.height - viewport.width / viewport.height) < 0.01, 'native resize preserves window aspect ratio');
  const pixel = image.toBitmap().subarray((8 * size.width + 8) * 4, (8 * size.width + 8) * 4 + 4);
  check(pixel[0] === 90 && pixel[1] === 200 && pixel[2] === 12 && pixel[3] === 255, 'PNG contains the owning renderer marker pixels');
  await wait(() => js("document.querySelector('.agent-view')?.textContent==='◉ heron viewed your window'"), 'named indicator');
  const appeared = Date.now();
  await wait(() => js("!document.querySelector('.agent-view')"), 'indicator expiry', 5000);
  check(Date.now() - appeared >= 1800 && Date.now() - appeared < 2600, 'titlebar indicator lasts two seconds');
  check(fs.readFileSync(path.join(root, '.meta/journal.ndjson'), 'utf8').split('\n').some(line => { try { const e=JSON.parse(line); return e.action==='live_view'&&e.client==='codex'&&e.sessionId==='native-heron'; } catch { return false; } }), 'native journal records live_view client and session');

  await js("document.querySelector('#live-view-marker').remove()");
  key('m', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']);
  await wait(() => js("document.activeElement===document.querySelector('.annotation-composer textarea')"), 'frozen Annotate');
  check((await capture()).status === 200, 'native capture allowed while Annotate frozen');
  await click('.to-pill');
  await wait(() => js("[...document.querySelectorAll('.routes button')].some(b=>b.textContent.includes('heron')&&b.querySelector('.pairing')?.textContent==='Pairing')"), 'Pairing badge');
  check(true, 'live presence session shows Pairing in Annotate To menu');
  key('Escape');
  await wait(() => js("!document.querySelector('[data-annotation-surface]')"), 'Annotate closes');
  await click('button[aria-label="Settings"]');
  await wait(() => js("!!document.querySelector('#settings-tab-general')"), 'Settings opens');
  await click('#settings-tab-general');
  const selector = '#settings-pane-general .chk input';
  // Choose the control by its visible label; preserve the settings pane's other toggles.
  await js(`(()=>{const input=[...document.querySelectorAll(${JSON.stringify(selector)})].find(i=>i.closest('label').textContent.includes('Allow agents to view the Flux window'));input.dataset.liveViewSetting='true'})()`);
  await click('[data-live-view-setting]');
  await wait(() => js('JSON.parse(localStorage.getItem("flux.settings")).allowAgentView===false'), 'viewing disabled');
  const disabled = await capture(); check(disabled.status === 403 && disabled.body.error === 'live-view-disabled', 'Settings off refuses native route with 403');
  await click('[data-live-view-setting]');
  await wait(() => js('JSON.parse(localStorage.getItem("flux.settings")).allowAgentView===true'), 'viewing enabled');
  check((await capture()).status === 200, 'Settings on restores capture');
  check(errors.length === 0, 'clean renderer console');
  fs.writeFileSync(path.join(artifacts, 'live-view-native.json'), JSON.stringify(checks, null, 2));
  win.destroy();
}
app.whenReady().then(() => main().then(() => { fs.writeSync(1, 'PROBE result=PASS\n'); process.exit(0); }).catch(e => {
  fs.writeSync(1, 'PROBE ' + String(e.stack || e) + '\n'); process.exit(1);
}));
process.stdin.resume(); process.stdin.on('end', () => process.exit(2));
setTimeout(() => process.exit(2), 90000);
