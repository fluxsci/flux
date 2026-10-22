// Hardware press feedback: real input, exact idle restoration, cancellation,
// settings persistence and the dense scene's cursor inheritance firewall.
import { launch, gotoApp, clickMode, waitFor, sleep, APP_URL, realErrors } from './lib/driver.mjs';
import { installDenseProject } from './lib/lazyFixture.mjs';
const { browser, page } = await launch();
const checks = [];
const ok = (value, message) => { checks.push([!!value, message]); console.log(`${value ? '✓' : '✗'} ${message}`); };
const hostCursor = () => page.$eval('.canvas-host', n => getComputedStyle(n).cursor);
const idle = () => waitFor(page, () => !document.querySelector('.canvas-host').style.getPropertyPriority('cursor'), null, { timeout: 1500, label: 'press returned to rest' });
const config = (patch) => page.evaluate(async patch => {
  const { settings } = await import(performance.getEntriesByType('resource').find(e => /\/src\/lib\/settings\.ts(?:\?|$)/.test(e.name)).name);
  settings.update(s => ({ ...s, ...patch }));
}, patch);
try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 1500 });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!document.querySelector('.canvas-host'));
  const defaults = await page.evaluate(async () => {
    const { settings } = await import(performance.getEntriesByType('resource').find(e => /\/src\/lib\/settings\.ts(?:\?|$)/.test(e.name)).name);
    return window.__flux.get(settings);
  });
  ok(defaults.arrowFill === '#ff60fc' && defaults.arrowOutline === '#07043c' && defaults.arrowSize === 22 && defaults.arrowOutlineWidth === 1.3 && defaults.arrowRounding === .9 && defaults.arrowShadow === .6 && defaults.arrowTilt === 0 && defaults.cursorPressEnabled && defaults.cursorPressDepth === 1.25 && defaults.cursorPressReturnMs === 80, 'fresh settings use the exact tuned pink cursor and press');
  await config({ arrowFill: '#ef75ad', cursorPressEnabled: true });
  const point = await page.$eval('.canvas-host', n => { const r = n.getBoundingClientRect(); return { x: r.right - 50, y: r.bottom - 50 }; });
  await page.mouse.move(point.x, point.y);
  const rest = await hostCursor();
  await page.evaluate(() => {
    window.__pressFrames = [];
    const host = document.querySelector('.canvas-host');
    new MutationObserver(() => window.__pressFrames.push({ t: performance.now(), css: host.style.cursor })).observe(host, { attributes: true, attributeFilter: ['style'] });
    host.addEventListener('pointerdown', () => { window.__pressImmediate = host.style.getPropertyPriority('cursor') === 'important'; });
  });
  await page.mouse.down();
  ok(await page.evaluate(() => window.__pressImmediate), 'press acknowledges the input in the pointerdown turn');
  // Sampling the held pose deliberately outlasts the 50ms downstroke.
  await sleep(90);
  const held = await hostCursor();
  ok(held !== rest && held.includes('%23ef75ad') && held.endsWith('3 3, default'), 'held pose preserves pink, hotspot and native cursor');
  const count = await page.evaluate(() => window.__pressFrames.length);
  await sleep(90); // steady hold: no further animation writes
  ok(await page.evaluate(n => window.__pressFrames.length === n, count), 'holding the button has zero animation writes');
  await page.mouse.up();
  await idle();
  ok(await hostCursor() === rest, 'release restores the exact resting arrow');
  const frames = await page.evaluate(() => window.__pressFrames);
  ok(new Set(frames.map(f => f.css)).size >= 4, 'the press and return have intermediate hardware frames');
  await page.mouse.click(point.x, point.y);
  await idle();
  ok(await hostCursor() === rest, 'a quick tap completes and restores the arrow');
  for (let i = 0; i < 5; i++) await page.mouse.click(point.x, point.y);
  await idle();
  ok(await hostCursor() === rest, 'rapid clicks leave no stuck or queued press');
  for (const event of ['blur', 'pointercancel', 'contextmenu']) {
    await page.mouse.down();
    await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
    await idle();
    ok(await hostCursor() === rest, `${event} immediately removes the animated override`);
    await page.mouse.up();
  }
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await idle();
  ok(await hostCursor() === rest, 'Escape cancels the press');
  await page.mouse.up();
  await config({ cursorPressEnabled: false });
  await page.mouse.down();
  ok(await hostCursor() === rest, 'disabled feedback keeps the original pressed arrow');
  await page.mouse.up();
  await config({ cursorPressEnabled: true });
  await page.mouse.down({ button: 'right' });
  ok(await hostCursor() === rest, 'secondary click has no depression');
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await page.mouse.down();
  ok(await hostCursor() === 'grabbing', 'pan retains its hand cursor');
  await page.mouse.up();
  await page.keyboard.press('v');

  // Dense fixture: compare a disabled control with enabled whole click cycles.
  const fx = await installDenseProject(page, { root: '/demo/cursor-press', figures: 1 });
  await page.evaluate(async root => window.__flux.bridge.loadFigInto(root, 'cursor-press'), fx.root);
  await page.evaluate(id => {
    const F = window.__flux.fig;
    const f = window.__flux.get(F.project).figures.find(f => f.id === id);
    F.activeCanvasId.set(f.canvasId); F.activeFigureId.set(id);
    F.viewport.set({ panX: 140 - f.x * .55, panY: 96 - f.y * .55, zoom: .55 });
  }, fx.figIds[0]);
  await waitFor(page, () => document.querySelectorAll('[data-editor-element-id] svg *').length > 10000, null, { timeout: 90000 });
  await sleep(1500); // drain fixture parsing and its independent deferred work
  const dense = await page.evaluate(() => {
    const host = document.querySelector('.canvas-host').getBoundingClientRect();
    const n = [...document.querySelectorAll('[data-editor-element-id]')].find(n => { const r = n.getBoundingClientRect(); return n.querySelector('svg *') && r.width > 40 && r.height > 40 && r.left > host.left + 30 && r.right < host.right - 30 && r.top > host.top + 30 && r.bottom < host.bottom - 30; });
    const r = n.getBoundingClientRect();
    return { id: n.dataset.editorElementId, x: r.x + r.width / 2, y: r.y + r.height / 2, nodes: document.querySelectorAll('[data-editor-element-id] svg *').length };
  });
  const inner = () => page.evaluate(id => getComputedStyle(document.querySelector(`[data-editor-element-id="${id}"] svg *`)).cursor, dense.id);
  const innerRest = await inner();
  await page.mouse.move(dense.x, dense.y);
  await page.mouse.down();
  await sleep(90);
  ok(await inner() === innerRest && await hostCursor() !== rest, `captured press leaves ${dense.nodes} plot nodes' cursor unchanged`);
  await page.mouse.move(dense.x + 8, dense.y + 6, { steps: 3 });
  ok(await hostCursor() !== rest, 'drag keeps the depressed arrow');
  await page.mouse.up();
  await idle();
  const afterDrag = await page.evaluate(() => [...document.querySelectorAll('.canvas-host [style]')].filter(n => n.style.getPropertyPriority('cursor') === 'important').length);
  ok(afterDrag === 0, 'drag release clears every temporary leaf override');
  const cdp = await page.target().createCDPSession();
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const costs = [];
  for (const enabled of [false, true]) {
    await config({ cursorPressEnabled: enabled });
    await page.mouse.move(point.x, point.y);
    await sleep(400); // finish preceding save/selection and frame-cache work before timing
    await page.evaluate(() => {
      window.__pressLong = [];
      window.__pressObserver?.disconnect();
      window.__pressObserver = new PerformanceObserver(l => window.__pressLong.push(...l.getEntries().map(e => e.duration)));
      window.__pressObserver.observe({ type: 'longtask' });
    });
    const before = await metrics();
    for (let i = 0; i < 6; i++) { await page.mouse.click(point.x, point.y); await idle(); }
    const after = await metrics();
    const style = (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000 / 6;
    costs.push(style);
    ok(style < 8, `${enabled ? 'animated' : 'disabled'} dense click style cost ${style.toFixed(2)}ms (<8ms for the whole cycle)`);
    ok(await page.evaluate(() => !window.__pressLong.some(n => n >= 50)), 'no long tasks during dense clicks');
  }
  console.log(`Dense style cost: off ${costs[0].toFixed(2)}ms/click; on ${costs[1].toFixed(2)}ms/click`);

  // Settings exercise the actual controls and the same action on the trial pad.
  await page.evaluate(async () => (await import(performance.getEntriesByType('resource').find(e => /\/src\/lib\/settings\.ts(?:\?|$)/.test(e.name)).name)).settingsOpen.set(true));
  await page.waitForSelector('#settings-tab-general');
  await page.click('#settings-tab-general');
  await page.$eval('[aria-label="Cursor press depth"]', n => n.scrollIntoView());
  for (const [label, value] of [['Cursor press depth', '0.75'], ['Cursor press return time', '85']]) {
    await page.$eval(`[aria-label="${label}"]`, (n, value) => { n.value = value; n.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flux.settings')));
  ok(saved.cursorPressDepth === .75 && saved.cursorPressReturnMs === 85 && saved.arrowFill === '#ef75ad', 'settings persist both motion controls without changing pink');
  await page.$$eval('button', buttons => buttons.find(b => b.textContent.trim() === 'Reset cursor to defaults').click());
  const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('flux.settings')));
  ok(reset.arrowFill === '#ff60fc' && reset.arrowOutline === '#07043c' && reset.cursorPressDepth === 1.25 && reset.cursorPressReturnMs === 80 && reset.cursorPressEnabled, 'Reset cursor restores the tuned appearance and motion together');
  await config({ arrowFill: '#ef75ad', cursorPressDepth: .75, cursorPressReturnMs: 85 });
  await page.click('.cursor-press-trial');
  await waitFor(page, () => !document.querySelector('.cursor-press-trial').style.getPropertyPriority('cursor'));
  await page.click('[aria-label="Cursor press animation"]');
  ok(await page.$('[aria-label="Cursor press depth"]') === null, 'toggle disables the motion controls');
  await page.reload();
  await waitFor(page, () => !!window.__flux);
  const persisted = await page.evaluate(async () => {
    const { settings } = await import(performance.getEntriesByType('resource').find(e => /\/src\/lib\/settings\.ts(?:\?|$)/.test(e.name)).name);
    return window.__flux.get(settings);
  });
  ok(!persisted.cursorPressEnabled && persisted.cursorPressDepth === .75 && persisted.cursorPressReturnMs === 85, 'toggle and tuning survive reload');
  await config({ cursorPressEnabled: true });
  await clickMode(page, 'Slide', { settle: 1600 });
  await waitFor(page, () => !!document.querySelector('.slide-mode .canvas-host'));
  const slidePoint = await page.$eval('.slide-mode .canvas-host', n => { const r = n.getBoundingClientRect(); return { x: r.right - 40, y: r.bottom - 40 }; });
  await page.mouse.move(slidePoint.x, slidePoint.y);
  const slideRest = await hostCursor();
  await page.mouse.down();
  await sleep(80); // past the tuned downstroke, while still held
  ok(await hostCursor() !== slideRest, 'the shared Slide canvas also depresses');
  await config({ cursorPressEnabled: false });
  await idle();
  ok(await hostCursor() === slideRest, 'disabling during a held press restores the pointer immediately');
  await page.mouse.up();
  ok((await realErrors(page)).length === 0, 'clean browser console');
} finally { await browser.close(); }
const failed = checks.filter(([ok]) => !ok).length;
console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-cursor-press', ok: !failed, checks: checks.length, failed })}`);
process.exitCode = failed ? 1 : 0;
