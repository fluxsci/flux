import fs from 'node:fs';
import { harness } from './lib/harness.mjs';
import { launch, waitFor, waitForFrame, realErrors } from './lib/driver.mjs';
import { layoutFixture } from './lib/alignArrangeFixture.mjs';
const h = harness('verify-plot-spines-gui');
const { browser, page } = await launch({ width: 1500, height: 1050 });
const fixture = name => ({ svg: fs.readFileSync(new URL(`./fixtures/${name}.svg`, import.meta.url), 'utf8'), manifest: JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.fluxplot.json`, import.meta.url), 'utf8')) });
const data = { box: fixture('plots/mpl_boxplot_FLUXPLOT'), multi: fixture('fluxplot03/features') };
async function seed(options = {}) {
  await page.evaluate(async ({ data, options }) => {
    const F = window.__flux, s = F.fig;
    F.layout.closeAlignArrange(true);
    const root = F.get(F.shell.currentProject).path;
    await window.fig.mkdir(root + '/fig/assets');
    for (const [key, asset] of Object.entries(data)) {
      await window.fig.writeText(root + `/fig/assets/spine-${key}.svg`, asset.svg);
      await window.fig.writeText(root + `/fig/assets/spine-${key}.fluxplot.json`, JSON.stringify(asset.manifest));
      F.plot.cachePlot(`spine-${key}`, asset.svg, asset.manifest);
    }
    s.commit(project => {
      const figure = project.figures.find(f => f.id === F.get(s.activeFigureId));
      figure.x = 0; figure.y = 0; figure.width = 1100; figure.height = 800;
      figure.groups = { 'spine-group': { id: 'spine-group', name: 'Plot with letter' } };
      for (const key of Object.keys(data)) if (!project.assets.some(a => a.id === `spine-${key}`)) project.assets.push({ id: `spine-${key}`, name: key, kind: 'svg', path: `assets/spine-${key}.svg`, naturalWidth: 240, naturalHeight: 144 });
      figure.elements = [
        { id: 'spine-a', name: 'Reference plot', type: 'plot', assetId: 'spine-box', x: 60, y: 80, width: 240, height: 144, rotation: 0 },
        { id: 'spine-b', name: options.multi ? 'Multi' : 'Second plot', type: 'plot', assetId: options.multi ? 'spine-multi' : 'spine-box', x: 430, y: 240, width: options.multi ? 600 : 300, height: options.multi ? 400 : 180, rotation: 0, groupId: 'spine-group', overrides: options.hidden ? { 'axis.x.spine': { hidden: true } } : { 'axis.x.spine': { dy: -4 } }, ...(options.crop ? { crop: { x: 60, y: 36, width: 120, height: 72 } } : {}) },
        { id: 'spine-letter', type: 'text', text: 'B', x: 408, y: 230, width: 20, height: 22, rotation: 0, fontFamily: 'Arial', fontSize: 18, fontWeight: 700, fontStyle: 'normal', align: 'left', color: '#111111', groupId: 'spine-group', ...(options.locked ? { locked: true } : {}) },
      ];
    });
    s.selection.set(new Set(['spine-a', 'spine-b', 'spine-letter']));
    s.viewport.set({ panX: 30, panY: 30, zoom: options.zoom ?? .8 });
    s.resetHistory(); s.dirty.set(false); document.activeElement?.blur();
  }, { data, options });
  await waitFor(page, () => !!document.getElementById('spine-a__axis.x.spine'));
  await waitForFrame(page);
}
const read = () => page.evaluate(() => {
  const F = window.__flux, s = F.fig;
  return { elements: structuredClone(F.get(s.project).figures.find(f => f.id === F.get(s.activeFigureId)).elements), history: s.historyStats(), state: F.get(F.layout.alignArrange) };
});
async function open() {
  await page.keyboard.press('KeyA');
  await waitFor(page, () => !!document.querySelector('[aria-label="Flux Align"]'));
  await waitForFrame(page);
}
async function spine(elementId, spineId) {
  return page.evaluate(({ elementId, spineId }) => {
    const part = document.getElementById(`${elementId}__${spineId}`);
    const path = part?.matches('path') ? part : part?.querySelector('path');
    if (!path) throw new Error('Missing rendered spine ' + elementId + '/' + spineId);
    const style = getComputedStyle(path), matrix = path.getScreenCTM();
    const ends = [path.getPointAtLength(0), path.getPointAtLength(path.getTotalLength())].map(p => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f }));
    return { ends, stroke: style.stroke, width: Number.parseFloat(style.strokeWidth), opacity: Number(style.opacity), display: style.display };
  }, { elementId, spineId });
}
try {
  await layoutFixture(page);
  await seed();
  const before = await read();
  await open();
  h.eq((await read()).elements, before.elements, 'opening Align changes no plot geometry');
  h.ok(await page.$eval('.spine-buttons button:first-child', b => !b.disabled), 'two real semantic plots enable X spines');
  await page.hover('.spine-buttons button:first-child');
  await waitForFrame(page);
  h.ok(await page.evaluate(() => window.__flux.get(window.__flux.layout.alignmentGuides).length >= 2), 'hover previews actual spine guides');
  await page.click('.spine-buttons button:first-child');
  await waitForFrame(page);
  const after = await read();
  const a = await spine('spine-a', 'axis.x.spine'), b = await spine('spine-b', 'axis.x.spine');
  h.ok(a.stroke !== 'none' && b.stroke !== 'none' && a.width > 0 && b.width > 0 && a.opacity > 0 && b.opacity > 0 && a.display !== 'none' && b.display !== 'none', 'oracle measures actual visible browser strokes');
  h.ok(Math.abs(a.ends[0].y - b.ends[0].y) < .25 && Math.abs(a.ends[1].y - b.ends[1].y) < .25, 'browser screen CTMs prove both X spines share a line');
  h.eq(after.elements[0], before.elements[0], 'reference plot remains byte-identical');
  h.ok(Math.abs((after.elements[1].y - before.elements[1].y) - (after.elements[2].y - before.elements[2].y)) < 1e-9, 'grouped panel letter moves by precisely the plot delta');
  h.ok(after.elements.every((e, i) => e.width === before.elements[i].width && e.height === before.elements[i].height && e.x === before.elements[i].x), 'spine alignment never resizes artwork or moves its transverse coordinate');
  h.eq(after.history.past, 1, 'one spine alignment is one Undo');
  await page.keyboard.press('Escape');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  await waitForFrame(page);
  h.eq((await read()).elements, before.elements, 'real Undo restores plot and annotation together');
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await waitForFrame(page);
  h.eq((await read()).elements, after.elements, 'real Redo restores exact aligned positions');
  await open();
  await page.select('[aria-label="Plot alignment reference"]', 'g:spine-group');
  const beforeY = await read();
  await page.click('.spine-buttons button:nth-child(2)'); await waitForFrame(page);
  const ay = await spine('spine-a', 'axis.y.spine'), by = await spine('spine-b', 'axis.y.spine');
  h.ok(Math.abs(ay.ends[0].x - by.ends[0].x) < .25, 'explicit second reference aligns actual Y spines');
  h.eq((await read()).elements.slice(1), beforeY.elements.slice(1), 'chosen group reference and its annotation stay fixed');

  await seed({ multi: true }); await open();
  h.ok(await page.$eval('.spine-buttons button:first-child', b => b.disabled), 'multipanel plot is disabled until a panel is chosen');
  const choice = await page.evaluate(() => {
    const state = window.__flux.get(window.__flux.layout.alignArrange);
    const unit = state.plot.units.find(u => u.id === 'g:spine-group');
    return unit.optionsX.find(o => JSON.parse(o.value).panelId === 'panel.fit').value;
  });
  await page.select('.plot-choice:last-child select:first-of-type', choice);
  await waitForFrame(page);
  h.ok(await page.$eval('.spine-buttons button:first-child', b => !b.disabled), 'named panel chooser enables the exact selected spine');
  await page.select('.plot-choice:last-child select:first-of-type', '');await waitForFrame(page);
  h.ok(await page.$eval('.spine-buttons button:first-child', b => b.disabled), 'clearing explicit panel choice restores ambiguity');
  h.eq((await read()).state.plot.units.find(u=>u.id==='g:spine-group').choiceX,'','cleared chooser never retains a stale spine');
  await page.select('.plot-choice:last-child select:first-of-type', choice);await waitForFrame(page);

  await page.click('.spine-buttons button:first-child'); await waitForFrame(page);
  const multiA = await spine('spine-a', 'axis.x.spine'), multiB = await spine('spine-b', 'panel.fit.axis.x.spine.bottom');
  h.ok(Math.abs(multiA.ends[0].y - multiB.ends[0].y) < .25, 'explicit multipanel alignment agrees with rendered browser geometry');

  for (const options of [{ hidden: true }, { crop: true }, { locked: true }]) {
    await seed(options); const unchanged = (await read()).elements; await open();
    h.ok(await page.$eval('.spine-buttons button:first-child', b => b.disabled), `unsupported selection disables X command: ${JSON.stringify(options)}`);
    await page.keyboard.press('KeyX'); await waitForFrame(page);
    h.eq((await read()).elements, unchanged, 'disabled shortcut cannot make a partial edit');
  }
  // Live bridge exercises the same planner, not a parallel UI approximation.
  await seed({ zoom: .45 });
  const result = await page.evaluate(async () => {
    const F = window.__flux;
    return F.liveCommands.dispatchCommand({ type: 'align_plot_spines', axis: 'x', referenceKey: 'e:spine-a', ids: ['spine-a', 'spine-b'] });
  });
  await waitForFrame(page);
  h.eq(result.moved, ['spine-b', 'spine-letter'], 'live command expands and translates the complete group');
  const liveA = await spine('spine-a', 'axis.x.spine'), liveB = await spine('spine-b', 'axis.x.spine');
  h.ok(Math.abs(liveA.ends[0].y - liveB.ends[0].y) < .25, 'live-command output remains aligned at a different canvas zoom');
  h.eq(realErrors(page), [], 'browser console remains clean');
} catch (error) { h.fail(String(error?.stack ?? error)); }
await h.done(() => browser.close());
