// Layer-swap lab — does a compositor layer swap ever PRESENT a wrong frame?
//
// A bare page with a dense SVG (thousands of paths + four black corner markers)
// under a transformed wrapper, driven exactly like Canvas.svelte's scene:
//   burstStart      rest → (will-change + paused transform animation + first move) in ONE frame, 30 moves, cool
//   foldAnimating   promoted + animating; every 20 frames the baked <g> scale and the residual swap (a fold)
//   foldDemoted     the same fold, but the layer is demoted (animation cancelled, will-change off) in that frame
//   liveZoom        residual scale changes 3 % per frame for 40 frames on the promoted layer (today's zoom)
// CDP Page.startScreencast samples presented frames; it can miss frames under
// load. Samples are measured for content fraction (dark pixels)
// and the marker bounding box. A BLANK is a frame whose content collapses against
// its neighbours; a GLITCH is a bbox size that leaves the neighbours' interpolation.
//   node_modules/electron/dist/electron scripts/perf/layer-swap-lab.cjs [--ozone-platform=wayland|x11|headless]
'use strict';
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { analyze } = require('./frame-oracle.cjs');
const labRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-layer-swap-'));
app.setPath('userData', path.join(labRoot, 'profile'));
app.on('will-quit', () => fs.rmSync(labRoot, { recursive: true, force: true }));
const PATHS = 24000; // matplotlib-like: every path clipped → a paint chunk each, raster-heavy
const html = `<!doctype html><html><body style="margin:0;background:#dddddd;overflow:hidden">
<div id="host" style="position:relative;width:1200px;height:800px;overflow:hidden;background:#dddddd">
<div id="scene" style="position:absolute;inset:0;transform-origin:0 0;transform:translate3d(100px,80px,0) scale(1)">
<svg id="svg" width="2000" height="1400" xmlns="http://www.w3.org/2000/svg" style="overflow:visible"><g id="g" transform="scale(0.2)">
<rect x="0" y="0" width="1800" height="1200" fill="#ffffff"/>
<rect x="0" y="0" width="60" height="60" fill="#000"/><rect x="1740" y="0" width="60" height="60" fill="#000"/><rect x="0" y="1140" width="60" height="60" fill="#000"/><rect x="1740" y="1140" width="60" height="60" fill="#000"/>
${Array.from({ length: PATHS }, (_, i) => { const x = 80 + (i % 160) * 10.3, y = 80 + Math.floor(i / 160) * 7.2; return `<path d="M${x} ${y}l10 6 l-4 8 l12 3" stroke="#8899aa" stroke-width="1.2" fill="none" clip-path="url(#c)"/>`; }).join('')}
</g><defs><clipPath id="c"><rect width="2000" height="1400"/></clipPath></defs></svg></div></div>
<script>
  const el = document.getElementById('scene'), g = document.getElementById('g');
  // Keep all four corner markers inside the viewport at the largest scale.
  // A marker legitimately leaving the viewport is not a layer-swap glitch.
  let anim = null, s = 1, pan = { x: 100, y: 80 };
  const tf = () => 'translate3d(' + pan.x + 'px,' + pan.y + 'px,0) scale(' + s + ')';
  const frames = (t) => [{ transform: t }, { transform: t }];
  window.lab = {
    set() { const t = tf(); el.style.transform = t; if (anim) anim.effect.setKeyframes(frames(t)); },
    hot() { if (anim) return; el.style.willChange = 'transform'; anim = el.animate(frames(tf()), { duration: 1000, fill: 'both' }); anim.pause(); },
    cool() { if (!anim) return; el.style.transform = tf(); anim.cancel(); anim = null; el.style.willChange = ''; },
    move(dx, dy) { pan.x += dx; pan.y += dy; this.set(); },
    zoom(f) { s *= f; this.set(); },
    fold() { const gs = parseFloat(/scale\\(([\\d.]+)/.exec(g.getAttribute('transform'))[1]); g.setAttribute('transform', 'scale(' + (gs * s) + ')'); s = 1; this.set(); },
    raf() { return new Promise((r) => requestAnimationFrame(() => r(performance.now()))); },
  };
</script></body></html>`;

let win;
const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function frameStats(image, region, scaleX, scaleY) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  let n = 0, dark = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    n++; if (lum < 40) { dark++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { t: Date.now(), dark: +(dark / n).toFixed(4), bw: maxX >= 0 ? +((maxX - minX) / scaleX).toFixed(0) : 0, bh: maxY >= 0 ? +((maxY - minY) / scaleY).toFixed(0) : 0, x: minX >= 0 ? +(minX / scaleX).toFixed(0) : null, y: minY >= 0 ? +(minY / scaleY).toFixed(0) : null };
}
async function scenario(name, run) {
  const dbg = win.webContents.debugger;
  const frames = [];
  const [w, h] = win.getContentSize();
  const maxW = 600;
  const onMsg = (_e, method, params) => { if (method !== 'Page.screencastFrame') return; try { const img = nativeImage.createFromBuffer(Buffer.from(params.data, 'base64')); const sz = img.getSize(); const f = frameStats(img, null, sz.width / w, sz.height / h); if (params.metadata?.timestamp) f.t = params.metadata.timestamp * 1000; frames.push(f); } catch {} dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {}); };
  dbg.on('message', onMsg);
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: maxW, maxHeight: Math.round(maxW * h / w), everyNthFrame: 1 });
  await sleep(150);
  await run();
  await sleep(300);
  await dbg.sendCommand('Page.stopScreencast').catch(() => {});
  dbg.removeListener('message', onMsg);
  if (frames.length < 3) throw new Error(`${name}: insufficient captured frames (${frames.length})`);
  const res = analyze(frames);
  console.log('LAB ' + name + ' ' + JSON.stringify(res));
  return res;
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { backgroundThrottling: false } });
  const file = path.join(labRoot, 'lab.html');
  fs.writeFileSync(file, html);
  await win.loadFile(file);
  win.webContents.debugger.attach('1.3');
  await sleep(600);
  const step = async (code) => { await js(code); await js('lab.raf()'); };
  // 1. burst start: promote + animation + first move in one frame; 30 moves; cool
  await scenario('burstStart', async () => { await step('lab.hot(); lab.move(4, 3)'); for (let i = 0; i < 30; i++) await step('lab.move(3, 2)'); await sleep(120); await step('lab.cool()'); });
  await js('lab.cool()'); await sleep(200);
  // 2. folds while promoted + animating
  await scenario('foldAnimating', async () => { await step('lab.hot()'); for (let k = 0; k < 3; k++) { for (let i = 0; i < 20; i++) await step('lab.zoom(1.012)'); await step('lab.fold()'); await sleep(60); } await step('lab.cool()'); });
  await js('lab.cool(); lab.zoom(1); '); await sleep(200);
  // 3. folds with demotion in the same frame
  await scenario('foldDemoted', async () => { for (let k = 0; k < 3; k++) { await step('lab.hot()'); for (let i = 0; i < 20; i++) await step('lab.zoom(0.988)'); await step('lab.cool(); lab.fold()'); await sleep(60); } });
  await js('lab.cool()'); await sleep(200);
  // 4. live zoom on the promoted layer (today's zoom): residual changes 3% per frame
  await scenario('liveZoom', async () => { await step('lab.hot()'); for (let i = 0; i < 40; i++) await step('lab.zoom(1.012)'); for (let i = 0; i < 40; i++) await step('lab.zoom(1/1.012)'); await sleep(120); await step('lab.cool(); lab.fold()'); });
  app.quit();
}).catch((e) => { console.error('LAB FAIL', e); app.exit(1); });
