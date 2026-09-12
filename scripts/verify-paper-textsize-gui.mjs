// Paper TEXT SIZE — the rendered half (the pure half is verify-paper-textscale.ts).
//
// Everything here is measured as REAL computed type, because the whole point of
// the feature is that it is not a transform: the manuscript's glyphs get bigger
// AND its 72ch measure widens with them. A gate that only read back the store
// would pass with a broken `--ts-scale` selector (see tokens.css) or a CSS
// transform hack, so every assertion below reads getComputedStyle / geometry.
//
// Covered: the status-bar slider and its ± buttons, Ctrl+/− and Ctrl+0, the
// scope popover's checkboxes (all / single / combination, and the refusal to
// empty the scope), out-of-scope panels keeping their size, the status bar NOT
// resizing itself, persistence across a reload, and the ≤100ms budget (§6).
//   node scripts/verify-paper-textsize-gui.mjs
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';

const h = harness('verify-paper-textsize-gui');
const { browser, page } = await launch();
const KEY = 'flux.paper.textScale';

const paints = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const px = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? parseFloat(getComputedStyle(el).fontSize) : null;
}, sel);
const metrics = () => page.evaluate(() => {
  const cs = (s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el) : null;
  };
  const content = document.querySelector('.cm-content');
  return {
    editor: parseFloat(cs('.cm-content')?.fontSize ?? '0'),
    editorSrc: parseFloat(cs('.cm-line.cm-flux-embedsrc, .cm-line.cm-frontmatter')?.fontSize ?? '0'),
    sidebar: parseFloat(cs('.dp-item')?.fontSize ?? '0'),
    margin: parseFloat(cs('.dm-wrap .legend')?.fontSize ?? '0'),
    statusbar: parseFloat(cs('.statusbar')?.fontSize ?? '0'),
    // Layout evidence, not paint evidence: a CSS transform would leave both of
    // these frozen at their 100% values.
    lineH: document.querySelector('.cm-line')?.getBoundingClientRect().height ?? 0,
    contentH: content ? content.scrollHeight : 0,
    editorTransform: cs('.editor-col')?.transform ?? 'none',
    readout: document.querySelector('.statusbar .pct')?.textContent?.trim() ?? '',
    scaleVar: (cs('.editor-col')?.getPropertyValue('--ts-scale') ?? '').trim(),
    rowH: document.querySelector('.dp-item')?.getBoundingClientRect().height ?? 0,
  };
});
const chord = async (key) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await paints();
};
const enterPaper = async () => {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 900 });
  await clickMode(page, 'Paper');
  await waitFor(page, () => !!window.__fluxView);
  await waitFor(page, () => !!document.querySelector('.statusbar .zslider'));
  await paints();
};

