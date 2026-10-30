// Real pointer/keyboard paths over the Route-L-only browser bridge. Setup may
// seed data; no gesture under test calls internal Canvas handlers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, shot, realErrors, waitFor } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { atlasFixture, settledAtlas, figurePoint, clickFigure, atlasState } from './lib/atlasFixture.mjs';
const h = harness('verify-figure-atlas');
const { browser, page } = await launch({ width: 1600, height: 1000 });
const timings = {};
try {
  const fx = await atlasFixture(page), start = Date.now();
  const before = await atlasState(page);
  try { await settledAtlas(page); }
  catch (error) {
    h.fail(`(a) active-only DOM and 11 PNGs within 10 s: ${error}; ${JSON.stringify(await atlasState(page))}`);
    await shot(page, 'figure-atlas-unsettled'); await h.done(() => browser.close());
  }
  timings.firstQuietMs = Date.now() - start;
  const state = await atlasState(page);
  h.eq(state.mounted.filter(f => f.elements > 0).map(f => f.id), [state.active], '(a) only active figure has live element wrappers');
  h.eq(state.mounted.filter(f => f.rasters === 1).length, 11, '(a) every other visible figure holds one PNG');
  h.ok(state.stats.rasters >= 11 && state.stats.blankFrames === 0, '(a) published rasters cover visible frames');
  h.ok(await page.$$eval('[data-figure-raster]', nodes => nodes.every(n => n.getAttribute('href').startsWith('data:image/png;base64,'))), 'raster display is PNG data URLs');
  const orange = await page.evaluate(async () => {
    const image = new Image(); image.src = document.querySelector('[data-figure-raster]').getAttribute('href'); await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data; let orange = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 170 && data[i] > data[i+1] + 15 && data[i+1] > data[i+2] + 15) orange++;
    return orange;
  });
  h.ok(orange > 100, `source-authored .grid point artwork survives the PNG capture (${orange} orange pixels)`);
  await shot(page, 'figure-atlas-canvas');

  const hover = await figurePoint(page, fx.figIds[1]); await page.mouse.move(hover.x, hover.y);
  await waitFor(page, () => !!document.querySelector('.hover-frame'), null, { label: 'frame hover' });
  h.eq(await page.$$('.hover-box').then(a => a.length), 0, '(g) raster hover has no element box');
  h.ok(await page.$eval('[data-figure-raster="lazyfig-2"]', n => getComputedStyle(n).cursor.includes('url(') && getComputedStyle(n).cursor.endsWith('default')), '(g) raster hover uses the resting arrow family');
  await shot(page, 'figure-atlas-hover-frame');

  await page.mouse.down();
  h.eq((await atlasState(page)).selected, [hover.elementId], '(b) raster press selects the hit element');
  await page.mouse.move(hover.x + 40, hover.y + 13);
  // Observe the wrapper while the native pointer is still captured: register()
  // must inherit the transform written BEFORE it mounted.
  try { await waitFor(page, id => !!document.querySelector(`[data-editor-element-id="${id}"]`), hover.elementId, { label: 'wrapper mounts during drag' }); }
  catch (error) { console.log(JSON.stringify(await atlasState(page))); console.log(realErrors(page)); throw error; }
  const caught = await page.$eval(`[data-editor-element-id="${hover.elementId}"]`, n => n.style.transform);
  h.ok(caught.includes('translate'), '(c) mounted wrapper catches the pending compositor transform');
  await shot(page, 'figure-atlas-mid-swap-drag');
  await page.mouse.up();
  const moved = await page.evaluate(id => window.__flux.figures().flatMap(f => f.elements).find(e => e.id === id), hover.elementId);
  h.ok(Math.abs(moved.x - hover.ex - 40 / hover.zoom) < .01 && Math.abs(moved.y - hover.ey - 13 / hover.zoom) < .01,
    `(c) native press-drag across swap preserves exact world delta (${moved.x},${moved.y})`);
  await settledAtlas(page);
  h.ok(!!await page.$('[data-figure-raster="lazyfig-1"]'), '(b) deactivated first figure rasterizes');

  await clickFigure(page, fx.figIds[2]); await settledAtlas(page);
  const alt = await figurePoint(page, fx.figIds[1]);
  await page.keyboard.down('Alt'); await page.mouse.move(alt.x, alt.y); await page.mouse.down();
  await page.mouse.move(alt.x + 20, alt.y + 12, { steps: 3 }); await page.mouse.up(); await page.keyboard.up('Alt');
  h.eq(await page.evaluate(id => window.__flux.figures().find(f => f.id === id).elements.length, fx.figIds[1]), 4, '(d) Alt-drag from a raster duplicates');
  await settledAtlas(page);

  const from = await figurePoint(page, fx.figIds[3], null, { x: 590, y: 390 });
  const to = await figurePoint(page, fx.figIds[3], null, { x: 1, y: 1 });
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  h.eq((await atlasState(page)).selected.length, 3, '(e) background marquee after raster activation selects by model geometry');
  await settledAtlas(page);

  const edit = await clickFigure(page, fx.figIds[3]);
  const oldKey = await page.evaluate(id => window.__flux.get(window.__flux.atlas.rasters).get(id)?.key, fx.figIds[3]);
  await page.keyboard.press('ArrowRight');
  await waitFor(page, ({ id, x }) => window.__flux.figures().flatMap(f => f.elements).find(e => e.id === id).x !== x, { id: edit.elementId, x: edit.ex }, { label: 'real keyboard edit' });
  const live = await page.evaluate(async id => window.__flux.atlas.routeLNow(id), fx.figIds[3]);
  h.ok(!!live && live.key !== oldKey, '(f) active edit changes the picture key');
  await clickFigure(page, fx.figIds[4]); await settledAtlas(page);
  const diff = await page.evaluate(async ({ id, live }) => {
    const raster = window.__flux.get(window.__flux.atlas.rasters).get(id);
    const pixels = async url => { const image = new Image(); image.src = url; await image.decode(); const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data; };
    const a = await pixels(live.dataUrl), b = await pixels(raster.dataUrl); let differing = 0;
    for (let i = 0; i < a.length; i += 4) if ([0,1,2,3].some(c => Math.abs(a[i+c] - b[i+c]) > 8)) differing++;
    return { fraction: differing / (a.length / 4), key: raster.key, expected: live.key, dimensions: a.length === b.length };
  }, { id: fx.figIds[3], live });
  h.eq(diff.key, diff.expected, '(f) deactivation publishes the fresh edit key');
  h.ok(diff.dimensions && diff.fraction <= .02, `(f) PNG matches mounted Route-L render (AA 8/255): ${(diff.fraction * 100).toFixed(4)}% pixels differ`);

  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await waitFor(page, ({ id, x }) => window.__flux.figures().flatMap(f => f.elements).find(e => e.id === id).x === x,
    { id: edit.elementId, x: edit.ex }, { label: 'Undo changes an inactive figure' });
  h.ok(await page.$eval('[data-annotation-figure="lazyfig-4"]', frame => !!frame.querySelector('[data-figure-raster]') ||
    [...frame.querySelectorAll('[data-editor-element-id]')].some(n => getComputedStyle(n).opacity === '1')),
    'Undo keeps the stale PNG or its ready live fallback visible during replacement');
  await waitFor(page, ({ id, key }) => window.__flux.get(window.__flux.atlas.rasters).get(id)?.key !== key,
    { id: fx.figIds[3], key: diff.key }, { timeout: 10000, label: 'global Undo refreshes inactive picture without Route C' });
  await settledAtlas(page);
  h.eq((await atlasState(page)).active, fx.figIds[4], 'refreshing an inactive picture preserves the active figure');

  // Ctrl on a raster is plain select, never an empty semantic part marquee.
  const ctrl = await figurePoint(page, fx.figIds[5]); await page.keyboard.down('Control');
  await page.mouse.click(ctrl.x, ctrl.y); await page.keyboard.up('Control');
  h.eq((await atlasState(page)).selected, [ctrl.elementId], 'Ctrl on an inactive picture selects the whole element');
  h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.partSelections).length), 0, 'inactive picture cannot deep-select plot parts');
  await settledAtlas(page);

  // Real cross-figure drop over a destination that is still a PNG.
  const src = await figurePoint(page, fx.figIds[5]), dst = await figurePoint(page, fx.figIds[6], null, { x: 150, y: 100 });
  await page.mouse.move(src.x, src.y); await page.mouse.down(); await page.mouse.move(dst.x, dst.y, { steps: 8 });
  h.eq(await page.$$('.figure-bg.droptarget').then(a => a.length), 1, '(i) raster destination frame lights up during cross-figure drag');
  await page.mouse.up();
  h.ok(await page.evaluate(({ fig, el }) => window.__flux.figures().find(f => f.id === fig).elements.some(e => e.id === el), { fig: fx.figIds[6], el: src.elementId }), '(i) release reparents to the raster destination');
  await settledAtlas(page);

  const jobs = await page.evaluate(() => window.__flux.atlas.stats.routeL + window.__flux.atlas.stats.routeC);
  const anchor = await page.$eval('.canvas-host', n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(anchor.x, anchor.y); await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: 650 }); await page.keyboard.up('Control');
  // Wait through the product's settle and idle timeout before judging jobs.
  await waitFor(page, z => window.__flux.get(window.__flux.fig.viewport).zoom < z / 2, src.zoom, { label: 'zoom-out crosses 2x' });
  await page.evaluate(() => new Promise(r => setTimeout(r, 2200)));
  h.eq(await page.evaluate(() => window.__flux.atlas.stats.routeL + window.__flux.atlas.stats.routeC), jobs, '(h) zoom-out never requests a new atlas raster');
  h.eq(realErrors(page).length, 0, `console clean: ${realErrors(page).join(' | ')}`);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/figure-atlas.json', JSON.stringify({ timings, before, after: state, pixelDiff: diff }, null, 2));
  console.log(`timings ${JSON.stringify(timings)}`);
} finally { await browser.close(); }
await h.done();
