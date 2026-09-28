/** Hold only native transport; exercise production picker/gallery/drop and toast DOM. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { launch, gotoApp, clickMode, waitFor, realErrors, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-model3d-import-progress-gui'), out = 'test-results/model3d/import-progress';
await mkdir(out, { recursive: true });
const bytes = (await readFile('scripts/fixtures/model3d/fluxplot-library/named-parts.glb')).toString('base64');
const { browser, page } = await launch({ width: 1400, height: 1000 });
const result = {};
const visible = () => page.evaluate(() => [...document.querySelectorAll('.toast')].filter(t => t.querySelector('.t-msg')?.textContent === 'Importing 3D model…').map(t => t.textContent));
const entered = count => waitFor(page, count => window.__progressTest.requests.length === count, count, { label: 'native import entered' });
const shown = () => waitFor(page, () => [...document.querySelectorAll('.toast')].some(t => t.querySelector('.t-msg')?.textContent === 'Importing 3D model…' && Number(getComputedStyle(t).opacity) === 1), null, { label: 'slow import feedback fully visible' });
const hidden = () => waitFor(page, () => ![...document.querySelectorAll('.toast .t-msg')].some(t => t.textContent === 'Importing 3D model…'), null, { label: 'import feedback retired' });
const start = route => page.evaluate(route => {
  const s = window.__progressTest, F = window.__flux;
  const work = route === 'drop'
    ? F.io.importDroppedFiles([new File([s.bytes], 'same.glb', { type: 'model/gltf-binary' })], 'progress-figure')
    : F.io.importPlotsFromPaths([s.source]); // same callback used by the gallery
  s.pending.push(work.then(value => ({ value }), error => ({ error: String(error) })));
}, route);
const release = (index, fail = false) => page.evaluate(({ index, fail }) => {
  const r = window.__progressTest.requests[index]; r.fail = fail; r.release();
}, { index, fail });
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 0 });
  await clickMode(page, 'Figure', { settle: 0 });
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'), null, { label: 'Figure ready' });
  await page.evaluate(async bytes => {
    const F = window.__flux, fb = window.fig, root = F.get(F.fig.embeddedProjectRoot);
    await F.lifecycle.flushById('figure');
    F.fig.commit(p => { p.figures = [{ ...p.figures[0], id: 'progress-figure', referenceKey: 'fig-import-progress', number: 1, name: 'Import progress', x: 0, y: 0, width: 700, height: 500, elements: [], groups: {}, captions: {} }]; });
    F.fig.activeFigureId.set('progress-figure'); F.fig.selectedFrameId.set(null); F.fig.viewport.set({ panX: 30, panY: 40, zoom: 1 });
    const s = window.__progressTest = { root, source: root + '/plots/same.glb', bytes: Uint8Array.from(atob(bytes), c => c.charCodeAt(0)), requests: [], pending: [] };
    await fb.writeFile(s.source, s.bytes);
    const imported = fb.importModel3d, dropped = fb.importDroppedModel3d;
    async function held(route, fn) {
      const request = { route, entered: performance.now() };
      s.requests.push(request);
      await new Promise(resolve => request.release = resolve);
      if (request.fail) throw new Error('Held fixture import rejected');
      return fn();
    }
    fb.importModel3d = request => held('path', () => imported(request));
    fb.importDroppedModel3d = (file, request) => held('drop', () => dropped(file, request));
    fb.openFiles = async () => [s.source];
  }, bytes);
  await page.click('button[title="Import PNG/SVG/GLB (Ctrl+Shift+K)"]');
  await entered(1);
  h.eq(await visible(), [], 'real toolbar picker starts native work immediately without early feedback');
  await shown();
  h.ok((await visible())[0].includes('same.glb'), 'held picker import names its actual file');
  await page.screenshot({ path: out + '/slow-picker.png' });
  await release(0, true); await hidden();
  h.eq(await page.evaluate(() => window.__flux.figures()[0].elements.length), 0, 'rejected picker cleans feedback and places no element');

  await start('gallery'); await entered(2); await shown();
  h.ok((await visible())[0].includes('same.glb'), 'gallery public insertion path shares delayed feedback');
  await release(1); await hidden();
  await waitFor(page, () => window.__flux.figures()[0].elements.length === 1, null, { label: 'gallery placement completed' });
  await start('drop'); await entered(3); await shown();
  h.eq(await page.evaluate(() => window.__progressTest.requests[2].route), 'drop', 'actual File drop enters dedicated transport with the same feedback');
  await release(2); await hidden();
  await waitFor(page, () => window.__flux.figures()[0].elements.length === 2, null, { label: 'dropped placement completed' });
  h.ok(true, 'successful gallery and File drop retire feedback and preserve placement');

  await start('gallery'); await start('gallery'); await entered(5);
  await waitFor(page, () => [...document.querySelectorAll('.toast .t-detail')].some(t => t.textContent.includes('same.glb (2 imports)')), null, { label: 'two concurrent slow imports' });
  await release(3, true);
  await waitFor(page, () => [...document.querySelectorAll('.toast')].some(t => t.querySelector('.t-msg')?.textContent === 'Importing 3D model…' && t.querySelector('.t-detail')?.textContent === 'same.glb'), null, { label: 'remaining import keeps feedback' });
  h.ok(true, 'one rejected same-name import cannot dismiss its pending sibling');
  await shown();
  await page.screenshot({ path: out + '/concurrent-remaining.png' });
  await release(4, true); await hidden();

  await start('gallery'); await entered(6); await shown();
  await page.evaluate(() => window.__flux.fig.embeddedProjectRoot.set('/progress-other'));
  await hidden(); h.ok(true, 'destination switch removes feedback while native transport remains held');
  await release(5);
  result.settlements = await page.evaluate(async () => Promise.all(window.__progressTest.pending));
  h.eq(await page.evaluate(() => window.__flux.figures()[0].elements.length), 2, 'stale completion cannot install in the changed destination');
  await page.evaluate(() => window.__flux.fig.embeddedProjectRoot.set(window.__progressTest.root));
  h.eq(await visible(), [], 'returning to the old destination cannot revive settled feedback');
  h.eq(realErrors(page), [], 'clean console through progress lifecycle');
} catch (error) {
  h.fail(String(error.stack ?? error)); await page.screenshot({ path: out + '/failure.png' }).catch(() => {});
} finally {
  await writeFile(out + '/receipt.json', JSON.stringify(result, null, 2)); await browser.close();
}
await h.done();
