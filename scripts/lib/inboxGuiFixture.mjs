// One real flux-core fixture, mirrored byte-for-byte into the renderer's file bridge.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, writePresence } from './inboxFixture.ts';
import { appendAnnotationEvent, claimItem, replyItem, resolveItem, archiveItem } from '../../flux-core/annotations.ts';
import { rasterizeSvgToPng } from '../../flux-core/render.ts';
import { makeNote, makeWithdraw } from '../../src/lib/project/annotations.ts';
import { waitFor } from './driver.mjs';

export async function inboxFixture(root) {
  const f = await fixture(root);
  const heron = { id: 'inbox-heron', name: 'heron', client: 'codex' };
  await writePresence(root, heron);
  const deckFile = path.join(root, 'slides/talk/deck.json');
  const deck = JSON.parse(await fs.readFile(deckFile, 'utf8'));
  deck.slides[0].elements.push({ type: 'rect', id: 'el-1', name: 'Hero', x: 20, y: 20, width: 50, height: 50, rotation: 0, fill: '#205ea6', stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
  await fs.writeFile(deckFile, JSON.stringify(deck));
  const manifestFile = path.join(root, 'project.json'), manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.slides = [{ id: 'talk', path: 'slides/talk/deck.json', title: 'Review talk' }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const extra = {};
  for (const [name, context] of Object.entries({
    present: { surface: 'present', present: { deckId: 'talk', slideId: 's1', slideIndex: 0, beat: 1 } },
    library: { surface: 'library', targets: [{ kind: 'library-item', citekey: 'fixture2026' }] },
    home: { surface: 'home' }, unknown: null,
    archived: { surface: 'figure', activeFigureId: 'review' },
    withdrawn: { surface: 'figure', activeFigureId: 'review' },
  })) {
    const event = makeNote(`${name} review #fixture`, context, 'human');
    await appendAnnotationEvent(root, event); extra[name] = event.id;
  }
  await appendAnnotationEvent(root, makeWithdraw(extra.withdrawn, 'human'));
  await archiveItem(root, extra.archived, true);
  await claimItem(root, f.notes[0].id, {}, { session: heron });
  await replyItem(root, f.notes[0].id, 'Which units?', { needsInput: true }, { session: heron });
  await claimItem(root, f.notes[2].id, {}, { session: heron });
  await resolveItem(root, f.comments[1].id, { note: 'Fixed prose' }, { session: heron });
  // PNG fixtures are tiny; marks are already baked into composer images.
  const image = '.meta/feedback/inbox.png';
  await fs.mkdir(path.join(root, '.meta/feedback'), { recursive: true });
  await fs.writeFile(path.join(root, image), await rasterizeSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#fffcf0"/><path d="M10 10L50 50M30 50H50V30" stroke="#af3029" stroke-width="3" fill="none"/><circle cx="10" cy="10" r="8" fill="#af3029"/><text x="7" y="14" font-size="11" fill="white">1</text></svg>', 100));
  const picture = makeNote('Picture and anchors #picture', { surface: 'figure', activeFigureId: 'review', snapshot: {
    image, rect: { x: 0, y: 0, w: 100, h: 100 }, window: { w: 100, h: 100, dpr: 1 },
    marks: [{ n: 1, kind: 'arrow', points: [[5, 5], [50, 50]], targets: [{ kind: 'figure', figureId: 'review', name: 'Density' }] }],
  } }, 'human');
  await appendAnnotationEvent(root, picture);
  return { ...f, extra, heron, picture: picture.id };
}
export async function projectFiles(root, dir = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await projectFiles(root, rel));
    else if (!rel.startsWith('.meta/locks/')) result.push([rel, (await fs.readFile(path.join(root, rel))).toString('base64')]);
  }
  return result;
}
export async function mountInboxFixture(page, root, files) {
  await page.evaluate(async ({ root, files }) => {
    await window.__flux.shell.goHome();
    for (const [rel, bytes] of files) await window.fig.writeFile(`${root}/${rel}`, Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
    await window.__flux.shell.openProjectAt(root);
  }, { root, files });
  await waitFor(page, () => !!window.__fluxInbox?.items.length, null, { label: 'Inbox snapshot loaded' });
}
export async function openInbox(page) {
  await page.keyboard.down('Alt'); await page.keyboard.press('q'); await page.keyboard.up('Alt');
  await page.waitForSelector('.inbox-panel');
}
export async function closeInbox(page) {
  await page.click('.inbox-panel header [aria-label="Close Inbox"]');
  await waitFor(page, () => !document.querySelector('.inbox-panel'), null, { label: 'Inbox closed' });
}
export async function queryInbox(page, query) {
  await page.$eval('.inbox-search', (el, query) => { el.value = query; el.dispatchEvent(new Event('input', { bubbles: true })); }, query);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}
export const inboxRows = page => page.$$eval('[data-inbox-row]', els => els.map(e => [e.dataset.itemId, e.dataset.status]).sort((a, b) => a[0].localeCompare(b[0])));
export const detailAction = (page, name) => page.evaluate(name => {
  const button = [...document.querySelectorAll('.detail .actions button')].find(b => b.textContent.trim() === name);
  if (!button) throw new Error('Missing Inbox action: ' + name);
  button.click();
}, name);
