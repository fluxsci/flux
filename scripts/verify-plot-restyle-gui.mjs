// Real F-menu wheel, history, X-ray hide and crop gestures.
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './lib/harness.mjs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, waitForFrame, realErrors, shot } from './lib/driver.mjs';
const h = harness('verify-plot-restyle-gui');
const fixture = process.env.FLUX_RESTYLE_FIXTURE;
const fixedDir = fixture ? `${fixture}/fig/assets/asset_muoj2mbf6sg8_5` : 'scripts/fixtures/colorscale/hexmatrix';

const { browser, page } = await launch({ width: 1500, height: 1000 });
const selector = '.canvas-host [data-editor-element-id="restyle-plot"] svg';
const serial = () => page.$eval(selector, node => new XMLSerializer().serializeToString(node));
const counters = () => page.evaluate(() => ({ ...window.__flux.plot.mountCounters }));
const shortcut = async (redo = false) => { await page.keyboard.down('Control'); if (redo) await page.keyboard.down('Shift'); await page.keyboard.press('z'); if (redo) await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await waitForFrame(page); };
try {
  for (const mode of ['fixed', 'elastic']) {
    h.section(mode);
    const dir = mode === 'elastic' ? 'scripts/fixtures/relayout/contour/base' : fixedDir;
    const svg = readFileSync(`${dir}.svg`, 'utf8'), manifest = JSON.parse(readFileSync(`${dir}.fluxplot.json`, 'utf8'));
    const scale = manifest.colorScales[0].id;
    await gotoApp(page, { url: APP_URL + '?fixture=demo' }); await clickMode(page, 'Figure');
    await waitFor(page, () => !!window.__flux && !!document.querySelector('.canvas-host'));
    await page.evaluate((svg, manifest, real, elastic) => {
      const F = window.__flux;
      F.io.reimportPlot('restyle-asset', svg, manifest);
      F.fig.commit(p => {
        const f = p.figures.find(f => f.id === F.get(F.fig.activeFigureId));
        p.figures = [f]; f.x = 0; f.y = 0; f.width = 750; f.height = 650;
        p.assets.push({ id: 'restyle-asset', name: 'hexmatrix.svg', kind: 'svg', path: 'assets/restyle-asset.svg', naturalWidth: real ? 240 : 326.4, naturalHeight: 268.8 });
        const labels = f.elements.filter(e => e.type === 'text' && e.panelLabel);
        f.elements = [{ id: 'restyle-plot', type: 'plot', assetId: 'restyle-asset', x: 40, y: 60, width: elastic ? 380 : real ? 240 : 326.4, height: 268.8, rotation: 0, ...(real ? { view: { x: { domain: [-.02, 1.46] } } } : {}) }, ...labels];
      });
      F.fig.viewport.set({ panX: 200, panY: 120, zoom: 1 }); F.fig.selectOnly('restyle-plot'); F.fig.resetHistory();
    }, svg, manifest, !!fixture, mode === "elastic");
    await waitFor(page, s => !!document.querySelector(s), selector);
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('f');
    await waitFor(page, () => !!document.querySelector('.fluxFigMenu.placed'));
    const key = await page.evaluate(() => [...document.querySelectorAll('.fluxFigMenu .field')].find(n => n.querySelector('.label')?.textContent === 'colour scale')?.getAttribute('data-key'));
    await page.keyboard.press(key);
    const max = `.fluxFigMenu [data-color-scale-limits="${scale}"] .nf:nth-of-type(2) input`;
    await waitFor(page, s => !!document.querySelector(s), max);
    await waitForFrame(page);
    // Warm module/UI startup separately from the measured gesture window.
    await new Promise(r => setTimeout(r, 500));
    const before = await serial(); await shot(page, `plot-restyle-${mode}-before`);
    await page.evaluate((s, max) => {
      const F = window.__flux;
      if (F.plot.mountCounters) Object.assign(F.plot.mountCounters, { renders: 0, restyles: 0, elasticRestyles: 0, reclones: 0 });
      window.__restyleRoots = []; window.__restyleMs = []; window.__restyleLong = [];
      window.__restyleObserver = new PerformanceObserver(list => window.__restyleLong.push(...list.getEntries().map(e => e.duration)));
      window.__restyleObserver.observe({ type: 'longtask' });
      window.addEventListener('wheel', e => {
        if (!e.target.closest('.fluxFigMenu')) return;
        window.__restyleStart = performance.now();
      }, true);
      document.querySelector(max).addEventListener('wheel', () => queueMicrotask(() => { const measure = performance.measure('plot-style-step', { start: window.__restyleStart, end: performance.now() }); window.__restyleMs.push(measure.duration); }));
      window.__restyleRoots.push(document.querySelector(s));
    }, selector, max);
    for (let i = 0; i < 20; i++) {
      const pos = await page.$eval(max, n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(pos.x, pos.y); await page.mouse.wheel({ deltaY: -100 }); await waitForFrame(page);
      // NumberField owns one history transaction per roll; let this notch end
      // before the next so the history contract here is exactly Undo x20.
      await new Promise(r => setTimeout(r, 240));
      await page.evaluate(s => window.__restyleRoots.push(document.querySelector(s)), selector);
    }
    const after = await serial(), stats = await counters();
    const measured = await page.evaluate(() => {
      window.__restyleObserver.disconnect();
      return { ms: window.__restyleMs, long: window.__restyleLong, replacements: window.__restyleRoots.slice(1).filter((n, i) => n !== window.__restyleRoots[i]).length, history: window.__flux.fig.historyStats().past };
    });
    console.log('RESTYLE_MEASURE', JSON.stringify({ mode, ...stats, ...measured }));
    writeFileSync(process.env.FLUX_RESTYLE_MEASURE_OUT ?? '/tmp/p3-restyle-gui-measure.json', JSON.stringify({ mode, ...stats, ...measured }, null, 2));
    h.eq(measured.replacements, 0, '20 real colour-limit wheels retain the same clone');
    h.eq(stats.reclones, 0, '20 colour-limit wheels cause zero re-clones');
    h.eq(stats.restyles, 20, '20 colour-limit wheels cause exactly 20 restyles');
    h.eq(stats.elasticRestyles, mode === 'elastic' ? 20 : 0, 'elastic wheel dispatches exactly 20 elastic restyles');
    h.eq(measured.history, 20, '20 separate wheel rolls create 20 undo steps');
    h.ok(measured.long.every(ms => ms <= 50), `no long task exceeds 50 ms (${measured.long.join(', ')} ms)`);
    await shot(page, `plot-restyle-${mode}-after`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());
    for (let i = 0; i < 20; i++) await shortcut();
    const undone = await serial();
    if (undone !== before) { writeFileSync('/tmp/p3-gui-before.svg', before); writeFileSync('/tmp/p3-gui-undone.svg', undone); const at = [...undone].findIndex((c, i) => c !== before[i]); console.log('UNDO_DIFF', at, undone.slice(at-70,at+200), before.slice(at-70,at+200)); }
    h.ok(undone === before, 'Undo x20 restores the exact pre-edit SVG');
    for (let i = 0; i < 20; i++) await shortcut(true);
    h.ok(await serial() === after, 'Redo x20 restores the exact post-edit SVG');
    // Enter the X-ray through its actual shortcut, choose an axis row, hide it.
    await page.keyboard.press('r');
    await waitFor(page, () => !!document.querySelector('.xray.placed'));
    const row = await page.evaluate(() => [...document.querySelectorAll('.xray .row[data-kind="part"]')].find(n => /axis/i.test(n.textContent))?.getAttribute('data-rid'));
    const rowSelector = `.xray .row[data-rid="${row}"]`;
    await page.click(rowSelector);
    const preHide = await counters(); await page.keyboard.press('x'); await waitForFrame(page);
    const postHide = await counters();
    h.eq(postHide.reclones, preHide.reclones, 'X-ray x hides a part without re-cloning');
    h.eq(postHide.restyles, preHide.restyles + 1, 'X-ray x dispatches one restyle');
    await shot(page, `plot-restyle-${mode}-hidden`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__flux.fig.xrayOpen.set(false); window.__flux.fig.selectOnly('restyle-plot'); });
    await shortcut(); // Undo hide; whole placement handles for the crop gesture.
    await page.evaluate(() => { window.__flux.fig.partSelection.set(null); window.__flux.fig.selectOnly('restyle-plot'); });
    await waitForFrame(page);
    const handle = await page.evaluate(() => { const r = document.querySelector('svg.overlay-svg .zone.edge[data-h="e"]')?.getBoundingClientRect(); const b = document.querySelector('svg.overlay-svg .sel-box')?.getBoundingClientRect(); return r && b ? { x: b.right, y: r.y + r.height / 2 } : null; });
    h.ok(!!handle, 'real crop resize handle is available');
    const preCrop = await counters();
    await page.keyboard.down('Control'); await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x - 35, handle.y, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Control'); await waitForFrame(page);
    h.eq((await counters()).reclones, preCrop.reclones + 1, 'a real crop gesture re-clones exactly once');
    await shot(page, `plot-restyle-${mode}-cropped`);
    h.eq(realErrors(page), [], 'no console errors');
  }
} catch (error) { await shot(page, 'plot-restyle-failure').catch(() => {}); h.fail(error.stack ?? String(error)); }
await h.done(() => browser.close());
