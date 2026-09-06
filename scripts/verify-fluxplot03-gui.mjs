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
    stores.xrayRoot.set({ kind: 'element', figId: F.get(F.fig.project).figures[0].id, elementId: 'field-plot' });
    stores.xrayOpen.set(true);
    window.__fieldCalls = [];
    window.fig.runRecipe = async (path, params) => {
      window.__fieldCalls.push({ path, params });
      return { code: 0, svgText: bundle.svg, manifestText: JSON.stringify(bundle.manifest), recipeText: JSON.stringify({ ...bundle.recipe, params }) };
    };
  }, bundle);
  await page.waitForSelector('.color-scales summary');
  await page.click('.color-scales summary');
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
  assert.deepEqual(realErrors(page), []);
  console.log('FLUXPLOT 0.3 GUI: ranges validated, regeneration invoked, authored overrides retained');
} finally { await browser.close(); }
