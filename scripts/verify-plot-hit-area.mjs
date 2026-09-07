// Real pointer regression: transparent SVG whitespace belongs to its plot,
// including after crop/rotation, without covering semantic parts or other layers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, waitForFrame, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';

const h = harness('verify-plot-hit-area');
const svg = readFileSync('scripts/fixtures/pre-regen/06_scatter_regression.svg', 'utf8')
  .replaceAll('fill: #fffcf0', 'fill: none');
const manifest = JSON.parse(readFileSync('scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json', 'utf8'));
const { browser, page } = await launch({ width: 1600, height: 1100 });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const paints = [];
async function seed(options = {}) {
  await page.evaluate(options => {
    const F = window.__flux, s = F.fig;
    s.clearSelection(); s.partSelection.set(null); s.activeTool.set('select');
    s.commit(p => {
      const f = p.figures[0]; p.figures = [f];
      Object.assign(f, { x: 0, y: 0, width: 850, height: 650, background: 'none' });
      delete f.groups; delete f.guides;
      f.elements = [{ type: 'plot', id: 'transparent-plot', assetId: 'transparent-asset',
        x: 150, y: 140, width: 400, height: 280, rotation: 0, overrides: {}, ...options }];
      s.activeFigureId.set(f.id); s.activeCanvasId.set(f.canvasId);
    });
    F.settings.update(v => ({ ...v, snapPixel: false, snapGrid: false }));
    s.viewport.set({ panX: 60, panY: 60, zoom: 0.8 });
    s.resetHistory(); s.dirty.set(false);
  }, options);
  await waitForFrame(page);
  await waitFor(page, () => !!document.getElementById('transparent-plot__axis.x.ticklabel.2'));
}
const state = () => page.evaluate(() => {
  const F = window.__flux, s = F.fig;
  return { el: structuredClone(F.figures()[0].elements[0]), selection: [...F.get(s.selection)],
    part: F.get(s.partSelection), history: s.historyStats() };
});
const point = (dx = 10, dy = 10) => page.evaluate(([dx, dy]) => {
  const e = window.__flux.figures()[0].elements[0];
  const g = document.querySelector('[data-editor-element-id="transparent-plot"] > g');
  const p = new DOMPoint(e.x + dx, e.y + dy).matrixTransform(g.getScreenCTM());
  return { x: p.x, y: p.y };
}, [dx, dy]);
async function click(p) {
  await page.evaluate(() => {
    window.__plotSelectionPaint = null;
    document.addEventListener('pointerdown', () => {
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__plotSelectionPaint = performance.now() - start; }));
    }, { capture: true, once: true });
  });
  await page.mouse.click(p.x, p.y);
  await waitFor(page, () => window.__plotSelectionPaint !== null);
  paints.push(await page.evaluate(() => window.__plotSelectionPaint));
}
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo' });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'));
  await page.evaluate((svg, manifest) => window.__flux.io.reimportPlot('transparent-asset', svg, manifest), svg, manifest);
  await seed();
  const p = await point();
  await click(p);
  assert.deepEqual((await state()).selection, ['transparent-plot'], 'clicking transparent margin selects the plot');
  assert.equal((await state()).part, null);

  // Start the move without preselecting; one Undo restores the complete model.
  await seed();
  const before = await state();
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x + 24, p.y + 16, { steps: 4 }); await page.mouse.up();
  await waitForFrame(page);
  let after = await state();
  assert.equal(after.el.x, before.el.x + 30);
  assert.equal(after.el.y, before.el.y + 20);
  assert.deepEqual(after.el.overrides, {});
  assert.equal(after.history.past, 1);
  await page.evaluate(() => window.__flux.fig.undo());
  assert.deepEqual((await state()).el, before.el, 'one Undo restores a whitespace drag');

  // A rear hit area must leave actual SVG parts available for deep selection.
  const part = await page.evaluate(() => {
    const r = document.getElementById('transparent-plot__axis.x.ticklabel.2').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.keyboard.down(mod); await click(part); await page.keyboard.up(mod);
  assert.equal((await state()).part?.partId, 'axis.x.ticklabel.2');
  await click(p);
  assert.equal((await state()).part, null, 'whitespace exits part selection');
  assert.deepEqual((await state()).selection, ['transparent-plot']);
  await page.keyboard.down(mod); await click(p); await page.keyboard.up(mod);
  assert.equal((await state()).part, null, 'deep click in whitespace selects no invented part');

  for (const options of [ { rotation: 32, flipX: true },
    { width: 160, height: 100, crop: { x: 0, y: 0, width: 80, height: 50 } } ]) {
    await seed(options); await click(await point());
    assert.deepEqual((await state()).selection, ['transparent-plot'], 'transformed/cropped whitespace is selectable');
    // Remove selection handles before probing the edge of the artwork itself.
    await page.evaluate(() => window.__flux.fig.clearSelection());
    await waitForFrame(page);
    await click(await point(-12, 10));
    assert.deepEqual((await state()).selection, [], 'hit area stops at the transformed placement edge');
  }

  await seed({ locked: true }); await click(await point());
  assert.deepEqual((await state()).selection, [], 'locked plot cannot be selected through whitespace');
  await seed();
  await page.evaluate(() => window.__flux.fig.commit(p => p.figures[0].elements.push({
    type: 'rect', id: 'front', x: 150, y: 140, width: 50, height: 50, rotation: 0,
    fill: '#4385be', stroke: 'none', strokeWidth: 0, cornerRadius: 0,
  })));
  await click(await point());
  assert.deepEqual((await state()).selection, ['front'], 'front layer remains selectable above plot whitespace');

  await seed();
  const exported = await page.evaluate(() => window.__flux.io.buildFigureSvg(window.__flux.figures()[0]));
  assert.ok(!exported.includes('plot-hit-area'), 'editor hit area never enters exports');
  const alpha = await page.evaluate(async svg => {
    const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    return ctx.getImageData(160, 150, 1, 1).data[3];
  }, exported);
  assert.equal(alpha, 0, 'transparent plot margin remains transparent in exported artwork');
  assert.ok(Math.max(...paints) <= 100, `selection paints within 100ms (${Math.max(...paints).toFixed(1)}ms)`);
  assert.deepEqual(realErrors(page), []);
  h.ok(true, `transparent plot selection, drag/Undo, deep selection, transforms, locks, stacking and export; max paint ${Math.max(...paints).toFixed(1)}ms`);
} finally { await browser.close(); }
await h.done();
