import { launch, gotoApp, clickMode, APP_URL, realErrors, shot, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { installDenseProject } from './lib/lazyFixture.mjs';
const h = harness('verify-unplaced-asset-bytes');
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 1800 });
  const fx = await installDenseProject(page, { root: '/demo/unplaced', figures: 2, panels: 1, elemsPerPanel: 80, panelBytes: 4000 });
  await page.evaluate(async root => {
    const fb = window.fig;
    if (!fb.reads) {
      fb.reads = [];
      for (const key of ['readFile', 'readText']) { const read = fb[key].bind(fb); fb[key] = async p => { fb.reads.push(p); return read(p); }; }
    }
    const index = JSON.parse(await fb.readText(root + '/fig/index.json'));
    index.assets.push({ ...index.assets[0], id: 'unused', path: 'assets/unused.svg' });
    await fb.writeText(root + '/fig/assets/unused.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    // A second unplaced asset that an agent places after open (QA-P4).
    index.assets.push({ ...index.assets[0], id: 'unused2', path: 'assets/unused2.svg' });
    await fb.writeText(root + '/fig/assets/unused2.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
    await fb.writeText(root + '/fig/index.json', JSON.stringify(index));
    await fb.writeText(root + '/manuscript/main.qmd', '# Unplaced asset probe\n');
    fb.reads.length = 0;
    await window.__flux.shell.openProjectAt(root);
  }, fx.root);
  await clickMode(page, 'Figure');
  await page.waitForSelector('[data-editor-element-id]');
  h.eq(await page.evaluate(root => window.fig.reads.filter(p => p === root + '/fig/assets/unused.svg' || p === root + '/fig/assets/unused2.svg').length, fx.root), 0, 'Figure open reads no unplaced image bytes');
  h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.project).assets.length), 4, 'all placed and unplaced metadata stays resident');
  await page.evaluate(() => {
    const fb = window.fig, write = fb.writeFile.bind(fb);
    window.__assetWrites = [];
    fb.writeFile = async (path, bytes) => { window.__assetWrites.push(path); return write(path, bytes); };
    window.__unusedBefore = Array.from(fb._files.get('/demo/unplaced/fig/assets/unused.svg'));
  });
  const box = await page.$eval('[data-editor-element-id]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(box.x, box.y); await page.keyboard.press('ArrowRight');
  await sleep(1200);
  h.ok(await page.evaluate(() => !window.__flux.get(window.__flux.fig.dirty)), 'real keyboard edit autosaves');
  h.eq(await page.evaluate(root => window.fig.reads.filter(p => p === root + '/fig/assets/unused.svg').length, fx.root), 0, 'ordinary figures save does not read unloaded clean bytes');
  h.eq(await page.evaluate(() => Array.from(window.fig._files.get('/demo/unplaced/fig/assets/unused.svg'))), await page.evaluate(() => window.__unusedBefore), 'ordinary figures save leaves unplaced bytes identical');
  h.eq(await page.evaluate(() => window.__assetWrites.filter(p => p.endsWith('/unused.svg')).length), 0, 'ordinary figures save never writes the unloaded asset');
  await shot(page, 'unplaced-assets-figure');

  // QA-P4: an asset no figure placed at open becomes placed later. Its element
  // must draw and export like any other (bytes resident), never blank.
  const resident = id => page.evaluate(async id => !!(await import('/src/lib/assets.ts')).getAssetData(id), id);
  const exportsActive = () => page.evaluate(async () => {
    const F = window.__flux, io = await import('/src/lib/io.ts');
    const p = F.get(F.fig.project), f = p.figures.find(x => x.id === F.get(F.fig.activeFigureId)) ?? p.figures[0];
    try { io.buildFigureSvg(f); return 'ok'; } catch (e) { return String(e?.message ?? e); }
  });
  h.ok(!(await resident('unused2')), 'precondition: the second unplaced asset has no resident bytes');
  const added = await page.evaluate(async () => (await import('/src/lib/bridge/commands.ts')).dispatchCommand({ type: 'add_plot', assetId: 'unused2', x: 30, y: 30 }));
  h.ok(!!added?.id && await resident('unused2'), 'live add_plot of an unplaced asset loads its bytes before placing it');
  h.eq(await exportsActive(), 'ok', 'the figure holding the newly placed asset exports');
  await page.waitForFunction(() => !window.__flux.get(window.__flux.fig.dirty), { timeout: 5000 });
  // An agent removes a placed element on disk → reload (one undo entry) → Ctrl+Z.
  const restoredAsset = fx.assetsByFig[fx.figIds[1]][0], restoredEl = 'lazyel-2-1';
  await page.evaluate(async (root, id) => {
    const path = root + '/fig/canvases/canvas-1.json', canvas = JSON.parse(await window.fig.readText(path));
    for (const f of canvas.figures) f.elements = f.elements.filter(e => e.id !== id);
    window.fig._files.set(path, new TextEncoder().encode(JSON.stringify(canvas)));
    window.fig._emitFsChange({ subsystem: 'fig', path });
  }, fx.root, restoredEl);
  await page.waitForFunction(id => !window.__flux.get(window.__flux.fig.project).figures.some(f => f.elements.some(e => e.id === id)), { timeout: 5000 }, restoredEl);
  await page.evaluate(() => window.__flux.fig.undo());
  h.ok(await page.evaluate(id => window.__flux.get(window.__flux.fig.project).figures.some(f => f.elements.some(e => e.id === id)), restoredEl), 'undo restores the element the external reload removed');
  h.ok(await resident(restoredAsset), 'its bytes stayed resident across the external reload');
  h.eq(await page.evaluate(async id => {
    const F = window.__flux, io = await import('/src/lib/io.ts');
    const f = F.get(F.fig.project).figures.find(x => x.elements.some(e => e.id === id));
    try { io.buildFigureSvg(f); return 'ok'; } catch (e) { return String(e?.message ?? e); }
  }, restoredEl), 'ok', 'the restored figure exports');
  await page.waitForFunction(() => !window.__flux.get(window.__flux.fig.dirty), { timeout: 5000 });
  const standalone = await page.evaluate(async root => {
    const F = window.__flux, fb = window.fig, source = '/demo/standalone-unplaced';
    const p = structuredClone(F.get(F.fig.project));
    await fb.writeText(source + '/project.json', JSON.stringify(p));
    const bytes = {};
    for (const asset of p.assets) {
      const data = fb._files.get(root + '/fig/' + asset.path);
      bytes[asset.id] = Array.from(data);
      await fb.writeFile(source + '/' + asset.path, data);
      const manifest = fb._files.get(root + '/fig/assets/' + asset.id + '.fluxplot.json');
      if (manifest) await fb.writeFile(source + '/assets/' + asset.id + '.fluxplot.json', manifest);
    }
    // Exercise standalone Open's real picker/load and Save As's real picker/copy.
    F.fig.embeddedProjectRoot.set(null);
    const picker = fb.openDirectory; fb.openDirectory = async () => source;
    fb.reads.length = 0;
    try { await F.io.openProject(); } finally { fb.openDirectory = picker; }
    return { source, bytes };
  }, fx.root);
  h.eq(await page.evaluate(root => window.fig.reads.filter(p => p === root + '/assets/unused.svg').length, standalone.source), 0, 'standalone Open also leaves unplaced bytes on disk');
  await page.evaluate(async () => { window.__assetWrites.length = 0; await window.__flux.io.saveProject(); });
  h.eq(await page.evaluate(() => window.__assetWrites.filter(p => p.endsWith('/unused.svg')).length), 0, 'ordinary standalone Save does not rewrite unloaded bytes');
  await page.evaluate(async () => {
    const fb = window.fig, picker = fb.save; fb.save = async () => '/demo/standalone-copy';
    try { await window.__flux.io.saveProjectAs(); } finally { fb.save = picker; }
  });
  h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.projectDir)), '/demo/standalone-copy', 'Save As adopts the fully copied destination');
  const copied = await page.evaluate(async () => {
    const root = '/demo/standalone-copy', index = JSON.parse(await window.fig.readText(root + '/project.json'));
    return Object.fromEntries(index.assets.map(a => [a.id, Array.from(window.fig._files.get(root + '/' + a.path) ?? [])]));
  });
  h.eq(copied, standalone.bytes, 'Save As copies every placed and unplaced asset byte-identically');
  h.eq(realErrors(page).length, 0, 'console clean');
} finally { await browser.close(); }
await h.done();
