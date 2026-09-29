import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { inspectGlb } from '../src/lib/model3d/glbCore.mjs';
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, sleep } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
const h = harness('verify-model3d-embed-gui');
const out = path.resolve('test-results/model3d/embeds'); await fs.mkdir(out, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-quarto-'));
const bytes = await fs.readFile('scripts/fixtures/model3d/fluxplot/named-parts.glb');
const manifest = JSON.parse(await fs.readFile('scripts/fixtures/model3d/fluxplot/named-parts.fluxplot.json', 'utf8'));
const fixture = { bytes: [...bytes], manifest, model: inspectGlb(bytes), sha: createHash('sha256').update(bytes).digest('hex') };
const { browser, page } = await launch({ width: 1440, height: 1050 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__embedMainGL = [];
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { if (/webgl/.test(kind)) window.__embedMainGL.push(kind); return get.call(this, kind, ...args); };
  });
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 300 });
  const seedDeck = p => p.evaluate(async fixture => {
    const { createDeck, addSlide, addBeat, setTransform } = await import('/src/lib/slide/ops.ts');
    const { makeModel3dElement } = await import('/src/lib/model3d/make.ts');
    const pm = window.__flux.get(window.__flux.shell.projectModel), root = pm.root;
    const asset = { id: 'embed-neuron', kind: 'glb', name: 'Neuron branches', path: 'assets/embed-neuron.glb', naturalWidth: 400, naturalHeight: 280, sha256: fixture.sha, bytes: fixture.bytes.length, model: fixture.model };
    const deck = createDeck({ id: 'model-embeds', title: 'Neuron views', stage: { width: 480, height: 300 }, withTitleSlide: false }); deck.assets = [asset];
    for (const id of ['front', 'side']) {
      const slide = addSlide(deck); slide.id = id; slide.name = id === 'front' ? 'Front branches' : 'Side branches'; slide.background = '#ffffff';
      const el = makeModel3dElement(asset, { id: `${id}-mesh` }); Object.assign(el, { x: 20, y: 10, width: 440, height: 270, orbitAzimuth: id === 'front' ? 0 : 90 }); slide.elements = [el];
      const beat = addBeat(deck, slide.id); setTransform(deck, slide.id, beat.id, el.id, { state: { orbitAzimuth: el.orbitAzimuth + 120 }, duration: 1800, easing: 'linear' });
    }
    pm.manifest.slides = [{ id: deck.id, title: deck.title, path: `slides/${deck.id}/deck.json` }];
    await window.fig.writeText(`${root}/project.json`, JSON.stringify(pm.manifest));
    await window.fig.writeText(`${root}/slides/${deck.id}/deck.json`, JSON.stringify(deck));
    await window.fig.writeFile(`${root}/slides/${deck.id}/${asset.path}`, new Uint8Array(fixture.bytes));
    await window.fig.writeText(`${root}/slides/${deck.id}/assets/${asset.id}.fluxplot.json`, JSON.stringify({ ...fixture.manifest, glb: 'embed-neuron.glb' }));
    window.__embedRoot = root;
  }, fixture);
  await seedDeck(page);
  await clickMode(page, 'Paper'); await waitFor(page, () => !!window.__fluxView, null, { timeout: 10000 });
  await page.evaluate(() => {
    const v = window.__fluxView;
    const line = id => `![](../slides/model-embeds/renders/${id}-step-0.svg){#embed-${id} .flux-slide deck="model-embeds" slide="${id}" width=50%}`;
    const text = `# Neuron animation\n\nType here.\n\n${line('front')}\n\n${line('side')}\n\nAfter.\n`;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.indexOf('Type here.') + 10 } }); v.focus();
  });
  await waitFor(page, () => document.querySelectorAll('.paper [data-model3d-host="service"] canvas[data-slide-model3d]').length === 2 && [...document.querySelectorAll('.paper canvas[data-slide-model3d]')].every(c => c.width > 0 && c.style.display === 'block'), null, { timeout: 20000 });
  const initial = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.paper canvas[data-slide-model3d]')];
    window.__embedNodes = canvases;
    return { images: canvases.map(c => c.toDataURL()), stats: window.__fluxModel3d.stats(), mainGL: window.__embedMainGL };
  });
  h.ok(initial.images[0] !== initial.images[1], 'two actual widgets display distinct authored 3D views');
  h.ok(initial.stats.contexts === 1 && initial.stats.retained === 1, 'Paper widgets share one worker and one retained geometry');
  h.eq(initial.mainGL, [], 'Paper creates no main-thread WebGL context');
  await page.screenshot({ path: path.join(out, 'paper-live.png') });
  await page.click('.paper [aria-label="Next animation step"]');
  await waitFor(page, before => document.querySelector('.paper canvas[data-slide-model3d]').toDataURL() !== before, initial.images[0], { timeout: 5000 });
  h.eq(await page.$$eval('.paper canvas[data-slide-model3d]', cs => cs[1].toDataURL()), initial.images[1], 'advancing first widget does not move the second view');
  await page.evaluate(() => {
    const v = window.__fluxView, at = v.state.doc.toString().indexOf('Type here.') + 10;
    v.dispatch({ selection: { anchor: at } }); v.focus(); window.__embedTyping = [];
    let stamp;
    v.contentDOM.addEventListener('keydown', e => { if (e.key === 'x') stamp = performance.now(); });
    v.contentDOM.addEventListener('input', () => { const started = stamp; if (started !== undefined) { stamp = undefined; requestAnimationFrame(() => window.__embedTyping.push(performance.now() - started)); } });
  });
  for (let i = 0; i < 30; i++) { await page.keyboard.type('x'); await sleep(20); }
  await waitFor(page, () => window.__embedTyping.length === 30, null, { timeout: 5000 });
  const typing = await page.evaluate(() => ({ raw: window.__embedTyping, changed: window.__fluxView.state.doc.toString().includes('xxxxxxxxxx'), stable: window.__embedNodes.every(c => c.isConnected) }));
  const sorted = [...typing.raw].sort((a,b) => a-b), p95 = sorted[Math.ceil(sorted.length * .95) - 1];
  h.ok(typing.changed && typing.stable, 'real typing changes prose and preserves both player DOM instances');
  h.ok(p95 <= 100 && Math.max(...typing.raw) <= 100, `typing with live 3D embed paints within100ms (p95 ${p95.toFixed(2)}ms)`);
  await waitFor(page, () => document.querySelector('.paper .flux-slide-bar')?.textContent.includes('Step 1 / 1'), null, { timeout: 5000 });
  const beforeIdle = await page.evaluate(() => window.__fluxModel3d.stats().renders); await sleep(500);
  h.eq(await page.evaluate(() => window.__fluxModel3d.stats().renders), beforeIdle, 'settled Paper models schedule no idle worker render');
  const offline = await page.evaluate(async () => {
    const { createSlideRepository } = await import('/src/lib/slide/embedRepository.ts');
    const { slideModelPosterIO } = await import('/src/lib/slide/model3dPosterIO.ts');
    const { renderManuscript } = await import('/src/shell/modes/paper/render/renderManuscript.ts');
    const repo = createSlideRepository(window.__embedRoot, { ...window.fig, ...slideModelPosterIO(window.__embedRoot, window.fig), modelData: 'omit' });
    const result = await renderManuscript(window.__fluxView.state.doc.toString(), { slides: repo, strict: true }); repo.dispose(); return result.full;
  });
  await fs.writeFile(path.join(out, 'offline.html'), offline);
  const quarto = await page.evaluate(async () => {
    const { createSlideRepository } = await import('/src/lib/slide/embedRepository.ts');
    const { slideModelPosterIO } = await import('/src/lib/slide/model3dPosterIO.ts');
    const { slideQuartoTransform } = await import('/src/lib/slide/embedQuarto.ts');
    const { prepareExport } = await import('/src/lib/exportPrep.ts');
    const root = window.__embedRoot, entry = `${root}/paper/p4c-qa.qmd`, include = `${root}/paper/p4c-detail.qmd`;
    const line = id => `![](../slides/model-embeds/renders/${id}-step-0.svg){#embed-${id} .flux-slide deck="model-embeds" slide="${id}" width=50%}`;
    const source = `---\ntitle: Neuron embeds\nformat:\n  html:\n    embed-resources: true\n    html-math-method: plain\n---\n\n${line('front')}\n\n{{< include p4c-detail.qmd >}}\n`;
    const detail = line('side'); await window.fig.writeText(entry, source); await window.fig.writeText(include, detail);
    const repo = createSlideRepository(root, { ...window.fig, ...slideModelPosterIO(root, window.fig), modelData: 'omit' });
    const prepared = await prepareExport(window.fig, { entry, ctx: { captions: new Map(), figures: new Map() }, ...slideQuartoTransform(root, repo, true) });
    const result = { source: await window.fig.readText(entry), detail: await window.fig.readText(include) };
    await prepared.restore(); repo.dispose();
    return { ...result, restored: (await window.fig.readText(entry)) === source && (await window.fig.readText(include)) === detail };
  });
  h.ok(quarto.restored, 'real Quarto preparation restores entry and include source bytes');
  await fs.writeFile(path.join(scratch, 'p4c-qa.qmd'), quarto.source); await fs.writeFile(path.join(scratch, 'p4c-detail.qmd'), quarto.detail);
  const compiled = spawnSync('quarto', ['render', 'p4c-qa.qmd', '--to', 'html'], { cwd: scratch, env: process.env, encoding: 'utf8', timeout: 60000 });
  await fs.writeFile(path.join(out, 'quarto.log'), compiled.stdout + compiled.stderr);
  if (compiled.status !== 0) throw new Error(`Quarto failed: ${compiled.stderr}`);
  const html = await fs.readFile(path.join(scratch, 'p4c-qa.html'), 'utf8'); await fs.writeFile(path.join(out, 'quarto.html'), html);
  h.ok((html.match(/id="flux-slide-data"/g) ?? []).length === 1, 'actual Quarto HTML has one include-wide payload table');
  const exported = await browser.newPage(); await exported.setOfflineMode(true); await exported.goto(`file://${path.join(out, 'offline.html')}`);
  await exported.waitForFunction(() => document.querySelectorAll('canvas[data-slide-model3d]').length === 2 && [...document.querySelectorAll('canvas[data-slide-model3d]')].every(c => c.width > 0 && c.style.display === 'block'));
  const before = await exported.$eval('canvas[data-slide-model3d]', c => c.toDataURL());
  await exported.click('[aria-label="Next animation step"]'); await exported.waitForFunction(before => document.querySelector('canvas[data-slide-model3d]').toDataURL() !== before, {}, before);
  h.ok(true, 'offline document runtime plays actual 3D pixels without a network');
  h.eq(await exported.evaluate(() => document[Symbol.for('flux.model3d.inlineHost')].core.stats().assets), 1, 'offline occurrences share one loaded geometry and one context');
  await exported.screenshot({ path: path.join(out, 'offline-live.png') });
  await exported.goto(`file://${path.join(out, 'quarto.html')}`); await exported.waitForFunction(() => [...document.querySelectorAll('canvas[data-slide-model3d]')].some(c => c.width > 0 && c.style.display === 'block'));
  const qBefore = await exported.$eval('canvas[data-slide-model3d]', c => c.toDataURL()); await exported.click('[aria-label="Next animation step"]');
  await exported.waitForFunction(before => document.querySelector('canvas[data-slide-model3d]').toDataURL() !== before, {}, qBefore);
  h.ok(true, 'actual Quarto HTML animates 3D pixels offline');
  await exported.screenshot({ path: path.join(out, 'quarto-live.png') }); await exported.close();
  await page.evaluate(() => { const v=window.__fluxView, text=v.state.doc.toString(), from=text.indexOf('![]'), to=text.indexOf('\n',from);v.dispatch({changes:{from,to,insert:''}}); });
  await waitFor(page, () => document.querySelectorAll('.paper canvas[data-slide-model3d]').length === 1 && window.__fluxModel3d.stats().retained === 1, null, { timeout: 10000 });
  const remaining = await page.$eval('.paper canvas[data-slide-model3d]', c => c.toDataURL()); await page.click('.paper [aria-label="Next animation step"]');
  await waitFor(page, before => document.querySelector('.paper canvas[data-slide-model3d]').toDataURL() !== before, remaining, { timeout: 5000 });
  h.ok(true, 'disposing one widget leaves the shared geometry and other player live');
  await page.evaluate(() => { const v=window.__fluxView;v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '# No embeds\n\nTyping continues.\n' } }); });
  await waitFor(page, () => !document.querySelector('.paper canvas[data-slide-model3d]') && window.__fluxModel3d.stats().retained === 0, null, { timeout: 10000 });
  h.ok(true, 'deleting embeds disposes canvases, pending views and worker retains');
  await page.evaluate(() => {
    const original = window.fig.readFile.bind(window.fig); let release;
    const barrier = new Promise(resolve => { release = resolve; }); window.__embedHeldReads = 0;
    window.__embedRelease = () => { window.fig.readFile = original; release(); };
    window.fig.readFile = async path => { if (path.endsWith('.glb')) { window.__embedHeldReads++; await barrier; } return original(path); };
    const v=window.__fluxView, line=id=>`![](../slides/model-embeds/renders/${id}-step-0.svg){#pending-${id} .flux-slide deck="model-embeds" slide="${id}" width=50%}`;
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert:`# Shared pending models\n\n${line('front')}\n\n${line('side')}\n`}});
  });
  await waitFor(page, () => window.__embedHeldReads > 0 && document.querySelectorAll('.paper canvas[data-slide-model3d]').length === 2, null, { timeout: 10000 });
  await page.evaluate(() => { const v=window.__fluxView,text=v.state.doc.toString(),from=text.indexOf('![]'),to=text.indexOf('\n',from);v.dispatch({changes:{from,to,insert:''}}); });
  await waitFor(page, () => document.querySelectorAll('.paper canvas[data-slide-model3d]').length === 1, null, { timeout: 5000 });
  await page.evaluate(() => window.__embedRelease());
  await waitFor(page, () => { const c=document.querySelector('.paper canvas[data-slide-model3d]');return c?.width>0&&c.style.display==='block'; }, null, { timeout: 10000 });
  h.ok(true, 'removing the first widget during shared byte load preserves the remaining owner');
  const oldPixels = await page.$eval('.paper canvas[data-slide-model3d]', c => c.toDataURL()); await page.click('.paper [aria-label="Next animation step"]');
  await waitFor(page, before => document.querySelector('.paper canvas[data-slide-model3d]').toDataURL() !== before, oldPixels, { timeout: 5000 });
  h.ok(true, 'surviving pending owner animates actual pixels after source resolution');
  await page.evaluate(() => { const v=window.__fluxView;window.__embedSavedDoc=v.state.doc.toString(); v.dispatch({changes:{from:v.state.doc.length,insert:'\n'+Array.from({length:150},(_,i)=>`Paragraph ${i}.`).join('\n\n')}});v.dispatch({selection:{anchor:v.state.doc.length},scrollIntoView:true}); });
  await waitFor(page, () => !document.querySelector('.paper canvas[data-slide-model3d]') && window.__fluxModel3d.stats().retained === 0, null, { timeout: 10000 });
  h.ok(true, 'scrolling the model outside the editor viewport releases its worker retain');
  await page.evaluate(() => { const v=window.__fluxView;v.dispatch({selection:{anchor:0},scrollIntoView:true}); });
  await waitFor(page, () => { const c=document.querySelector('.paper canvas[data-slide-model3d]');return c?.width>0&&c.style.display==='block'; }, null, { timeout: 10000 });
  h.ok(true, 'scrolling back remounts the model with real pixels');
  await page.evaluate(() => { const v=window.__fluxView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# Finished\n'}}); });
  await waitFor(page, () => !document.querySelector('.paper canvas[data-slide-model3d]') && window.__fluxModel3d.stats().retained === 0, null, { timeout: 10000 });

  h.eq(realErrors(page), [], 'Paper widget lifecycle has no console/module errors');
  // A live 3D widget that cannot start (here: its lazy 3D module fails to load)
  // keeps the still and says so in a visible status line, not just a tooltip.
  const failing = await browser.newPage(); await failing.setViewport({ width: 1440, height: 1050 });
  // Fail only that module; page-wide request interception stalled the widget before it mounted.
  const cdp = await failing.createCDPSession(); await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*embedServiceHost*' }] });
  cdp.on('Fetch.requestPaused', e => { void cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Failed' }).catch(() => {}); });
  await gotoApp(failing, { url: `${APP_URL}?fixture=demo`, settle: 300 }); await seedDeck(failing);
  await clickMode(failing, 'Paper'); await waitFor(failing, () => !!window.__fluxView, null, { timeout: 10000 });
  await failing.evaluate(() => { const v = window.__fluxView, text = `# Unavailable\n\n![](../slides/model-embeds/renders/front-step-0.svg){#embed-front .flux-slide deck="model-embeds" slide="front" width=50%}\n`; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); });
  await waitFor(failing, () => { const s = document.querySelector('.paper .flux-slide-embed .flux-slide-status[role="status"]'); return !!s && !s.hidden; }, null, { timeout: 10000, label: '3D failure status line' });
  const unavailable = await failing.$eval('.paper .flux-slide-embed', w => { const s = w.querySelector('.flux-slide-status[role="status"]'), r = s.getBoundingClientRect(); return { text: s.textContent, title: s.title, visible: r.width > 0 && r.height > 0, still: !!w.querySelector('img[src^="data:image/svg+xml"]') }; });
  h.ok(unavailable.text === '3D preview unavailable — showing a still' && unavailable.visible && unavailable.still, 'failed live 3D embed keeps its still and says so visibly');
  h.ok(unavailable.title.length > 0, 'the failure reason is the status line tooltip');
  await failing.screenshot({ path: path.join(out, 'paper-unavailable.png') }); await failing.close();
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify({ typing, p95, initialStats: initial.stats }, null, 2));
} catch (error) { h.fail(String(error)); console.error(error); await page.screenshot({ path: path.join(out, 'failure.png') }); }
await h.done(async () => { await browser.close(); await fs.rm(scratch, { recursive: true, force: true }); });
