// The live (uncached) SVG must release Chromium's animated raster-scale lock
// during zoom. At 16x -> fit that lock exhausted the whole window's tile pool
// on NVIDIA/Wayland. This structural browser gate complements the actual GPU
// frame/warning oracle in perf/input-probe.cjs --phases=zoomDeep --frames.
import { mkdirSync } from 'node:fs';
import { launch, gotoApp, clickMode, waitFor, sleep, APP_URL, realErrors } from './lib/driver.mjs';
import { installDenseProject } from './lib/lazyFixture.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-canvas-zoom-raster');
const { browser, page } = await launch({ width: 1800, height: 1100 });
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 500 });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!window.__flux?.bridge && !!window.__flux?.fig);
  // >20k nodes deliberately exercises the live path, not a warm proxy.
  const fixture = await installDenseProject(page, { root: '/demo/zoom-raster', figures: 1, panels: 14 });
  await page.evaluate(async root => { await window.__flux.bridge.loadFigInto(root, 'zoom-raster'); }, fixture.root);
  await page.evaluate(id => {
    const F = window.__flux, s = F.fig, f = F.get(s.project).figures.find(f => f.id === id);
    s.activeFigureId.set(id); s.activeCanvasId.set(f.canvasId);
    s.viewport.set({ zoom: .6, panX: 100, panY: 70 });
  }, fixture.figIds[0]);
  await waitFor(page, () => document.querySelectorAll('.scene-svg *').length > 20_000, null, { timeout: 60000 });
  const original = await page.evaluate(() => JSON.stringify(window.__flux.get(window.__flux.fig.project)));
  const host = await page.$eval('.canvas-host', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; });
  await page.evaluate(({ w, h }) => window.__flux.fig.viewport.set({ zoom: 16, panX: w / 2 - 620 * 16, panY: h / 2 - 440 * 16 }), host);
  await waitFor(page, () => document.querySelector('.scene-svg > g').getAttribute('transform') === 'scale(16)', null, { label: 'deep zoom folded' });
  await sleep(250); // real raster has settled before the adverse zoom-out
  await page.mouse.move(host.x, host.y);
  await page.keyboard.down('Control');
  const samples = [];
  for (let i = 0; i < 26; i++) {
    await page.mouse.wheel({ deltaY: 120 });
    samples.push(await page.evaluate(() => {
      const sc = document.querySelector('.scene'), v = window.__flux.get(window.__flux.fig.viewport);
      const m = new DOMMatrix(getComputedStyle(sc).transform);
      const baked = Number(/scale\(([-\d.e]+)/.exec(document.querySelector('.scene-svg > g').getAttribute('transform'))[1]);
      return { zoom: v.zoom, baked, effective: m.a * baked, x: m.e, y: m.f, panX: v.panX, panY: v.panY,
        locked: sc.getAnimations().length > 0 || getComputedStyle(sc).willChange.includes('transform'),
        live: getComputedStyle(sc).opacity === '1', hover: !!document.querySelector('.hover-box,.hover-trace') };
    }));
    await sleep(8);
  }
  await page.keyboard.up('Control');
  h.ok(samples[0].zoom > 10 && samples.at(-1).zoom < .2, 'actual Ctrl-wheel covers deep zoom through fit to zoomed-out view');
  h.ok(samples.every(s => s.live), 'the test uses uncached live SVG throughout');
  h.ok(samples.every(s => !s.locked), 'live scaled artwork never retains a paused animation or will-change raster lock');
  h.ok(samples.every(s => !s.hover), 'stationary-pointer hover outlines stay hidden during zoom');
  h.ok(samples.every(s => Math.abs(s.effective - s.zoom) < 1e-4 && Math.abs(s.x - s.panX) < .01 && Math.abs(s.y - s.panY) < .01), 'world-to-screen mapping stays exact at every observed zoom');
  await waitFor(page, () => {
    const sc = document.querySelector('.scene'), v = window.__flux.get(window.__flux.fig.viewport);
    return Number(/scale\(([-\d.e]+)/.exec(document.querySelector('.scene-svg > g').getAttribute('transform'))[1]) === v.zoom && !sc.getAnimations().length;
  }, null, { label: 'sharp idle fold' });
  h.eq(await page.evaluate(() => JSON.stringify(window.__flux.get(window.__flux.fig.project))), original, 'zoom leaves all authored project data unchanged');
  await page.mouse.wheel({ deltaX: 20 });
  h.eq(await page.$eval('.scene', sc => sc.getAnimations().length), 1, 'translation still uses the fast compositor drive');
  mkdirSync('test-results/zoom-repair', { recursive: true });
  await page.screenshot({ path: 'test-results/zoom-repair/browser-zoom-out.png' });
  h.eq(realErrors(page), [], 'clean browser console');
} catch (error) { h.fail(String(error)); console.error(error); }
await h.done(() => browser.close());
