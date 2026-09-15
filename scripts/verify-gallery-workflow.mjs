// Isolated in-memory gallery workflow: tree navigation, expanded preview,
// playable movies, companion dissections, similar names and reusable batches.
// No native project, machine configuration or running app is accessed.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launch, gotoApp, clickMode, APP_URL, waitFor, realErrors } from './lib/driver.mjs';

const { browser, page } = await launch({ width: 1600, height: 1100 });
const ROOT = '/demo/myc-growth-paper';
const PLOTS = ROOT + '/plots';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const movie = readFileSync('scripts/fixtures/slide-video-clips/moving-box.mp4').toString('base64');
const poster = readFileSync('scripts/fixtures/slide-video-clips/poster.png').toString('base64');
const previewSelector = '[aria-label="Expanded plot preview"]';
let passed = 0;
let gallery;
const timings = [];
const popupErrors = [];
const check = (value, message) => { assert.ok(value, message); passed++; console.log('  ✓ ' + message); };
const frame = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function query(p, value) { await p.$eval('.importer .search-in', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value); await frame(p); }
const tile = async (p, name) => {
  const result = await p.evaluateHandle(name => [...document.querySelectorAll('.importer .list .row')].find(el => el.querySelector('.nm')?.textContent === name), name);
  assert.ok(result.asElement(), `gallery tile ${name}`); return result;
};
async function clickTile(p, name, modifier = false) {
  const el = await tile(p, name);
  // The pinned gallery adopts nodes created in its opener. Native mouse input
  // uses painted geometry, avoiding CDP content-quads' stale frame ownership.
  const point = await el.evaluate(node => { node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, visible: r.width > 0 && r.height > 0 && node.contains(node.ownerDocument.elementFromPoint(x, y)) }; });
  assert.ok(point.visible, `gallery tile ${name} has an unobstructed hit target`);
  if (modifier) await p.keyboard.down(mod); await p.mouse.click(point.x, point.y); if (modifier) await p.keyboard.up(mod);
  await el.dispose(); await frame(p);
}
async function popupClick(p, selector) {
  const point = await p.$eval(selector, node => { node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, visible: r.width > 0 && r.height > 0 && node.contains(node.ownerDocument.elementFromPoint(x, y)) }; });
  assert.ok(point.visible, `popup control ${selector} has an unobstructed hit target`);
  await p.mouse.click(point.x, point.y);
}
const treeRow = path => `[role="treeitem"][data-path="${path}"]`;
const canvas = () => page.evaluate(() => { const f = window.__flux; return { deck: JSON.stringify(f.slide.currentDeck()), history: JSON.stringify(f.fig.historyStats()), selected: [...f.get(f.fig.selection)], dirty: f.get(f.fig.dirty), count: f.slide.composedSlide(f.get(f.fig.activeFigureId)).elements.length }; });
const picks = p => p.$eval('.importer', el => el.querySelector('.pickpill')?.textContent?.trim() ?? '0 selected');
async function waitPreview(p) { await p.waitForSelector(previewSelector); await waitFor(p, () => { const el = document.querySelector('[data-gallery-preview-media]'); return !!el && (el.tagName === 'VIDEO' ? el.readyState >= 2 : !!el.querySelector('img')?.naturalWidth); }, null, { timeout: 15000, label: 'expanded media decoded' }); }
async function measure(p, label, action) { await p.evaluate(() => { window.__galleryInputPaint = null; document.addEventListener('pointerdown', () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__galleryInputPaint = performance.now() - start; })); }, { once: true, capture: true }); }); await action(); await waitFor(p, () => window.__galleryInputPaint !== null); timings.push({ label, ms: await p.evaluate(() => window.__galleryInputPaint) }); }
try {
  await gotoApp(page, { url: new URL('?fixture=demo', APP_URL).href, settle: 200 });
  check(await clickMode(page, 'Slide', { settle: 200 }), 'scratch Slide editor opens');
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay));
  await page.evaluate(async ({ root, movie, poster }) => {
    const svg = (color, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360" viewBox="0 0 600 360"><rect width="600" height="360" fill="#fffcf0"/><path d="M30 300 150 220 270 260 390 90 560 40" fill="none" stroke="${color}" stroke-width="9"/><text x="30" y="340" font-size="24" fill="#100f0f">${label}</text></svg>`;
    await window.fig.writeText(`${root}/plots/study/rate_NREM_subject01.svg`, svg('#205ea6', 'NREM subject 01'));
    await window.fig.writeText(`${root}/plots/study/rate_REM_subject02.svg`, svg('#24837b', 'REM subject 02'));
    await window.fig.writeText(`${root}/plots/elsewhere/rate_NREM_subject03.svg`, svg('#ad8301', 'NREM subject 03'));
    await window.fig.writeText(`${root}/plots/unrelated/control.svg`, svg('#a02f6f', 'Control'));
    await window.fig.writeText(`${root}/plots/study/deep/inside/nested.svg`, svg('#d14d41', 'Nested'));
    await window.fig.writeText(`${root}/plots/_dissections/study/rate_NREM_subject01/overview.svg`, svg('#879a39', 'Companion overview'));
    await window.fig.writeText(`${root}/plots/_dissections/study/rate_NREM_subject01/by_subject/subj01.svg`, svg('#ce5d97', 'Individual subject'));
    await window.fig.writeText(`${root}/plots/_dissections/study/rate_NREM_subject01/by_subject/subj01.fluxplot.json`, '{}');
    const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
    await window.fig.writeFile(`${root}/plots/_videos/moving-box.mp4`, bytes(movie));
    const movieUrl = 'data:video/mp4;base64,' + movie;
    window.__galleryVideoReleases = [];
    window.fig.videoPreview = async () => ({ poster: 'data:image/png;base64,' + poster, width: 160, height: 90, durationMs: 1200, hasAudio: true });
    window.fig.videoGalleryUrl = async () => movieUrl;
    window.fig.releaseVideoGalleryUrl = async url => { window.__galleryVideoReleases.push(url); };
    const readdir = window.fig.readdir.bind(window.fig);
    window.__galleryDirReads = [];
    window.fig.readdir = async path => { window.__galleryDirReads.push(path); return readdir(path); };
  }, { root: ROOT, movie, poster });
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyG'); await page.keyboard.up('Alt'); await page.waitForSelector('.importer');
  await page.waitForSelector(treeRow(PLOTS + '/study'));
  check(await page.$eval(treeRow(PLOTS + '/study'), el => el.getAttribute('aria-expanded') === 'false'), 'folder sidebar starts with nested folders collapsed');
  check(!(await page.$(treeRow(PLOTS + '/study/deep'))), 'collapsed descendants are absent from the tree');
  // Ordinary plots have an existing background search warmup. Reserved
  // companion trees are outside that cache, so this isolates sidebar IO.
  check(!(await page.evaluate(path => window.__galleryDirReads.includes(path), PLOTS + '/_dissections/study/rate_NREM_subject01/by_subject')), 'opening the sidebar does not scan unopened companion descendants');
  const folderBefore = await page.$eval('.path .cur', el => el.textContent);
  await measure(page, 'expand folder', () => page.click(treeRow(PLOTS + '/study') + ' .tree-disclosure'));
  await page.waitForSelector(treeRow(PLOTS + '/study/deep'));
  check(await page.$eval('.path .cur', el => el.textContent) === folderBefore, 'expansion reveals children without navigating the gallery');
  await page.click(treeRow(PLOTS + '/study/deep'));
  await waitFor(page, () => document.querySelector('.path .cur')?.textContent === 'study/deep');
  check(true, 'folder row navigation updates the gallery directory');
  await page.click(treeRow(PLOTS + '/study'));
  await waitFor(page, () => document.querySelector('.path .cur')?.textContent === 'study');
  await page.click(treeRow(PLOTS + '/study/rate_NREM_subject01.svg'));
  await waitFor(page, () => document.querySelector('.importer .list .row.sel .nm')?.textContent === 'rate_NREM_subject01');
  check(await picks(page) === '0 selected', 'tree file click highlights a file without adding a batch pick');
  check(await page.$eval('.importer .list .row.sel .nm', el => el.textContent) === 'rate_NREM_subject01', 'tree file selection follows the matching gallery tile');
  const beforeTreePreview = await canvas();
  await page.keyboard.down(mod); await page.click(treeRow(PLOTS + '/study/rate_NREM_subject01.svg')); await page.keyboard.up(mod); await waitPreview(page);
  check(await picks(page) === '0 selected' && JSON.stringify(await canvas()) === JSON.stringify(beforeTreePreview), 'Ctrl/Cmd-click from the tree previews without selecting or inserting');
  await page.click('[aria-label="Close preview"]'); await frame(page);
  await page.focus('.tree-viewport'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('F4'); await waitPreview(page);
  check(await page.$eval('[aria-label="Expanded plot preview"] h2', el => el.textContent) === 'rate_REM_subject02.svg' && await picks(page) === '0 selected', 'F4 previews the keyboard-focused tree file without picking it');
  await page.click('[aria-label="Close preview"]'); await frame(page);
  await page.click('[aria-label="Toggle folder sidebar"]'); await frame(page);
  check(!(await page.$('.gallery-tree')), 'folder sidebar collapses independently of the gallery');
  await page.$eval('[aria-label="Preview size"]', el => { el.value = '600'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); await frame(page);
  check(await page.$eval('[aria-label="Preview size"]', el => Number(el.value)) === 600, 'thumbnail size extends beyond the former 360 limit');
  check(await page.$eval('.importer .list .row .tile-preview', el => el.getBoundingClientRect().width) > 400, 'larger preview size changes the actual painted thumbnail geometry');
  await page.$eval('[aria-label="Preview size"]', el => { el.value = '300'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); await frame(page);
  await clickTile(page, 'rate_REM_subject02');
  const beforePreview = await canvas(), beforePicks = await picks(page);
  await clickTile(page, 'rate_NREM_subject01', true); await waitPreview(page);
  check(await picks(page) === beforePicks, 'Ctrl/Cmd-click opens preview without toggling existing picks');
  check(JSON.stringify(await canvas()) === JSON.stringify(beforePreview), 'opening preview leaves canvas content, selection and history unchanged');
  const full = await page.$eval(previewSelector, el => { const r = el.getBoundingClientRect(); return { w: r.width / innerWidth, h: r.height / innerHeight }; });
  check(full.w > .9 && full.h > .9, 'expanded preview uses the whole application window');
  const fitImageWidth = await page.$eval('[data-gallery-preview-media] img', el => Math.min(el.clientWidth / el.naturalWidth, el.clientHeight / el.naturalHeight) * el.naturalWidth);
  // The preview's own zoom control: the Slide toolbar underneath the fixed
  // preview also carries a "Zoom in" button (first in DOM order), and since the
  // 2026-09-15 surface redesign the preview's compact nav no longer happens to
  // overlap it — an unscoped selector would click the covered toolbar button.
  await page.click(previewSelector + ' [aria-label="Zoom in"]'); await frame(page);
  check(await page.$eval('[data-gallery-preview-media] img', el => el.getBoundingClientRect().width) > fitImageWidth * 1.1, 'Zoom in enlarges the fitted image instead of shrinking it');
  await page.click(previewSelector + ' [aria-label="Fit preview"]'); await frame(page);
  await page.screenshot({ path: 'test-results/gallery-expanded-preview.png' });
  await page.keyboard.press('KeyD');
  await waitFor(page, () => document.querySelector('[data-dissect-cell][data-name="overview.svg"] img')?.naturalWidth > 0);
  check(await page.$eval('[data-dissect-cell][data-name="overview.svg"] img', img => img.naturalWidth > 0), 'D reveals the current plot companion dissection images');
  const groupButton = await page.evaluateHandle(() => [...document.querySelectorAll('[aria-label="Dissection groups"] button')].find(el => el.textContent.trim().startsWith('by_subject')));
  assert.ok(groupButton.asElement(), 'by_subject dissection group'); await groupButton.click(); await groupButton.dispose(); await frame(page);
  await waitFor(page, () => document.querySelector('[data-dissect-cell][data-name="subj01.svg"] img')?.naturalWidth > 0); await frame(page);
  check(await page.$$eval('[data-dissect-cell]', els => els.length) === 1, 'dissection groups omit manifest sidecars');
  await page.click('[data-dissect-cell][data-name="subj01.svg"]', { count: 2 });
  await waitFor(page, () => document.querySelector('[data-dissect-detail] img')?.naturalWidth > 0);
  check(await page.$eval('[data-dissect-detail] img', img => img.naturalWidth > 0), 'a dissection image expands for inspection');
  await page.keyboard.press('Escape'); await frame(page);
  check(!!(await page.$(previewSelector)) && !(await page.$('[data-dissect-detail]')), 'Escape returns from dissection detail to its grid');
  await page.keyboard.press('KeyD'); await waitPreview(page);
  check(!!(await page.$('[data-gallery-preview-media] img')), 'D returns from dissections to the original plot');
  await page.click('[aria-label="Close preview"]'); await frame(page);
  check(await picks(page) === beforePicks && JSON.stringify(await canvas()) === JSON.stringify(beforePreview), 'closing preview preserves existing picks and the editor');
  // Related-name browsing changes the candidate set, never batch selection.
  await clickTile(page, 'rate_NREM_subject01', true); await waitPreview(page);
  await page.click('[aria-label="Find similar names"]'); await frame(page);
  await waitFor(page, () => document.querySelectorAll('.importer .list .row[data-kind="file"]').length >= 2);
  const related = await page.$$eval('.importer .list .row[data-kind="file"] .nm', els => els.map(el => el.textContent));
  check(related.includes('rate_NREM_subject01') && related.some(name => name !== 'rate_NREM_subject01') && !related.includes('control'), 'Similar names finds related files and excludes unrelated names');
  check(await picks(page) === beforePicks, 'Similar names does not change batch picks');
  await page.click('[aria-label="Clear similar names"]'); await frame(page);
  await page.click('.rootbtn'); await query(page, 'moving-box');
  await clickTile(page, 'moving-box', true); await waitPreview(page);
  check(await page.$eval('video[data-gallery-preview-media]', el => el.controls && el.videoWidth === 160 && el.videoHeight === 90), 'video preview has native playback controls and decoded movie dimensions');
  await page.$eval('video[data-gallery-preview-media]', el => el.play());
  await waitFor(page, () => document.querySelector('video[data-gallery-preview-media]')?.currentTime > .1);
  await page.$eval('video[data-gallery-preview-media]', el => { el.pause(); el.currentTime = .6; });
  await waitFor(page, () => { const video = document.querySelector('video[data-gallery-preview-media]'); return video && !video.seeking && video.paused && Math.abs(video.currentTime - .6) < .05; });
  check(true, 'video preview plays, pauses and seeks actual media');
  await page.screenshot({ path: 'test-results/gallery-video-preview.png' });
  await page.click('[aria-label="Close preview"]'); await frame(page);
  check(await page.evaluate(() => window.__galleryVideoReleases.length) === 1, 'closing a video preview releases its media capability');
  check(await picks(page) === beforePicks && JSON.stringify(await canvas()) === JSON.stringify(beforePreview), 'movie preview never inserts a video or changes existing picks');
  await query(page, 'rate_NREM_subject01'); await clickTile(page, 'rate_NREM_subject01');
  check(await picks(page) === '2 selected', 'a second plot joins the batch across navigation');
  const popupEvent = new Promise(resolve => page.once('popup', resolve)); await page.click('.pinbtn'); gallery = await popupEvent;
  gallery.on('pageerror', error => popupErrors.push(error.message)); gallery.on('console', message => { if (message.type() === 'error') popupErrors.push(message.text()); });
  await gallery.waitForSelector('.detached .importer'); await gallery.bringToFront();
  const beforeInsert = await canvas(); await popupClick(gallery, '.insbtn');
  await waitFor(page, count => window.__flux.slide.composedSlide(window.__flux.get(window.__flux.fig.activeFigureId)).elements.length === count + 2, beforeInsert.count);
  await waitFor(gallery, () => !document.querySelector('.pickpill'));
  check(!!(await gallery.$('.importer')) && await picks(gallery) === '0 selected', 'successful pinned insertion keeps the gallery open and clears its batch selection');
  // The inserted batch legitimately clears dirty when autosave completes.
  // Settle that write before testing that subsequent previews leave state alone.
  await waitFor(page, () => !window.__flux.get(window.__flux.fig.dirty), null, { label: 'inserted batch autosaved before preview' });
  // Preview ownership follows the moved subtree into its utility window.
  await query(gallery, 'rate_NREM_subject01'); await clickTile(gallery, 'rate_NREM_subject01', true); await waitPreview(gallery);
  check(await picks(gallery) === '0 selected', 'Ctrl/Cmd-preview also works in a pinned gallery without selecting an item');
  await gallery.keyboard.press('Escape'); await frame(gallery);
  check(!(await gallery.$(previewSelector)) && !!(await gallery.$('.importer')), 'Escape closes pinned preview and retains the gallery');
  const beforePinnedVideo = await canvas();
  await query(gallery, 'moving-box'); await clickTile(gallery, 'moving-box', true); await waitPreview(gallery);
  await gallery.$eval('video[data-gallery-preview-media]', el => el.play());
  await waitFor(gallery, () => document.querySelector('video[data-gallery-preview-media]')?.currentTime > .1);
  check(await gallery.$eval('video[data-gallery-preview-media]', el => el.controls && el.videoWidth === 160), 'pinned video preview decodes and plays within the utility window CSP');
  await popupClick(gallery, '[aria-label="Close preview"]'); await frame(gallery);
  check(await page.evaluate(() => window.__galleryVideoReleases.length) === 2 && await picks(gallery) === '0 selected' && JSON.stringify(await canvas()) === JSON.stringify(beforePinnedVideo), 'closing pinned video releases its media without changing editor state or picks');
  await query(gallery, 'rate_REM_subject02'); await clickTile(gallery, 'rate_REM_subject02'); await popupClick(gallery, '.insbtn');
  await waitFor(page, count => window.__flux.slide.composedSlide(window.__flux.get(window.__flux.fig.activeFigureId)).elements.length === count + 3, beforeInsert.count);
  await waitFor(gallery, () => !document.querySelector('.pickpill'));
  check(await picks(gallery) === '0 selected', 'the next pinned insertion contains only the newly picked file');
  await popupClick(gallery, '[aria-label="Toggle folder sidebar"]'); await frame(gallery);
  await gallery.waitForSelector(treeRow(PLOTS + '/study'));
  await popupClick(gallery, treeRow(PLOTS + '/study') + ' .tree-disclosure');
  await gallery.waitForSelector(treeRow(PLOTS + '/study/rate_NREM_subject01.svg'));
  await popupClick(gallery, treeRow(PLOTS + '/study/rate_NREM_subject01.svg')); await frame(gallery);
  await gallery.focus('.tree-viewport'); await gallery.keyboard.press('ArrowDown'); await frame(gallery);
  check(await gallery.$eval('.tree-row.focused', el => el.dataset.path) === PLOTS + '/study/rate_REM_subject02.svg', 'tree keyboard focus can move independently of the previous gallery highlight');
  await gallery.keyboard.down(mod); await gallery.keyboard.press('Enter'); await gallery.keyboard.up(mod);
  await waitFor(page, count => window.__flux.slide.composedSlide(window.__flux.get(window.__flux.fig.activeFigureId)).elements.length === count + 4, beforeInsert.count);
  check(await page.evaluate(() => window.__flux.slide.composedSlide(window.__flux.get(window.__flux.fig.activeFigureId)).elements.at(-1).source?.svgPath) === 'plots/study/rate_REM_subject02.svg', 'Ctrl/Cmd+Enter inserts the focused tree file rather than the previous highlight');
  await popupClick(gallery, '[aria-label="Toggle folder sidebar"]'); await frame(gallery);
  await popupClick(gallery, '.pinbtn'); await page.waitForSelector('.importer'); await page.bringToFront();
  await page.click('[aria-label="Toggle folder sidebar"]'); await frame(page);
  check(!!(await page.$('.gallery-tree')), 'collapsed sidebar can reopen after docking');
  check(timings.every(t => t.ms <= 100), 'folder expansion paints within the 100ms interaction budget');
  check(realErrors(page).length === 0 && popupErrors.length === 0, 'clean renderer consoles: ' + [...realErrors(page), ...popupErrors].join('; '));
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/gallery-workflow.png' });
  writeFileSync('test-results/gallery-workflow.json', JSON.stringify({ passed, timings }, null, 2) + '\n');
  console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-gallery-workflow', ok: true, checks: passed, failed: 0, timings })}`);
} catch (error) {
  console.error(error); console.error('Renderer errors', [...realErrors(page), ...popupErrors]); await (gallery && !gallery.isClosed() ? gallery : page).screenshot({ path: 'test-results/gallery-workflow-failure.png' }).catch(() => {});
  console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-gallery-workflow', ok: false, checks: passed + 1, failed: 1 })}`); process.exitCode = 1;
} finally { await browser.close(); }