try {
  await page.setViewport({ width: 1500, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // A fresh device: the default scope is the manuscript alone, every panel 100%.
  // Removed again before the persistence reload — otherwise the hook would wipe
  // the very state the reload is supposed to restore.
  const clearHook = await page.evaluateOnNewDocument(
    (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    KEY,
  );
  await enterPaper();

  // ---- baseline ------------------------------------------------------------
  // One long paragraph: its wrapped height is the cheapest honest proof that
  // the text RE-LAYS-OUT (a transform cannot change layout pixels).
  await page.evaluate(() => {
    const v = window.__fluxView;
    const para = 'Cortical firing rates across wake, NREM and REM were compared within subject and across recording sessions. '.repeat(14);
    // The front-matter block gives the mono source-line metrics something to
    // measure — they are a separate rule in the theme and scale independently.
    v.dispatch({
      changes: {
        from: 0,
        to: v.state.doc.length,
        insert: `---
title: Firing rates across wake, NREM and REM
---

# Results

${para}
`,
      },
    });
  });
  await paints();
  const base = await metrics();
  h.ok(Math.abs(base.editor - 17) < 0.5, `the manuscript starts at its authored 17px (${base.editor})`);
  h.ok(Math.abs(base.sidebar - 12.5) < 0.5, `the sidebar starts at its authored 12.5px (${base.sidebar})`);
  h.ok(Math.abs(base.statusbar - 11) < 0.5, `the status bar starts at 11px (${base.statusbar})`);
  h.ok(base.readout === '100%▾' || base.readout.startsWith('100%'), `the readout starts at 100% (${base.readout})`);
  h.ok(base.editorTransform === 'none', 'the editor column carries NO transform — this is real type, not a scaled canvas');

  // ---- the slider ----------------------------------------------------------
  // A real pointer drag along the track, the way the user moves it.
  const dragSlider = async (fraction) => {
    const box = await page.$eval('.statusbar .zslider', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y + r.height / 2, w: r.width };
    });
    await page.mouse.move(box.x + box.w * 0.5, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * fraction, box.y, { steps: 10 });
    await page.mouse.up();
    await paints();
  };
  await dragSlider(0.95);
  const big = await metrics();
  h.ok(big.editor > base.editor * 1.3, `dragging the slider right grows the manuscript (${base.editor} → ${big.editor}px)`);
  h.ok(big.lineH > base.lineH * 1.3, `a wrapped paragraph's LAYOUT height grows (${Math.round(base.lineH)} → ${Math.round(big.lineH)}px) — the text re-wraps, it is not scaled`);
  h.ok(big.contentH > base.contentH, `the document gets taller as it re-wraps (${base.contentH} → ${big.contentH}px)`);
  h.ok(big.editorSrc > base.editorSrc, 'the mono source-line metrics scale with the prose');
  h.ok(Math.abs(big.sidebar - base.sidebar) < 0.3, 'an out-of-scope panel (sidebar) keeps its size');
  h.ok(Math.abs(big.statusbar - base.statusbar) < 0.3, 'the status bar does not resize itself along with the manuscript');
  h.ok(big.editorTransform === 'none', 'still no transform at 200%+');
  await shot(page, 'paper-textsize-large');

  await dragSlider(0.05);
  const small = await metrics();
  h.ok(small.editor < base.editor * 0.8, `dragging left shrinks the manuscript (${small.editor}px)`);
  h.ok(small.lineH < base.lineH, 'and the paragraph re-wraps shorter when it shrinks');

  // ---- the ± buttons and the ladder ---------------------------------------
  await page.click('.statusbar .zoom .step.minus'); // −
  await paints();
  const afterMinus = await metrics();
  h.ok(afterMinus.editor <= small.editor, 'the − button steps down (or holds at the floor)');
  for (let i = 0; i < 12; i++) await page.click('.statusbar .zoom .step.plus');
  await paints();
  const ceiling = await metrics();
  h.ok(ceiling.readout.startsWith('250%'), `the + button ladders up to the 250% ceiling and stops (${ceiling.readout})`);

  // ---- the chords ----------------------------------------------------------
  await page.evaluate(() => window.__fluxView.focus());
  await chord('Digit0');
  let m = await metrics();
  h.ok(Math.abs(m.editor - 17) < 0.5 && m.readout.startsWith('100%'), `Ctrl+0 resets to 100% (${m.readout})`);

  await chord('Equal');
  m = await metrics();
  h.ok(m.readout.startsWith('110%') && m.editor > 17, `Ctrl+= steps one rung up (${m.readout}, ${m.editor}px)`);
  await chord('Minus');
  m = await metrics();
  h.ok(m.readout.startsWith('100%') && Math.abs(m.editor - 17) < 0.5, 'Ctrl+− steps back to exactly 100%');
  // Ctrl+Shift+= is the same physical key as Ctrl++ on a US layout.
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Equal');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await paints();
  m = await metrics();
  h.ok(m.readout.startsWith('110%'), `Ctrl+Shift+= (the "+" key) steps up too (${m.readout})`);
  await chord('Digit0');

  // The chords must not leak to the editor as text or to the browser as zoom.
  const doc = await page.evaluate(() => window.__fluxView.state.doc.toString());
  h.ok(!doc.includes('==') && !/\n-\n/.test(doc), 'the chords never type into the manuscript');

  // ---- the scope popover ---------------------------------------------------
  await page.click('.statusbar .pct');
  await waitFor(page, () => !!document.querySelector('.scope'));
  const boxes = await page.$$eval('.scope input[data-panel]', (els) => els.map((e) => e.dataset.panel));
  h.ok(boxes.join(',') === 'editor,sidebar,margin', `the popover offers one checkbox per panel (${boxes.join(',')})`);
  const checked = await page.$$eval('.scope input[data-panel]', (els) => els.map((e) => e.checked));
  h.ok(checked.join(',') === 'true,false,false', 'it opens showing the live scope (manuscript only, by default)');

  // A COMBINATION: manuscript + sidebar, margin left out.
  await page.click('.scope input[data-panel="sidebar"]');
  await paints();
  await page.keyboard.press('Escape');
  await waitFor(page, () => !document.querySelector('.scope'));
  await page.evaluate(() => window.__fluxView.focus());
  await chord('Equal');
  await chord('Equal');
  m = await metrics();
  h.ok(m.editor > 17 && m.sidebar > 12.5, `the chords now resize both scoped panels (editor ${m.editor}px, sidebar ${m.sidebar}px)`);
  h.ok(m.rowH > 30, `the sidebar's rows grow with its type instead of clipping it (${Math.round(m.rowH)}px)`);
  h.ok(Math.abs(m.statusbar - 11) < 0.3, 'the status bar still holds its own size');
  await shot(page, 'paper-textsize-scope');

  // ALL panels together.
  await page.click('.statusbar .pct');
  await waitFor(page, () => !!document.querySelector('.scope'));
  await page.click('.scope .scope-row.all input');
  await paints();
  const allOn = await page.$$eval('.scope input[data-panel]', (els) => els.every((e) => e.checked));
  h.ok(allOn, '"All panels together" checks all three');
  await page.keyboard.press('Escape');
  await waitFor(page, () => !document.querySelector('.scope'));
  await page.evaluate(() => window.__fluxView.focus());
  // The right margin needs a pane open before it has any type to measure.
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Alt');
  await waitFor(page, () => !!document.querySelector('.dm-wrap .legend'));
  await paints();
  const beforeAll = await metrics();
  await chord('Equal');
  const afterAll = await metrics();
  h.ok(
    afterAll.editor > beforeAll.editor &&
      afterAll.sidebar > beforeAll.sidebar &&
      afterAll.margin > beforeAll.margin,
    `all three panels move together (editor ${afterAll.editor}px, sidebar ${afterAll.sidebar}px, margin ${afterAll.margin}px)`,
  );
  await page.click('.statusbar .pct');
  await waitFor(page, () => !!document.querySelector('.scope'));

  // The scope can never be emptied — the last checkbox refuses to clear.
  await page.click('.scope input[data-panel="editor"]');
  await page.click('.scope input[data-panel="sidebar"]');
  await paints();
  await page.click('.scope input[data-panel="margin"]');
  await paints();
  const stillOn = await page.$eval('.scope input[data-panel="margin"]', (e) => e.checked);
  h.ok(stillOn, 'unchecking the last remaining panel is refused — the slider is never wired to nothing');

  // Esc closes it.
  await page.keyboard.press('Escape');
  await waitFor(page, () => !document.querySelector('.scope'));
  h.ok(true, 'Escape closes the scope popover');

  // ---- responsiveness (§6 instantaneous class) -----------------------------
  await page.evaluate(() => window.__fluxView.focus());
  const timings = [];
  for (let i = 0; i < 6; i++) {
    const t = await page.evaluate(() => performance.now());
    await page.keyboard.down('Control');
    await page.keyboard.press(i % 2 ? 'Minus' : 'Equal');
    await page.keyboard.up('Control');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    timings.push((await page.evaluate(() => performance.now())) - t);
  }
  const worst = Math.max(...timings);
  h.ok(worst <= 100, `a text-size chord paints within the instantaneous budget (worst ${worst.toFixed(1)}ms)`);

  // ---- persistence ---------------------------------------------------------
  await page.evaluate(() => window.__fluxView.focus());
  await chord('Digit0');
  await page.click('.statusbar .pct');
  await waitFor(page, () => !!document.querySelector('.scope'));
  await page.click('.scope .scope-row.all input');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__fluxView.focus());
  await chord('Equal');
  await chord('Equal');
  const before = await metrics();
  const stored = await page.evaluate((k) => localStorage.getItem(k), KEY);
  h.ok(!!stored && JSON.parse(stored).targets.margin === true, `the scope persists to ${KEY} (${stored})`);

  await page.removeScriptToEvaluateOnNewDocument(clearHook.identifier);
  await enterPaper();
  const after = await metrics();
  h.ok(Math.abs(after.editor - before.editor) < 0.5, `the manuscript size survives a reload (${before.editor} → ${after.editor}px)`);
  h.ok(Math.abs(after.sidebar - before.sidebar) < 0.5, 'the sidebar size survives a reload');
  await page.click('.statusbar .pct');
  await waitFor(page, () => !!document.querySelector('.scope'));
  const restored = await page.$$eval('.scope input[data-panel]', (els) => els.map((e) => e.checked).join(','));
  h.ok(restored === 'true,true,true', `the chosen scope survives a reload (${restored})`);
  await page.keyboard.press('Escape');

  // Leave the device clean for the next gate on this profile.
  await page.evaluate((k) => localStorage.removeItem(k), KEY);

  const errs = realErrors(page);
  h.ok(errs.length === 0, `console clean (${errs.length ? errs.join(' | ') : 'no errors'})`);
} catch (e) {
  h.ok(false, `threw: ${e && e.stack ? e.stack : e}`);
}
await h.done(() => browser.close());
