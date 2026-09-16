// Real X-ray inputs + regeneration/reimport/cache flow, hermetic file bridge.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launch, gotoApp, clickMode, realErrors, shot } from './lib/driver.mjs';
const dir = new URL('./fixtures/fluxplot03/', import.meta.url);
const bundle = { svg: await readFile(new URL('fields.svg', dir), 'utf8'),
  manifest: JSON.parse(await readFile(new URL('fields.fluxplot.json', dir), 'utf8')),
  recipe: JSON.parse(await readFile(new URL('fields.recipe.json', dir), 'utf8')) };
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: 'http://127.0.0.1:1420/?fixture=demo', settle: 1200 });
  await clickMode(page, 'Figure');
  await page.evaluate(async (bundle) => {
    const F = window.__flux, stores = await import('/src/lib/store.ts');
    window.__fieldBundle = bundle;
    const root = F.get(F.shell.projectModel).root;
    await window.fig.writeText(`${root}/plots/fields.recipe.json`, JSON.stringify(bundle.recipe));
    F.fig.commit((p) => {
      p.assets.push({ id: 'field-gate', name: 'fields.svg', kind: 'svg', path: 'assets/field-gate.svg', naturalWidth: 480, naturalHeight: 230.4 });
      p.figures[0].elements.push({ id: 'field-plot', type: 'plot', assetId: 'field-gate', x: 40, y: 40, width: 480, height: 230.4, rotation: 0,
        source: { svgPath: 'plots/fields.svg', recipePath: 'plots/fields.recipe.json' }, overrides: { 'panel.matrix.correlation.x-heatmap': { opacity: .7 } } });
    });
    F.io.reimportPlot('field-gate', bundle.svg, bundle.manifest, bundle.recipe);
    // The dev handle's stores, not a dynamic import of /src/lib/store.ts: once the
    // dev server has HMR-timestamped its module graph, that import is a SECOND
    // store instance the app never reads (2026-09-16 — the X-ray never opened).
    F.fig.xrayRoot.set({ kind: 'element', figId: F.get(F.fig.project).figures[0].id, elementId: 'field-plot' });
    F.fig.xrayOpen.set(true);
    window.__fieldCalls = [];
    window.fig.runRecipe = async (path, params) => {
      window.__fieldCalls.push({ path, params });
      return { code: 0, svgText: bundle.svg, manifestText: JSON.stringify(bundle.manifest), recipeText: JSON.stringify({ ...bundle.recipe, params }) };
    };
  }, bundle);
  await page.waitForSelector('.color-scales summary');
  await page.click('.color-scales summary');
  // 2026-09-16: the palette field carries a preview bar and opens the colormap picker (every fluxplot collection)
  await page.waitForSelector('.color-scales .cmapbtn');
  assert.ok(await page.$eval('.color-scales .cmapbar', (b) => /gradient/.test(b.getAttribute('style') || '')), 'the current colormap previews as a gradient bar');
  await page.click('.color-scales .cmapbtn');
  await page.waitForSelector('.color-scales .cmappick .cmp');
  await page.evaluate(() => document.querySelector('.color-scales .cmp .tabs .tab:nth-child(2)').click()); // Crameri
  await page.evaluate(() => document.querySelector('.color-scales .cmp .cm[data-map="batlow"]').click());
  await page.waitForFunction(() => !document.querySelector('.color-scales .cmappick'));
  assert.equal(await page.$eval('.color-scales input[aria-label="matrix / correlation palette"]', (i) => i.value), 'crameri.batlow', 'picking a map fills the palette with its qualified name');
  const input = await page.$('.color-scales input[aria-label="matrix / correlation maximum"]');
  await input.focus(); await page.keyboard.press('Home'); await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift'); await page.keyboard.press('Backspace'); await input.type('0');
  await page.click('.color-scales button[type=submit]');
  await page.waitForSelector('.color-scales [role=alert]');
  assert.equal(await page.evaluate(() => window.__fieldCalls.length), 0, 'invalid range never starts regeneration');
  await input.focus(); await page.keyboard.press('Home'); await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift'); await page.keyboard.press('Backspace'); await input.type('2');
  await page.click('.color-scales button[type=submit]');
  await page.waitForFunction(() => window.__fieldCalls.length === 1 && document.querySelector('.regen')?.textContent.includes('regenerated'));
  const state = await page.evaluate(() => ({ call: window.__fieldCalls[0],
    overrides: window.__flux.get(window.__flux.fig.project).figures[0].elements.find((e) => e.id === 'field-plot').overrides,
    nodes: window.__flux.plot.plotDom.get('field-gate').querySelectorAll('*').length }));
  assert.equal(state.call.params.__fluxplot__['panel.matrix.correlation'].vmax, 2);
  assert.equal(state.overrides['panel.matrix.correlation.x-heatmap'].opacity, .7);
  assert(state.nodes > 100 && state.nodes < 1000);
  const bounds = await page.evaluate(() => {
    const p = document.querySelector('.xray').getBoundingClientRect(), h = document.querySelector('.xhead').getBoundingClientRect();
    return { top: p.top, bottom: p.bottom, header: h.top, screen: innerHeight };
  });
  assert(bounds.top >= 0 && bounds.header >= bounds.top && bounds.bottom <= bounds.screen, 'expanded controls keep header and panel on screen');
  await shot(page, 'fluxplot03-color-scales');

  // A slow regeneration belongs to the plot that started it, even if the
  // user re-roots the X-ray before it finishes.
  const beforeReRoot = await page.evaluate((bundle) => {
    const F = window.__flux;
    F.fig.commit((p) => {
      const original = p.figures[0].elements.find((e) => e.id === 'field-plot');
      p.figures[0].elements.push({ ...structuredClone(original), id: 'field-other', assetId: 'field-other-asset', x: 550 });
      p.assets.push({ ...p.assets.find((a) => a.id === 'field-gate'), id: 'field-other-asset' });
    });
    F.io.reimportPlot('field-other-asset', bundle.svg, bundle.manifest, bundle.recipe);
    window.fig.runRecipe = () => new Promise((resolve) => { window.__resolveFieldRecipe = resolve; });
    return { ...F.get(F.plot.plotGen) };
  }, bundle);
  await page.click('.xray .regen');
  await page.waitForFunction(() => !!window.__resolveFieldRecipe);
  await page.evaluate(() => {
    const F = window.__flux;
    F.fig.xrayRoot.set({ kind: 'element', figId: F.get(F.fig.project).figures[0].id, elementId: 'field-other' });
  });
  await page.waitForFunction(() => document.querySelector('.xray .row[data-rid="el:field-other"]'));
  await page.evaluate((bundle) => window.__resolveFieldRecipe({ code: 0, svgText: bundle.svg,
    manifestText: JSON.stringify(bundle.manifest), recipeText: JSON.stringify(bundle.recipe) }), bundle);
  await page.waitForFunction(() => !document.querySelector('.xray .regen')?.disabled);
  const afterReRoot = await page.evaluate(() => ({ ...window.__flux.get(window.__flux.plot.plotGen) }));
  assert(afterReRoot['field-gate'] > beforeReRoot['field-gate'], 'the completed recipe refreshes its original plot');
  assert.equal(afterReRoot['field-other-asset'], beforeReRoot['field-other-asset'], 're-rooting cannot replace a different plot with pending recipe output');
  assert.equal(await page.$eval('.xray .regen', (b) => b.textContent.trim()), 'Regenerate', 'the new root does not inherit a different plot’s completion message');
  assert.deepEqual(realErrors(page), []);
  console.log('FLUXPLOT 0.3 GUI: ranges validated, regeneration invoked, authored overrides retained');
} finally { await browser.close(); }
