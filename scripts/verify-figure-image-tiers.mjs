// Display tiers in the real canvas (policy gate: verify-image-tiers.ts).
//
// The owner's Figure 22 — nine 28 MP PNGs — froze the editor 520–1,033 ms after every zoom, drag and
// nudge: the live DOM, and so every scene capture, carried the originals (2026-11-09). What this gate
// holds, with real wheel input over the browser bridge:
//   (a) at rest the canvas paints TIERS: no image element holds its original, and a tier has at most
//       ~2× the pixels the screen needs;
//   (b) a scene capture carries tiers only — its size follows the screen, not the files;
//   (c) deep zoom draws a DETAIL of the visible part over the capped tier, and no capture contains it;
//   (d) exports still embed the ORIGINAL bytes (tiers are display only);
//   (e) a small image is never tiered; replaced bytes get new tiers;
//   (f) negative proof: with tiers off the same canvas holds the originals and (a)/(b) fail;
//   (g) a PICTURED figure shows its images: no picture is taken while an image still waits for its first
//       tier (the owner's Figure 22 was pictured as nine grey boxes), a waiting image draws nothing rather
//       than a grey box, and the picture survives leaving, editing and returning;
//   (h) the raster service is sent TIERS, never the originals whose bytes it would refuse.
import { launch, shot, realErrors, waitFor, gotoApp, clickMode, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';

const h = harness('verify-figure-image-tiers');
const { browser, page } = await launch({ width: 1600, height: 1000 });
const ROOT = '/demo/image-tiers', BIG = { w: 6000, h: 3000 }, SMALL = { w: 500, h: 400 };

/** Two figures: A places four 18 MP images and one small one; B places one more big image. */
async function install(target = page) {
  return target.evaluate(async ({ ROOT, BIG, SMALL }) => {
    const F = window.fig;
    const png = async (w, hgt, seed) => {
      const c = new OffscreenCanvas(w, hgt), g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, w, hgt); grad.addColorStop(0, `hsl(${seed * 67 % 360} 70% 55%)`); grad.addColorStop(1, `hsl(${(seed * 67 + 140) % 360} 60% 30%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, hgt);
      // One-pixel line work: what a downsampled copy loses and a detail must bring back.
      g.strokeStyle = '#111'; g.lineWidth = 1;
      for (let x = 0.5; x < w; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hgt); g.stroke(); }
      for (let y = 0.5; y < hgt; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      // Incompressible bytes, so the original weighs megabytes like a real micrograph.
      const side = Math.min(700, w, hgt), noise = g.createImageData(side, side);
      let s = seed * 2654435761 >>> 0;
      for (let i = 0; i < noise.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; noise.data[i] = s >>> 24; noise.data[i + 1] = (s >>> 16) & 255; noise.data[i + 2] = (s >>> 8) & 255; noise.data[i + 3] = 255; }
      g.putImageData(noise, 0, 0);
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    };
    const assets = [], bytes = {};
    const add = async (id, size, seed) => { const b = await png(size.w, size.h, seed); bytes[id] = b.length; await F.writeFile(`${ROOT}/fig/assets/${id}.png`, b); assets.push({ id, kind: 'png', path: `assets/${id}.png`, name: `${id}.png`, naturalWidth: size.w, naturalHeight: size.h }); };
    for (let i = 1; i <= 5; i++) await add(`big-${i}`, BIG, i);
    await add('small-1', SMALL, 9);
    const image = (id, assetId, x, y, width, height) => ({ type: 'image', id, assetId, x, y, width, height, rotation: 0 });
    const figures = [
      { id: 'fig-a', name: 'Images', canvasId: 'canvas-1', x: 0, y: 0, width: 680, height: 520, background: '#ffffff', elements: [
        image('img-1', 'big-1', 20, 20, 300, 150), image('img-2', 'big-2', 360, 20, 300, 150),
        image('img-3', 'big-3', 20, 190, 300, 150), image('img-4', 'big-4', 360, 190, 300, 150),
        image('img-s', 'small-1', 20, 360, 125, 100),
        { type: 'text', id: 'label', x: 360, y: 380, width: 200, height: 20, rotation: 0, text: 'Label', fontFamily: 'Arial', fontSize: 14, fontWeight: 400, fontStyle: 'normal', align: 'left', color: '#222222', sizing: 'auto' },
      ] },
      { id: 'fig-b', name: 'Other', canvasId: 'canvas-1', x: 760, y: 0, width: 400, height: 300, background: '#ffffff', elements: [image('img-5', 'big-5', 20, 20, 360, 180)] },
    ];
    await F.writeText(`${ROOT}/fig/canvases/canvas-1.json`, JSON.stringify({ schemaVersion: '0.1.0', id: 'canvas-1', name: 'Canvas 1', figures }));
    await F.writeText(`${ROOT}/fig/index.json`, JSON.stringify({ schemaVersion: '0.1.0', canvases: [{ id: 'canvas-1', name: 'Canvas 1', order: 1 }],
      figures: figures.map((f, i) => ({ id: f.id, name: f.name, label: f.id, order: i + 1, kind: 'main', canvas: 'canvas-1', caption: '' })), assets, palette: [] }));
    return { bytes };
  }, { ROOT, BIG, SMALL });
}
async function load(target = page, active = 'fig-a') {
  await target.evaluate(async ({ root, active }) => {
    const F = window.__flux;
    await F.bridge.loadFigInto(root, 'tiers');
    F.fig.activeCanvasId.set('canvas-1'); F.fig.activeFigureId.set(active);
    F.fig.selectedFrameId.set(null); F.fig.selection.set(new Set());
    F.settings.update(s => ({ ...s, snapGrid: false, snapPixel: false, smartGuides: false }));
    const host = document.querySelector('.canvas-host');
    F.fig.viewport.set({ zoom: 1, panX: (host.clientWidth - 1160) / 2, panY: 90 });
  }, { root: ROOT, active });
}
/** A fresh page on the Figure editor with the fixture installed (not yet loaded). */
async function freshPage() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1600, height: 1000 });
  await p.evaluateOnNewDocument(() => { window.__name ??= f => f; });
  await gotoApp(p, { url: APP_URL + '?fixture=demo', settle: 100 });
  await clickMode(p, 'Figure');
  await waitFor(p, () => !!window.__flux?.fig && !!window.__flux.imageDisplay && !!document.querySelector('.canvas-host'), null, { timeout: 20000, label: 'Figure ready' });
  return p;
}
/** The colour a figure's PICTURE holds at a figure-local point, and the picture's key. */
const pictureAt = (target, figureId, x, y) => target.evaluate(async ({ figureId, x, y }) => {
  const node = document.querySelector(`[data-figure-raster="${figureId}"]`); if (!node) return null;
  const fig = window.__flux.figures().find(f => f.id === figureId), img = new Image(); img.src = node.getAttribute('href'); await img.decode();
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight), g = c.getContext('2d'); g.drawImage(img, 0, 0);
  // Average a small patch: one sample could land on a grid line of the fixture image.
  const px = Math.round(x / fig.width * img.naturalWidth), py = Math.round(y / fig.height * img.naturalHeight), d = g.getImageData(px - 4, py - 4, 8, 8).data;
  let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return { rgb: [Math.round(r / n), Math.round(gg / n), Math.round(b / n)], key: node.getAttribute('data-raster-key'), route: window.__flux.get(window.__flux.atlas.rasters).get(figureId)?.route };
}, { figureId, x, y });
// The fixture image is a saturated gradient: a placeholder is grey (#eee) and an unpainted box is the white page.
const isImage = rgb => !!rgb && Math.max(...rgb) - Math.min(...rgb) > 35;
/** What the live scene's image elements hold, against the originals in the asset store. */
const scene = () => page.evaluate(async () => {
  const F = window.__flux, data = F.get((await import('/src/lib/assets.ts')).assetData), display = F.get(F.imageDisplay.display);
  const rows = [];
  for (const node of document.querySelectorAll('.figure-mode [data-editor-element-id]')) {
    const id = node.dataset.editorElementId, el = F.figures().flatMap(f => f.elements).find(e => e.id === id);
    if (el?.type !== 'image') continue;
    const images = [...node.querySelectorAll('image')], base = images.find(i => !i.classList.contains('image-detail')), detail = images.find(i => i.classList.contains('image-detail'));
    const natural = async href => { const img = new Image(); img.src = href; await img.decode(); return [img.naturalWidth, img.naturalHeight]; };
    rows.push({ id, assetId: el.assetId, placeholder: !base, isOriginal: !!base && base.getAttribute('href') === data[el.assetId], hrefChars: base ? base.getAttribute('href').length : 0,
      size: base ? await natural(base.getAttribute('href')) : null, cssWidth: Math.round(node.getBoundingClientRect().width), level: display[el.assetId]?.tier?.level ?? null,
      pending: !!display[el.assetId]?.pending, detail: detail ? { size: await natural(detail.getAttribute('href')), blob: detail.getAttribute('href').startsWith('blob:'), box: (() => { const b = detail.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })() } : null });
  }
  return { rows, originalChars: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), stats: { ...F.imageDisplay.stats }, dpr: devicePixelRatio, zoom: F.get(F.fig.viewport).zoom };
});
/** Serialize the scene exactly as a zoom-proxy capture does. */
const capture = () => page.evaluate(async () => {
  const { serializeSceneSnapshot } = await import('/src/lib/interact/zoomProxy.ts');
  const svg = document.querySelector('.figure-mode .scene-svg'), ser = serializeSceneSnapshot(svg, { bx: -50, by: -50, bw: 1300, bh: 700 }, 1);
  return { chars: ser.svg.length, details: (ser.svg.match(/image-detail/g) ?? []).length, blobs: (ser.svg.match(/href="blob:/g) ?? []).length, images: (ser.svg.match(/<image /g) ?? []).length };
});
const settled = (label, ids = ['img-1', 'img-2', 'img-3', 'img-4']) => waitFor(page, ids => {
  const F = window.__flux, display = F.get(F.imageDisplay.display);
  return ids.every(id => { const node = document.querySelector(`[data-editor-element-id="${id}"] image`); const el = F.figures().flatMap(f => f.elements).find(e => e.id === id); return !!node && !!display[el.assetId]?.tier; });
}, ids, { timeout: 30000, interval: 50, label });

try {
  await page.evaluateOnNewDocument(() => { window.__name ??= f => f; });
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 100 });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!window.__flux?.fig && !!window.__flux.imageDisplay && !!document.querySelector('.canvas-host'), null, { timeout: 20000, label: 'Figure ready' });
  const fx = await install();
  const originalMB = Object.entries(fx.bytes).filter(([k]) => k.startsWith('big')).reduce((n, [, v]) => n + v, 0) / 1048576;
  h.ok(originalMB > 5, `fixture: five ${BIG.w}×${BIG.h} originals weigh ${originalMB.toFixed(1)} MB`);

  h.section('(a) at rest the canvas paints tiers');
  await load(); await settled('first tiers');
  let s = await scene();
  const big = s.rows.filter(r => r.assetId.startsWith('big')), small = s.rows.find(r => r.assetId === 'small-1');
  h.eq(big.length, 4, 'the active figure mounts its four large images');
  h.ok(big.every(r => !r.isOriginal && !r.placeholder), 'no large image element holds its original bytes');
  h.ok(big.every(r => r.size[0] >= r.cssWidth * s.dpr * 0.999 && r.size[0] * r.size[1] <= (r.cssWidth * s.dpr) ** 2 * (BIG.h / BIG.w) * 2.1),
    `each tier is at least screen-sharp and at most ~2× the pixels needed (${big.map(r => `${r.size.join('×')} for ${r.cssWidth}px`).join(', ')})`);
  h.ok(big.every(r => r.hrefChars < s.originalChars[r.assetId] / 20), `a tier weighs under 1/20 of its original (${big.map(r => (r.hrefChars / 1024).toFixed(0) + ' KB').join(', ')} vs ${(s.originalChars['big-1'] / 1048576).toFixed(1)} MB)`);
  h.ok(small && small.isOriginal && small.level === null, 'the small image paints its own bytes (never tiered)');
  h.ok(s.stats.decodes >= 4 && s.stats.decodes <= 5 && s.stats.failures === 0, `at most one decode per large image (four on the live figure, one for the pictured one), none failed (${JSON.stringify(s.stats)})`);
  h.ok(big.every(r => r.level !== null), 'every large image on the live figure shows a tier');
  await shot(page, 'image-tiers-rest');

  h.section('(b) a scene capture follows the screen, not the files');
  let cap = await capture();
  const originalChars = ['big-1', 'big-2', 'big-3', 'big-4'].reduce((n, id) => n + s.originalChars[id], 0);
  h.ok(cap.chars < originalChars / 10 && cap.chars < 1_500_000, `the capture is ${(cap.chars / 1024).toFixed(0)} KB (the originals it used to carry: ${(originalChars / 1048576).toFixed(1)} MB)`);
  h.eq([cap.details, cap.blobs], [0, 0], 'no detail and no blob: URL in the capture');

  h.section('(c) deep zoom: a detail of the visible part, over a capped tier');
  const target = await page.evaluate(() => { const b = document.querySelector('[data-editor-element-id="img-1"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(target.x, target.y);
  await page.keyboard.down('Control');
  for (let i = 0; i < 26; i++) { await page.mouse.wheel({ deltaY: -120 }); await new Promise(r => setTimeout(r, 30)); }
  await page.keyboard.up('Control');
  await waitFor(page, () => !!document.querySelector('[data-editor-element-id="img-1"] image.image-detail'), null, { timeout: 30000, interval: 50, label: 'detail drawn' });
  s = await scene();
  const zoomed = s.rows.find(r => r.id === 'img-1');
  h.ok(s.zoom > 20, `zoomed to ${s.zoom.toFixed(1)}× (the screen wants ${(300 * s.zoom * s.dpr).toFixed(0)} px across a ${BIG.w} px image)`);
  h.ok(zoomed.size[0] * zoomed.size[1] <= 2_000_000 && zoomed.size[0] >= 1500, `the tier stops at the cap (${zoomed.size.join('×')})`);
  h.ok(zoomed.detail && zoomed.detail.blob && zoomed.detail.size[0] * zoomed.detail.size[1] <= 4_050_000 && zoomed.detail.size[0] < BIG.w, `the detail is part of the image within its budget (${zoomed.detail?.size.join('×')})`);
  const host = await page.evaluate(() => { const b = document.querySelector('.canvas-host').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
  h.ok(zoomed.detail.box[0] <= host[0] + 1 && zoomed.detail.box[1] <= host[1] + 1 && zoomed.detail.box[0] + zoomed.detail.box[2] >= host[0] + host[2] - 1 && zoomed.detail.box[1] + zoomed.detail.box[3] >= host[1] + host[3] - 1, 'the detail covers the whole viewport');
  // Sharpness: the 1 px grid lines of the source survive in the detail's pixels (16 px period at 1:1).
  const sharp = await page.evaluate(async () => {
    const node = document.querySelector('[data-editor-element-id="img-1"] image.image-detail'), img = new Image(); img.src = node.getAttribute('href'); await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, 1), g = c.getContext('2d'); g.drawImage(img, 0, -Math.floor(img.naturalHeight / 2) - 5);
    const row = g.getImageData(0, 0, img.naturalWidth, 1).data; let dark = 0;
    for (let x = 0; x < img.naturalWidth; x++) if (row[x * 4] < 60 && row[x * 4 + 1] < 60 && row[x * 4 + 2] < 60) dark++;
    return { dark, width: img.naturalWidth };
  });
  h.ok(sharp.dark >= sharp.width / 16 * 0.8 && sharp.dark <= sharp.width / 16 * 1.6, `the detail is the source's own pixels: ${sharp.dark} one-pixel grid lines across ${sharp.width} px`);
  cap = await capture();
  h.eq([cap.details, cap.blobs], [0, 0], 'the capture at deep zoom still contains no detail');
  h.ok(cap.chars < originalChars / 3, `…and stays bounded (${(cap.chars / 1048576).toFixed(2)} MB)`);
  await shot(page, 'image-tiers-deep');
  // Zooming back out drops the detail (the tier is enough again).
  await page.keyboard.down('Control');
  for (let i = 0; i < 26; i++) { await page.mouse.wheel({ deltaY: 120 }); await new Promise(r => setTimeout(r, 30)); }
  await page.keyboard.up('Control');
  await waitFor(page, () => !document.querySelector('image.image-detail'), null, { timeout: 15000, interval: 50, label: 'detail dropped' });
  h.ok(true, 'zooming back out drops the detail');

  h.section('(d) exports embed the original');
  const exported = await page.evaluate(async () => {
    const F = window.__flux, data = F.get((await import('/src/lib/assets.ts')).assetData), fig = F.figures().find(f => f.id === 'fig-a');
    const svg = F.io.buildFigureSvg(fig);
    return { chars: svg.length, originals: ['big-1', 'big-2', 'big-3', 'big-4'].filter(id => svg.includes(data[id].slice(0, 4000)) && svg.includes(data[id].slice(-4000))).length };
  });
  h.eq(exported.originals, 4, 'the exported figure holds all four ORIGINAL images');
  h.ok(exported.chars > originalChars, `the export is ${(exported.chars / 1048576).toFixed(1)} MB (full fidelity)`);

  h.section('(e) replaced bytes get new tiers');
  const before = (await scene()).rows.find(r => r.id === 'img-2');
  await page.evaluate(async () => {
    const A = await import('/src/lib/assets.ts');
    const c = new OffscreenCanvas(6000, 3000), g = c.getContext('2d'); g.fillStyle = '#00aa44'; g.fillRect(0, 0, 6000, 3000);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    A.setAssetData('big-2', A.bytesToDataUrl(bytes, 'image/png')); A.markAssetDirty('big-2');
    // Any view change makes the canvas report again.
    const F = window.__flux; F.fig.viewport.update(v => ({ ...v, panX: v.panX + 1 }));
  });
  await waitFor(page, async prev => {
    const node = document.querySelector('[data-editor-element-id="img-2"] image'); if (!node || node.getAttribute('href') === prev) return false;
    const img = new Image(); img.src = node.getAttribute('href'); await img.decode();
    const c = new OffscreenCanvas(1, 1), g = c.getContext('2d'); g.drawImage(img, -Math.floor(img.naturalWidth / 2), -Math.floor(img.naturalHeight / 2));
    const p = g.getImageData(0, 0, 1, 1).data; return p[1] > 140 && p[0] < 40;
  }, await page.$eval('[data-editor-element-id="img-2"] image', n => n.getAttribute('href')), { timeout: 30000, interval: 100, label: 'tier of the new bytes' });
  const after = (await scene()).rows.find(r => r.id === 'img-2');
  h.ok(!after.isOriginal && after.hrefChars < 200_000 && before.hrefChars !== after.hrefChars, 'the image shows a tier of its NEW bytes');

  h.section('(f) negative proof: with tiers off the canvas holds the originals');
  await page.evaluate(() => { window.__flux.imageDisplay.dev.enabled = false; });
  await load();
  await waitFor(page, () => document.querySelectorAll('.figure-mode [data-editor-element-id] image').length >= 5, null, { timeout: 20000, label: 'images mounted without tiers' });
  s = await scene(); cap = await capture();
  h.ok(s.rows.filter(r => r.assetId.startsWith('big')).every(r => r.isOriginal), 'tiers off: every large image element holds its original (assertion (a) can fail)');
  h.ok(cap.chars > originalChars * 0.9, `tiers off: the capture carries the originals, ${(cap.chars / 1048576).toFixed(1)} MB (assertion (b) can fail)`);
  await page.evaluate(() => { window.__flux.imageDisplay.dev.enabled = true; });

  h.eq(realErrors(page), [], 'console is clean');

  h.section('(g) a pictured figure shows its images');
  {
    const g = await freshPage();
    try {
      await install(g);
      // Hold every tier 1.2 s: the window in which a picture taken too early would hold placeholders.
      const t0 = await g.evaluate(() => {
        window.__flux.imageDisplay.dev.delayMs = 1200;
        window.__grey = 0; window.__early = 0; window.__blank = 0;
        new MutationObserver(() => { window.__grey = Math.max(window.__grey, document.querySelectorAll('.figure-mode .scene-svg rect[fill="#eee"]').length); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['fill'] });
        const watch = () => {
          const display = window.__flux.get(window.__flux.imageDisplay.display);
          if (document.querySelector('[data-figure-raster="fig-b"]') && !display['big-5']?.tier) window.__early++;
          // The ACTIVE figure mounts at once, so its images are the ones seen waiting (the pictured figure
          // asks for its tier before it is ever mounted).
          if (document.querySelector('[data-editor-element-id="img-1"] rect[fill="transparent"]') && !document.querySelector('[data-editor-element-id="img-1"] image')) window.__blank++;
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
        return performance.now();
      });
      await load(g);
      await waitFor(g, () => !!document.querySelector('[data-figure-raster="fig-b"]'), null, { timeout: 30000, interval: 30, label: 'the non-active figure is pictured' });
      const waited = await g.evaluate(t => performance.now() - t, t0), first = await pictureAt(g, 'fig-b', 200, 150);
      const seen = await g.evaluate(() => ({ grey: window.__grey, early: window.__early, blank: window.__blank }));
      h.ok(waited >= 1100, `the picture waited for the image's first tier (${Math.round(waited)} ms with tiers held 1,200 ms)`);
      h.eq(seen.early, 0, 'no frame showed a picture of the figure before its image had a tier');
      h.ok(isImage(first?.rgb), `the picture holds the image, not a placeholder (rgb ${first?.rgb} at the image's centre)`);
      h.eq(seen.grey, 0, 'no grey placeholder box was ever drawn for a waiting image');
      h.ok(seen.blank > 0, `while its tier loaded, a mounted image drew nothing and stayed hittable (${seen.blank} frames on the active figure)`);
      await g.evaluate(() => { window.__flux.imageDisplay.dev.delayMs = 0; });
      // Click into the pictured figure, edit it, click out: the new picture still holds the image.
      const at = id => g.evaluate(id => { const F = window.__flux, f = F.figures().find(f => f.id === id), v = F.get(F.fig.viewport), host = document.querySelector('.canvas-host').getBoundingClientRect(), e = f.elements[0]; return { x: host.x + v.panX + (f.x + e.x + e.width / 2) * v.zoom, y: host.y + v.panY + (f.y + e.y + e.height / 2) * v.zoom }; }, id);
      const b = await at('fig-b'); await g.mouse.click(b.x, b.y);
      await waitFor(g, () => window.__flux.get(window.__flux.fig.activeFigureId) === 'fig-b' && !!document.querySelector('[data-editor-element-id="img-5"] image'), null, { timeout: 15000, label: 'the pictured figure activates with its image' });
      await g.keyboard.press('ArrowRight'); await g.keyboard.press('ArrowRight');
      const a = await at('fig-a'); await g.mouse.click(a.x, a.y);
      await waitFor(g, key => { const n = document.querySelector('[data-figure-raster="fig-b"]'); return !!n && n.getAttribute('data-raster-key') !== key && !document.querySelector('[data-annotation-figure="fig-b"] [data-editor-element-id]'); }, first.key, { timeout: 30000, interval: 30, label: 'the edited figure is pictured again' });
      const again = await pictureAt(g, 'fig-b', 202, 150);
      h.ok(isImage(again?.rgb) && again.key !== first.key, `after click in, edit, click out the new picture still holds the image (rgb ${again?.rgb})`);
      h.eq(await g.evaluate(() => window.__grey), 0, '…and still no grey box was drawn');
      await shot(g, 'image-tiers-pictured');
      h.eq(realErrors(g), [], '(g) console is clean');
    } finally { await g.close(); }
  }

  h.section('(h) the raster service is sent tiers, never originals');
  {
    const svc = await freshPage();
    try {
      const sizes = await install(svc);
      await svc.evaluate(() => {
        window.__calls = [];
        window.fig.rasterizeFigure = async req => {
          window.__calls.push({ figure: req.figure.id, scale: req.scale, inline: Object.fromEntries(Object.entries(req.inlineAssets ?? {}).map(([id, url]) => [id, { chars: url.length, png: url.startsWith('data:image/png;base64,') }])), inlineUrl: req.inlineAssets?.['big-5'] });
          const c = new OffscreenCanvas(req.width, req.height), x = c.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, req.width, req.height);
          return { png: new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()), width: req.width, height: req.height };
        };
      });
      await load(svc); // fig-b (one large image) is the cold, non-active figure: the service pictures it
      await waitFor(svc, () => window.__calls.some(c => c.figure === 'fig-b') && !!document.querySelector('[data-figure-raster="fig-b"]'), null, { timeout: 30000, interval: 30, label: 'the service pictured the image figure' });
      const call = await svc.evaluate(async () => {
        const c = window.__calls.find(c => c.figure === 'fig-b'), img = new Image(); img.src = c.inlineUrl; await img.decode();
        return { scale: c.scale, inline: c.inline, tierWidth: img.naturalWidth, calls: window.__calls.filter(c => c.figure === 'fig-b').length, route: window.__flux.get(window.__flux.atlas.rasters).get('fig-b')?.route,
          live: document.querySelectorAll('[data-annotation-figure="fig-b"] [data-editor-element-id]').length, routeL: window.__flux.atlas.stats.routeL };
      });
      h.ok(call.inline['big-5']?.png, 'the request carries a PNG tier for the figure\'s large image');
      h.ok(call.inline['big-5'].chars < sizes.bytes['big-5'] / 20, `…under 1/20 of its original (${(call.inline['big-5'].chars / 1024).toFixed(0)} KB vs ${(sizes.bytes['big-5'] / 1048576).toFixed(1)} MB)`);
      h.ok(call.tierWidth >= 360 * call.scale * 0.999 && call.tierWidth <= 360 * call.scale * 2.9, `…and sharp enough for the picture (${call.tierWidth} px for 360 units at ${call.scale.toFixed(2)} px/unit)`);
      h.eq(Object.keys(call.inline), ['big-5'], 'only the figure\'s own large image is sent');
      h.ok(call.route === 'C' && call.live === 0 && call.routeL === 0, 'the figure was pictured by the service without ever mounting live');
      h.eq(realErrors(svc), [], '(h) console is clean');
    } finally { await svc.close(); }
  }
} catch (error) {
  h.fail(`threw: ${error?.stack ?? error}`);
  try { await shot(page, 'image-tiers-failure'); } catch {}
}
await h.done(() => browser.close());
