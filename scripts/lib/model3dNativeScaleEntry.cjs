'use strict';
// Production Electron entry and preload. Instrumentation observes actual worker
// messages and publication-driven frame boundaries; it never drives an idle RAF.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path');
const { assertUsableDisplay, qualifiedNativeBounds } = require('./nativeWindowQualification.cjs');
const scratch = process.env.MODEL3D_NATIVE_SCRATCH, root = process.env.MODEL3D_NATIVE_ROOT;
const out = process.env.MODEL3D_NATIVE_ARTIFACTS;
const captureBaseline = process.env.MODEL3D_NATIVE_CAPTURE_BASELINE;
const figureId = process.env.MODEL3D_NATIVE_FIGURE_ID || 'scale-models';
const expectedModels = captureBaseline ? 4 : 8;
if (!scratch || !root?.startsWith(scratch + path.sep) || !out) throw Error('Owned scratch project required');
if (captureBaseline && !path.resolve(captureBaseline).startsWith(scratch + path.sep)) throw Error('Baseline must be a separate owned scratch project');
if (!/^[a-zA-Z0-9_.-]+$/.test(figureId)) throw Error('Invalid native fixture figure id');
if (process.platform === 'linux' && (process.env.FLUX_PRIVATE_DISPLAY !== '1' || !process.argv.includes('--ozone-platform=x11'))) throw Error('Explicit private X11 required');
require('../../electron/entry.cjs');
let win, probe, measuring = false;
const checks = [], errors = [], metrics = {};
const js = code => win.webContents.executeJavaScript(code, true);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
function check(ok, label) { checks.push({ ok: !!ok, label }); console.log('PROBE ' + JSON.stringify(checks.at(-1))); if (!ok) throw Error(label); }
async function qualified() {
  if (!win.isFocused() || !win.isVisible() || !await js("document.visibilityState==='visible'&&document.hasFocus()")) throw Error('Native scale window lost focus/visibility; cohort is unqualified');
}
async function wait(fn, label, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    if (measuring) await qualified();
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await sleep(25);
  }
  throw Error(`Timeout: ${label}${last ? ': ' + last.message : ''}`);
}
async function paint() { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function point(selector) {
  return js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing native target');const b=n.getBoundingClientRect();const p={x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};if(!b.width||!b.height||!n.contains(document.elementFromPoint(p.x,p.y)))throw Error('Native target hidden or covered');return p})()`);
}
async function click(selector, clickCount = 1) {
  await qualified(); const p = await point(selector);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount, ...p });
  await paint();
}
async function screenshot(name, rect) { const image = await win.webContents.capturePage(rect); await fs.writeFile(path.join(out, name + '.png'), image.toPNG()); return image; }
const model = '.figure-mode [data-editor-element-id="scale-element-0"]';
const live = '[data-model3d-orbit="scale-element-0"] canvas[data-model3d-live]';
async function instrument() {
  await js(`(()=>{
    const evidence=window.__nativeScale={inputs:[],frames:[],workers:[],visibility:[],hostRaf:{requests:0,callbacks:0,cancels:0,pending:{},events:[],trace:true}};
    const rafEvidence=evidence.hostRaf,hostRaf=window.requestAnimationFrame,hostCancel=window.cancelAnimationFrame;
    const record=event=>{rafEvidence.events.push(event);if(rafEvidence.events.length>2048)rafEvidence.events.shift()};
    window.requestAnimationFrame=callback=>{
      rafEvidence.requests++;
      const traced=rafEvidence.trace,requestedAt=traced?performance.now():undefined;
      const stack=traced?new Error('host RAF request').stack:undefined;
      const id=hostRaf.call(window,stamp=>{
        rafEvidence.callbacks++;
        if(traced){delete rafEvidence.pending[id];if(rafEvidence.trace)record({kind:'callback',id,stamp,time:performance.now(),requestedAt,stack})}
        callback(stamp);
      });
      if(traced){rafEvidence.pending[id]={requestedAt,stack};record({kind:'request',id,time:requestedAt,stack})}
      return id;
    };
    window.cancelAnimationFrame=id=>{
      rafEvidence.cancels++;
      if(rafEvidence.trace)record({kind:'cancel',id,time:performance.now(),stack:new Error('host RAF cancel').stack});
      delete rafEvidence.pending[id];return hostCancel.call(window,id);
    };
    const state=()=>({time:performance.now(),visible:document.visibilityState,focused:document.hasFocus()});
    for(const type of ['visibilitychange','focus','blur'])window.addEventListener(type,()=>evidence.visibility.push({event:type,...state()}),true);
    document.addEventListener('pointermove',event=>{if(event.isTrusted)evidence.inputs.push({stamp:event.timeStamp,x:event.clientX,y:event.clientY,buttons:event.buttons,...state()})},true);
    document.addEventListener('flux-model3d-frame',event=>{
      const frame={...event.detail,received:performance.now(),...state()};evidence.frames.push(frame);
      requestAnimationFrame(stamp=>{frame.nextRafStamp=stamp;frame.nextRafObserved=performance.now()});
    },true);
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);this.row={url:String(args[0]),messages:[],requests:[]};evidence.workers.push(this.row);this.addEventListener('message',event=>{
        const d=event.data;if(!d||typeof d!=='object')return;
        this.row.messages.push({type:d.type,reqId:d.reqId,ms:d.ms,renderMs:d.renderMs,encodeMs:d.encodeMs,renderer:d.renderer,stats:d.stats,received:performance.now()});
      })}
      postMessage(message,...rest){if(message?.type==='render')this.row.requests.push({reqId:message.reqId,elementId:message.spec?.element?.id,time:performance.now(),width:message.spec?.w,height:message.spec?.h});return super.postMessage(message,...rest)}
    };
  })()`);
}
async function boot() {
  win = await wait(() => BrowserWindow.getAllWindows()[0], 'production BrowserWindow');
  metrics.displaySnapshot={displays:screen.getAllDisplays().map(d=>({bounds:d.bounds,workArea:d.workArea})),primary:screen.getPrimaryDisplay()};
  win.setBounds(qualifiedNativeBounds(metrics.displaySnapshot.displays,metrics.displaySnapshot.primary,1900,1050)); win.setAlwaysOnTop(true); win.show(); app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(async () => win.isFocused() && await js('document.hasFocus()'), 'owned focused window');
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await wait(() => js("!!document.querySelector('button[aria-label=Figure]')&&!!document.querySelector('.cm-editor')"), 'scratch Paper initialized');
  check(app.getPath('userData').startsWith(scratch + path.sep), 'all native preferences remain scratch');
  check(await js("location.protocol==='file:'&&!window.__flux&&!!window.fig"), 'real production bundle and preload without development handles');
  metrics.runtime = { versions: process.versions, gpuFeatures: app.getGPUFeatureStatus(), gpuInfo: await app.getGPUInfo('complete'), bounds: win.getBounds(), contentBounds: win.getContentBounds(), displays: screen.getAllDisplays().map(d=>({bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor})), viewport: await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})') };
  assertUsableDisplay(metrics.runtime.displays); check(true, 'usable nonzero native display required for GPU qualification');
  await instrument(); probe = require('./model3dNativeContextProbe.cjs')(win.webContents); await probe.arm();
  await click('button[aria-label=Figure]');
  await wait(() => js(`!!document.querySelector('.figrow[data-fig-id="${figureId}"] .item')`), 'scale Figure loaded');
  await click(`.figrow[data-fig-id="${figureId}"] .item`);
  if (!captureBaseline) {
    await click('.figure-mode .zoom button:last-child');
    await wait(()=>js("document.querySelector('.figure-mode .zoomval')?.textContent==='100%'"),'native toolbar100% fixture zoom');
    metrics.canvasVisibility=await js(`(()=>{
      const host=document.querySelector('.figure-mode .canvas-host'),h=host?.getBoundingClientRect();
      if(!host||!h)return null;
      const clip={x:Math.max(0,h.x+host.clientLeft),y:Math.max(0,h.y+host.clientTop),right:Math.min(innerWidth,h.x+host.clientLeft+host.clientWidth),bottom:Math.min(innerHeight,h.y+host.clientTop+host.clientHeight)};
      const boxes=[...document.querySelectorAll('.figure-mode [data-editor-element-id^="scale-element-"]')].map(n=>{
        const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
        return{id:n.dataset.editorElementId,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,hit:n.contains(document.elementFromPoint(x,y))};
      });return{clip,boxes};
    })()`);
    const visible=metrics.canvasVisibility;
    check(visible&&visible.clip.right>visible.clip.x&&visible.clip.bottom>visible.clip.y&&visible.boxes.length===expectedModels&&visible.boxes.every(r=>r.width>0&&r.height>0&&r.x>=visible.clip.x&&r.y>=visible.clip.y&&r.right<=visible.clip.right&&r.bottom<=visible.clip.bottom&&r.hit),'all eight model boxes are visible and hittable inside the canvas at100% fixture zoom');
  }
  await wait(() => js(`document.querySelectorAll('.figure-mode [data-model3d-poster]').length===${expectedModels}`), 'all expected decoded model posters', 90000);
  await paint();
}
async function structureAndIdle() {
  await wait(()=>js(`(()=>{const w=window.__nativeScale.workers.filter(w=>w.url.includes('model3d.worker'));if(w.length!==1)return false;const r=w[0].requests,m=w[0].messages;return new Set(r.map(x=>x.elementId)).size===${expectedModels}&&r.every(q=>m.some(a=>a.reqId===q.reqId&&(a.type==='rendered'||a.type==='error')))})()`),'all editor poster render requests completed',90000);
  const evidence = await js('window.__nativeScale');
  const workers = evidence.workers.filter(w => w.url.includes('model3d.worker'));
  check(workers.length === 1, 'distinct meshes create one actual model worker');
  const messages = workers[0].messages;
  const available = messages.find(m => m.type === 'available');
  check(available?.renderer && !/swiftshader|llvmpipe|software/i.test(available.renderer), 'worker positively identifies hardware GPU'); metrics.renderer = available.renderer;
  metrics.resident = messages.filter(m => m.stats).at(-1).stats;
  check(metrics.resident.assets === expectedModels && metrics.resident.contexts === 1, 'all expected loaded assets share one WebGL2 context');
  check(metrics.resident.residentBytes < 768 * 1024 * 1024, 'resident source-byte budget is below 768 MiB');
  const session = await probe.connect(); check(await probe.workerCount() === 1, 'CDP independently counts one model worker');
  check((await probe.state(session)).contexts === 1, 'actual worker owns one captured WebGL2 context');
  await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: "globalThis.__nativeScaleRaf=0;globalThis.__nativeScaleOriginalRaf=globalThis.requestAnimationFrame;if(globalThis.requestAnimationFrame)globalThis.requestAnimationFrame=function(cb){globalThis.__nativeScaleRaf++;return globalThis.__nativeScaleOriginalRaf.call(this,cb)}" }, session);
  const before = await js('window.__nativeScale.workers.flatMap(w=>w.messages).filter(m=>m.type===\'rendered\').length');
  const hostBefore=await js('({...structuredClone(window.__nativeScale.hostRaf),observedAt:performance.now()})');
  // Bounded observation interval is the measured idle window, not a readiness delay.
  await sleep(500);
  const after = await js('window.__nativeScale.workers.flatMap(w=>w.messages).filter(m=>m.type===\'rendered\').length');
  const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'globalThis.__nativeScaleRaf', returnByValue: true }, session);
  const hostAfter=await js('({...structuredClone(window.__nativeScale.hostRaf),observedAt:performance.now()})');
  metrics.idle = { durationMs: 500, before, after, workerRafRequests: result.result.value, hostBefore, hostAfter };
  check(hostBefore.requests===hostAfter.requests&&hostBefore.callbacks===hostAfter.callbacks,'zero host animation requests and callbacks at rest');
  check(before === after && result.result.value === 0, 'zero worker renders and animation callbacks at rest');
  probe.detach(); check(!win.webContents.debugger.isAttached(), 'debugger detached for measured native input');
  await screenshot(captureBaseline ? 'public-example-four-models' : 'eight-models');
}
async function captureImageBaseline() {
  const fixture = JSON.parse(await fs.readFile(path.join(root, 's8-fixture-receipt.json'), 'utf8'));
  const images = [];
  for (const model of fixture.additions) {
    const rect = await js(`(()=>{const n=document.querySelector('[data-editor-element-id="${model.elementId}"]');const r=n?.getBoundingClientRect();if(!r||r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight)throw Error('S8 model is outside the visible fixture');return{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);
    const image = await screenshot(model.elementId, rect);
    images.push({ ...model, png: image.toPNG(), pixelSize: image.getSize() });
    const pixels=image.toBitmap();let colored=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>30)colored++;
    check(colored>100,`S8 ${model.elementId} capture contains actual colored mesh pixels`);
  }
  await fs.cp(root, captureBaseline, { recursive: true });
  const indexPath = path.join(captureBaseline, 'fig/index.json'), index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const canvasPath = path.join(captureBaseline, 'fig/canvases', fixture.canvasId + '.json'), canvas = JSON.parse(await fs.readFile(canvasPath, 'utf8'));
  const figure = canvas.figures.find(f => f.id === fixture.figureId);
  for (const image of images) {
    const assetId = image.assetId + '-flat', assetPath = `assets/${assetId}.png`;
    await fs.writeFile(path.join(captureBaseline, 'fig', assetPath), image.png);
    index.assets.push({ id: assetId, kind: 'png', name: 'Matched 3D mesh and furniture raster', path: assetPath, naturalWidth: image.pixelSize.width, naturalHeight: image.pixelSize.height });
    const n = figure.elements.findIndex(e => e.id === image.elementId), original = figure.elements[n];
    if (original?.type !== 'model3d') throw Error('S8 original model missing');
    figure.elements[n] = { id: original.id, type: 'image', assetId, x: original.x, y: original.y, width: original.width, height: original.height, rotation: original.rotation };
  }
  await fs.writeFile(canvasPath, JSON.stringify(canvas, null, 2)); await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  metrics.baseline = { path: captureBaseline, figuresIdenticalExceptFourRasterReplacements: true, captures: images.map(({png,...rest})=>({...rest,bytes:png.length})) };
  check(images.length === 4, 'exact public example has four visible model placements and four matched raster replacements');
}
async function orbit() {
  // Diagnostic call stacks and event records stop before any Orbit timing.
  await js('window.__nativeScale.hostRaf.trace=false');
  const previous = await js('window.__nativeScale.frames.length'); await click(model, 2);
  await wait(() => js(`!!document.querySelector(${JSON.stringify(live)})&&window.__nativeScale.frames.length>${previous}`), 'live Orbit publication');
  const center = await point(live);
  const rect = await js(`(()=>{const r=document.querySelector(${JSON.stringify(live)}).getBoundingClientRect();return{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);
  const before = await screenshot('orbit-before', rect);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...center });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...center });
  measuring = true; const sent = [];
  const start = await js('performance.now()');
  for (let i = 0; i < 480; i++) {
    if (i % 16 === 0) await qualified();
    const p = { x: center.x + Math.round(35 * Math.sin(i / 19)), y: center.y + Math.round(25 * Math.sin(i / 27)) };
    sent.push({ index: i, ...p, mainTime: performance.now() });
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], ...p });
    // Defined 125 Hz input cadence; never a renderer heartbeat.
    await sleep(8);
  }
  // Final coordinate is outside the pacing path and inside the measured canvas,
  // so an earlier same-coordinate event cannot satisfy the retirement barrier.
  check(rect.width > 110, 'orbit viewport has room for a distinct final pointer coordinate');
  const last = { index: sent.length, x: center.x + 45, y: center.y, mainTime: performance.now() };
  sent.push(last); win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: last.x, y: last.y });
  const lastStamp = await wait(() => js(`window.__nativeScale.inputs.filter(e=>e.buttons===1&&e.stamp>=${start}&&e.x===${last.x}&&e.y===${last.y}).at(-1)?.stamp`), 'last delivered move');
  await wait(() => js(`window.__nativeScale.frames.some(f=>f.inputTimeStamp===${lastStamp}&&f.nextRafStamp!==undefined)`), 'last move matching publication and frame boundary');
  const releaseFrom = await js('window.__nativeScale.frames.length');
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: last.x, y: last.y });
  await wait(() => js(`window.__nativeScale.frames.slice(${releaseFrom}).some(f=>f.fullResolution&&f.nextRafStamp!==undefined)`), 'full-resolution release publication');
  await qualified(); measuring = false;
  const evidence = await js('window.__nativeScale');
  const inputs = evidence.inputs.filter(e => e.stamp >= start && e.buttons === 1);
  const frames = evidence.frames.filter(f => f.inputTimeStamp >= start && f.inputTimeStamp <= lastStamp && f.nextRafStamp !== undefined);
  // Preserve duplicate publications in raw evidence. Only their identical next
  // RAF timestamp denotes the same observed frame; all positive gaps survive.
  const boundaries = [...new Set(frames.map(f => f.nextRafStamp))].sort((a, b) => a - b);
  const gaps = boundaries.slice(1).map((t, i) => t - boundaries[i]);
  const steady = gaps.slice(6);
  const timings = evidence.workers.flatMap(w => w.messages).filter(m => m.type === 'rendered' && m.received >= start);
  metrics.orbit = { sent, delivered: inputs.length, published: frames.length, distinctPublishedInputs: new Set(frames.map(f=>f.inputTimeStamp)).size, coalescedInputs: inputs.length-new Set(frames.map(f=>f.inputTimeStamp)).size, frameBoundaries: boundaries, frameGaps: gaps, warmupGaps: 6, allGapP95FrameMs: p95(gaps), rawP95FrameMs: p95(steady), displayedP95FrameMs: Math.round(p95(steady)*10)/10, publicationP95: p95(frames.map(f=>f.paintTime-f.inputTimeStamp)), nextFrameP95: p95(frames.map(f=>f.nextRafObserved-f.inputTimeStamp)), workerRenderP95: p95(timings.map(m=>m.renderMs)), workerBitmapTransferP95: p95(timings.map(m=>m.encodeMs)) };
  const after = await screenshot('orbit-after', rect), a = before.toBitmap(), b = after.toBitmap(); let changed = 0;
  check(a.length === b.length, 'mesh viewport stays fixed during orbit');
  for (let i = 0; i < a.length; i += 4) if (Math.max(...[0,1,2].map(c=>Math.abs(a[i+c]-b[i+c]))) > 12) changed++;
  metrics.orbit.changedPixelRatio = changed / (a.length / 4);
  check(changed > 100, 'real trusted orbit changes mesh pixels');
  check(inputs.length >= 200 && frames.length >= 90 && boundaries.length >= 90, 'sustained orbit has a substantial delivered and published cohort');
  check(inputs.every(e=>e.visible==='visible'&&e.focused) && frames.every(f=>f.visible==='visible'&&f.focused), 'all measured native inputs and publications remain focused and visible');
  check(metrics.orbit.rawP95FrameMs <= 16.7, 'raw orbit observed frame-gap p95 is at most 16.7 ms');
  check(metrics.orbit.publicationP95 <= 100 && metrics.orbit.nextFrameP95 <= 100, 'matching bitmap/furniture publication and next frame meet 100 ms input budget');
}
async function main() {
  await fs.mkdir(out, { recursive: true }); await boot(); await structureAndIdle();
  if (captureBaseline) await captureImageBaseline(); else await orbit();
  const observed=await js("window.__nativeScale.workers.filter(w=>w.url.includes('model3d.worker')).length");
  check(observed===1, 'only one model worker was constructed throughout the run');
  const session = await probe.connect(); check(await probe.workerCount() === 1 && (await probe.state(session)).contexts === 1, 'orbit retains the same one-worker one-context topology'); probe.detach();
  check(errors.length === 0, 'production renderer console has no errors'); await screenshot('scene');
}
async function finish(error) {
  measuring = false; probe?.detach();
  if (error) { errors.push(error.stack || String(error)); console.error(error); }
  if (win && !win.isDestroyed()) {
    metrics.evidence = await js('window.__nativeScale').catch(()=>null);
    if (error) await screenshot('failure').catch(()=>{});
  }
  await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify({ ok: !error, status: error?.code === 'NATIVE_DISPLAY_UNAVAILABLE' ? 'capability-blocked' : error ? 'failed' : 'passed', checks, metrics, errors }, null, 2));
  console.log('PROBE result=' + (error ? 'FAIL' : 'PASS')); app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(()=>finish(),finish);
process.stdin.resume(); process.stdin.on('end',()=>app.exit(1)); process.stdin.on('close',()=>app.exit(1));
