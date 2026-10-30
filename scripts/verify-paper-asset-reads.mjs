// A real Paper visit and a typed embed must not read the other 19 figures.
import { launch, gotoApp, clickMode, APP_URL, realErrors, shot, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { installDenseProject } from './lib/lazyFixture.mjs';
const h = harness('verify-paper-asset-reads');
const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 1800 });
  const fx = await installDenseProject(page, { root: '/demo/paper-reads', figures: 20, panels: 2, elemsPerPanel: 80, panelBytes: 4000 });
  await page.evaluate(async root => {
    const fb = window.fig;
    // Counter fallback lets this exact gate measure old code in the negative proof.
    if (!fb.reads) {
      fb.reads = [];
      for (const key of ['readFile', 'readText']) {
        const read = fb[key].bind(fb); fb[key] = async path => { fb.reads.push(path); return read(path); };
      }
    }
    await fb.writeText(root + '/manuscript/main.qmd', '# Asset reads\n\nA manuscript without embeds.\n');
    const index = JSON.parse(await fb.readText(root + '/fig/index.json'));
    for (const f of index.figures) f.label = 'fig-' + f.id;
    await fb.writeText(root + '/fig/index.json', JSON.stringify(index));
    fb.reads.length = 0;
    await window.__flux.shell.openProjectAt(root);
  }, fx.root);
  await clickMode(page, 'Paper');
  await page.waitForSelector('.cm-content');
  await sleep(400);
  const reads = () => page.evaluate(root => window.fig.reads.filter(p => p.startsWith(root + '/fig/assets/')), fx.root);
  h.eq((await reads()).length, 0, 'visiting Paper with 20 figures reads zero asset files or manifests');
  await page.click('.cm-content');
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await page.keyboard.type('\n\n![One](../fig/renders/lazyfig-7.svg){#fig-lazyfig-7}\n\n', { delay: 1 });
  await page.waitForFunction(() => !!document.querySelector('img[data-figure-state="ready"]'));
  await sleep(350);
  const expected = fx.assetsByFig[fx.figIds[6]].flatMap(id => [`${fx.root}/fig/assets/${id}.svg`, `${fx.root}/fig/assets/${id}.fluxplot.json`]).sort();
  h.eq((await reads()).sort(), expected, 'one visible embed reads exactly its two assets and their two manifests once');
  await shot(page, 'paper-assets-one-embed');
  await page.evaluate(async root => {
    const paper = await import('/src/shell/modes/paper/scholar/figures.ts');
    window.fig.reads.length = 0;
    const snapshot = paper.captureFigureExport();
    const svg = await snapshot.render('lazyfig-12', false);
    window.__exportHasPlots = !!svg?.includes('s0.line');
  }, fx.root);
  h.ok(await page.evaluate(() => window.__exportHasPlots), 'captured export prepares a previously unseen figure');
  h.eq((await reads()).sort(), fx.assetsByFig[fx.figIds[11]].flatMap(id => [`${fx.root}/fig/assets/${id}.svg`, `${fx.root}/fig/assets/${id}.fluxplot.json`]).sort(), 'export reads only its requested figure');
  h.eq(realErrors(page).length, 0, 'console clean');
} finally { await browser.close(); }
await h.done();
