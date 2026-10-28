'use strict';
// Optional native-input-probe fixture hooks. No renderer test handles, camera
// setters or model mutation: this drives the production bundle/preload/input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertNativePointerTarget } = require('./nativeWindowQualification.cjs');

function sampleScene() {
  const test = window.__denseZoomTest, root = document.querySelector('.figure-mode');
  const byID = new Map([...root.querySelectorAll('[data-editor-element-id]')].map(n => [n.dataset.editorElementId, n]));
  // Parked (display:none) placements are resident but not displayed.
  const shown = [...byID].filter(([, n]) => !n.closest('.parked')).map(([id]) => id);
  const canvases = [...root.querySelectorAll('.zoom-proxy canvas,.zoom-proxy-coarse canvas')];
  return { ids: shown, resident: [...byID.keys()], frames: [...root.querySelectorAll('[data-annotation-figure]')].map(n => n.dataset.annotationFigure),
    changedInitial: [...test.initial].filter(([id, node]) => byID.get(id) !== node).map(([id]) => id),
    nodes: root.querySelector('.scene-svg').getElementsByTagName('*').length,
    canvasCount: canvases.length, canvasPixels: canvases.reduce((sum, n) => sum + n.width * n.height, 0),
    canvasSizes: canvases.map(n => [n.width, n.height]),
    live: !!root.querySelector('.zoom-proxy.live,.zoom-proxy-coarse.live'), liveOpacity: getComputedStyle(root.querySelector('.scene-svg')).opacity,
    additions: test.additions.slice(), removals: test.removals.slice() };
}

function presentationState() {
  const root = document.querySelector('.figure-mode');
  const info = (selector, captureText = false) => {
    const node = root.querySelector(selector); if (!node) return { present: false };
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { present: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, opacity: style.opacity,
      visibility: style.visibility, ...(captureText ? { text: node.textContent.slice(0, 120) } : {}) };
  };
  return { elapsedMs: performance.now() - window.__densePresentationStart.entry,
    focused: document.hasFocus(), visible: document.visibilityState,
    marker: info('[data-editor-element-id="dense-edit-marker"]'), layer: info('[data-layer-key="e:dense-edit-marker"]', true),
    inspector: info('.inspector', true), liveSVG: info('.scene-svg'), sharp: info('.zoom-proxy'),
    coarse: info('.zoom-proxy-coarse'), backdrop: info('.zoom-proxy-backdrop') };
}

