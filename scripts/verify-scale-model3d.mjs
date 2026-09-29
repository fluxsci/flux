/** Figure scale qualification. Native GPU throughput/input-probe has a separate sibling. */
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, gotoApp, clickMode, waitFor, waitForFrame, APP_URL, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { model3dScaleFixtures } from './lib/model3dScaleFixture.mjs';

const h = harness('verify-scale-model3d'), out = 'test-results/model3d/scale';
await mkdir(out, { recursive: true });
const fixtures = await model3dScaleFixtures();
h.ok(fixtures.length === 8 && fixtures.every(f => f.info.triangles === 250000), 'eight distinct 250,000-triangle models');
h.eq(new Set(fixtures.map(f => f.manifest.glbSha256)).size, 8, 'geometry bytes prevent resident asset deduplication');
const { browser, page } = await launch({ width: 1900, height: 1050 });
const results = { fixtures: fixtures.map(f => ({ triangles: f.info.triangles, bytes: f.bytes.length, sha256: f.manifest.glbSha256 })), cohorts: [] };
try {
  await page.evaluateOnNewDocument(() => {
    const raf = window.requestAnimationFrame;
    window.__modelRafRequests = 0;
    window.requestAnimationFrame = function (callback) {
      if (/\/model3d\/|\/Model3dElement\.svelte/.test(new Error().stack ?? '')) window.__modelRafRequests++;
      return raf.call(window, callback);
    };
  });
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 0 });
  await clickMode(page, 'Figure', { settle: 0 });
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'), null, { label: 'Figure ready' });
  await page.evaluate(async () => {
    const F = window.__flux;
    await F.lifecycle.flushById('figure');
    F.fig.commit(p => { p.figures = [{ ...p.figures[0], id: 'scale3d', x: 0, y: 0, width: 930, height: 480, elements: [] }]; });
    F.fig.activeFigureId.set('scale3d'); F.fig.selectedFrameId.set(null);
    F.fig.viewport.set({ panX: 30, panY: 60, zoom: 1 });
    const { modelSourceRegistryStats } = await import('/src/lib/model3d/sourceRegistry.ts');
    window.__scale3dStats = modelSourceRegistryStats;
  });
  results.availability = await page.evaluate(async () => {
    try {
      const { appModel3dService } = await import('/src/lib/model3d/posterStore.ts');
      return (await appModel3dService()).service.available();
    } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
  });
  if (!results.availability.ok) {
    results.status = 'capability-blocked';
    throw Error(`WebGL2 capability unavailable: ${results.availability.reason}; timing cohort cannot be qualified`);
  }
  h.ok(!!results.availability.renderer, 'worker reports its actual WebGL2 renderer before timing');
  for (const [index, fixture] of fixtures.entries()) {
    await page.evaluate(async ({ stem, bytes, manifest, index }) => {
      const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot);
      await window.fig.writeFile(`${root}/plots/${stem}.glb`, Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
      await window.fig.writeText(`${root}/plots/${stem}.fluxplot.json`, JSON.stringify(manifest));
      await F.io.importPlotsFromPaths([`${root}/plots/${stem}.glb`]);
      F.fig.commit(p => {
        const e = p.figures[0].elements.at(-1);
        Object.assign(e, { x: 10 + index % 4 * 230, y: 10 + Math.floor(index / 4) * 230, width: 220, height: 210 });
      });
    }, { stem: fixture.stem, bytes: Buffer.from(fixture.bytes).toString('base64'), manifest: fixture.manifest, index });
  }
  await page.evaluate(() => { window.__flux.fig.clearSelection(); window.__scale3dModels = structuredClone(window.__flux.figures()[0].elements); });
  await waitFor(page, () => document.querySelectorAll('[data-editor-element-id] [data-model3d-poster]').length === 8 && !window.__scale3dStats()?.active && window.__scale3dStats()?.queued === 0, null, { timeout: 90000, label: 'all eight decoded posters and idle worker' });
  await waitForFrame(page);
  const baselineImages = [];
  for (const id of await page.evaluate(() => window.__scale3dModels.map(e => e.id))) {
    const node = await page.$(`[data-editor-element-id="${id}"]`);
    baselineImages.push({ id, png: (await node.screenshot()).toString('base64') });
  }
  await page.evaluate(async images => {
    const F = window.__flux, { assetData } = await import('/src/lib/assets.ts');
    F.fig.commit(p => {
      for (const [i, item] of images.entries()) p.assets.push({ id: `scale-image-${i}`, name: 'Matched mesh and furniture raster', kind: 'png', path: `assets/scale-image-${i}.png`, naturalWidth: 220, naturalHeight: 210 });
    });
    assetData.update(data => ({ ...data, ...Object.fromEntries(images.map((item, i) => [`scale-image-${i}`, 'data:image/png;base64,' + item.png])) }));
    window.__scale3dImages = window.__scale3dModels.map((e, i) => ({ type: 'image', id: e.id, assetId: `scale-image-${i}`, x: e.x, y: e.y, width: e.width, height: e.height, rotation: 0 }));
  }, baselineImages);
  results.resident = await page.evaluate(() => window.__scale3dStats());
  h.eq(results.resident.contexts, 1, 'eight meshes share one WebGL context');
  h.eq(results.resident.assets, 8, 'all eight distinct meshes are resident');
  h.ok(results.resident.residentBytes < 768 * 1024 * 1024, 'resident GLB bytes stay below 768 MiB budget');
  const workers = page.workers().filter(worker => worker.url().includes('model3d.worker'));
  h.eq(workers.length, 1, 'one actual model worker target');
  const worker = workers[0];
  await worker.evaluate(`(()=>{globalThis.__scaleRafRequests=0;const original=globalThis.requestAnimationFrame;if(original)globalThis.requestAnimationFrame=function(cb){globalThis.__scaleRafRequests++;return original.call(globalThis,cb)};return true})()`);
  const resting = await page.evaluate(async () => {
    const before = { raf: window.__modelRafRequests, renders: window.__scale3dStats().renders };
    await new Promise(resolve => setTimeout(resolve, 250));
    return { before, after: { raf: window.__modelRafRequests, renders: window.__scale3dStats().renders } };
  });
  h.eq(resting.after, resting.before, 'zero main-thread model animation requests and worker renders at rest');
  results.workerIdleRaf = await worker.evaluate('globalThis.__scaleRafRequests');
  h.eq(results.workerIdleRaf, 0, 'actual worker schedules zero animation frames at rest');
  await page.screenshot({ path: out + '/eight-models.png' });
  // ABBA ordering, identical coordinates, real trusted pointer/wheel events.
  // No artificial denominator floor or relaxed timing budget.
  for (const kind of ['model', 'image', 'image', 'model']) {
    await page.evaluate(kind => {
      const F = window.__flux;
      F.fig.commit(p => { p.figures[0].elements = structuredClone(kind === 'model' ? window.__scale3dModels : window.__scale3dImages); });
      F.fig.viewport.set({ panX: 30, panY: 60, zoom: 1 }); F.fig.clearSelection();
    }, kind);
    await waitForFrame(page);
    if (kind === 'model') await waitFor(page, () => document.querySelectorAll('[data-editor-element-id] [data-model3d-poster]').length === 8 && !window.__scale3dStats()?.active && window.__scale3dStats()?.queued === 0, null, { timeout: 90000, label: 'restored model posters and idle worker' });
    await page.evaluate(async () => {
      const images = [...document.querySelectorAll('[data-editor-element-id] image')];
      await Promise.all(images.map(node => { const image = new Image(); image.src = node.href.baseVal; return image.decode(); }));
    });
    await waitForFrame(page);
    const box = await page.$eval('.canvas-host', n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    for (const phase of ['hover', 'pan', 'zoom']) {
      await page.evaluate(() => { window.__flux.fig.viewport.set({ panX: 30, panY: 60, zoom: 1 }); });
      await waitFor(page, () => !document.querySelector('.canvas-host .zoom-proxy.live') && !window.__scale3dStats()?.active && !window.__scale3dStats()?.queued, null, { timeout: 90000, label: 'phase starts with settled viewport and idle worker' });
      await waitForFrame(page);
      const hoverPoints = await page.$$eval('[data-editor-element-id]', nodes => nodes.slice(0, 2).map(n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: n.dataset.editorElementId }; }));
      await page.evaluate(() => {
        window.__scale3dInputs = [];
        window.__scale3dListener = e => {
          const sample = { type: e.type, stamp: e.timeStamp, trusted: e.isTrusted, visible: document.visibilityState, focused: document.hasFocus() };
          window.__scale3dInputs.push(sample);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            sample.paint = performance.now();
            const F = window.__flux;
            sample.viewport = { ...F.get(F.fig.viewport) };
            sample.hover = F.get(F.fig.hoverId);
            sample.hoverBox = document.querySelector('.hover-box')?.outerHTML;
            const proxy = document.querySelector('.canvas-host .zoom-proxy.live');
            sample.proxy = !!proxy;
            sample.sceneTransform = (proxy ?? document.querySelector('.canvas-host .scene'))?.getAttribute('style');
          }));
        };
        for (const name of ['pointermove', 'wheel']) document.addEventListener(name, window.__scale3dListener, { capture: true, passive: true });
      });
      await page.mouse.move(box.x + 420, box.y + 270);
      if (phase === 'pan') { await page.keyboard.down('Space'); await page.mouse.down(); }
      if (phase === 'zoom') await page.keyboard.down('Control');
      await page.evaluate(() => { window.__scale3dInputs = []; });
      for (let i = 0; i < 48; i++) {
        if (phase === 'zoom') await page.mouse.wheel({ deltaY: i % 2 ? 12 : -12 });
        else if (phase === 'hover') { const p = hoverPoints[i % 2]; await page.mouse.move(p.x, p.y); }
        else await page.mouse.move(box.x + 420 + (i % 2 ? 30 : -30), box.y + 270 + i % 7);
        await waitForFrame(page);
      }
      if (phase === 'pan') { await page.mouse.up(); await page.keyboard.up('Space'); }
      if (phase === 'zoom') await page.keyboard.up('Control');
      await waitFor(page, () => window.__scale3dInputs.every(s => s.paint), null, { label: 'all delivered inputs reach paint observation' });
      const samples = await page.evaluate(phase => {
        for (const name of ['pointermove', 'wheel']) document.removeEventListener(name, window.__scale3dListener, true);
        return window.__scale3dInputs.filter(s => s.type === (phase === 'zoom' ? 'wheel' : 'pointermove'));
      }, phase);
      h.eq(samples.length, 48, `${kind} ${phase}: all 48 trusted inputs delivered`);
      h.ok(samples.every(s => s.trusted && s.visible === 'visible' && s.focused), `${kind} ${phase}: input window remains visible and focused`);
      if (phase === 'hover') {
        h.ok(hoverPoints.every(p => samples.some(s => s.hover === p.id && s.hoverBox)), `${kind}: both actual element hover outlines observed`);
      } else {
        const views = samples.map(s => phase === 'zoom' ? s.viewport.zoom : s.viewport.panX);
        h.ok(new Set(views).size > 1 && new Set(samples.map(s => s.sceneTransform)).size > 1, `${kind} ${phase}: input changes viewport and rendered scene transform`);
      }
      results.cohorts.push({ kind, phase, raw: samples, samples: samples.slice(6).map(s => s.paint - s.stamp) });
    }
  }
  const p95 = a => [...a].sort((a, b) => a - b)[Math.ceil(a.length * .95) - 1];
  results.comparison = {};
  for (const phase of ['hover', 'pan', 'zoom']) {
    const samples = kind => results.cohorts.filter(c => c.kind === kind && c.phase === phase).flatMap(c => c.samples);
    const model = p95(samples('model')), image = p95(samples('image'));
    results.comparison[phase] = { modelP95: model, imageP95: image, ratio: model / image };
    h.ok(Number.isFinite(model) && model <= 100, `${phase}: model input to observed paint p95 ≤100 ms`);
    h.ok(model <= image * 1.1, `${phase}: model p95 no more than 10% above matched image baseline`);
  }
  h.eq(realErrors(page), [], 'no browser errors during heavy scene interactions');
} catch (error) { h.fail(String(error.stack ?? error)); await page.screenshot({ path: out + '/failure.png' }).catch(() => {}); }
finally { await writeFile(out + '/browser.json', JSON.stringify(results, null, 2)); await browser.close(); }
await h.done();
