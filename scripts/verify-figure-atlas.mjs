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
  await clickFigure(page, fx.figIds[4]);
  // A press outside Canvas gestures (an Arrange gap scrub, a panel scrub) is
  // still a gesture: the deactivated figure's swap must not land inside it.
  const held = await page.$eval('.sidebar', n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.bottom - 12 }; });
  await page.mouse.move(held.x, held.y); await page.mouse.down();
  // A negative observation needs a window: idle timeout (300 ms) + readiness + one Route-L job fit well inside it.
  await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
  const duringPress = await page.$eval(`[data-annotation-figure="${fx.figIds[3]}"]`, g => ({ live: g.querySelectorAll('[data-editor-element-id]').length, raster: g.querySelector('[data-figure-raster]')?.getAttribute('data-raster-key') ?? null }));
  await page.mouse.up();
  h.ok(duringPress.live > 0 && duringPress.raster === null, `a held pointer defers the deactivated figure's swap (${JSON.stringify(duringPress)})`);
  await settledAtlas(page);
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
  // R2: activation warms up OFF the press. Log each animation frame of the
  // activated figure from just before a real press on its picture.
  await settledAtlas(page);
  const warmId = fx.figIds[8], warmAt = await figurePoint(page, warmId);
  await page.evaluate(id => {
    const g = document.querySelector(`[data-annotation-figure="${id}"]`); window.__warmLog = [];
    const frame = () => {
      const slots = [...g.querySelectorAll('[data-editor-element-id]')], img = g.querySelector('[data-figure-raster]');
      window.__warmLog.push({ ids: slots.map(n => n.getAttribute('data-editor-element-id')), img: !!img,
        behind: !!img && slots.every(n => (img.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) > 0), opacity: slots.map(n => getComputedStyle(n).opacity) });
      if (window.__warmLog.length < 240 && (img || !slots.length)) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Mutation batches show the state each commit leaves for the next paint.
    window.__warmMuts = [];
    new MutationObserver(() => {
      const slots = [...g.querySelectorAll('[data-editor-element-id]')], img = g.querySelector('[data-figure-raster]');
      window.__warmMuts.push({ frame: window.__warmLog.length, mode: g.getAttribute('data-atlas-mode'), slots: slots.length, img: !!img,
        behind: !!img && slots.every(n => (img.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) > 0), opacity: slots.map(n => getComputedStyle(n).opacity) });
    }).observe(g, { childList: true, subtree: true });
  }, warmId);
  await page.mouse.move(warmAt.x, warmAt.y); await page.mouse.down(); await page.mouse.up();
  await waitFor(page, () => { const l = window.__warmLog; return l.length > 2 && !l.at(-1).img && l.at(-1).ids.length > 0; }, null, { label: 'activated figure warmed up and dropped its picture', timeout: 10000 });
  const warm = await page.evaluate(() => window.__warmLog), muts = await page.evaluate(() => window.__warmMuts);
  const firstMount = warm.findIndex(f => f.ids.length > 0), partial = muts.filter(f => f.img && f.slots > 0);
  h.ok(warm[0].ids.length === 0 && warm[0].img, `(R2) the press frame paints the picture with no slot mounted (${JSON.stringify(warm[0])})`);
  h.ok(firstMount > 0 && warm[firstMount].ids.includes(warmAt.elementId), `(R2) the pressed element mounts in the first chunk (frame ${firstMount}: ${JSON.stringify(warm[firstMount]?.ids)})`);
  h.ok(partial.length > 0 && partial.every(f => f.behind && f.opacity.every(o => o === '1')), `(R2) while warming the picture sits behind slots at normal opacity (${partial.length} commits: ${JSON.stringify(partial.slice(0, 2))})`);
  const dropped = muts.find(f => !f.img), lastWithPicture = muts.filter(f => f.img).at(-1);
  h.ok(!!dropped && dropped.slots === 3 && dropped.frame > (lastWithPicture?.frame ?? -1), `(R2) the picture is dropped only in a later frame than the last mount (${JSON.stringify({ dropped, lastWithPicture })})`);
  h.ok(!warm.at(-1).img && warm.at(-1).ids.length === 3, `(R2) the picture is removed once every wanted element mounted (${JSON.stringify(warm.at(-1))})`);
  // Without the scene raster child (the browser bridge, like base parking) the
  // active figure keeps no offscreen working set: panning it fully out of view
  // unmounts its element DOM, so its models/plots release their live resources
  // (selected elements always stay mounted, so clear the selection first).
  await page.evaluate(() => { const F = window.__flux.fig; F.selection.set(new Set()); F.viewport.update(v => ({ ...v, panX: -50000, panY: -50000 })); });
  try {
    await waitFor(page, () => document.querySelectorAll('[data-editor-element-id]').length === 0, null, { timeout: 5000, label: 'offscreen active figure unmounts' });
    h.ok(true, 'an offscreen active figure keeps no live element DOM without the scene raster child');
  } catch (error) { h.fail(`an offscreen active figure keeps no live element DOM without the scene raster child: ${error}`); }
  // R4: with the scene raster child (Electron's capability, stubbed here) the
  // active figure retains its mounted working set, and an Arrange visit must not
  // drop it: selected-but-offscreen wrappers keep their identity on entry.
  const keep = await page.evaluate(async id => {
    const F = window.__flux, f = F.figures().find(x => x.id === id), host = document.querySelector('.canvas-host');
    window.fig.rasterizeScene ??= async () => ({ error: 'unavailable' });
    F.fig.activeFigureId.set(id);
    const el = f.elements[0], zoom = 12;
    F.fig.viewport.set({ zoom, panX: host.clientWidth / 2 - (f.x + el.x + el.width / 2) * zoom, panY: host.clientHeight / 2 - (f.y + el.y + el.height / 2) * zoom });
    F.fig.selection.set(new Set(f.elements.map(e => e.id)));
    return f.elements.map(e => e.id);
  }, fx.figIds[0]);
  await waitFor(page, ids => ids.every(id => document.querySelector(`[data-editor-element-id="${id}"]`)), keep, { label: 'selected working set mounted', timeout: 10000 });
  await page.evaluate(() => new Promise(r => setTimeout(r, 400))); // the cull step settles (a re-cull is what drops them)
  await page.evaluate(ids => { window.__keepNodes = ids.map(id => document.querySelector(`[data-editor-element-id="${id}"]`)); }, keep);
  await page.keyboard.down('Alt'); await page.keyboard.press('t'); await page.keyboard.up('Alt');
  await waitFor(page, () => document.querySelector('.align-arrange-panel')?.getAttribute('aria-label') === 'Flux Arrange', null, { label: 'Alt+T opens Arrange' });
  await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
  const kept = await page.evaluate(() => window.__keepNodes.filter(n => !n.isConnected).length);
  h.eq(kept, 0, `(R4) an Arrange visit keeps the active figure's retained wrappers (${kept} of ${keep.length} unmounted)`);
  await page.keyboard.press('Escape');
  h.eq(realErrors(page).length, 0, `console clean: ${realErrors(page).join(' | ')}`);
  // D3 ruling (R3): with the raster service present (stubbed here with a
  // magenta PNG of the requested size), a DEACTIVATED figure is pictured by
  // Route C from its model — never a Route-L capture of its live DOM.
  const svc = await browser.newPage();
  try {
    await svc.setViewport({ width: 1600, height: 1000 });
    const sfx = await atlasFixture(svc, 12, { beforeLoad: () => {
      window.__cCalls = [];
      window.fig.rasterizeFigure = async req => {
        window.__cCalls.push(req.figure.id);
        const c = new OffscreenCanvas(req.width, req.height), x = c.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, req.width, req.height);
        return { png: new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()), width: req.width, height: req.height };
      };
    } });
    await settledAtlas(svc);
    const before = await svc.evaluate(() => ({ routeL: window.__flux.atlas.stats.routeL, calls: window.__cCalls.length }));
    await clickFigure(svc, sfx.figIds[1]);
    await waitFor(svc, id => window.__flux.get(window.__flux.atlas.rasters).get(id)?.key === document.querySelector(`[data-annotation-figure="${id}"]`)?.querySelector('[data-figure-raster]')?.getAttribute('data-raster-key') && !!document.querySelector(`[data-figure-raster="${id}"]`), sfx.figIds[0], { label: 'deactivated figure pictured', timeout: 10000 });
    const after = await svc.evaluate(id => ({ routeL: window.__flux.atlas.stats.routeL, calls: window.__cCalls.filter(f => f === id).length, route: window.__flux.get(window.__flux.atlas.rasters).get(id)?.route }), sfx.figIds[0]);
    h.ok(after.route === 'C' && after.routeL === before.routeL && after.calls >= 1, `(R3) a deactivated figure is pictured by the raster service, not a Route-L capture (${JSON.stringify({ before, after })})`);
    h.eq(realErrors(svc).length, 0, `service page console clean: ${realErrors(svc).join(' | ')}`);
  } finally { await svc.close(); }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/figure-atlas.json', JSON.stringify({ timings, before, after: state, pixelDiff: diff }, null, 2));
  console.log(`timings ${JSON.stringify(timings)}`);
} finally { await browser.close(); }
await h.done();
