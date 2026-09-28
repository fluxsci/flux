/** Real hover defers optional SVG snapshot work; quiet resumes a pixel-valid proxy. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { launch, gotoApp, clickMode, waitFor, realErrors, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-model3d-snapshot-quiet');
const out = 'test-results/model3d/snapshot-quiet'; await mkdir(out, { recursive: true });
const fixture = { bytes: (await readFile('scripts/fixtures/model3d/fluxplot/continuous.glb')).toString('base64'), manifest: await readFile('scripts/fixtures/model3d/fluxplot/continuous.fluxplot.json', 'utf8') };
const { browser, page } = await launch({ width: 1400, height: 1000 });
const result = {};
const proxy = () => page.$eval('.zoom-proxy', node => node.src);
const point = () => page.$eval('[data-model3d-poster]', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const hover = async (ms = 2100) => {
  const p = await point(), start = Date.now(); let moves = 0;
  while (Date.now() - start < ms) {
    await page.mouse.move(p.x + (moves % 2 ? 18 : -18), p.y + (moves % 3 - 1) * 8);
    moves++;
    await new Promise(resolve => setTimeout(resolve, 30)); // actual sustained input cadence, not a readiness sleep
  }
  return moves;
};
const ready = previous => waitFor(page, previous => {
  const image = document.querySelector('.zoom-proxy');
  return !!image?.complete && image.naturalWidth > 0 && (!previous || image.src !== previous) && !image.classList.contains('live');
}, previous, { timeout: 20000, label: 'decoded current zoom proxy after actual quiet' });
const nudge = async id => {
  const before = await page.evaluate(id => window.__flux.figures()[0].elements.find(e => e.id === id)?.x, id);
  await page.keyboard.press('ArrowRight');
  await waitFor(page, ({ id, before }) => window.__flux.figures()[0].elements.find(e => e.id === id)?.x === before + 1, { id, before }, { label: 'real ArrowRight changes selected model position' });
};
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 0 });
  await clickMode(page, 'Figure', { settle: 0 });
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'), null, { label: 'Figure mounted' });
  const id = await page.evaluate(async fixture => {
    const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot);
    await F.lifecycle.flushById('figure');
    F.fig.commit(p => { p.figures = [{ ...p.figures[0], id: 'snapshot-quiet', referenceKey: 'fig-snapshot-quiet', number: 1, name: 'Snapshot quiet', x: 0, y: 0, width: 700, height: 500, elements: [], groups: {}, captions: {} }]; });
    F.fig.activeFigureId.set('snapshot-quiet'); F.fig.selectedFrameId.set(null); F.fig.viewport.set({ panX: 35, panY: 45, zoom: 1 });
    await window.fig.writeFile(root + '/plots/continuous.glb', Uint8Array.from(atob(fixture.bytes), c => c.charCodeAt(0)));
    await window.fig.writeText(root + '/plots/continuous.fluxplot.json', fixture.manifest);
    await F.io.importPlotsFromPaths([root + '/plots/continuous.glb']);
    return F.figures()[0].elements[0].id;
  }, fixture);
  await waitFor(page, () => document.querySelector('image[data-model3d-poster]')?.getAttribute('href')?.startsWith('data:image/png') && !window.__fluxModel3d?.stats().pendingPosters, null, { label: 'real model poster', timeout: 30000 });
  let p = await point(); await page.mouse.click(p.x, p.y);
  await waitFor(page, id => window.__flux.get(window.__flux.fig.selection).has(id), id, { label: 'real selected model' });
  await ready(); const initial = await proxy();
  await page.evaluate(() => {
    const state = window.__snapshotQuiet = { svgs: [], urls: new Set(), rasters: [], moves: [], idles: [], quietTimers: [], frames: [], hold: false, held: false, release: null };
    const timeout = window.setTimeout;
    window.setTimeout = function(callback, delay, ...args) {
      const id = Reflect.apply(timeout, this, [callback, delay, ...args]);
      if (delay === 1500) state.quietTimers.push({ id, time: performance.now() });
      return id;
    };
    const idle = window.requestIdleCallback;
    window.requestIdleCallback = function(callback, options) {
      const id = Reflect.apply(idle, this, [callback, options]);
      state.idles.push({ id, time: performance.now() });
      return id;
    };
    const create = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      const url = Reflect.apply(create, this, [blob]);
      if (blob.type === 'image/svg+xml') { state.urls.add(url); state.svgs.push({ time: performance.now(), url }); }
      return url;
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(image, ...args) {
      if (state.urls.has(image?.src)) state.rasters.push({ time: performance.now(), url: image.src });
      return Reflect.apply(draw, this, [image, ...args]);
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function() {
      await Reflect.apply(decode, this, []);
      if (state.hold && state.urls.has(this.src)) {
        state.held = true;
        await new Promise(resolve => { state.release = () => { state.hold = false; state.held = false; state.release = null; resolve(); }; });
      }
    };
    document.addEventListener('flux-model3d-frame', event => state.frames.push(event.detail), true);
    document.querySelector('.canvas-host').addEventListener('pointermove', e => state.moves.push({ time: performance.now(), trusted: e.isTrusted, orbit: !!e.target.closest('[data-model3d-orbit]'), promoted: document.querySelector('.scene').style.willChange }), true);
  });
  result.validHoverMoves = await hover(1700);
  h.eq(await proxy(), initial, 'pure hover preserves an existing valid bitmap');
  h.eq(await page.evaluate(() => window.__snapshotQuiet.svgs.length), 0, 'pure hover creates no optional snapshot work');
  h.ok(await page.evaluate(() => window.__snapshotQuiet.moves.length > 20 && window.__snapshotQuiet.moves.every(m => m.trusted && m.promoted !== 'transform')), 'real hover does not promote the live scene');

  const before = await page.evaluate(() => ({ svg: window.__snapshotQuiet.svgs.length, moves: window.__snapshotQuiet.moves.length, started: performance.now() }));
  await nudge(id); result.pendingHoverMoves = await hover();
  result.pending = await page.evaluate(before => ({ ...before, end: performance.now(), svg: window.__snapshotQuiet.svgs.length, moves: window.__snapshotQuiet.moves.slice(before.moves) }), before);
  h.ok(result.pending.end - before.started > 1500 && result.pending.moves.length > 35 && result.pending.moves.every(m => m.trusted), 'sustained real pointer input crosses the original quiet deadline');
  h.eq(result.pending.svg, before.svg, 'no SVG snapshot starts during sustained hover after an edit');
  h.eq(await proxy(), initial, 'pending hover does not replace the prior invisible bitmap');
  await ready(initial); const settled = await proxy();
  result.quiet = await page.evaluate(() => ({ svgs: window.__snapshotQuiet.svgs, rasters: window.__snapshotQuiet.rasters, lastMove: window.__snapshotQuiet.moves.at(-1).time }));
  h.eq(result.quiet.svgs.length, 1, 'true quiet eventually produces one fresh snapshot');
  h.ok(result.quiet.svgs[0].time > result.quiet.lastMove && result.quiet.rasters.length === 1, 'snapshot rasterization follows the last pointer activity');

  const priorIdles = await page.evaluate(() => { window.__snapshotQuiet.hold = true; return window.__snapshotQuiet.idles.length; });
  await nudge(id);
  p = await point(); await page.mouse.move(p.x + 12, p.y);
  await waitFor(page, count => window.__snapshotQuiet.idles.length > count, priorIdles, { label: 'real quiet timer registers idle capture' });
  // Headless Chromium can postpone a no-timeout idle callback indefinitely
  // without a subsequent frame. Supply one test-only frame after registration;
  // the browser still delivers the callback and the actual SVG still decodes.
  await page.screenshot({ path: out + '/held-capture-frame.png' });
  await waitFor(page, () => window.__snapshotQuiet.held, null, { label: 'hold only an already decoded SVG snapshot continuation' });
  const held = await page.evaluate(() => ({ svg: window.__snapshotQuiet.svgs.length, rasters: window.__snapshotQuiet.rasters.length }));
  p = await point(); await page.mouse.move(p.x + 20, p.y);
  await page.evaluate(() => window.__snapshotQuiet.release());
  result.inflightHoverMoves = await hover();
  h.eq(await proxy(), settled, 'pointer activity rejects an obsolete asynchronous snapshot publication');
  h.eq(await page.evaluate(() => window.__snapshotQuiet.rasters.length), held.rasters, 'obsolete decoded SVG performs no raster readback after hover resumes');
  h.eq(await page.evaluate(() => window.__snapshotQuiet.svgs.length), held.svg, 'cancelled in-flight work is not retried during sustained hover');
  await ready(settled);
  result.pixels = await page.evaluate(() => {
    const image = document.querySelector('.zoom-proxy'), rect = image.getBoundingClientRect(), mesh = document.querySelector('[data-model3d-poster]').getBoundingClientRect();
    const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
    const x = Math.max(0, Math.round((mesh.x - rect.x) * c.width / rect.width)), y = Math.max(0, Math.round((mesh.y - rect.y) * c.height / rect.height));
    const w = Math.min(c.width - x, Math.round(mesh.width * c.width / rect.width)), h = Math.min(c.height - y, Math.round(mesh.height * c.height / rect.height));
    const data = ctx.getImageData(x, y, w, h).data; let blue = 0;
    for (let at = 0; at < data.length; at += 4) if (data[at + 2] > data[at] + 30 && data[at + 2] > data[at + 1] + 30 && data[at + 3] > 100) blue++;
    return { blue, width: c.width, height: c.height };
  });
  h.ok(result.pixels.blue > 300, 'resumed quiet snapshot contains actual 3D mesh pixels');
  p = await point(); await page.mouse.move(p.x, p.y); await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -60 }); await page.keyboard.up('Control');
  h.ok(await page.$eval('.zoom-proxy', node => node.classList.contains('live')), 'real Ctrl-wheel uses the current decoded proxy after hover');
  await page.screenshot({ path: out + '/zoom-proxy.png' });
  await waitFor(page, () => !document.querySelector('.zoom-proxy')?.classList.contains('live'), null, { label: 'zoom returns to sharp live scene' });
  await page.screenshot({ path: out + '/quiet-scene.png' });
  await page.click('.model3d-properties .heading button');
  await waitFor(page, () => !!document.querySelector('[data-model3d-orbit].ready'), null, { label: 'actual Orbit button starts a painted preview', timeout: 30000 });
  const beforeDrag = await page.evaluate(() => window.__snapshotQuiet.frames.length);
  p = await point(); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 20, p.y + 10, { steps: 4 }); await page.mouse.up();
  await waitFor(page, count => window.__snapshotQuiet.frames.length > count && window.__snapshotQuiet.frames.at(-1)?.fullResolution === true, beforeDrag, { label: 'changed Orbit view has a full-resolution release frame', timeout: 30000 });
  const beforeOrbit = await page.evaluate(() => ({ timers: window.__snapshotQuiet.quietTimers.length, idles: window.__snapshotQuiet.idles.length, svgs: window.__snapshotQuiet.svgs.length, renders: window.__fluxModel3d.stats().renders, moves: window.__snapshotQuiet.moves.length }));
  result.orbitHoverMoves = await hover(1700);
  // Observe the unchanged 1500ms scheduling window after real ordinary hover.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1700)));
  result.orbit = await page.evaluate(before => ({ before, timers: window.__snapshotQuiet.quietTimers.length, idles: window.__snapshotQuiet.idles.length, svgs: window.__snapshotQuiet.svgs.length, renders: window.__fluxModel3d.stats().renders, moves: window.__snapshotQuiet.moves.slice(before.moves) }), beforeOrbit);
  h.ok(result.orbit.moves.length > 20 && result.orbit.moves.every(move => move.trusted && move.orbit), 'ordinary trusted hover reaches the active Orbit overlay');
  h.eq(result.orbit.timers, beforeOrbit.timers, 'active previews never schedule optional snapshot quiet timers');
  h.eq({ idles: result.orbit.idles, svgs: result.orbit.svgs, renders: result.orbit.renders }, { idles: beforeOrbit.idles, svgs: beforeOrbit.svgs, renders: beforeOrbit.renders }, 'resting Orbit hover has no snapshot or render heartbeat');
  await page.screenshot({ path: out + '/orbit-hover.png' });
  await page.keyboard.press('Enter');
  await waitFor(page, () => !document.querySelector('[data-model3d-live]'), null, { label: 'changed Orbit view settles to its decoded poster', timeout: 30000 });
  h.eq(realErrors(page), [], 'clean console through hover, cancellation, zoom and Orbit');
} catch (error) {
  result.failureState = await page.evaluate(() => {
    const F = window.__flux, state = window.__snapshotQuiet;
    return { hold: state?.hold, held: state?.held, svgs: state?.svgs, rasters: state?.rasters, selected: [...F.get(F.fig.selection)], figure: F.figures()[0], focus: document.activeElement?.outerHTML.slice(0, 200), pending: window.__fluxModel3d?.stats() };
  }).catch(() => null);
  h.fail(String(error.stack ?? error)); await page.screenshot({ path: out + '/failure.png' }).catch(() => {});
} finally { await writeFile(out + '/receipt.json', JSON.stringify(result, null, 2)); await browser.close(); }
await h.done();
