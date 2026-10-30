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
    await fb.writeText(root + '/fig/index.json', JSON.stringify(index));
    await fb.writeText(root + '/manuscript/main.qmd', '# Unplaced asset probe\n');
    fb.reads.length = 0;
    await window.__flux.shell.openProjectAt(root);
  }, fx.root);
  await clickMode(page, 'Figure');
  await page.waitForSelector('[data-editor-element-id]');
  h.eq(await page.evaluate(root => window.fig.reads.filter(p => p === root + '/fig/assets/unused.svg').length, fx.root), 0, 'Figure open reads no unplaced image bytes');
  h.eq(await page.evaluate(() => window.__flux.get(window.__flux.fig.project).assets.length), 3, 'all placed and unplaced metadata stays resident');
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
