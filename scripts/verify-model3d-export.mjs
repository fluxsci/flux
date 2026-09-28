/** Real poster preparation, captured exports and shared-source lifecycle. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { launch, gotoApp, clickMode, waitFor, realErrors, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-model3d-export'), out = 'test-results/model3d/export'; await mkdir(out, { recursive: true });
const fixture = { bytes: (await readFile('scripts/fixtures/model3d/fluxplot/continuous.glb')).toString('base64'), manifest: await readFile('scripts/fixtures/model3d/fluxplot/continuous.fluxplot.json', 'utf8') };
const { browser, page } = await launch({ width: 1300, height: 950 });
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 0 }); await clickMode(page, 'Figure', { settle: 0 });
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'), null, { timeout: 20000, label: 'Figure mounted' });
  await page.evaluate(async () => window.__flux.lifecycle.flushById('figure'));
  const result = await page.evaluate(async fixture => {
    const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot), fb = window.fig;
    const api = await import('/src/lib/model3d/posterStore.ts'), statics = await import('/src/lib/model3d/static.ts'), poster = await import('/src/lib/model3d/poster.ts'), stores = await import('/src/lib/model3d/store.ts');
    await fb.writeFile(`${root}/plots/export.glb`, Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0))); await fb.writeText(`${root}/plots/export.fluxplot.json`, fixture.manifest);
    F.fig.commit(p => { p.figures.push({ id: 'export3d', name: '3D export', canvasId: p.canvases[0].id, x: 0, y: 0, width: 400, height: 350, background: '#ffffff', elements: [] }); });
    F.fig.activeFigureId.set('export3d'); await F.io.importPlotsFromPaths([`${root}/plots/export.glb`]);
    const fig = structuredClone(F.figures().find(f => f.id === 'export3d')), element = fig.elements[0], asset = F.get(F.fig.project).assets.find(a => a.id === element.assetId), manifest = F.get(stores.scene3dManifests)[asset.id], source = api.captureAppModelPosterSource();
    const dims = async url => { const image = new Image(); image.src = url; await image.decode(); return [image.naturalWidth, image.naturalHeight]; };
    const base = { element, asset, manifest }, rows = [];
    for (const dpi of [300, 600]) {
      const bytes = await F.io.renderFigureBytes(fig, { format: 'png', mm: fig.width / 96 * 25.4, dpi, transparent: true });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      rows.push({ name: `${dpi} DPI final raster dimensions`, pass: JSON.stringify(await dims(url)) === JSON.stringify([Math.round(fig.width * dpi / 96), Math.round(fig.height * dpi / 96)]) });
      URL.revokeObjectURL(url);
      const req = statics.staticModelRequest(element, asset, manifest, { kind: 'raster', dpi }), stored = await fb.readFile(`${root}/${poster.posterPath(req.key)}`);
      rows.push({ name: `${dpi} DPI mesh uses viewport dimensions`, pass: new DataView(stored).getUint32(16) === req.w && new DataView(stored).getUint32(20) === req.h });
    }
    const oldSave = fb.save; fb.save = async () => `${root}/export3d.svg`;
    await F.io.exportFigureSvg(fig); const svg = await fb.readText(`${root}/export3d.svg`); fb.save = oldSave;
    rows.push({ name: 'SVG contains PNG mesh and vector labels', pass: svg.includes('data:image/png;') && /<text\b/.test(svg) && svg.includes('Height') && !svg.includes('model/gltf') });
    const unusual = { ...base, element: { ...element, orbitAzimuth: element.orbitAzimuth + 13 }, surface: 'svg' }, req = statics.staticModelRequest(unusual.element, asset, manifest, 'svg');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const wrong = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0)); await fb.writeFile(`${root}/${poster.posterPath(req.key)}`, wrong);
    const corrected = await api.modelPosterUrl(unusual, { source }); rows.push({ name: 'wrong-size disk cache regenerated', pass: JSON.stringify(await dims(corrected)) === JSON.stringify([req.w, req.h]) });
    const app = api.retainModel3d(asset), appReady = await app.ready;
    const otherRoot = '/explicit-paper-source'; await fb.writeFile(`${otherRoot}/fig/${asset.path}`, new Uint8Array(await fb.readFile(`${root}/fig/${asset.path}`)));
    let current = true; const other = { root: otherRoot, prefix: 'fig', bridge: fb, scope: 'paper-test', isCurrent: () => current };
    const paper = api.retainModel3d(asset, { source: other }), paperReady = await paper.ready;
    rows.push({ name: 'Paper and editor share one renderer with distinct root IDs', pass: appReady.service === paperReady.service && appReady.assetId !== paperReady.assetId && appReady.service.stats().contexts === 1 });
    await api.modelPosterUrl({ ...base, surface: 'figure' }, { source: other });
    current = false; paper.release();
    const still = await appReady.service.renderPng({ assetId: appReady.assetId, w: 128, h: 128, element, manifest });
    rows.push({ name: 'closing Paper preserves active editor retain', pass: still.size > 100 && appReady.service.stats().contexts === 1 }); app.release();
    const broken = { ...other, scope: 'broken-source', isCurrent: () => true }; await fb.writeFile(`${otherRoot}/fig/${asset.path}`, new Uint8Array([1, 2, 3]));
    const bad = api.retainModel3d(asset, { source: broken }); let rejected = false; try { await bad.ready; } catch (error) { rejected = /changed since/.test(String(error)); } finally { bad.release(); }
    rows.push({ name: 'captured prepared SHA rejects replaced source bytes', pass: rejected });
    const fallbackElement = { ...element, name: 'Named fallback model', orbitAzimuth: element.orbitAzimuth + 43 };
    await api.modelPosterUrl({ ...base, element: fallbackElement, surface: 'figure' });
    const availability = fb.model3dAvailability; fb.model3dAvailability = async () => ({ disabled: true });
    const warnings = []; const fallback = await api.modelPosterUrl({ ...base, element: fallbackElement, surface: 'svg' }, { onWarning: warning => warnings.push(warning) });
    rows.push({ name: 'disabled export uses stored poster and names element', pass: !!fallback && warnings.some(w => w.includes('Named fallback model') && w.includes('stored poster')) });
    let missing = ''; try { await api.modelPosterUrl({ ...base, element: { ...element, orbitAzimuth: element.orbitAzimuth + 97 }, surface: 'svg' }); } catch (error) { missing = String(error); }
    rows.push({ name: 'disabled model with no poster refuses export', pass: /WebGL/.test(missing) }); fb.model3dAvailability = availability;
    const registry = await import('/src/lib/model3d/sourceRegistry.ts'), exporter = await import('/src/lib/model3d/exportPosters.ts');
    const named = { ...element, name: 'Custom missing placement' }, missingAsset = { ...asset, path: 'assets/absent.glb' };
    let missingName = ''; try { await exporter.ensureModelPosters([{ ...fig, elements: [named] }], [missingAsset], { [asset.id]: manifest }, 'svg', source); } catch (error) { missingName = String(error); }
    rows.push({ name: 'missing GLB fails by placed element name', pass: missingName.includes('Custom missing placement') });
    for (const phase of ['source', 'disk']) {
      let release, reached; const barrier = new Promise(resolve => release = resolve), entered = new Promise(resolve => reached = resolve);
      const bridge = { ...fb, projectAssetPath: undefined,
        exists: async path => { if (phase === 'source' && path.endsWith('.glb')) { reached(); await barrier; } return fb.exists(path); },
        readFile: async path => { if (phase === 'disk' && path.endsWith('.png')) { reached(); await barrier; } return fb.readFile(path); } };
      const controller = new AbortController(), captured = { ...source, bridge, scope: `cancellation-${phase}` };
      const task = api.modelPosterUrl({ ...base, surface: 'figure' }, { source: captured, signal: controller.signal }).then(() => 'resolved', () => 'aborted');
      await entered; const began = performance.now(); controller.abort();
      const status = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
      rows.push({ name: `${phase} IO cancellation settles immediately`, pass: status === 'aborted' && performance.now() - began < 100 }); release(); await task;
    }
    F.fig.selection.set(new Set());
    F.fig.viewport.set({ panX: -50000, panY: -50000, zoom: 1 });
    for (let i = 0; i < 100 && api.model3dAppStats().retained; i++) await new Promise(resolve => setTimeout(resolve, 10));
    rows.push({ name: 'gallery lifecycle probe begins without editor retains', pass: api.model3dAppStats().retained === 0 });
    const gallery = await api.appModel3dService(), raw = await fb.readFile(`${root}/fig/${asset.path}`);
    await gallery.service.retain({ id: 'gallery-owned-by-app', bytes: raw });
    await fb.writeFile(`${otherRoot}/fig/${asset.path}`, new Uint8Array(raw));
    const otherOwner = { ...other, scope: 'paper-gallery-concurrent', isCurrent: () => true }, paperHold = api.retainModel3d(asset, { source: otherOwner }); await paperHold.ready;
    paperHold.release(); registry.releaseModelSource(otherOwner);
    const galleryPng = await gallery.service.renderPng({ assetId: 'gallery-owned-by-app', w: 128, h: 128, element, manifest });
    rows.push({ name: 'closing Paper preserves a gallery-only retain', pass: galleryPng.size > 100 && gallery.service.stats().contexts === 1 }); gallery.service.release('gallery-owned-by-app');
    F.fig.viewport.set({ panX: 30, panY: 45, zoom: 1 });
    return { rows, svg, stats: api.model3dAppStats() };
  }, fixture);
  for (const row of result.rows) h.ok(row.pass, row.name);
  await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2)); await writeFile(`${out}/figure.svg`, result.svg);
  await page.screenshot({ path: `${out}/figure.png` }); h.eq(realErrors(page).length, 0, 'clean console');
} finally { await browser.close(); }
await h.done();
