// M4 drives the actual Animator. The only direct writes create fixtures.
import { mkdirSync } from 'node:fs';
import { waitFor, gotoApp, clickMode, APP_URL } from './driver.mjs';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shots = 'notes/flux_animation_v2/workers/out/shots/M4';
const paint = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const read = page => page.evaluate(() => {
  const f = window.__flux, s = f.slide.currentDeck().slides.find(s => s.id === f.get(f.fig.activeFigureId));
  return { tracks: s.beats.at(-1).tracks, history: f.fig.historyStats() };
});
async function shot(page, name, selector) {
  mkdirSync(shots, { recursive: true }); await paint(page);
  const target = selector ? await page.$(selector) : page;
  await target.screenshot({ path: `${shots}/${name}.png` });
}
async function select(page, ids) {
  for (let i = 0; i < ids.length; i++) {
    if (i) await page.keyboard.down(mod);
    await page.click(`.lane-row[data-track-id="${ids[i]}"] .track-label`);
    if (i) await page.keyboard.up(mod);
  }
  await paint(page);
}
async function field(page, selector, value) {
  await page.$eval(selector, (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await paint(page);
}
async function paste(page, text) {
  await page.$eval('.curve-popover', (e, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    e.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
  }, text); await paint(page);
}
export async function seedCurves(page) {
  const ids = await page.evaluate(() => {
    const f = window.__flux; let sid, ids = [];
    f.slide.commitDeckLive(d => sid = f.slideOps.addSlide(d, { name: 'Easing and springs', layout: 'blank' }).id);
    f.slide.selectSlide(sid);
    f.fig.commit(p => {
      const s = p.figures.find(s => s.id === sid);
      ['Smooth', 'Bouncy', 'Influence'].forEach((name, i) => s.elements.push({ id: `m4-${i}`, name, type: 'rect', x: 100 + i * 160, y: 150, width: 90, height: 70, rotation: 0, fill: ['#4385be', '#d0a215', '#3c9e78'][i], stroke: 'none', strokeWidth: 0, cornerRadius: 0 }));
    });
    f.slide.commitDeckLive(d => {
      const b = f.slideOps.addBeat(d, sid, { label: 'Timing curves' });
      for (let i = 0; i < 3; i++) ids.push(f.slideOps.appendAnimation(d, sid, b.id, { target: `m4-${i}`, preset: 'fade', duration: 600, ...(i === 0 ? { easing: 'smooth' } : i === 1 ? { curve: { kind: 'spring', bounce: .35 } } : { influence: { out: 33, in: 33 } }) }).id);
    });
    f.slide.activeBeat.set(1); return ids;
  });
  if (!await page.$('.animator')) await page.evaluate(() => [...document.querySelectorAll('.deckbar button')].find(b => /Animate/.test(b.textContent))?.click());
  await waitFor(page, () => !!document.querySelector('.animator'), null, { label: 'Animator open' });
  await page.evaluate(() => [...document.querySelectorAll('.inspector-tabs button')].find(b => b.textContent === 'Animation')?.click());
  await paint(page); await select(page, [ids[0]]); return ids;
}

export async function verifyCurveField(page, ok) {
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 600 });
  await clickMode(page, 'Slide');
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { label: 'curve deck loaded' });
  const ids = await seedCurves(page);
  const exists = !!await page.$('.curve-trigger');
  ok(exists, 'M4: collapsed curve field replaces the easing select');
  if (!exists) return;
  await shot(page, '01-collapsed', '.props');
  await waitFor(page, () => !document.querySelector('.toast'), null, { timeout: 10000, label: 'prior command toasts dismissed' });
  await shot(page, '07-sparklines', '.beatrail');
  ok(await page.$$eval('.curve-sparkline path:not(.arrival-tick)', ps => ps.length === 3 && ps.every(p => p.getAttribute('d').split('L').length === 24)), 'M4: every non-media bar has one 24-sample sparkline');
  const before = await read(page);
  const latency = await page.evaluate(() => {
    document.querySelector('.animator').focus();
    const start = performance.now();
    document.querySelector('.animator').dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
    return new Promise(r => requestAnimationFrame(() => r({ ms: performance.now() - start, open: !!document.querySelector('.curve-popover') })));
  });
  ok(latency.open && latency.ms <= 100, `M4: e opens the real popover within 100 ms (${latency.ms.toFixed(1)} ms)`);
  await shot(page, '02-tiles', '.curve-popover');
  await page.focus('.curve-group[data-group="Spring"] .group-name'); await page.keyboard.press('3'); await paint(page);
  ok((await read(page)).tracks[0].curve?.bounce === .35, 'M4: digit 3 chooses Bouncy in the focused Spring group');
  await page.hover('[data-curve="snappy"]');
  await waitFor(page, () => Number(document.querySelector('.curve-tile circle')?.getAttribute('cx')) === 1, null, { label: 'one preview pass finishes' });
  ok(await page.$eval('.curve-tile circle', e => e.getAttribute('cx') === '1'), 'M4: tile hover runs one preview pass to the exact endpoint');

  await page.click('[data-curve="bouncy"]'); await page.mouse.move(5, 5); await paint(page);
  let state = await read(page);
  const expected = await page.evaluate(async () => {
    const { springStats, resolveCurve } = await import('/src/lib/slide/curves.ts');
    return 600 * resolveCurve({ easing: 'smooth' }).arrival / springStats(.35, 0).arrival90;
  });
  ok(state.tracks[0].curve?.kind === 'spring' && state.tracks[0].curve.bounce === .35 && !state.tracks[0].easing && !state.tracks[0].influence, 'M4: Bouncy writes the catalog spec and clears both competing curve fields');
  ok(Math.abs(state.tracks[0].duration - expected) < 1e-8, `M4: keep arrival rescales duration from springStats (${state.tracks[0].duration} / ${expected})`);
  ok(await page.$eval(`.lane-row[data-track-id="${ids[0]}"] .curve-sparkline`, e => {
    const d = e.querySelector('path').getAttribute('d'); return Math.min(...[...d.matchAll(/[ML][^,]+,([-\d.]+)/g)].map(m => +m[1])) < 0 && !!e.querySelector('.arrival-tick');
  }), 'M4: spring sparkline overshoots the bar top and has an arrival tick');
  await shot(page, '03-spring', '.curve-popover'); await shot(page, '05-spacing', '.spacing-block');
  await field(page, '[aria-label="Bounce"]', .5);
  await page.keyboard.press('Escape'); await paint(page); state = await read(page);
  ok(JSON.stringify(state.tracks) === JSON.stringify(before.tracks) && state.history.past === before.history.past, 'M4: Escape restores the opening curve and duration without an undo entry');
  await select(page, [ids[0], ids[1]]);
  ok(await page.$eval('.curve-name', e => e.textContent === 'Mixed'), 'M4: different selected curves show Mixed');
  await shot(page, '06-mixed', '.props');
  const mixedBefore = await read(page);
  await page.click('.curve-trigger'); await page.click('[data-curve="bouncy"]'); await page.mouse.move(5, 5); await page.keyboard.press('Enter'); await paint(page);
  state = await read(page);
  ok(state.tracks.slice(0, 2).every(t => t.curve?.bounce === .35) && state.history.past === mixedBefore.history.past + 1, 'M4: one preset applies to a mixed selection in one undo');
  ok(Math.abs(state.tracks[0].duration - expected) < 1e-8 && state.tracks[1].duration === 600, 'M4: keep arrival rescales each selected track independently');
  await select(page, [ids[0]]); await page.click('.curve-trigger');
  await paste(page, 'cubic-bezier(.2,1.4,.4,1)'); state = await read(page);
  ok(JSON.stringify(state.tracks[0].curve) === JSON.stringify({ kind: 'bezier', p: [.2, 1.4, .4, 1] }) && !!await page.$('.overshoot-readout'), 'M4: pasted CSS bezier stores its spec and shows overshoot');
  await shot(page, '08-bezier', '.curve-popover');
  const valid = JSON.stringify(state.tracks); await paste(page, 'not a curve');
  ok(!!await page.$('.curve-error') && JSON.stringify((await read(page)).tracks) === valid, 'M4: invalid paste shows an inline error and writes nothing');
  await shot(page, '09-paste-error', '.curve-popover');
  await page.keyboard.press('Escape'); await select(page, [ids[2]]); await page.click('.curve-trigger');
  ok(await page.$eval('.curve-graph', e => e.dataset.kind === 'influence'), 'M4: legacy influence opens the same graph with horizontal handles');
  await shot(page, '04-influence', '.curve-popover');
  const handle = await page.$eval('[data-handle="0"]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x + 10, handle.y - 25); await page.mouse.up(); await paint(page);
  state = await read(page);
  ok(state.tracks[2].curve?.kind === 'bezier' && state.tracks[2].curve.p[1] > .1 && !state.tracks[2].influence && !state.tracks[2].easing, 'M4: dragging influence off its horizontal rail converts through the curve op');
  const p0 = state.tracks[2].curve.p[0]; await page.$eval('[data-handle="0"]', e => e.focus()); await page.keyboard.press('ArrowRight'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift'); await paint(page);
  ok(Math.abs((await read(page)).tracks[2].curve.p[0] - p0 - .11) < 1e-8, 'M4: handle arrows nudge .01, Shift arrows .1');
  const oldPath = await page.$eval('.graph-path', e => e.getAttribute('d'));
  const redraw = await page.evaluate(() => {
    const input = document.querySelector('[aria-label="y1"]'), start = performance.now(); input.value = '.4'; input.dispatchEvent(new Event('input', { bubbles: true }));
    return new Promise(r => requestAnimationFrame(() => r({ ms: performance.now() - start, path: document.querySelector('.graph-path').getAttribute('d') })));
  });
  ok(redraw.path !== oldPath && redraw.ms <= 100, `M4: handle edit redraws in the next frame (${redraw.ms.toFixed(1)} ms)`);
  await page.keyboard.press('Escape'); await page.mouse.move(5, 5);
  await page.keyboard.press('e'); await paint(page);
  ok(!!await page.$('.curve-popover'), 'M4: e reopens after Escape returned focus to the curve field');
  const unchanged = (await read(page)).tracks[2].duration;
  await page.click('.keep input'); await page.click('[data-curve="playful"]'); await page.mouse.move(5, 5); await paint(page);
  ok((await read(page)).tracks[2].duration === unchanged, 'M4: disabling Keep arrival preserves duration');
  await page.keyboard.press('Escape');

  await waitFor(page, () => !document.querySelector('.deckbar .dirty.on'), null, { label: 'curve edits autosaved before idle census' });
  await waitFor(page, () => document.getAnimations().every(a => a.playState !== 'running'), null, { label: 'finite hover and save transitions settled' });
  const idle = await page.evaluate(async () => {
    let calls = 0; const original = window.requestAnimationFrame;
    window.requestAnimationFrame = fn => { calls++; return original.call(window, fn); };
    let animated = 0; const targets = new Set(); const sample = setInterval(() => { const running = document.getAnimations().filter(a => a.playState === 'running'); animated += running.length; for (const a of running) targets.add(a.effect?.target?.className + ':' + a.constructor.name); }, 20);
    await new Promise(r => setTimeout(r, 500)); clearInterval(sample); window.requestAnimationFrame = original;
    return { calls, animated, targets: [...targets], closed: !document.querySelector('.curve-popover') };
  });
  ok(idle.closed && idle.calls === 0 && idle.animated === 0, `M4: closed at rest, no animation or rAF in 500 ms (${JSON.stringify(idle)})`);
}

export async function verifyCurveSurface(page, ok) {
  // A fresh document avoids borrowing the preceding Figure fixture's dirty assets.
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 600 });
  await clickMode(page, 'Slide');
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { label: 'surface deck' });
  await seedCurves(page);
  if (!await page.$('.curve-trigger')) { ok(false, 'M4: curve popover surface exists'); return; }
  await page.click('.curve-trigger'); await page.mouse.move(5, 5);
  const style = await page.$eval('.curve-popover', e => {
    const s = getComputedStyle(e), input = getComputedStyle(e.querySelector('input[type=number]') ?? e.querySelector('input'));
    const r = e.getBoundingClientRect();
    return { font: s.fontFamily, ui: s.getPropertyValue('--font-ui').trim(), value: input.fontFamily, mono: s.getPropertyValue('--font-mono').trim(), radius: s.borderRadius, border: s.borderTopWidth, bg: s.backgroundImage, blur: s.backdropFilter, inView: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  });
  ok(style.font === style.ui && style.value === style.mono && style.radius === '2px' && style.border === '1px' && style.bg === 'none' && style.blur === 'none' && style.inView, `M4: curve popover follows the font/radius/hairline/flat/on-screen surface contract (${JSON.stringify(style)})`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await page.hover('[data-curve="bouncy"]'); await paint(page);
  ok(!await page.$('.curve-tile circle'), 'M4: reduced motion keeps tile previews static');
  await page.keyboard.press('Escape'); await page.emulateMediaFeatures([]);
}

export async function verifyCopyTiming(page, ok) {
  const ids = await seedCurves(page);
  const menu = async (id, label) => {
    await page.click(`.lane-row[data-track-id="${id}"] .trk`, { button: 'right' });
    const handle = await page.evaluateHandle(label => [...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent === label), label);
    if (!handle.asElement()) { await page.keyboard.press('Escape'); return false; }
    await handle.click(); await handle.dispose(); await paint(page); return true;
  };
  await page.evaluate(id => {
    const f = window.__flux, sid = f.get(f.fig.activeFigureId);
    f.slide.commitDeckLive(d => {
      const t = d.slides.find(s => s.id === sid).beats[1].tracks.find(t => t.id === id);
      t.stagger = { perMs: 35, from: 'end' };
    });
  }, ids[1]);
  await select(page, [ids[1]]);
  const copied = await menu(ids[1], 'Copy timing'); ok(copied, 'M4: context menu exposes Copy timing'); if (!copied) return;
  await select(page, [ids[0], ids[2]]); const before = await read(page);
  ok(await menu(ids[0], 'Paste timing'), 'M4: context menu exposes Paste timing');
  const after = await read(page);
  ok([0, 2].every(i => after.tracks[i].duration === 600 && after.tracks[i].curve?.bounce === .35 && after.tracks[i].stagger?.perMs === 35 && after.tracks[i].stagger.from === 'end' && !after.tracks[i].easing && !after.tracks[i].influence) && after.history.past === before.history.past + 1, 'M4: Paste timing copies duration, curve, stagger across the selection in one undo');
  await page.keyboard.down(mod); await page.keyboard.press('KeyZ'); await page.keyboard.up(mod); await paint(page);
  ok(JSON.stringify((await read(page)).tracks) === JSON.stringify(before.tracks), 'M4: one Undo restores every pasted timing field');
  await shot(page, '10-copy-timing');
}
