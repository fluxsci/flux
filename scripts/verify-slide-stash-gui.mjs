// Isolated in-memory editor regression. Show hidden is a view choice; the same
// canonical deck must still play its authored disappears and later appearances.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from './lib/driver.mjs';

const { browser, page } = await launch({ width: 1600, height: 1100 });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
let passed = 0;
const timings = [];
const hiddenIds = ['hidden-image', 'hidden-plot', 'hidden-text', 'group-hidden', 'snap-hidden'];
const check = (value, message) => { assert.ok(value, message); passed++; console.log('  ✓ ' + message); };
const paint = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const clickText = async (selector, text) => {
  const handle = await page.evaluateHandle(({ selector, text }) => [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text), { selector, text });
  assert.ok(handle.asElement(), `button ${text}`); await handle.click(); await handle.dispose(); await paint();
};
const read = () => page.evaluate(() => {
  const f = window.__flux, sid = f.get(f.fig.activeFigureId), deck = f.slide.currentDeck();
  return { deck: JSON.stringify(deck), history: JSON.stringify(f.fig.historyStats()), dirty: f.get(f.fig.dirty),
    slide: deck.slides.find(s => s.id === sid), display: f.get(f.fig.project).figures.find(s => s.id === sid).elements,
    selection: [...f.get(f.fig.selection)], part: f.get(f.fig.partSelection), presentation: f.get(f.slide.slideCanvasPresentation) };
});
const point = (x, y) => page.evaluate(([x, y]) => {
  const scene = document.querySelector('[data-editor-element-id="back-image"] > g');
  const p = new DOMPoint(x, y).matrixTransform(scene.getScreenCTM());
  return { x: p.x, y: p.y };
}, [x, y]);
const geom = id => page.$eval(`[data-editor-element-id="${id}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
async function measuredClick(p, label) {
  await page.evaluate(() => {
    window.__stashPaint = null;
    document.addEventListener('pointerdown', () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__stashPaint = performance.now() - start; })); }, { once: true, capture: true });
  });
  if (typeof p === 'string') await page.click(p); else await page.mouse.click(p.x, p.y);
  await waitFor(page, () => window.__stashPaint !== null);
  timings.push({ label, ms: await page.evaluate(() => window.__stashPaint) });
}
const shortcut = async key => { await page.keyboard.down(mod); await page.keyboard.press(key); await page.keyboard.up(mod); await paint(); };
async function afterStep(index) {
  await page.evaluate(index => window.__flux.slide.activeBeat.set(index), index); await paint();
  await clickText('.edit-switch button', `Edit after step ${index}`);
}
async function undo() { await page.click('[aria-label="Undo"]'); await paint(); }
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 200 });
  assert.ok(await clickMode(page, 'Slide', { settle: 200 }));
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: 'scratch deck' });
  await page.evaluate(async () => {
    const f = window.__flux, sid = f.get(f.fig.activeFigureId);
    const { setAssetData } = await import('/src/lib/assets.ts');
    const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="90"><rect width="150" height="90" fill="#da702c"/><circle cx="75" cy="45" r="30" fill="#d0a215"/></svg>';
    setAssetData('stash-image', 'data:image/svg+xml;base64,' + btoa(picture));
    f.plot.cachePlot('stash-plot', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 120" width="150" height="120"><g id="series.hidden"><rect id="series.hidden.child" x="10" y="10" width="55" height="95" fill="#d14d41" style="pointer-events:all"/></g><rect id="series.visible" x="90" y="10" width="45" height="95" fill="#879a39"/></svg>');
    const rect = (id, x, y, width = 150, height = 90, extra = {}) => ({ id, name: id, type: 'rect', x, y, width, height, rotation: 0, opacity: 1, fill: '#4385be', stroke: 'none', strokeWidth: 0, cornerRadius: 0, ...extra });
    f.slide.commitDeckLive(d => {
      d.stage = { width: 1000, height: 600 };
      const s = f.slideOps.slideById(d, sid); d.slides = [s]; s.beats = [{ id: 'stash-initial', tracks: [] }];
      s.groups = { 'mixed-group': { id: 'mixed-group', name: 'Mixed visible and disappeared' } };
      s.elements = [rect('back-image', 80, 70), rect('back-plot', 310, 70), rect('back-text', 540, 70),
        rect('group-visible', 80, 250, 70, 70, { groupId: 'mixed-group' }), rect('group-hidden', 200, 250, 70, 70, { groupId: 'mixed-group' }),
        rect('snap-visible', 400, 300, 40, 40), rect('snap-hidden', 630, 430, 40, 40),
        { id: 'hidden-image', name: 'Disappeared image', type: 'image', assetId: 'stash-image', x: 80, y: 70, width: 150, height: 90, rotation: 0, opacity: 1 },
        { id: 'hidden-plot', name: 'Disappeared plot', type: 'plot', assetId: 'stash-plot', x: 310, y: 70, width: 150, height: 90, rotation: 0, overrides: {} },
        { id: 'hidden-text', name: 'Disappeared text', type: 'text', text: 'Hidden label', x: 540, y: 90, width: 150, height: 55, rotation: 0, opacity: 1, fontFamily: 'Arial', fontSize: 24, fontWeight: 400, fontStyle: 'normal', align: 'left', color: '#cecdc3', sizing: 'fixed', lines: ['Hidden label'] },
        { id: 'parts-plot', name: 'Partial plot', type: 'plot', assetId: 'stash-plot', x: 760, y: 70, width: 150, height: 120, rotation: 0, overrides: {} }];
      const b = f.slideOps.addBeat(d, sid, { label: 'Disappear' });
      for (const target of ['hidden-image', 'hidden-plot', 'hidden-text', 'group-hidden', 'snap-hidden']) f.slideOps.appendAnimation(d, sid, b.id, { target, preset: 'fadeOut', duration: 300 });
      f.slideOps.appendAnimation(d, sid, b.id, { target: 'parts-plot', part: 'series.hidden', preset: 'fadeOut', duration: 300 });
      f.slideOps.addBeat(d, sid, { label: 'Work in the cleared space' });
      const reappear = f.slideOps.addBeat(d, sid, { label: 'Return image' });
      f.slideOps.appendAnimation(d, sid, reappear.id, { target: 'hidden-image', preset: 'fade', duration: 300 });
      const birth = f.slideOps.addBeat(d, sid, { label: 'Future copy' });
      const result = f.slideOps.addGhostTransform(d, sid, birth.id, 'back-image', { count: 1, original: 'stay', states: [{ x: 790, y: 300 }] });
      window.__stashUnborn = result.elementIds[0];
    });
    f.settings.update(s => ({ ...s, snapGrid: false, snapPixel: false }));
    f.fig.viewport.set({ zoom: .8, panX: 24, panY: 24 }); f.fig.clearSelection(); f.fig.partSelection.set(null);
    f.slide.activeBeat.set(1); f.fig.resetHistory(); f.fig.dirty.set(false);
  });
  await clickText('.deckbar button', 'Animate ⏱'); await afterStep(1);
  // Opening the dock resizes the canvas and adjusts pan to preserve its centre;
  // pin the measured fixture viewport after that layout has settled.
  await page.evaluate(() => window.__flux.fig.viewport.set({ zoom: .8, panX: 24, panY: 24 })); await paint();
  await waitFor(page, () => !!document.getElementById('parts-plot__series.hidden.child'));
  check(await page.$eval('.ghost-toggle input', e => e.checked), 'existing Show hidden behavior remains the initial view');
  check(await page.$$eval('[data-editor-element-id]', (els, ids) => ids.every(id => els.some(el => el.dataset.editorElementId === id)), hiddenIds), 'all disappeared object types begin as editable ghosts');
  const unchanged = await read();
  await measuredClick('.ghost-toggle input', 'Show hidden off');
  check(await page.$$eval('[data-editor-element-id]', (els, ids) => els.every(el => !ids.includes(el.dataset.editorElementId)), hiddenIds), 'Show hidden off unmounts disappeared image, plot, text and group members');
  check(!(await page.$(`[data-editor-element-id="${await page.evaluate(() => window.__stashUnborn)}"]`)), 'unborn future copies remain absent from the canvas');
  for (const [id, x, y] of [['back-image', 155, 115], ['back-plot', 385, 115], ['back-text', 590, 112]]) {
    const p = await point(x, y);
    assert.equal(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('[data-editor-element-id]')?.getAttribute('data-editor-element-id'), p), id, 'pointer reaches the visible object through the cleared canvas');
    await measuredClick(p, `select through ${id}`);
    assert.deepEqual((await read()).selection, [id]); check(true, `clicks pass through disappeared ${id.slice(5)} to the visible object beneath`);
  }
  const groupPoint = await point(115, 285); await measuredClick(groupPoint, 'select mixed group');
  assert.deepEqual((await read()).selection, ['group-visible']); check(true, 'group expansion omits its stashed member');
  await page.keyboard.press('ArrowRight'); await paint();
  let state = await read();
  check(state.display.find(e => e.id === 'group-visible').x === 81 && state.display.find(e => e.id === 'group-hidden').x === 200, 'nudge moves only the visible group member');
  check(!state.slide.beats[1].tracks.some(t => t.target === 'group-hidden' && t.preset === 'transform'), 'nudge never authors an accidental Change for a stashed group member');
  await undo();
  const gp = await geom('group-visible');
  await page.mouse.move(gp.x + gp.w / 2, gp.y + gp.h / 2); await page.mouse.down(); await page.keyboard.down('Alt');
  await page.mouse.move(gp.x + gp.w / 2 + 32, gp.y + gp.h / 2 + 16, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Alt'); await paint();
  state = await read(); check(state.display.find(e => e.id === 'group-visible').x === 120 && state.display.find(e => e.id === 'group-hidden').x === 200, 'group drag leaves the stashed member untouched'); await undo();
  const a = await point(55, 225), b = await point(290, 345);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up(); await paint();
  assert.deepEqual((await read()).selection, ['group-visible']); check(true, 'marquee selection excludes stashed objects and group expansion');
  const beforeDuplicate = await read(); await shortcut('KeyD'); state = await read();
  check(state.slide.elements.length === beforeDuplicate.slide.elements.length + 1 && hiddenIds.every(id => state.slide.elements.some(e => e.id === id)), 'duplicating the visible group selection copies only its available member'); await undo();
  await shortcut('KeyA'); state = await read();
  check(hiddenIds.every(id => !state.selection.includes(id)), 'canvas Select all excludes every stashed object');
  const beforeNudge = state; await page.keyboard.press('ArrowRight'); await paint(); state = await read();
  check(hiddenIds.every(id => JSON.stringify(state.display.find(e => e.id === id)) === JSON.stringify(beforeNudge.display.find(e => e.id === id))), 'Select all then nudge preserves every stashed object'); await undo();
  await shortcut('KeyA');
  await page.keyboard.press('Backspace'); await paint(); state = await read();
  check(hiddenIds.every(id => state.slide.elements.some(e => e.id === id)), 'Select all then Delete preserves every stashed object'); await undo();
  // Visible geometry near the disappeared target's x=630 must retain x=627;
  // accepting the hidden edge would incorrectly snap the drag three units.
  await page.evaluate(() => window.__flux.fig.clearSelection()); await paint();
  const sp = await geom('snap-visible');
  await page.mouse.move(sp.x + sp.w / 2, sp.y + sp.h / 2); await page.mouse.down();
  await page.mouse.move(sp.x + sp.w / 2 + 227 * .8, sp.y + sp.h / 2 + 23 * .8, { steps: 5 }); await page.mouse.up(); await paint();
  state = await read(); check(Math.abs(state.display.find(e => e.id === 'snap-visible').x - 627) < .05, 'a stashed object supplies neither edge nor spacing snap targets: x=' + state.display.find(e => e.id === 'snap-visible').x); await undo();
  // A descendant explicitly opting into pointer events must inherit the stash.
  const hiddenPartPoint = await point(792, 115);
  await page.keyboard.down(mod); await measuredClick(hiddenPartPoint, 'hidden plot part'); await page.keyboard.up(mod);
  check(!(await read()).part, 'deep click cannot select a stashed semantic group through its pointer-active child');
  await measuredClick('.ghost-toggle input', 'Show hidden on');
  check(await page.$$eval('[data-editor-element-id]', (els, ids) => ids.every(id => els.some(el => el.dataset.editorElementId === id)), hiddenIds), 'Show hidden on restores every disappeared object as an editing ghost');
  check(!(await page.$(`[data-editor-element-id="${await page.evaluate(() => window.__stashUnborn)}"]`)), 'Show hidden never exposes unborn future copies');
  await page.keyboard.down(mod); await measuredClick(hiddenPartPoint, 'restored plot part'); await page.keyboard.up(mod);
  check((await read()).part?.partId?.startsWith('series.hidden'), 'Show hidden restores semantic children for deep selection');
  await measuredClick('.ghost-toggle input', 'Show hidden off again');
  check(!(await read()).part, 'turning Show hidden off prunes the selected disappeared part');
  await afterStep(2);
  check(!(await page.$('[data-editor-element-id="hidden-image"]')) && !(await page.$eval('.ghost-toggle input', e => e.checked)), 'disappeared objects stay absent while navigating to the next step');
  await afterStep(3);
  check(await page.$('[data-editor-element-id="hidden-image"]') && !(await page.$('[data-editor-element-id="hidden-text"]')), 'an authored later Appear restores its object normally while other objects stay stashed');
  await clickText('.edit-switch button', 'Design');
  check(await page.$('[data-editor-element-id="hidden-image"]') && !(await page.$(`[data-editor-element-id="${await page.evaluate(() => window.__stashUnborn)}"]`)), 'Design shows authored originals but never unborn copies');
  await afterStep(1);
  await measuredClick('.ghost-toggle input', 'Show hidden on before preview');
  const viewOnly = await read();
  check(viewOnly.deck === unchanged.deck, 'Show hidden toggles and navigation preserve canonical deck bytes');
  // Undo/redo above exercise authoring in between; reset the scratch history before
  // isolating another complete view cycle for the history and dirty-state claim.
  await page.evaluate(() => { window.__flux.fig.resetHistory(); window.__flux.fig.dirty.set(false); });
  const beforeView = await read();
  await measuredClick('.ghost-toggle input', 'view-only off'); await measuredClick('.ghost-toggle input', 'view-only on');
  const afterView = await read();
  check(afterView.history === beforeView.history && afterView.dirty === beforeView.dirty && afterView.deck === beforeView.deck, 'view choices neither create Undo entries nor dirty the project');
  // Seek through the actual preview while Show hidden displays editor ghosts.
  const ruler = await page.$eval('.ruler', e => { const r = e.getBoundingClientRect(); return { x: r.right - 4, y: r.y + r.height / 2 }; });
  await page.mouse.click(ruler.x, ruler.y); await paint();
  await waitFor(page, () => !!document.querySelector('.preview-overlay .sl-el[data-el-id="hidden-image"]'));
  const previewOpacity = await page.$eval('.preview-overlay .sl-el[data-el-id="hidden-image"]', el => {
    let opacity = 1; for (let node = el; node && !node.classList.contains('preview-overlay'); node = node.parentElement) opacity *= +getComputedStyle(node).opacity;
    const effect = el.querySelector('.sl-effects'); if (effect) opacity *= +getComputedStyle(effect).opacity;
    return opacity;
  });
  check(previewOpacity === 0, 'Show hidden does not reveal disappeared objects in authored playback');
  await clickText('.animator .transport button', '■ Stop');
  check((await read()).deck === beforeView.deck, 'preview inspection leaves the canonical deck unchanged');
  check(timings.every(t => t.ms <= 100), 'Show hidden toggles and selection paint within 100ms');
  check(realErrors(page).length === 0, 'clean renderer console: ' + realErrors(page).join('; '));
  mkdirSync('test-results', { recursive: true });
  await page.click('.ghost-toggle input'); await paint();
  await page.evaluate(() => window.__flux.fig.clearSelection()); await paint();
  await page.screenshot({ path: 'test-results/slide-stash.png' });
  await page.click('.ghost-toggle input'); await paint(); await page.screenshot({ path: 'test-results/slide-show-hidden.png' });
  writeFileSync('test-results/slide-stash.json', JSON.stringify({ passed, timings }, null, 2) + '\n');
  console.log('Stash interaction timings ' + JSON.stringify(timings));
  console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-slide-stash-gui', ok: true, checks: passed, failed: 0 })}`);
} catch (error) {
  console.error(error); console.error('Renderer errors', realErrors(page));
  await page.screenshot({ path: 'test-results/slide-stash-failure.png' }).catch(() => {});
  console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-slide-stash-gui', ok: false, checks: passed + 1, failed: 1 })}`); process.exitCode = 1;
} finally { await browser.close(); }
