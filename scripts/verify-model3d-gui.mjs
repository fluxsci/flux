/** Real Figure interactions and gallery acceptance; native IO is a separate gate. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { launch, gotoApp, clickMode, waitFor, realErrors, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-model3d-gui'), out = 'test-results/model3d/scene'; await mkdir(out, { recursive: true });
const fixtures = Object.fromEntries(await Promise.all(['continuous', 'named-parts', 'plain'].map(async name => [name, { bytes: (await readFile(`scripts/fixtures/model3d/fluxplot/${name}.glb`)).toString('base64'), manifest: await readFile(`scripts/fixtures/model3d/fluxplot/${name}.fluxplot.json`, 'utf8') }])));
const { browser, page } = await launch({ width: 1500, height: 1050 });
const results = {};
const state = () => page.evaluate(() => { const F = window.__flux, p = F.get(F.fig.project); return { figures: p.figures, assets: p.assets, selected: [...F.get(F.fig.selection)], active: F.get(F.fig.activeFigureId), stats: window.__fluxModel3d?.stats() }; });
const chord = async key => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); };
const settled = () => waitFor(page, () => { const s = window.__fluxModel3d?.stats(); return !!s && !s.active && !s.queued && !s.pendingPosters; }, null, { timeout: 45000, label: 'model service settled' });
const elementState = id => page.evaluate(id => window.__flux.figures().flatMap(f => f.elements).find(e => e.id === id), id);
const center = selector => page.$eval(selector, n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 0 }); await clickMode(page, 'Figure', { settle: 0 });
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'), null, { timeout: 20000, label: 'Figure mounted' });
  await page.evaluate(async () => window.__flux.lifecycle.flushById('figure'));
  const setup = await page.evaluate(async fixtures => {
    const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot), before = F.figures().map(f => ({ id: f.id, elements: structuredClone(f.elements) }));
    for (const [name, fixture] of Object.entries(fixtures)) {
      await window.fig.writeFile(`${root}/plots/${name}.glb`, Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0)));
      if (name !== 'plain') await window.fig.writeText(`${root}/plots/${name}.fluxplot.json`, fixture.manifest);
    }
    F.fig.commit(p => {
      for (const f of p.figures) f.y += 600;
      p.figures.push({ id: 'm3d-main', name: '3D acceptance', canvasId: p.canvases[0].id, x: 0, y: 0, width: 600, height: 450, background: '#ffffff', elements: [] });
      p.figures.push({ id: 'm3d-other', name: 'Other 3D view', canvasId: p.canvases[0].id, x: 720, y: 0, width: 600, height: 450, background: '#ffffff', elements: [] });
    });
    F.fig.activeFigureId.set('m3d-main'); F.fig.selectedFrameId.set(null); F.fig.viewport.set({ panX: 35, panY: 55, zoom: .95 });
    const start = performance.now(); const count = await F.io.importPlotsFromPaths([`${root}/plots/continuous.glb`]);
    const el = F.figures().find(f => f.id === 'm3d-main').elements[0];
    window.__m3dTest = { root, before, id: el.id, start };
    return { count, id: el.id, assetId: el.assetId, width: el.width, height: el.height, before };
  }, fixtures);
  h.eq(setup.count, 1, 'public import route places one model');
  await waitFor(page, id => document.querySelector(`[data-editor-element-id="${id}"] image[data-model3d-poster]`)?.getAttribute('href')?.startsWith('data:image/png'), setup.id, { timeout: 45000, label: 'decoded model poster' });
  results.firstPosterMs = await page.evaluate(() => performance.now() - window.__m3dTest.start); await settled();
  const pixels = await page.evaluate(async id => {
    const el = document.querySelector(`[data-editor-element-id="${id}"]`), url = el.querySelector('image[data-model3d-poster]').getAttribute('href');
    const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let opaque = 0, bright = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0) { opaque++; bright += Math.max(data[i], data[i + 1], data[i + 2]); }
    return { coverage: opaque / (data.length / 4), brightness: bright / opaque, text: el.textContent, labels: [...el.querySelectorAll('text')].map(n => n.getAttribute('font-size')), width: canvas.width, height: canvas.height };
  }, setup.id);
  h.ok(pixels.coverage > .01 && pixels.coverage < .95 && pixels.brightness > 40, 'poster has visible nonblack mesh pixels and transparent margins');
  h.ok(pixels.text.includes('Height'), 'vector furniture label is in the scene DOM');
  const storage = await page.evaluate(id => ({ posters: [...window.fig._files.keys()].filter(p => /\/renders\/model3d\/m3d-.*\.png$/.test(p)) }), setup.assetId);
  h.ok(storage.posters.length > 0, 'physical poster persisted in project derived cache');
  h.eq((await state()).stats.contexts, 1, 'one worker WebGL context');
  h.ok(await page.evaluate(before => before.every(old => JSON.stringify(window.__flux.figures().find(f => f.id === old.id).elements) === JSON.stringify(old.elements)), setup.before), 'existing 2D artwork unchanged');
  h.ok(await page.evaluate(async id => { const { assetData } = await import('/src/lib/assets.ts'); return !Object.hasOwn(window.__flux.get(assetData), id); }, setup.assetId), 'GLB never enters assetData');
  await page.screenshot({ path: out + '/imported-model.png' });

  h.section('real pointer editing and shared history');
  const selector = `[data-editor-element-id="${setup.id}"] .model3d-hit-area`;
  let point = await center(selector); await page.mouse.click(point.x, point.y);
  await waitFor(page, id => window.__flux.get(window.__flux.fig.selection).has(id), setup.id, { label: 'pointer selects transparent model box' });
  const beforeMove = await elementState(setup.id); await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 35, point.y + 22, { steps: 5 }); await page.mouse.up();
  await waitFor(page, a => { const e = window.__flux.figures().flatMap(f => f.elements).find(e => e.id === a.id); return e.x !== a.x || e.y !== a.y; }, beforeMove, { label: 'pointer moved model' });
  h.ok((await elementState(setup.id)).x > beforeMove.x, 'real drag moves model');
  await chord('z'); await waitFor(page, a => window.__flux.figures().flatMap(f => f.elements).find(e => e.id === a.id).x === a.x, beforeMove, { label: 'Undo move' });
  const beforeResize = await elementState(setup.id), oldKey = await page.$eval(`[data-editor-element-id="${setup.id}"] image[data-model3d-poster]`, n => n.getAttribute('data-model3d-key'));
  const handle = await page.$$eval('.overlay-svg .handle', nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).sort((a, b) => b.x + b.y - a.x - a.y)[0]);
  await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x + 70, handle.y + 45, { steps: 5 }); await page.mouse.up();
  await waitFor(page, before => window.__flux.figures().flatMap(f => f.elements).find(e => e.id === before.id).width > before.width, beforeResize, { label: 'resize commit' }); await settled();
  const resized = await elementState(setup.id), labels = await page.$$eval(`[data-editor-element-id="${setup.id}"] text`, nodes => nodes.map(n => n.getAttribute('font-size')));
  h.ok(resized.width > beforeResize.width && resized.height > beforeResize.height, 'real resize changes placement geometry'); h.eq(labels, pixels.labels, 'resize keeps furniture type at its authored point size');
  h.ok(await page.$eval(`[data-editor-element-id="${setup.id}"] image[data-model3d-poster]`, (n, key) => n.getAttribute('data-model3d-key') !== key, oldKey), 'resize requests a reframed poster');
  const rotation = await center('.rot-handle'); point = await center(selector);
  await page.mouse.move(rotation.x, rotation.y); await page.mouse.down(); await page.mouse.move(point.x + 110, point.y - 110, { steps: 7 }); await page.mouse.up();
  await waitFor(page, id => Math.abs(window.__flux.figures().flatMap(f => f.elements).find(e => e.id === id).rotation) > 1, setup.id, { label: 'pointer rotation' }); h.ok(true, 'real rotation changes placement transform');
  await chord('z'); await chord('d'); await waitFor(page, () => window.__flux.figures().find(f => f.id === 'm3d-main').elements.length === 2, null, { label: 'duplicate model' });
  h.eq((await state()).assets.filter(a => a.kind === 'glb').length, 1, 'duplicate shares immutable GLB asset');
  await chord('c'); await chord('v'); await waitFor(page, () => window.__flux.figures().find(f => f.id === 'm3d-main').elements.length === 3, null, { label: 'copy paste model' }); h.ok(true, 'real clipboard shortcut pastes model');
  await chord('z'); await chord('z');
  await page.evaluate(id => { const F = window.__flux; F.fig.selection.set(new Set([id])); F.fig.viewport.set({ panX: 35, panY: 55, zoom: .62 }); }, setup.id);
  await waitFor(page, () => document.querySelector('.scene-svg > g')?.getAttribute('transform') === 'scale(0.62)', null, { label: 'crossfigure view folded' });
  const cross = await page.evaluate(id => { const F = window.__flux, e = F.figures().find(f => f.id === 'm3d-main').elements.find(e => e.id === id), dst = F.figures().find(f => f.id === 'm3d-other'), vp = F.get(F.fig.viewport), r = document.querySelector('.canvas-host').getBoundingClientRect(); return { x: r.x + vp.panX + (dst.x + e.x + e.width / 2) * vp.zoom, y: r.y + vp.panY + (dst.y + e.y + e.height / 2) * vp.zoom }; }, setup.id);
  point = await center(selector); await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(cross.x, cross.y, { steps: 9 }); await page.mouse.up();
  await waitFor(page, id => window.__flux.figures().find(f => f.id === 'm3d-other').elements.some(e => e.id === id), setup.id, { label: 'crossfigure real drag' }); h.ok(true, 'crossfigure drag preserves model asset and view');
  await chord('z'); await chord('y'); await waitFor(page, id => window.__flux.figures().find(f => f.id === 'm3d-other').elements.some(e => e.id === id), setup.id, { label: 'crossfigure redo' }); await chord('z');
  await page.evaluate(id => { const F = window.__flux; F.fig.activeFigureId.set('m3d-main'); F.fig.selection.set(new Set([id])); F.fig.viewport.set({ panX: 35, panY: 55, zoom: .95 }); }, setup.id); await settled();
  await page.screenshot({ path: out + '/edited-model.png' });

  h.section('furniture double-click selects the part, like 2D plot parts');
  const cbar = await page.$eval(`[data-editor-element-id="${setup.id}"] [data-model3d-furniture="over"] [data-role="colorbar"]`, n => { const t = n.querySelector('text') ?? n, r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: n.getAttribute('data-part-id') }; });
  await page.mouse.click(cbar.x, cbar.y, { count: 2, delay: 80 });
  await waitFor(page, pid => window.__flux.get(window.__flux.fig.partSelection)?.partId === pid, cbar.id, { label: 'double-click selects the colorbar part' });
  h.ok(!(await page.$('[data-model3d-orbit]')), 'double-clicking furniture does not start orbit');
  h.eq(await page.$eval('.model3d-properties h4', n => n.textContent.trim().startsWith('3D view')), true, 'Inspector uses the 3D view section heading');
  await page.evaluate(id => { const F = window.__flux; F.fig.partSelection.set(null); F.fig.selection.set(new Set([id])); }, setup.id);

  h.section('zoom proxy and residency');
  await waitFor(page, () => { const i = document.querySelector('.zoom-proxy'); return !!i?.complete && i.naturalWidth > 0 && !i.classList.contains('live'); }, null, { timeout: 20000, label: 'decoded zoom proxy' });
  results.proxy = await page.evaluate(id => {
    const i = document.querySelector('.zoom-proxy'), r = i.getBoundingClientRect(), m = document.querySelector(`[data-editor-element-id="${id}"] image[data-model3d-poster]`).getBoundingClientRect();
    const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(i, 0, 0);
    const x = Math.max(0, Math.round((m.x - r.x) * c.width / r.width)), y = Math.max(0, Math.round((m.y - r.y) * c.height / r.height));
    const w = Math.min(c.width - x, Math.round(m.width * c.width / r.width)), ht = Math.min(c.height - y, Math.round(m.height * c.height / r.height));
    const p = ctx.getImageData(x, y, w, ht).data; let blue = 0; for (let k = 0; k < p.length; k += 4) if (p[k + 2] > p[k] + 30 && p[k + 2] > p[k + 1] + 30 && p[k + 3] > 100) blue++;
    return { blue, pixels: w * ht, crop: { x, y, w, h: ht }, src: i.src };
  }, setup.id);
  h.ok(results.proxy.blue > 300, 'actual zoom proxy raster contains blue model pixels');
  point = await center(selector); await page.mouse.move(point.x, point.y); await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -60 }); await page.keyboard.up('Control');
  h.ok(await page.$eval('.zoom-proxy', n => n.classList.contains('live')), 'real Ctrl-wheel activates decoded proxy');
  await page.screenshot({ path: out + '/zoom-proxy.png' });
  await waitFor(page, () => !document.querySelector('.zoom-proxy')?.classList.contains('live'), null, { label: 'zoom settles to live scene' });
  const loads = (await state()).stats.loads; await page.evaluate(() => { const F = window.__flux; F.fig.selection.set(new Set()); F.fig.viewport.update(v => ({ ...v, panX: -50000, panY: -50000 })); });
  await waitFor(page, () => document.querySelectorAll('[data-model3d-poster]').length === 0 && window.__fluxModel3d.stats().retained === 0 && !window.__fluxModel3d.stats().active, null, { timeout: 20000, label: 'culled model releases live refs' });
  h.eq((await state()).stats.retained, 0, 'culling releases every live model reference');
  await page.evaluate(() => window.__flux.fig.viewport.set({ panX: 35, panY: 55, zoom: .95 }));
  await waitFor(page, () => !!document.querySelector('[data-model3d-poster]'), null, { label: 'warm model remount' }); await settled(); h.eq((await state()).stats.loads, loads, 'warm remount reuses resident mesh');

  h.section('gallery accent and filtering');
  await page.evaluate(() => window.__flux.fig.importerOpen.set(true));
  await waitFor(page, () => !!document.querySelector('.importer [data-path$="continuous.glb"]'), null, { timeout: 20000, label: 'gallery lists GLB' });
  h.ok(await page.$eval('.importer .items [data-path$="continuous.glb"]', n => !!n.querySelector('[data-model3d-kind="fluxplot"]')), 'scene3d has accent 3D chip');
  h.ok(await page.$eval('.importer .items [data-path$="plain.glb"]', n => !!n.querySelector('[data-model3d-kind="mesh"]')), 'plain mesh has muted 3D chip');
  await page.click('[aria-label="Show only 3D models"]');
  h.ok(await page.$$eval('.importer .items [data-kind="file"]', nodes => nodes.length >= 3 && nodes.every(n => n.getAttribute('data-path').endsWith('.glb'))), '3D filter excludes 2D files');
  await waitFor(page, () => [...document.querySelectorAll('.importer .items [data-path$="continuous.glb"] img')].some(n => n.complete && n.naturalWidth), null, { timeout: 45000, label: 'gallery mesh thumbnail decoded' }); await page.screenshot({ path: out + '/gallery-models.png' });
  await page.click('button[aria-label="List view"]');
  h.ok(await page.$eval('.importer .items [data-path$="continuous.glb"]', n => !!n.querySelector('[data-model3d-kind="fluxplot"]')), 'list view keeps 3D metadata chip');
  await page.keyboard.down('Control'); await page.click('.importer .items [data-path$="continuous.glb"]'); await page.keyboard.up('Control');
  await waitFor(page, () => document.querySelector('img.model-preview')?.complete && document.querySelector('img.model-preview')?.naturalWidth > 0, null, { timeout: 45000, label: 'expanded model preview' });
  await page.screenshot({ path: out + '/gallery-expanded.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(async fixtures => {
    const root = (await window.fig.prefsGet()).plotLibraryResolved;
    await window.fig.writeFile(`${root}/global.glb`, Uint8Array.from(atob(fixtures['named-parts'].bytes), c => c.charCodeAt(0)));
    await window.fig.writeText(`${root}/global.fluxplot.json`, fixtures['named-parts'].manifest);
  }, fixtures);
  await page.click('[data-scope="global"]');
  await waitFor(page, () => !!document.querySelector('.importer .items [data-path$="global.glb"]'), null, { label: 'Global gallery model' });
  h.ok(true, 'Global gallery lists 3D models');
  await page.click('button[aria-label="Gallery view"]');
  await waitFor(page, () => [...document.querySelectorAll('.importer .items [data-path$="global.glb"] img')].some(n => n.complete && n.naturalWidth), null, { timeout: 45000, label: 'Global thumbnail' });
  h.eq((await state()).stats.contexts, 1, 'project and Global previews share opener context');
  await page.screenshot({ path: out + '/gallery-global.png' });
  await page.click('[data-scope="project"]');
  await page.click('button[aria-label="List view"]');
  await page.evaluate(async fixtures => {
    const fb = window.fig, root = window.__m3dTest.root, bytes = Uint8Array.from(atob(fixtures.plain.bytes), c => c.charCodeAt(0));
    const values = { 'invalid-meta': { spec: 'fluxplot/svg', schemaVersion: '0.1.0' }, 'future-meta': { ...JSON.parse(fixtures.continuous.manifest), schemaVersion: '99.0.0' }, 'mismatch-meta': { ...JSON.parse(fixtures.continuous.manifest), glbSha256: '0'.repeat(64) } };
    for (const [name, manifest] of Object.entries(values)) { await fb.writeFile(`${root}/plots/${name}.glb`, bytes); await fb.writeText(`${root}/plots/${name}.fluxplot.json`, JSON.stringify(manifest)); }
    window.__m3dTest.listReads = 0; window.__m3dTest.readFile = fb.readFile;
    fb.readFile = async path => { if (/-meta\.glb$/.test(path)) window.__m3dTest.listReads++; return window.__m3dTest.readFile(path); };
  }, fixtures);
  await page.click('.importer .refreshbtn');
  await waitFor(page, () => ['invalid-meta', 'future-meta', 'mismatch-meta'].every(name => document.querySelector(`.importer .items [data-path$="${name}.glb"] [data-model3d-checked="true"]`)), null, { label: 'bounded metadata checks in list' });
  h.ok(await page.$$eval('.importer .items [data-path$="invalid-meta.glb"] [data-model3d-kind], .importer .items [data-path$="future-meta.glb"] [data-model3d-kind]', nodes => nodes.length === 2 && nodes.every(n => n.dataset.model3dKind === 'mesh')), 'invalid and future metadata keep plain mesh chips');
  h.eq(await page.evaluate(() => window.__m3dTest.listReads), 0, 'list metadata chips never read GLB bytes');
  await page.click('button[aria-label="Gallery view"]');
  await waitFor(page, () => document.querySelector('.importer .items [data-path$="mismatch-meta.glb"] img')?.complete && document.querySelector('.importer .items [data-path$="mismatch-meta.glb"] img')?.naturalWidth > 0 && document.querySelector('.importer .items [data-path$="mismatch-meta.glb"] [data-model3d-kind="mesh"]'), null, { timeout: 45000, label: 'preview original-hash downgrade' });
  h.ok(true, 'worker preview downgrades mismatched original-byte metadata');
  await page.evaluate(() => window.fig.readFile = window.__m3dTest.readFile);
  await page.keyboard.press('Escape');

  h.section('cached fallback, missing source and cancellation');
  await page.evaluate(async () => {
    const { scene3dGeneration } = await import('/src/lib/model3d/store.ts');
    window.__m3dTest.availability = window.fig.model3dAvailability;
    window.fig.model3dAvailability = async () => ({ disabled: true });
    // A same-root reload deliberately keeps the worker; a lost GPU is a reset.
    window.__fluxModel3d.reset();
    scene3dGeneration.update(n => n + 1);
  });
  await waitFor(page, () => !!document.querySelector('[data-model3d-poster]') && window.__fluxModel3d.stats().contexts === 0, null, { label: 'cached poster survives disabled GPU' });
  h.eq((await state()).stats.contexts, 0, 'cached poster is usable with WebGL explicitly disabled');
  await page.evaluate(id => window.__flux.fig.commit(p => { p.figures.flatMap(f => f.elements).find(e => e.id === id).orbitAzimuth += 13; }), setup.id);
  await waitFor(page, () => document.querySelector('[data-model3d-placeholder]')?.textContent.includes('WebGL'), null, { label: 'uncached disabled fallback' });
  point = await center(selector); await page.mouse.click(point.x, point.y);
  h.ok((await state()).selected.includes(setup.id), 'unavailable model box remains selectable');
  h.ok(await page.$eval(`[data-editor-element-id="${setup.id}"]`, n => n.textContent.includes('Height')), 'vector furniture remains visible without WebGL');
  await page.screenshot({ path: out + '/webgl-disabled.png' });
  await page.evaluate(async () => { window.fig.model3dAvailability = window.__m3dTest.availability; const { scene3dGeneration } = await import('/src/lib/model3d/store.ts'); scene3dGeneration.update(n => n + 1); });
  await waitFor(page, () => !!document.querySelector('[data-model3d-poster]'), null, { timeout: 45000, label: 'available renderer restored' }); await settled();
  await page.evaluate(async assetId => {
    const F = window.__flux, a = F.get(F.fig.project).assets.find(a => a.id === assetId), path = `${window.__m3dTest.root}/fig/${a.path}`;
    window.__m3dTest.removed = { path, bytes: await window.fig.readFile(path) }; await window.fig.remove(path);
    const { scene3dGeneration } = await import('/src/lib/model3d/store.ts'); scene3dGeneration.update(n => n + 1);
  }, setup.assetId);
  await waitFor(page, () => document.querySelector('[data-model3d-placeholder]')?.textContent.includes('missing'), null, { label: 'missing GLB fallback' });
  h.ok(true, 'missing GLB displays explicit fallback despite existing disk poster');
  await page.screenshot({ path: out + '/missing-model.png' });
  await page.evaluate(async () => { const { path, bytes } = window.__m3dTest.removed; await window.fig.writeFile(path, bytes); const { scene3dGeneration } = await import('/src/lib/model3d/store.ts'); scene3dGeneration.update(n => n + 1); });
  await waitFor(page, () => !!document.querySelector('[data-model3d-poster]'), null, { timeout: 45000, label: 'missing model restored' });
  results.cancel = await page.evaluate(async () => {
    const F = window.__flux, fb = window.fig, original = fb.importModel3d, originalDiscard = fb.discardModel3d, originalAdopt = fb.adoptModel3d;
    let discarded = 0, adopted = 0, receipt;
    fb.discardModel3d = async request => { discarded++; return originalDiscard(request); };
    fb.adoptModel3d = async request => { adopted++; return originalAdopt(request); };
    fb.importModel3d = async request => { const result = await original(request); receipt = result; F.fig.activeFigureId.set('m3d-other'); return result; };
    let error = ''; const before = F.get(F.fig.project).assets.length;
    try { await F.io.importPlotsFromPaths([`${window.__m3dTest.root}/plots/named-parts.glb`]); } catch (e) { error = String(e); }
    finally { fb.importModel3d = original; fb.discardModel3d = originalDiscard; fb.adoptModel3d = originalAdopt; F.fig.activeFigureId.set('m3d-main'); }
    return { discarded, adopted, error, unchanged: before === F.get(F.fig.project).assets.length, removed: !await fb.exists(`${window.__m3dTest.root}/fig/${receipt.asset.path}`) };
  });
  h.ok(results.cancel.discarded === 1 && results.cancel.adopted === 0 && results.cancel.unchanged && results.cancel.removed, 'late import destination switch discards exact uncommitted receipt');
  results.drop = await page.evaluate(async fixture => {
    const F = window.__flux, before = F.get(F.fig.project).assets.length;
    const file = new File([Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0))], 'dropped.glb', { type: 'model/gltf-binary' });
    await F.io.importDroppedFiles([file], 'm3d-main');
    const e = F.figures().find(f => f.id === 'm3d-main').elements.at(-1);
    return { added: F.get(F.fig.project).assets.length - before, type: e.type, frozen: e.source?.frozen };
  }, fixtures.plain);
  h.ok(results.drop.added === 1 && results.drop.type === 'model3d' && results.drop.frozen, 'actual File drop bridge places a frozen browser source');
  h.section('rootless Save-first and genuine picker reauthorization');
  results.rootless = await page.evaluate(async fixture => {
    const F = window.__flux, fb = window.fig, source = '/external/rootless.glb';
    await fb.writeFile(source, Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0)));
    const original = { save: fb.save, openFiles: fb.openFiles, watchRoot: fb.watchRoot, importModel3d: fb.importModel3d };
    const rows = [], grants = new Set(); let calls = [], imports = 0, watches = 0;
    fb.watchRoot = async root => { watches++; grants.clear(); return original.watchRoot(root); };
    fb.importModel3d = async request => { imports++; if (!grants.has(request.sourcePath)) throw new Error('No current picker source grant'); return original.importModel3d(request); };
    const reset = () => {
      F.fig.embeddedProjectRoot.set(null); F.fig.projectDir.set(null);
      F.fig.commit(p => { p.assets = []; for (const f of p.figures) f.elements = []; });
      F.fig.activeFigureId.set('m3d-main'); calls = []; imports = 0; watches = 0; grants.clear();
    };
    try {
      reset(); fb.save = async () => null; fb.openFiles = async filters => { calls.push(filters); grants.add(source); return [source]; };
      await F.io.importAssets(); rows.push({ name: 'save cancellation imports nothing', pass: imports === 0 && watches === 0 && calls.length === 1 });
      reset(); fb.save = async () => '/rootless-cancel.flux'; fb.openFiles = async filters => { calls.push(filters); if (calls.length === 1) { grants.add(source); return [source]; } return null; };
      await F.io.importAssets(); rows.push({ name: 'repicker cancellation retains saved project', pass: imports === 0 && watches === 1 && calls.length === 2 && await fb.exists('/rootless-cancel.flux/project.json') && F.get(F.fig.projectDir) === '/rootless-cancel.flux' });
      reset(); fb.save = async () => '/rootless-switch.flux'; fb.openFiles = async filters => { calls.push(filters); grants.add(source); if (calls.length === 2) F.fig.activeFigureId.set('m3d-other'); return [source]; };
      await F.io.importAssets(); rows.push({ name: 'repicker destination switch refuses import', pass: imports === 0 && calls.length === 2 });
      reset(); fb.save = async () => '/rootless-success.flux'; fb.openFiles = async filters => { calls.push(filters); grants.add(source); return calls.length === 1 ? [source, '/external/also.svg'] : [source]; };
      await F.io.importAssets(); const asset = F.get(F.fig.project).assets[0];
      rows.push({ name: 'mixed selection reacquires mixed picker authorization after root registration', pass: imports === 1 && watches === 1 && calls.length === 2 && ['png', 'svg', 'glb'].every(ext => calls[1][0].extensions.includes(ext)) && asset?.kind === 'glb' && await fb.exists('/rootless-success.flux/' + asset.path) });
      const before = watches; await F.io.saveProject(); rows.push({ name: 'same-root save preserves current picker grants', pass: watches === before && grants.has(source) });
      reset(); fb.save = async () => '/rootless-pending.flux';
      let entered, release; const registration = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
      fb.watchRoot = async root => { const result = await original.watchRoot(root); entered(); await held; return result; };
      const saving = F.io.saveProjectAs(); await registration;
      fb.openFiles = async filters => { calls.push(filters); grants.add(source); return [source]; };
      const inserting = F.io.importAssets();
      await new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
      F.fig.activeFigureId.set('m3d-other'); release(); await Promise.all([saving, inserting]);
      rows.push({ name: 'destination change during pending root registration refuses import', pass: imports === 0 && F.get(F.fig.project).assets.length === 0 });
    } finally { Object.assign(fb, original); }
    return rows;
  }, fixtures.plain);
  for (const row of results.rootless) h.ok(row.pass, row.name);
  h.eq(realErrors(page).length, 0, 'clean console'); results.stats = (await state()).stats;
} catch (error) { h.fail(String(error)); results.error = String(error); results.errors = realErrors(page); await page.screenshot({ path: out + '/gui-failure.png' }); }
finally { await writeFile(out + '/gui-result.json', JSON.stringify(results, null, 2)); await browser.close(); }
await h.done();
