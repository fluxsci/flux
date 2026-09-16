// Continuous input must reveal newly visible artwork and never hide it behind
// an offscreen/stale zoom image. Run against the actual shared Canvas.
import { launch, gotoApp, clickMode, waitFor, sleep, realErrors, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-canvas-coverage');
const { browser, page } = await launch();
const fresh = previous => waitFor(page, src => {
  const i = document.querySelector('.zoom-proxy');
  return i?.complete && i.naturalWidth > 0 && i.src !== src && !i.classList.contains('live');
}, previous ?? '', { timeout: 20000, label: 'current snapshot' });
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 500 });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!document.querySelector('[data-editor-element-id]'), null, { timeout: 15000 });
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit(p => { p.figures = [{ ...p.figures[0], id: 'audit-wide', x: 0, y: 0, width: 6000, height: 700,
      background: '#fff', elements: [0, 800, 1600, 2400, 3200, 4000, 4800].map((x, i) => ({
        id: 'audit-' + i, type: 'rect', x, y: 100, width: 200, height: 250, rotation: 0,
        fill: '#d00000', stroke: 'none', strokeWidth: 0, cornerRadius: 0,
      })) }]; });
    F.activeCanvasId.set(window.__flux.get(F.project).figures[0].canvasId);
    F.activeFigureId.set('audit-wide'); F.viewport.set({ zoom: 1, panX: 40, panY: 60 });
  });
  await fresh();
  h.eq(await page.$eval('.zoom-proxy', i => getComputedStyle(i).opacity), '0', 'idle raster is fully invisible, with no stale ghost');
  const host = await page.$eval('.canvas-host', e => { const r = e.getBoundingClientRect(); return { x: r.x + 300, y: r.y + 200 }; });
  await page.mouse.move(host.x, host.y);
  for (let i = 0; i < 20; i++) { await page.mouse.wheel({ deltaX: 120 }); await sleep(16); }
  h.ok(!!await page.$('[data-editor-element-id="audit-4"]'), 'long continuous pan mounts the destination before the gesture ends');
  await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -10 });
  h.ok(await page.evaluate(() => {
    const p = document.querySelector('.zoom-proxy'), sc = document.querySelector('.scene');
    if (getComputedStyle(sc).opacity === '1') return true;
    const r = p.getBoundingClientRect(), host = document.querySelector('.canvas-host').getBoundingClientRect();
    return p.classList.contains('live') && r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom;
  }), 'zoom immediately after a long pan keeps visible scene coverage');
  await page.keyboard.up('Control'); await sleep(600);

  const before = await page.$eval('.zoom-proxy', i => i.src);
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit(p => { p.figures[0].width = 900; p.figures[0].elements = p.figures[0].elements.slice(0, 1); });
    F.viewport.set({ zoom: 1, panX: 40, panY: 60 });
  });
  await fresh(before);
  await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -20 });
  h.ok(await page.$eval('.zoom-proxy', i => i.classList.contains('live')), 'fresh covered scene uses the fast zoom path');
  await page.evaluate(() => window.__flux.fig.commit(p => { p.figures[0].elements[0].fill = '#008800'; }));
  await waitFor(page, () => getComputedStyle(document.querySelector('.scene')).opacity === '1', null, { timeout: 1000, label: 'edit reveals live scene' });
  h.ok(!await page.$eval('.zoom-proxy', i => i.classList.contains('live')), 'content edit during zoom retires the stale image immediately');
  await page.keyboard.up('Control'); await sleep(600);
  const old = await page.$eval('.zoom-proxy', i => i.src); await fresh(old);
  const ungridded = await page.$eval('.zoom-proxy', i => i.src);
  await page.evaluate(() => window.__flux.settings.update(s => ({ ...s, showGrid: !s.showGrid })));
  await fresh(ungridded);
  h.ok(true, 'grid appearance invalidates the raster even without a model edit');

  // Clearing a hidden editor's stale caret is useful; clearing a selection in
  // a visible neighboring pane on a wheel event would destroy user state.
  for (const hidden of [false, true]) {
    await sleep(600);
    await page.evaluate(hidden => {
      document.querySelector('#audit-selection')?.remove();
      const el = document.createElement('div'); el.id = 'audit-selection'; el.className = hidden ? 'mc hidden' : 'mc';
      el.textContent = 'selected text'; el.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none'; document.body.appendChild(el);
      const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }, hidden);
    await page.mouse.wheel({ deltaX: 5 });
    h.eq(await page.evaluate(() => getSelection().rangeCount > 0), !hidden, hidden ? 'wheel clears a stale selection in a hidden pane' : 'wheel preserves a selection in a visible pane');
  }
  await page.evaluate(() => document.querySelector('#audit-selection')?.remove());
  const small = await page.$eval('.zoom-proxy', i => i.src);
  await page.setViewport({ width: 2400, height: 1800, deviceScaleFactor: 2 });
  await page.evaluate(() => {
    const F = window.__flux.fig;
    window.__flux.settings.update(s => ({ ...s, showGrid: false }));
    F.commit(p => { p.figures[0].width = 6000; p.figures[0].height = 6000; });
    F.viewport.set({ zoom: 1, panX: -1600, panY: -1300 });
  });
  await fresh(small);
  const capped = await page.$eval('.zoom-proxy', i => ({ src: i.src, pixels: i.naturalWidth * i.naturalHeight }));
  h.ok(capped.pixels <= 3_000_000, 'actual large DPR=2 Canvas raster respects the physical pixel budget');
  await sleep(4000); // longer than two quiet-capture intervals
  h.eq(await page.$eval('.zoom-proxy', i => i.src), capped.src, 'pixel-capped snapshots stay cached instead of rebuilding forever at idle');
  h.eq(realErrors(page), [], 'clean browser console');
} catch (e) { h.fail(String(e)); console.error(e); }
await h.done(() => browser.close());
