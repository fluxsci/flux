import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, waitFor, shot, realErrors, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { atlasFixture, settledAtlas, figurePoint, clickFigure, atlasState } from './lib/atlasFixture.mjs';
const h = harness('verify-scale-figure-atlas');
const { browser, page } = await launch({ width: 1600, height: 1000 });
const timings = {};
async function dragProbe(page, figureId) {
  const pt = await figurePoint(page, figureId);
  await page.mouse.move(pt.x, pt.y); await page.mouse.down();
  await page.evaluate(() => {
    const F = window.__flux; F.perf.slotChecks = 0; F.perf.elementRenders = 0;
    window.__atlasFrames = []; window.__atlasFrameOn = true;
    const frame = ts => { if (window.__atlasFrameOn) { window.__atlasFrames.push(ts); requestAnimationFrame(frame); } };
    requestAnimationFrame(frame);
  });
  for (let i = 1; i <= 35; i++) {
    await page.mouse.move(pt.x + i * .5, pt.y + i * .18);
    await sleep(16); // Input cadence is the display cadence, not a product delay.
  }
  const result = await page.evaluate(() => {
    window.__atlasFrameOn = false;
    const gaps = window.__atlasFrames.slice(1).map((t, i) => t - window.__atlasFrames[i]).sort((a,b) => a-b);
    return { frames: gaps.length, p95: gaps[Math.floor(gaps.length * .95)] ?? 0, max: gaps.at(-1) ?? 0,
      slotChecks: window.__flux.perf.slotChecks, elementRenders: window.__flux.perf.elementRenders };
  });
  await page.mouse.up();
  return result;
}
try {
  const fx = await atlasFixture(page, 60), start = Date.now();
  timings.before = await atlasState(page);
  try { await settledAtlas(page, 60, 45000); }
  catch (error) { h.fail(`60-figure atlas settles: ${error}; ${JSON.stringify(await atlasState(page))}`); await shot(page, 'scale-figure-atlas-unsettled'); await h.done(() => browser.close()); }
  timings.settleMs = Date.now() - start; timings.after = await atlasState(page);
  h.eq(timings.after.mounted.filter(f => f.elements).length, 1, '60 figures at fit mount elements in exactly the active figure');
  h.eq(timings.after.mounted.filter(f => f.rasters).length, 59, 'all 59 inactive figures are PNGs');
  const active = timings.after.mounted.find(f => f.id === timings.after.active);
  h.ok(active.plotNodes > 4000, `fixture has three dense plots (${active.plotNodes} nodes)`);
  h.eq(timings.after.mounted.reduce((n,f) => n + f.plotNodes, 0), active.plotNodes, 'fit plot node budget is exactly the active figure');
  await shot(page, 'scale-figure-atlas-60-fit');
  timings.heavy = await dragProbe(page, timings.after.active);
  h.ok(timings.heavy.slotChecks <= 3 && timings.heavy.elementRenders <= 3,
    `fit drag touches at most active elements: slots=${timings.heavy.slotChecks}, renders=${timings.heavy.elementRenders}`);
  await settledAtlas(page, 60);
  const anchor = await page.$eval('.canvas-host', n => { const r = n.getBoundingClientRect(); return { x: r.x + 30, y: r.y + 50 }; });
  await page.evaluate(() => { window.__flux.perf.slotChecks = 0; window.__flux.perf.elementRenders = 0; });
  await page.mouse.move(anchor.x, anchor.y); await page.keyboard.down('Space'); await page.mouse.down();
  await page.mouse.move(anchor.x + 40, anchor.y + 15, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Space');
  timings.pan = await page.evaluate(() => ({ slotChecks: window.__flux.perf.slotChecks, elementRenders: window.__flux.perf.elementRenders }));
  h.ok(timings.pan.slotChecks <= 3 && timings.pan.elementRenders <= 3, `fit pan touches at most active elements (${JSON.stringify(timings.pan)})`);
  await page.evaluate(() => { window.__flux.perf.slotChecks = 0; window.__flux.perf.elementRenders = 0; });
  await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -30 }); await page.mouse.wheel({ deltaY: 30 }); await page.keyboard.up('Control');
  await page.evaluate(() => new Promise(r => setTimeout(r, 400))); // Product zoom fold, then inspect its mounted set.
  timings.zoom = await page.evaluate(() => ({ slotChecks: window.__flux.perf.slotChecks, elementRenders: window.__flux.perf.elementRenders }));
  h.ok(timings.zoom.slotChecks <= 3 && timings.zoom.elementRenders <= 3, `fit zoom touches at most active elements (${JSON.stringify(timings.zoom)})`);
  await settledAtlas(page, 60);
  const beforeJobs = await page.evaluate(() => window.__flux.atlas.stats.routeL);
  await clickFigure(page, fx.figIds[0]); await page.keyboard.press('ArrowRight');
  // Deactivate the edited active figure through the real raster press path.
  await clickFigure(page, fx.figIds[1]); await settledAtlas(page, 60);
  timings.editJobs = await page.evaluate(n => window.__flux.atlas.stats.routeL - n, beforeJobs);
  h.ok(timings.editJobs <= 1, `one active edit causes at most one live raster job (${timings.editJobs})`);

  const control = await browser.newPage();
  try {
    await atlasFixture(control, 1);
    await waitFor(control, () => window.__flux.plot.plotResidency.pending() === 0 && document.querySelectorAll('[data-editor-element-id] svg circle').length > 4000, null, { timeout: 20000, label: 'one-figure control parsed' });
    // Same rendered scale and plot density as the heavy page. The larger
    // one-figure fit zoom would test a different pixel workload.
    const zoom = await page.evaluate(() => window.__flux.get(window.__flux.fig.viewport).zoom);
    await control.evaluate(z => window.__flux.fig.viewport.set({ zoom: z, panX: 120, panY: 120 }), zoom);
    await control.evaluate(() => new Promise(r => setTimeout(r, 2200)));
    timings.control = await dragProbe(control, 'lazyfig-1');
  } finally { await control.close(); }
  timings.gapRatio = timings.heavy.p95 / timings.control.p95;
  h.ok(timings.heavy.frames >= 20 && timings.control.frames >= 20 && timings.gapRatio <= 1.5,
    `fit drag frame p95 ratio ≤ 1.5: ${timings.heavy.p95.toFixed(2)}/${timings.control.p95.toFixed(2)} = ${timings.gapRatio.toFixed(3)}`);
  h.eq(realErrors(page).length, 0, `console clean (${realErrors(page).join(' | ')})`);
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/scale-figure-atlas.json', JSON.stringify(timings, null, 2));
  console.log(JSON.stringify(timings));
} finally { await browser.close(); }
await h.done();