module.exports = function denseZoomProbe({ win, js, wait, sleep, mouse, nativeWheelBurst, ctrlDown, ctrlUp, out, project }) {
  const fixture = JSON.parse(fs.readFileSync(path.join(project, 'dense-zoom-fixture.json'), 'utf8'));
  const receipt = { fixture, initial: null, stages: [], mutation: null, edit: null };
  let expectedWindow;
  const save = () => fs.writeFileSync(path.join(out, 'dense-zoom-receipt.json'), JSON.stringify(receipt, null, 2));
  const sample = () => js(`(${sampleScene.toString()})()`);
  const paint = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  let context;
  async function clickSelector(selector) {
    const observation = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing native target');const b=n.getBoundingClientRect(),point={x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)},hit=document.elementFromPoint(point.x,point.y);return{point,rect:b.toJSON(),viewport:{width:innerWidth,height:innerHeight},matches:!!hit&&(hit===n||n.contains(hit)),disabled:n.disabled===true,focused:document.hasFocus(),visible:document.visibilityState}})()`);
    assertNativePointerTarget(win, observation);
    const point = observation.point;
    await js(`(()=>{window.__densePointerUp=false;window.addEventListener('pointerup',e=>{window.__densePointerUp=e.isTrusted&&e.clientX===${point.x}&&e.clientY===${point.y}},{once:true,capture:true});return true})()`);
    mouse({ type: 'mouseMove', ...point });
    mouse({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    mouse({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait(() => js('window.__densePointerUp===true'), 'trusted native click release delivered');
    await paint(); return point;
  }
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  async function pixelAt(point, filename) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, filename), image.toPNG());
    const size = image.getSize(), viewport = await js('({width:innerWidth,height:innerHeight})');
    const x = Math.round(point.x * size.width / viewport.width), y = Math.round(point.y * size.height / viewport.height);
    assert(x >= 0 && x < size.width && y >= 0 && y < size.height, 'Independent pixel sample is on the native surface');
    const pixels = image.toBitmap(), i = (y * size.width + x) * 4;
    return [pixels[i + 2], pixels[i + 1], pixels[i]];
  }
  const center = id => js(`(()=>{const n=document.querySelector('[data-editor-element-id="'+CSS.escape(${JSON.stringify(id)})+'"]');if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  async function presentedKey(keyCode, modifiers, point, expectedPixel) {
    const expectedKey = keyCode === 'Delete' ? 'delete' : keyCode.toLowerCase();
    await js(`(()=>{window.__densePresentationPaint=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('trusted key delivery timed out')),2000);
      const listener=e=>{if(!e.isTrusted||e.key.toLowerCase()!==${JSON.stringify(expectedKey)})return;window.removeEventListener('keydown',listener,true);
        window.__densePresentationStart={entry:performance.now(),timeStamp:e.timeStamp,timeOrigin:performance.timeOrigin};
        requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(window.__densePresentationStart)}))};window.addEventListener('keydown',listener,true)});return true})()`);
    key(keyCode, modifiers);
    const delivered = await js('window.__densePresentationPaint');
    const attempts = []; let matched = false, pixel = null;
    do {
      const started = performance.now();
      // Crop directly without PNG encoding, full-window copying or an idle
      // sleep in the timing interval. A double rAF alone does not prove that
      // the native capture surface contains the newly submitted frame.
      const image = await win.webContents.capturePage({ x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 });
      const captureMs = performance.now() - started, size = image.getSize(), bytes = image.toBitmap();
      const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
      pixel = [bytes[offset + 2], bytes[offset + 1], bytes[offset]];
      const state = await js(`(${presentationState.toString()})()`);
      attempts.push({ captureMs, pixel, ...state });
      matched = pixel.every((v, i) => Math.abs(v - expectedPixel[i]) <= 3);
      if (matched || state.elapsedMs >= 100) break;
    } while (true);
    const elapsedMs = attempts.at(-1).elapsedMs;
    return { budgetMs: 100, delivered, attempts, pixel, elapsedMs, presentedInBudget: matched && elapsedMs <= 100,
      window: { id: win.id, webContentsID: win.webContents.id, url: win.webContents.getURL(), visible: win.isVisible(), focused: win.isFocused() }, expectedWindow };
  }
  return {
    async prepare(value) {
      context = value;
      expectedWindow = { id: win.id, webContentsID: win.webContents.id, url: win.webContents.getURL() };
      assert.equal(value.mode, 'figure'); assert.equal(value.sc, 'base');
      // An observed real cache, rather than a fixed sleep, makes the test
      // portable across machines and ensures that it exercises retention.
      await wait(() => js("!!document.querySelector('.figure-mode .zoom-proxy-coarse[data-overview] canvas')"), 'dense canvas overview is warm', 60000);
      await js(`(()=>{const root=document.querySelector('.figure-mode'),initial=new Map([...root.querySelectorAll('[data-editor-element-id]')].map(n=>[n.dataset.editorElementId,n]));
        const test=window.__denseZoomTest={initial,additions:[],removals:[],removed:new Set()};
        const relevant=new Set(${JSON.stringify(fixture.modelIDs)});
        test.observer=new MutationObserver(records=>{for(const [id,node]of initial)if(!node.isConnected&&!test.removed.has(id)){test.removed.add(id);test.removals.push({id,at:performance.now()})}
          for(const r of records)for(const n of r.addedNodes){if(n.nodeType!==1)continue;const id=n.getAttribute('data-editor-element-id');if(id&&relevant.has(id))test.additions.push({id,at:performance.now()});
            if(n.hasAttribute('data-annotation-figure'))for(const e of n.querySelectorAll('[data-editor-element-id]'))if(relevant.has(e.dataset.editorElementId))test.additions.push({id:e.dataset.editorElementId,at:performance.now()});}});
        test.observer.observe(root.querySelector('.scene-svg'),{subtree:true,childList:true});return true})()`);
      receipt.initial = { ...await sample(), camera: await js(value.cameraJs) };
      save();
      assert(Math.abs(receipt.initial.camera.zoom - fixture.initialZoom) < 1e-6, 'Fixture begins at the real default 0.6 zoom');
      assert(receipt.initial.nodes >= 60000 && receipt.initial.nodes <= 90000, 'Initial live DOM contains the dense 60–90k-node workload');
      assert(fixture.frameIDs.every(id => receipt.initial.frames.includes(id)), 'Both neighboring frames are initially mounted');
      assert(fixture.supplementIDs.every(id => !receipt.initial.ids.includes(id)), 'Supplement-only placements begin outside the displayed scene');
    },
    async stage(label, cycle) {
      receipt.stages.push({ label, cycle, ...await sample() }); save();
    },
    async finish() {
      receipt.mutation = await sample();
      await js('window.__denseZoomTest.observer.disconnect()');
      const widePoint = await center(fixture.markerID);
      assert(widePoint, 'Marker is live after the final wide fold');
      receipt.widePixel = await pixelAt(widePoint, 'dense-wide.png');
      save();
      // Return to a useful editing scale with the SAME trusted wheel/barrier
      // helper. This is outside the measured deep phase; no renderer camera or
      // geometry implementation is duplicated by this fixture.
      await clickSelector('.figrow[data-fig-id="zoom-frame-0"] .item');
      await js('window.__p.start()'); ctrlDown();
      try { await nativeWheelBurst(context.cx, context.cy, 0, 120, 14, ['control']); }
      finally { ctrlUp(); }
      await wait(() => js(`(()=>{const c=${context.cameraJs};return !c.proxy&&Math.abs(c.residual-1)<1e-5})()`), 'editing zoom folded');
      await js('window.__p.stop()');
      await js("window.__denseBeforeSelectionCanvas=document.querySelector('.figure-mode .zoom-proxy canvas')");
      await clickSelector(`[data-editor-element-id="${fixture.markerID}"]`);
      // A real reversible native edit gives readiness an observable content
      // revision boundary, independent of whether selection itself needed a
      // new capture. Hidden old canvases alone are not proof of a valid cache.
      const original = await center(fixture.markerID);
      await js('window.__p.start()');
      key('Right');
      await wait(async () => (await center(fixture.markerID)).x > original.x + .3, 'native setup nudge changes marker geometry');
      await paint();
      key('z', [process.platform === 'darwin' ? 'meta' : 'control']);
      await wait(async () => Math.abs((await center(fixture.markerID)).x - original.x) < .1, 'native setup undo restores marker geometry');
      await paint();
      receipt.setupKeyPaint = (await js('window.__p.stop()')).keyPaint;
      await wait(() => js("!!document.querySelector('.figure-mode .zoom-proxy-coarse[data-overview] canvas')&&!!document.querySelector('.figure-mode .zoom-proxy canvas')&&document.querySelector('.figure-mode .zoom-proxy canvas')!==window.__denseBeforeSelectionCanvas"), 'fresh post-selection sharp plane and overview are ready before the edit', 60000);
      const before = await center(fixture.markerID);
      receipt.beforeEditPixel = await pixelAt(before, 'dense-before-edit.png');
      await js('window.__p.start()'); ctrlDown();
      // Anchor the zoom at the marker itself, so its center is invariant while
      // the proxy carries the camera and the live SVG remains frozen.
      try { await nativeWheelBurst(Math.round(before.x), Math.round(before.y), 0, 40, 1, ['control']); }
      finally { ctrlUp(); }
      assert(await js("!!document.querySelector('.figure-mode .zoom-proxy.live,.figure-mode .zoom-proxy-coarse.live')"), 'The edit begins while a captured raster is actively displayed');
      // Record the marker's actual screen position through the current
      // production scene transform, then delete it via the native key path.
      const oldPoint = await center(fixture.markerID);
      const deletePresentation = await presentedKey('Delete', [], oldPoint, [255, 255, 255]);
      const deleted = await sample(), deletedPixel = deletePresentation.pixel;
      fs.writeFileSync(path.join(out, 'dense-deleted.png'), (await win.webContents.capturePage()).toPNG());
      const timing = await js('window.__p.stop()');
      const undoPresentation = await presentedKey('z', [process.platform === 'darwin' ? 'meta' : 'control'], oldPoint, fixture.markerColor);
      const restoredPixel = undoPresentation.pixel;
      fs.writeFileSync(path.join(out, 'dense-restored.png'), (await win.webContents.capturePage()).toPNG());
      receipt.edit = { deleted, deletedPixel, restoredPixel, deletePresentation, undoPresentation, keyPaint: timing.keyPaint, wheelEntryPaint: timing.wheelEntryPaint };
      save();
    },
  };
};
