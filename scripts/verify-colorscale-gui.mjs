// Colour-system plan A7.5 / A7.7 — the live colour-scale editor in the real GUI (Inspector,
// F-menu, slide Change) over the hexmatrix fixture whose parity with fluxplot the DOM gate proves:
//   • typing a limit previews at once (the canvas hex paints the law's colour, the key's labels
//     re-tick), Enter is one undo, Ctrl+Z / Escape / an empty field restore the generated scale;
//   • an impossible limit is refused with a reason and leaves the model untouched;
//   • the colormap picker writes the picked map AS ITS TABLE (the document never depends on the
//     lazy LUTs), reverse / norm / extend round-trip, Reset clears the scale;
//   • Apply to source writes the complete v2 __fluxplot__ control, regenerates through the file
//     bridge and clears the live override; the standalone export bakes the live colours;
//   • the F-menu offers the same editor; a slide "Edit after step" writes state.colorScale on a
//     Change track and the ruler scrubs through intermediate colours.
import { readFileSync, mkdirSync } from 'node:fs';
import { harness } from './lib/harness.mjs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, waitForFrame, realErrors } from './lib/driver.mjs';
const h = harness('verify-colorscale-gui');
const dir = 'scripts/fixtures/colorscale/';
const svg = readFileSync(`${dir}hexmatrix.svg`, 'utf8');
const manifest = JSON.parse(readFileSync(`${dir}hexmatrix.fluxplot.json`, 'utf8'));
const recipe = JSON.parse(readFileSync(`${dir}hexmatrix.recipe.json`, 'utf8'));
const edited = { svg: readFileSync(`${dir}hexmatrix-edited.svg`, 'utf8'), manifest: readFileSync(`${dir}hexmatrix-edited.fluxplot.json`, 'utf8'), recipe: readFileSync(`${dir}hexmatrix-edited.recipe.json`, 'utf8') };
const { browser, page } = await launch({ width: 1500, height: 1000 });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const scope = (root) => ({ block: `${root} .color-scales`, max: `${root} [data-color-scale-limits="rates"] .nf:nth-of-type(2) input`, min: `${root} [data-color-scale-limits="rates"] .nf:nth-of-type(1) input` });
const I = scope('.inspector');
const PROBE = 'cs-plot__rates.hex.1.1';
const hex = (container = '.canvas-host [data-editor-element-id="cs-plot"]') => page.evaluate((c, id) => document.querySelector(`${c} [id="${id}"]`)?.style.fill ?? null, container, PROBE);
const labels = () => page.evaluate(() => [...document.querySelectorAll('.canvas-host [data-editor-element-id="cs-plot"] [id^="cs-plot__colorbar.color.tick-label."]')].filter(n => n.style.display !== 'none').map(n => n.textContent.replace(/\s+/g, '')));
const stop = (i) => page.evaluate((i) => { const s = document.querySelectorAll('.canvas-host [data-editor-element-id="cs-plot"] [id="cs-plot__colorbar.color.solids.gradient"] stop'); return s[i < 0 ? s.length + i : i]?.getAttribute('stop-color'); }, i);
const expected = (view) => page.evaluate(async (view, id) => {
  const { effectiveScale, colorFor } = await import('/src/lib/plot/colorscale.ts');
  const F = window.__flux, m = F.get(F.plot.plotManifests)['cs-asset'], scale = m.colorScales[0];
  const eff = effectiveScale(scale, view, () => null);
  const v = Number(document.querySelector(`.canvas-host [id="${id}"]`).getAttribute('data-value'));
  const c = colorFor(eff, v).slice(0, 7);
  return `rgb(${parseInt(c.slice(1, 3), 16)}, ${parseInt(c.slice(3, 5), 16)}, ${parseInt(c.slice(5, 7), 16)})`;
}, view, PROBE);
const model = () => page.evaluate(() => { const F = window.__flux, p = F.get(F.fig.project), el = p.figures.flatMap(f => f.elements).find(e => e.id === 'cs-plot'); return { cs: el.colorScale ?? null, history: F.fig.historyStats().past }; });
async function seed(mode) {
  await gotoApp(page, { url: APP_URL + '?fixture=demo' });
  await clickMode(page, mode);
  await waitFor(page, () => !!window.__flux && !!document.querySelector('.canvas-host'));
  await page.evaluate(async (svg, manifest, recipe) => {
    const F = window.__flux;
    const root = F.get(F.shell.projectModel).root;
    await window.fig.writeText(`${root}/plots/hexmatrix.recipe.json`, JSON.stringify(recipe));
    F.io.reimportPlot('cs-asset', svg, manifest, recipe);
    F.fig.commit(p => {
      const f = p.figures.find(f => f.id === F.get(F.fig.activeFigureId));
      f.elements = [{ id: 'cs-plot', type: 'plot', assetId: 'cs-asset', x: 40, y: 60, width: 326.4, height: 268.8, rotation: 0, source: { svgPath: 'plots/hexmatrix.svg', recipePath: 'plots/hexmatrix.recipe.json' } }];
    });
    F.fig.selectOnly('cs-plot'); F.fig.resetHistory();
  }, svg, manifest, recipe);
  await waitFor(page, s => !!document.querySelector(s), `${I.block} summary`);
  await page.evaluate(s => { const d = document.querySelector(s); if (!d.open) d.querySelector('summary').click(); }, I.block);
  await waitFor(page, s => !!document.querySelector(s), I.max);
}
async function type(value, selector = I.max) { await page.click(selector, { count: 3 }); await page.keyboard.type(value); await waitForFrame(page); }
try {
  await seed('Figure');
  h.eq(await page.$eval(`${I.block} input[aria-label="rates palette"]`, n => n.value), 'viridis', 'the palette shows the generated colormap');
  h.eq(await page.$eval(I.max, n => n.value), '', 'default limit is empty');
  h.eq(await page.$eval(I.max, n => n.placeholder), '143', 'placeholder is the generated maximum');
  const before = await hex(), beforeLabels = await labels();
  h.eq(beforeLabels, ['1', '3', '10', '30', '100'], 'the generated key reads 1·3·10·30·100');
  await type('20');
  h.eq((await model()).cs?.rates?.norm?.vmax, 20, 'typing previews the limit before commit');
  const at20 = await hex();
  h.ok(at20 !== before, 'the canvas hex recolours live');
  h.eq(at20, await expected({ norm: { vmax: 20 } }), 'the hex paints exactly the colour law\'s value');
  h.eq(await labels(), ['1', '3', '10'], 'the key re-ticks for the new limits');
  await page.keyboard.press('Enter');
  h.eq((await model()).history, 1, 'one armed edit is one undo');
  const exported = await page.evaluate(async (id) => {
    const F = window.__flux, p = F.get(F.fig.project), f = p.figures.find(f => f.elements.some(e => e.id === 'cs-plot'));
    const { buildFigureSvg } = await import('/src/lib/io.ts');
    return new DOMParser().parseFromString(buildFigureSvg(f), 'image/svg+xml').querySelector(`[id="${id}"]`)?.getAttribute('style');
  }, PROBE);
  const canvasHex = await page.evaluate((id) => { const s = document.querySelector(`.canvas-host [id="${id}"]`).style; return s.fill; }, PROBE);
  h.ok(exported && exported.includes(`fill: ${canvasHex}`), `standalone SVG export bakes the live colour (${exported})`);
  await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod); await waitForFrame(page);
  h.eq((await model()).cs, null, 'Ctrl+Z removes the colour scale in one step');
  h.eq(await hex(), before, 'undo restores the generated paint');
  h.eq(await labels(), beforeLabels, 'undo restores the generated key');
  await type('9'); await page.keyboard.press('Escape'); await waitForFrame(page);
  h.eq((await model()).cs, null, 'Escape cancels the live draft');
  await type('20'); await page.keyboard.press('Enter');
  await page.click(I.max, { count: 3 }); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter'); await waitForFrame(page);
  h.eq((await model()).cs, null, 'an empty limit restores its generated default');
  await type('0', I.min);
  await waitFor(page, s => !!document.querySelector(`${s} [role="alert"]`), I.block);
  h.ok((await page.$eval(`${I.block} [role="alert"]`, n => n.textContent)).includes('above 0'), 'an impossible log minimum explains itself');
  h.eq((await model()).cs, null, 'and leaves the model untouched');
  await page.keyboard.press('Escape'); await waitForFrame(page);
  // colormap picker → table
  await page.click(`${I.block} .cmapbtn`);
  await waitFor(page, s => !!document.querySelector(`${s} .cmappick .cmp`), I.block);
  await page.evaluate(s => [...document.querySelectorAll(`${s} .cmp .tabs .tab`)].find(t => /crameri/i.test(t.textContent)).click(), I.block); // the Crameri collection, wherever fluxplot orders it
  await page.evaluate(s => document.querySelector(`${s} .cmp .cm[data-map="batlow"]`).click(), I.block);
  await waitFor(page, s => !document.querySelector(`${s} .cmappick`), I.block);
  await waitFor(page, () => !!window.__flux.get(window.__flux.fig.project).figures.flatMap(f => f.elements).find(e => e.id === 'cs-plot').colorScale?.rates?.cmap);
  const picked = (await model()).cs.rates.cmap;
  h.eq(picked?.name, 'crameri.batlow', 'picking a map records its qualified name');
  h.eq(picked?.lut?.length, 256, 'and its full table (the document never depends on the lazy LUTs)');
  h.eq(await page.$eval(`${I.block} input[aria-label="rates palette"]`, n => n.value), 'crameri.batlow', 'the palette field shows the picked name');
  h.eq((await stop(0))?.toLowerCase(), picked.lut[0].slice(0, 7).toLowerCase(), 'the key gradient starts at the new table\'s first entry');
  h.eq(await hex(), await expected({ cmap: picked }), 'the hex paints through the new table');
  await page.click(`${I.block} input[aria-label="rates reversed"]`); await waitForFrame(page);
  h.eq((await model()).cs.rates.reversed, true, 'reverse toggles the view');
  h.eq((await stop(0))?.toLowerCase(), picked.lut[255].slice(0, 7).toLowerCase(), 'a reversed table starts at its last entry');
  await page.click(`${I.block} input[aria-label="rates reversed"]`); await waitForFrame(page);
  h.eq((await model()).cs.rates.reversed, undefined, 'toggling back removes the field');
  await page.select(`${I.block} select[aria-label="rates norm"]`, 'linear'); await waitForFrame(page);
  h.eq((await model()).cs.rates.norm?.kind, 'linear', 'the norm kind switches within editable.normKinds');
  h.eq(await hex(), await expected({ cmap: picked, norm: { kind: 'linear' } }), 'and the hex paints through the linear law');
  await page.select(`${I.block} select[aria-label="rates norm"]`, 'log'); await waitForFrame(page);
  h.eq((await model()).cs.rates.norm?.kind, undefined, 'switching back to the generated kind removes the field');
  await page.select(`${I.block} select[aria-label="rates extend"]`, 'both'); await waitForFrame(page);
  h.eq((await model()).cs.rates.extend, 'both', 'extend round-trips');
  await page.select(`${I.block} select[aria-label="rates extend"]`, 'neither'); await waitForFrame(page);
  h.eq((await model()).cs.rates.extend, undefined, 'the generated extend is absence');
  // Apply to source: the complete v2 control, regeneration through the bridge, override cleared
  await type('20'); await page.keyboard.press('Enter'); await waitForFrame(page);
  await page.evaluate((edited) => {
    window.__csCalls = [];
    window.fig.runRecipe = async (path, params) => { window.__csCalls.push({ path, params }); return { code: 0, svgText: edited.svg, manifestText: edited.manifest, recipeText: JSON.stringify({ ...JSON.parse(edited.recipe), params }) }; };
  }, edited);
  await page.click(`${I.block} button.apply-source`);
  await waitFor(page, s => window.__csCalls.length === 1 && (document.querySelector(`${s} .status`)?.textContent ?? '').includes('regenerated'), I.block);
  const call = await page.evaluate(() => window.__csCalls[0]);
  h.eq(call.params.__fluxplot__.rates, { cmap: 'crameri.batlow', vmin: 1, vmax: 20, norm: { kind: 'log' }, extend: 'neither' }, 'Apply to source writes the complete v2 control keyed by the series root');
  h.ok(call.path.endsWith('plots/hexmatrix.recipe.json'), 'the recipe path resolves through the plot\'s source candidates');
  h.eq((await model()).cs, null, 'the live override clears once the source paints it');
  h.eq(await page.evaluate(() => window.__flux.get(window.__flux.plot.plotManifests)['cs-asset'].colorScales[0].colormap.name), 'magma', 'the regenerated plot replaced the asset in place');
  await type('20'); await page.keyboard.press('Enter'); await waitForFrame(page);
  h.eq((await model()).cs?.rates?.norm?.vmax, undefined, 'the regenerated scale (vmax 20) makes the same edit an identity');
  await type('5'); await page.keyboard.press('Enter'); await waitForFrame(page);
  await page.click(`${I.block} .reset`); await waitForFrame(page);
  h.eq((await model()).cs, null, 'Reset restores the generated scale');
  // the F-menu offers the same editor
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('f');
  await waitFor(page, () => !!document.querySelector('.fluxFigMenu.placed'));
  const key = await page.evaluate(() => [...document.querySelectorAll('.fluxFigMenu .field')].find(n => n.querySelector('.label')?.textContent === 'colour scale')?.getAttribute('data-key') ?? null);
  h.ok(!!key, `F-menu offers "colour scale" (key ${key})`);
  await page.keyboard.press(key);
  const M = scope('.fluxFigMenu');
  await waitFor(page, s => !!document.querySelector(s), M.max);
  await type('10', M.max); await page.keyboard.press('Enter'); await waitForFrame(page);
  h.eq((await model()).cs?.rates?.norm?.vmax, 10, 'the F-menu edits through the same control');
  mkdirSync('test-results/colorscale', { recursive: true });
  await page.screenshot({ path: 'test-results/colorscale/figure-menu.png' });
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

  // Slide: an "Edit after step" writes state.colorScale on a Change; the ruler scrubs colours
  await seed('Slide');
  await page.evaluate(() => { const F = window.__flux, sid = F.get(F.fig.activeFigureId); F.slide.commitDeckLive(d => { F.slideOps.addBeat(d, sid, { label: 'First' }); F.slideOps.addBeat(d, sid, { label: 'Warm' }); }); F.slide.activeBeat.set(2); });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /Animate ⏱/.test(b.textContent))?.click());
  await waitFor(page, () => !!document.querySelector('.animator'));
  await page.evaluate(() => [...document.querySelectorAll('.edit-switch button')].find(b => b.textContent.trim() === 'Edit after step 2')?.click());
  await waitFor(page, s => !!document.querySelector(s), I.max);
  await type('20'); await page.keyboard.press('Enter'); await waitForFrame(page);
  const state = await page.evaluate(() => { const F = window.__flux, d = F.slide.currentDeck(), s = d.slides.find(s => s.id === F.get(F.fig.activeFigureId)); return { base: s.elements.find(e => e.id === 'cs-plot').colorScale ?? null, track: s.beats[2].tracks.find(t => t.target === 'cs-plot') }; });
  h.eq(state.base, null, 'After-step edit preserves the canonical Design scale');
  h.eq(state.track?.to?.state?.colorScale?.rates?.norm?.vmax, 20, 'After step 2 captures state.colorScale on a Change track');
  const fills = [];
  for (const fraction of [0, .5, 1]) {
    const spot = await page.evaluate(fraction => {
      const ruler = [...document.querySelectorAll('.animator .ruler')].find(n => n.getBoundingClientRect().width > 0), r = ruler.getBoundingClientRect();
      const tick = [...ruler.querySelectorAll('.tick')].find(n => parseFloat(n.textContent) > 0);
      const scale = parseFloat(tick.style.left) / (parseFloat(tick.textContent) * 1000);
      const F = window.__flux, s = F.slide.currentDeck().slides.find(s => s.id === F.get(F.fig.activeFigureId)), t = s.beats[2].tracks.find(t => t.target === 'cs-plot');
      return { x: r.x + fraction * (t.duration ?? 600) * scale + .01, y: r.y + r.height / 2 };
    }, fraction);
    await page.mouse.click(spot.x, spot.y);
    await waitFor(page, () => !!document.querySelector('.preview-overlay .sl-el')); await waitForFrame(page);
    fills.push(await hex('.preview-overlay [data-el-id="cs-plot"]'));
  }
  h.ok(fills[0] && fills[0] !== fills[1] && fills[1] !== fills[2], `real ruler scrubbing glides through distinct colours (${fills.join(' → ')})`);
  await page.screenshot({ path: 'test-results/colorscale/slide-scrub.png' });
  h.eq(realErrors(page), [], 'no console errors');
} catch (e) { await page.screenshot({ path: 'test-results/colorscale/failure.png' }).catch(() => {}); h.fail(e.stack ?? String(e)); }
await h.done(() => browser.close());
