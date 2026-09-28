'use strict';
// Production renderer only. Native OS dialog interaction is outside this
// unattended gate; their deterministic answers still exercise real IPC grants.
const { app, BrowserWindow, dialog, screen } = require('electron');
const { assertUsableDisplay, qualifiedNativeBounds } = require('./nativeWindowQualification.cjs');
const fs = require('node:fs/promises'), path = require('node:path');
const scratch = process.env.MODEL3D_NATIVE_SCRATCH, root = process.env.MODEL3D_NATIVE_ROOT;
const artifacts = process.env.MODEL3D_NATIVE_ARTIFACTS, scenario = process.env.MODEL3D_NATIVE_SCENARIO;
if (!scratch || !root?.startsWith(scratch + path.sep) || !artifacts || !scenario) throw Error('Hermetic model3d native context required');
if (process.platform === 'linux' && (process.env.FLUX_PRIVATE_DISPLAY !== '1' || !process.argv.includes('--ozone-platform=x11'))) throw Error('Native model3d gate requires explicit private x11 display');
const checks = [], errors = [], dialogs = [], metrics = {};
let win, contextProbe, measuringInput = false;
dialog.showOpenDialog = async (_win, opts) => {
  dialogs.push({ kind: 'open', filters: opts.filters });
  return { canceled: false, filePaths: [path.join(root, scenario === 'shape' ? 'plots/cortex-states.glb' : scenario === 'field' ? 'plots/continuous.glb' : 'plots/neuron.glb')] };
};
dialog.showSaveDialog = async (_win, opts) => {
  const filePath = path.join(root, 'exports', `${dialogs.filter(dialog => dialog.kind === 'save').length + 1}-${path.basename(opts.defaultPath)}`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  dialogs.push({ kind: 'save', filePath, filters: opts.filters });
  return { canceled: false, filePath };
};
require('../../electron/entry.cjs');
const js = code => win.webContents.executeJavaScript(code, true);
const paint = () => js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
function check(value, label) {
  checks.push({ ok: !!value, label });
  console.log('PROBE ' + JSON.stringify(checks.at(-1)));
  if (!value) throw Error(label);
}
async function wait(fn, label, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    if (measuringInput) await timingWindow();
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
async function timingWindow() {
  if (!await js("document.visibilityState==='visible'&&document.hasFocus()")) throw Error('Native input measurement lost its visible focused window; timing cohort is unqualified');
}
async function focus() {
  await wait(async () => { app.focus({ steal: true }); win.focus(); win.webContents.focus(); return win.isFocused() && await js('document.hasFocus()'); }, 'native focus');
}
async function point(selector) {
  return js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing ${selector.replaceAll("'", '')}');n.scrollIntoView({block:'nearest'});const b=n.getBoundingClientRect();if(!b.width||!b.height)throw Error('Hidden control');const p={x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};if(!n.contains(document.elementFromPoint(p.x,p.y)))throw Error('Covered control');return p})()`);
}
async function click(selector, clickCount = 1) {
  await focus(); const p = await point(selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...p });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...p });
  await paint();
}
async function clickText(selector, text) {
  await js(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing ${text}');n.dataset.nativeModelHit='1'})()`);
  try { await click('[data-native-model-hit="1"]'); }
  finally { await js("document.querySelector('[data-native-model-hit]')?.removeAttribute('data-native-model-hit')"); }
}
async function key(keyCode, modifiers = []) {
  await focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await paint();
}
async function screenshot(name) {
  const file = path.join(artifacts, name + '.png');
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
  return file;
}
async function savedFigure() {
  const canvas = JSON.parse(await fs.readFile(path.join(root, 'fig/canvases/native-canvas.json'), 'utf8'));
  return canvas.figures.find(figure => figure.id === 'native-model');
}
const modelSelector = '.figure-mode [data-editor-element-id]:has(.model3d-hit-area)';
async function modelState() {
  const figure = await savedFigure(); return figure.elements.find(element => element.type === 'model3d');
}
async function instrument() {
  await js(`(()=>{
    const evidence=window.__nativeModelEvidence={inputs:[],frames:[],workers:[],visibility:[],pending:0};
    const visibility=()=>({time:performance.now(),state:document.visibilityState,focused:document.hasFocus()});
    for(const type of ['visibilitychange','focus','blur'])window.addEventListener(type,()=>evidence.visibility.push({...visibility(),event:type}),true);
    for(const type of ['pointerdown','pointermove','pointerup','wheel','keydown'])document.addEventListener(type,event=>{
      if(!event.isTrusted)return;
      evidence.inputs.push({type,timeStamp:event.timeStamp,key:event.key,buttons:event.buttons,x:event.clientX,y:event.clientY,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,...visibility()});
    },true);
    document.addEventListener('flux-model3d-frame',event=>{
      const row={...event.detail,received:performance.now(),...visibility()};evidence.frames.push(row);evidence.pending++;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{row.nextFrame=performance.now();evidence.pending--}));
    },true);
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker{constructor(...args){super(...args);const row={url:String(args[0]),messages:[]};evidence.workers.push(row);this.addEventListener('message',event=>{if(['available','lost','restored'].includes(event.data?.type)||event.data?.renderer)row.messages.push(event.data)})}};
  })()`);
}
async function boot() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], 'production window');
  const displays = screen.getAllDisplays(), primary = screen.getPrimaryDisplay();
  metrics.displayQualification = { displays, primary };
  win.setBounds(qualifiedNativeBounds(displays, primary, 1440, 1040));
  win.setAlwaysOnTop(true); win.show(); await focus();
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await wait(() => js("!!document.querySelector('button[aria-label=Figure]')&&!!document.querySelector('.cm-editor')"), 'scratch Paper ready');
  check(app.getPath('userData').startsWith(scratch + path.sep), 'native preferences are contained in scratch');
  check(await js("location.protocol==='file:'&&!window.__flux&&!!window.fig"), 'built production renderer uses actual preload without development handles');
  metrics.boot = { url: win.webContents.getURL(), versions: process.versions, platform: process.platform,
    gpuFeatures: app.getGPUFeatureStatus(), gpuInfo: await app.getGPUInfo('complete'),
    viewport: await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState,focused:document.hasFocus()})'),
    bounds: win.getBounds(), contentBounds: win.getContentBounds(), displays: screen.getAllDisplays().map(d=>({bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor})), scenario };
  assertUsableDisplay(metrics.boot.displays);
  await instrument();
  if (scenario === 'hardware' || scenario === 'software') {
    contextProbe = require('./model3dNativeContextProbe.cjs')(win.webContents);
    await contextProbe.arm();
  }
  await click('button[aria-label=Figure]');
  await wait(() => js("!!document.querySelector('.figure-mode .canvas-host')&&!!document.querySelector('.figrow[data-fig-id=\"native-model\"]')"), 'canonical Figure loaded');
  await click('.figrow[data-fig-id="native-model"] .item');
  await clickText('.figure-mode .toolbar .zoom button', '100%');
}
async function importModel() {
  await clickText('.figure-mode .toolbar button', 'Import');
  await wait(() => js(`!!document.querySelector(${JSON.stringify(modelSelector)})`), 'native GLB placement');
  const state = await wait(modelState, 'import saved through real project persistence');
  check(state.width === (scenario==='shape'?288:336) && state.height === 288, 'import preserves authored physical dimensions');
  check(dialogs.some(dialog => dialog.kind === 'open' && dialog.filters?.some(filter => filter.extensions?.includes('glb'))), 'toolbar uses actual GLB file-picker bridge and native grant');
  return state;
}
async function rendered() {
  await wait(() => js("(()=>{const image=document.querySelector('.figure-mode [data-model3d-poster]');return !!image?.href.baseVal.startsWith('data:image/png')&&!image.closest('.editing-hidden')&&!document.querySelector('[data-model3d-preview]')})()"), 'decoded model PNG visible after live overlay retirement');
  await paint();
}
const orbitSelector = '[data-model3d-orbit] canvas[data-model3d-live]';
const view = element => Object.fromEntries(['orbitAzimuth', 'orbitElevation', 'orbitRoll', 'orbitZoom', 'orbitPanX', 'orbitPanY', 'orbitProjection', 'orbitFov'].map(key => [key, element[key] ?? (key === 'orbitRoll' || key === 'orbitPanX' || key === 'orbitPanY' ? 0 : undefined)]));
const p95 = samples => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
async function captureMesh(name) {
  const rect = await js(`(()=>{const b=document.querySelector(${JSON.stringify(orbitSelector)})?.getBoundingClientRect()??document.querySelector('[data-model3d-poster]')?.getBoundingClientRect();if(!b)throw Error('No mesh surface');return{x:Math.floor(b.x),y:Math.floor(b.y),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()`);
  const image = await win.webContents.capturePage(rect);
  await fs.writeFile(path.join(artifacts, name + '.png'), image.toPNG());
  return { bytes: image.toBitmap(), width: image.getSize().width, height: image.getSize().height };
}
function pixelDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw Error('Mesh surface size changed during comparison');
  let changed = 0;
  for (let i = 0; i < a.bytes.length; i += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(a.bytes[i + channel] - b.bytes[i + channel]))) > 12) changed++;
  return changed / (a.bytes.length / 4);
}
async function openOrbit() {
  const previous = await js('window.__nativeModelEvidence.frames.length');
  await click(modelSelector, 2);
  await wait(() => js(`!!document.querySelector(${JSON.stringify(orbitSelector)})&&window.__nativeModelEvidence.frames.length>${previous}`), 'actual live bitmap publication after native double-click');
  await paint();
  check(await js("!document.querySelector('.zoom-proxy.active')"), 'orbit suppresses the zoom proxy');
}
async function measuredOrbit() {
  contextProbe.detach();
  check(!win.webContents.debugger.isAttached(), 'worker diagnostic debugger is detached during native latency measurement');
  const baseline = view(await modelState());
  await openOrbit();
  const before = await captureMesh('orbit-before');
  const start = await point(orbitSelector);
  await js('window.__nativeModelEvidence.frames.length=0;window.__nativeModelEvidence.inputs.length=0;void 0');
  measuringInput = true;
  // One matching render per paced input, followed by a genuine continuous
  // native drag burst. Coalesced requests are counted, never called painted.
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
  let sent = 0;
  for (let i = 1; i <= 30; i++) {
    const count = await js('window.__nativeModelEvidence.inputs.length');
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: start.x + i * 2, y: start.y + Math.round(i / 3) }); sent++;
    const stamp = await wait(() => js(`window.__nativeModelEvidence.inputs.slice(${count}).find(input=>input.type==='pointermove'&&input.buttons===1)?.timeStamp`), 'trusted native drag input');
    await wait(() => js(`window.__nativeModelEvidence.frames.some(frame=>frame.inputTimeStamp===${stamp}&&frame.nextFrame)`), 'matching bitmap and next paint frame');
  }
  const pacedEnd = await js('window.__nativeModelEvidence.frames.length');
  const burstInputStart = await js('window.__nativeModelEvidence.inputs.length');
  for (let i = 1; i <= 36; i++) {
    await timingWindow();
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: start.x + 60 + i, y: start.y + 10 + Math.round(Math.sin(i / 4) * 8) }); sent++;
    await js('new Promise(resolve=>requestAnimationFrame(resolve))');
  }
  const lastBurstStamp = await wait(() => js(`window.__nativeModelEvidence.inputs.slice(${burstInputStart}).findLast(input=>input.type==='pointermove'&&input.buttons===1&&input.x===${start.x + 96}&&input.y===${start.y + 10 + Math.round(Math.sin(9) * 8)})?.timeStamp`), 'last sent burst coordinate delivered');
  await wait(() => js(`window.__nativeModelEvidence.frames.some(frame=>frame.inputTimeStamp===${lastBurstStamp}&&frame.nextFrame)`), 'last burst input matching publication and next frame');
  const releaseStart = await js('window.__nativeModelEvidence.frames.length');
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x + 96, y: start.y + 10 + Math.round(Math.sin(9) * 8) });
  await wait(() => js(`window.__nativeModelEvidence.frames.slice(${releaseStart}).some(frame=>frame.inputTimeStamp===${lastBurstStamp}&&frame.fullResolution&&frame.nextFrame)`), 'release publishes full-resolution latest view');
  await wait(() => js('window.__nativeModelEvidence.pending===0'), 'paint observations settled');
  const evidence = await js('window.__nativeModelEvidence');
  measuringInput = false;
  const dragInputs = evidence.inputs.filter(input => input.type === 'pointermove' && input.buttons === 1);
  const stamps = new Set(dragInputs.map(input => input.timeStamp));
  const seen = new Set();
  const frames = evidence.frames.filter(frame => stamps.has(frame.inputTimeStamp) && frame.nextFrame && !seen.has(frame.inputTimeStamp) && seen.add(frame.inputTimeStamp));
  const publication = frames.map(frame => frame.paintTime - frame.inputTimeStamp);
  const nextFrame = frames.map(frame => frame.nextFrame - frame.inputTimeStamp);
  const burstStamps = new Set(evidence.inputs.slice(burstInputStart).filter(input=>input.type==='pointermove'&&input.buttons===1).map(input=>input.timeStamp));
  const burstPublished = frames.filter(frame=>burstStamps.has(frame.inputTimeStamp)).length;
  metrics.orbit = { sent, delivered: stamps.size, published: frames.length, pacedEnd, paced: {sent:30,delivered:stamps.size-burstStamps.size,published:frames.length-burstPublished}, burst: {sent:36,delivered:burstStamps.size,published:burstPublished,lastInputTimeStamp:lastBurstStamp}, publicationP95: p95(publication), nextFrameP95: p95(nextFrame), publication, nextFrame, frames, visibility: evidence.visibility,
    measure: 'Native DOM event timestamp to matching bitmap+furniture publication, and double-rAF observation after that publication; not a GPU fence or physical scanout.' };
  check(stamps.size >= 60 && frames.length >= 30, 'real native drag reaches production orbit and yields at least 30 correlated frames');
  check(dragInputs.every(input => input.state === 'visible' && input.focused) && frames.every(frame => frame.state === 'visible' && frame.focused), 'all measured native input and publications occur in the visible focused production window');
  check(publication.every(ms => ms >= 0) && nextFrame.every(ms => ms >= 0), 'event and paint timestamps share the monotonic clock');
  check(metrics.orbit.publicationP95 <= 100 && metrics.orbit.nextFrameP95 <= 100, `native orbit publication p95 ${metrics.orbit.publicationP95.toFixed(1)} ms and next-frame p95 ${metrics.orbit.nextFrameP95.toFixed(1)} ms ≤ 100 ms`);
  const after = await captureMesh('orbit-after');
  metrics.orbit.changedPixelRatio = pixelDifference(before, after);
  check(metrics.orbit.changedPixelRatio > .005, 'native orbit visibly changes actual neuron pixels');
  await screenshot('orbit-native');
  await key('Return');
  await wait(() => js("!document.querySelector('[data-model3d-orbit]')"), 'Enter commits and retires the overlay');
  // Autosave can still contain an intermediate drag state immediately after
  // Enter. Wait for the final displacement actually sent, not any changed pose.
  const expectedAzimuth = baseline.orbitAzimuth - 96 * .4;
  const expectedElevation = baseline.orbitElevation + (10 + Math.round(Math.sin(9) * 8)) * .4;
  const committed = await wait(async () => { const state = view(await modelState()); return Math.abs(state.orbitAzimuth - expectedAzimuth) < 1e-8 && Math.abs(state.orbitElevation - expectedElevation) < 1e-8 && state; }, 'final committed pointer pose persisted');
  await rendered();
  await key('Z', [process.platform === 'darwin' ? 'meta' : 'control']);
  await wait(async () => JSON.stringify(view(await modelState())) === JSON.stringify(baseline), 'one Undo restores full orbit baseline');
  check(true, 'entire native orbit visit is one persisted undo entry');
  await key('Z', [process.platform === 'darwin' ? 'meta' : 'control', 'shift']);
  await wait(async () => JSON.stringify(view(await modelState())) === JSON.stringify(committed), 'Redo restores committed view');
  await key('S', [process.platform === 'darwin' ? 'meta' : 'control']);
  metrics.saved = await modelState();
  await rendered();
  // Axis views and cancellation are native keyboard input, outside timing.
  await openOrbit();
  for (const keyCode of ['1', '2', '3', '4', '5', '6', '0', 'P']) {
    const previous = await js('window.__nativeModelEvidence.frames.length'); await key(keyCode);
    await wait(() => js(`window.__nativeModelEvidence.frames.length>${previous}`), `native ${keyCode} publishes a frame`);
  }
  await key('Escape');
  await wait(() => js("!document.querySelector('[data-model3d-orbit]')"), 'Escape cancels orbit');
  check(JSON.stringify(view(await modelState())) === JSON.stringify(committed), 'Escape retains the saved view after native axis, Home and projection previews');
}
async function contextRecovery() {
  await rendered(); await openOrbit();
  const session = await contextProbe.connect(), initial = await contextProbe.state(session);
  const modelWorkers = () => js("window.__nativeModelEvidence.workers.filter(worker=>worker.url.includes('model3d.worker')).length");
  check(await modelWorkers() === 1 && await contextProbe.workerCount() === 1 && initial?.contexts === 1 && !initial.isContextLost && !contextProbe.failures.length, 'exactly one actual model worker and one WebGL2 context exist');
  const before = await captureMesh('context-before');
  await contextProbe.lose(session);
  await wait(async () => (await contextProbe.state(session)).lost > initial.lost, 'actual worker webglcontextlost event');
  await wait(() => js("window.__nativeModelEvidence.workers.some(worker=>worker.messages.some(message=>message.type==='lost'))&&document.body.textContent.includes('3D context interrupted; waiting for recovery')"), 'production context-loss message and visible recovery hint');
  const lost = await captureMesh('context-lost');
  check(pixelDifference(before, lost) === 0, 'context loss preserves the last complete neuron bitmap');
  const p = await point(orbitSelector), count = await js('window.__nativeModelEvidence.inputs.length');
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
  win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: p.x + 24, y: p.y + 10 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: p.x + 24, y: p.y + 10 });
  const stamp = await wait(() => js(`window.__nativeModelEvidence.inputs.slice(${count}).find(input=>input.type==='pointermove'&&input.buttons===1)?.timeStamp`), 'native input while the worker context is lost');
  await contextProbe.restore(session);
  await wait(async () => { const state = await contextProbe.state(session); return state.restored > initial.restored && !state.isContextLost; }, 'actual worker webglcontextrestored event');
  await wait(() => js(`window.__nativeModelEvidence.workers.some(worker=>worker.messages.some(message=>message.type==='restored'))&&window.__nativeModelEvidence.frames.some(frame=>frame.inputTimeStamp===${stamp}&&frame.nextFrame)`), 'latest view publishes again through the production recovery path');
  const after = await captureMesh('context-restored');
  metrics.context = { initial, final: await contextProbe.state(session), changedPixelRatio: pixelDifference(before, after), failures: contextProbe.failures };
  check(metrics.context.changedPixelRatio > .005, 'recovered production worker renders the latest pending view');
  contextProbe.detach();
  await key('Escape'); await rendered(); await openOrbit(); await key('Escape'); await rendered();
  const reopened = await contextProbe.connect();
  metrics.context.reopened = await contextProbe.state(reopened);
  check(await modelWorkers() === 1 && await contextProbe.workerCount() === 1 && metrics.context.reopened?.contexts === 1 && metrics.context.reopened.restored === 1, 'Orbit reopens after recovery without creating another worker or context');
  contextProbe.detach();
}
async function nativeModifierHandoff() {
  const baseline = view(await modelState()); await openOrbit();
  const p = await point(orbitSelector), count = await js('window.__nativeModelEvidence.inputs.length');
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
  win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: p.x + 20, y: p.y });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: p.x + 20, y: p.y });
  const stamp = await wait(() => js(`window.__nativeModelEvidence.inputs.slice(${count}).find(input=>input.type==='pointermove'&&input.buttons===1)?.timeStamp`), 'native modifier test drag');
  await wait(() => js(`window.__nativeModelEvidence.frames.some(frame=>frame.inputTimeStamp===${stamp}&&frame.nextFrame)`), 'modifier test changed view');
  // One key event carries the native modifier bit; there is deliberately no
  // separate Control keydown that could settle the overlay ahead of the chord.
  await key('Z', [process.platform === 'darwin' ? 'meta' : 'control']);
  await wait(() => js("!document.querySelector('[data-model3d-orbit]')"), 'native Undo exits orbit');
  await wait(async () => JSON.stringify(view(await modelState())) === JSON.stringify(baseline), 'same native chord undoes the orbit visit');
  await rendered();
  check(true, 'single native modifier chord both exits and undoes orbit');
}
async function nativeShapeHistory() {
  await rendered();
  await click(modelSelector);
  const selector='input[type="range"][aria-label="inflated shape weight"]';
  await wait(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),'native Shape controls');
  const baseline=(await modelState()).modelStates??{}, before=await captureMesh('shape-before');
  await point(selector);
  const rect=await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(b.x+8),end:Math.round(b.x+b.width*.68),y:Math.round(b.y+b.height/2)}})()`);
  await focus();
  win.webContents.sendInputEvent({type:'mouseMove',x:rect.x,y:rect.y});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:rect.x,y:rect.y});
  for(let i=1;i<=8;i++){
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:Math.round(rect.x+(rect.end-rect.x)*i/8),y:rect.y});
    await paint();
  }
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:rect.end,y:rect.y});
  const value=await wait(()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&Number(n.value)>.5&&Number(n.value)})()`),'actual native range drag changes shape');
  await wait(async()=>Math.abs(((await modelState()).modelStates?.inflated??0)-value)<1e-8,'shape drag persisted');
  await rendered(); const after=await captureMesh('shape-after');
  check(pixelDifference(before,after)>.005,'native Shape drag visibly changes the actual cortex mesh');
  check(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),'Shape range retains focus after native drag');
  await key('Z',[process.platform==='darwin'?'meta':'control']);
  await wait(async()=>JSON.stringify((await modelState()).modelStates??{})===JSON.stringify(baseline),'focused range one Undo restores all baseline shape weights');
  check(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&Number(document.activeElement.value)===${baseline.inflated??0}`),'native Ctrl/Cmd+Z reaches Flux history while Shape range keeps focus');
  await key('Z',[process.platform==='darwin'?'meta':'control','shift']);
  await wait(async()=>Math.abs(((await modelState()).modelStates?.inflated??0)-value)<1e-8,'focused range Redo restores drag');
  check(await js(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&Number(document.activeElement.value)===${value}`),'native focused Shape Redo restores the same value');
  await rendered();
  metrics.shape={baseline,changedValue:value,changedPixelRatio:pixelDifference(before,after),saved:await modelState()};
  await screenshot('shape-native');
}
async function selectValue(selector, value) {
  const index = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return [...n.options].findIndex(option=>option.value===${JSON.stringify(String(value))})})()`);
  if (index < 0) throw Error(`Missing option ${value}`);
  await click(selector); await key('Home');
  for (let i = 0; i < index; i++) await key('Down');
  await key('Return');
  check(await js(`document.querySelector(${JSON.stringify(selector)}).value`) === String(value), `native select chooses ${value}`);
}
async function exports() {
  const exported = [];
  for (const [label, selector] of [['png300', '.inspector button[title^="Quick PNG"]'], ['svg', '.inspector button[title="Vector SVG"]'], ['pdf', '.inspector button[title="Vector PDF"]']]) {
    const count = dialogs.length; await click(selector);
    const dialog = await wait(() => dialogs.slice(count).find(item => item.kind === 'save'), `${label} native save dialog after poster readiness`);
    await wait(async () => (await fs.stat(dialog.filePath)).size > 100, `${label} actual export bytes`);
    exported.push({ label, file: dialog.filePath });
  }
  await click('.journal-export > summary');
  await selectValue('.journal-export select', 'custom');
  await click('.journal-export input[type="number"]'); await key('A', [process.platform === 'darwin' ? 'meta' : 'control']);
  await win.webContents.insertText('158.75'); await key('Tab');
  await selectValue('.journal-export label:has(select):nth-last-of-type(2) select', '600');
  for (const [label, text] of [['png600', 'PNG'], ['tiff600', 'TIFF']]) {
    const count = dialogs.length; await clickText('.journal-export button', text);
    const dialog = await wait(() => dialogs.slice(count).find(item => item.kind === 'save'), `${label} native export dialog`);
    await wait(async () => (await fs.stat(dialog.filePath)).size > 100, `${label} actual export bytes`);
    exported.push({ label, file: dialog.filePath });
  }
  metrics.exports = [];
  for (const item of exported) {
    const name = item.label + path.extname(item.file); await fs.copyFile(item.file, path.join(artifacts, name));
    metrics.exports.push({ label: item.label, file: name, bytes: (await fs.stat(item.file)).size });
  }
  check(exported.length === 5, 'actual native PNG300, PNG600, TIFF600, SVG and PDF exports complete');
}
async function main() {
  await fs.mkdir(artifacts, { recursive: true }); await boot();
  if (scenario === 'reopen' || scenario === 'disabled-cached') {
    const saved = await modelState(); check(!!saved, 'fresh production process reloads the saved model');
    await rendered(); metrics.saved = saved;
    if (scenario === 'disabled-cached') check(await js("!window.__nativeModelEvidence.workers.some(worker=>worker.url.includes('model3d.worker'))"), 'disabled cached model draws its stored poster without creating a model worker');
  } else {
    const imported = await importModel(); metrics.imported = imported;
    if (scenario.startsWith('disabled')) {
      await wait(() => js("!!document.querySelector('.figure-mode [data-model3d-placeholder]')"), 'disabled service shows named placeholder');
      check(await js(`document.querySelector('.figure-mode [data-model3d-placeholder]')?.textContent.includes(${JSON.stringify(imported.name)})`), 'disabled uncached model has a named fallback');
      check(await js("document.querySelectorAll('.figure-mode [data-model3d-furniture] text').length>0"), 'vector furniture remains visible without WebGL');
    } else {
      await rendered();
      if(['semantics','field','paper','source'].includes(scenario)) await require('./model3dNativeSmoke.cjs')({scenario,root,artifacts,js,check,wait,click,clickText,key,screenshot,modelState,rendered,modelSelector,captureMesh,pixelDifference,metrics,inputText:async text=>win.webContents.insertText(text)});
      else if(scenario==='shape') await nativeShapeHistory();
      else {
        await measuredOrbit();
        await contextRecovery();
        await nativeModifierHandoff();
        if (scenario === 'hardware') await exports();
      }
    }
  }
  await wait(() => js("document.querySelectorAll('.toasts .toast').length===0"), 'transient notifications retire before final scene screenshot');
  await screenshot('scene');
  metrics.evidence = await js('window.__nativeModelEvidence');
  const renderers = metrics.evidence.workers.flatMap(worker => worker.messages).filter(message => message.type === 'available').map(message => message.renderer);
  metrics.renderers = renderers;
  if (['hardware','shape','semantics','field','paper','source'].includes(scenario)) check(renderers.length > 0 && renderers.every(renderer => !/swiftshader|llvmpipe|software/i.test(renderer)), 'normal production path positively uses the hardware worker renderer');
  if (scenario === 'software') check(renderers.some(renderer => /swiftshader/i.test(renderer)), 'SOFTGPU path positively uses the SwiftShader worker renderer');
  if (scenario === 'disabled') check(!metrics.evidence.workers.some(worker => worker.url.includes('model3d.worker')), 'disabled renderer creates no model worker');
  check(errors.length === 0, `production console has no errors: ${errors.join('; ')}`);
}
async function finish(error) {
  contextProbe?.detach();
  if (error) { errors.push(error.stack || String(error)); console.error(error.stack || error); if (win && !win.isDestroyed()) {
    metrics.evidence = await js('window.__nativeModelEvidence').catch(() => null);
    metrics.savedAtFailure = await modelState().catch(() => null);
    metrics.controlsAtFailure = await js("({active:document.activeElement?.outerHTML,undo:document.querySelector('button[title^=Undo]')?.outerHTML,redo:document.querySelector('button[title^=Redo]')?.outerHTML,visibility:document.visibilityState,focused:document.hasFocus()})").catch(() => null);
    await screenshot('failure').catch(() => {}); console.error(await js('document.body.textContent.slice(-16000)').catch(() => ''));
  } }
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify({ scenario, status: error?.code === 'NATIVE_DISPLAY_UNAVAILABLE' ? 'capability-blocked' : error ? 'failed' : 'passed', checks, metrics, dialogs, errors, ok: !error }, null, 2));
  console.log('PROBE result=' + (error ? 'FAIL' : 'PASS'));
  app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish(), finish);
process.stdin.resume(); process.stdin.on('end', () => app.exit(1)); process.stdin.on('close', () => app.exit(1));
