import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { launch, gotoApp, APP_URL, waitFor, realErrors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { inboxFixture, projectFiles, mountInboxFixture, openInbox } from './lib/inboxGuiFixture.mjs';
import { makeNote, serializeEvent } from '../src/lib/project/annotations.ts';
const h = harness('verify-scale-inbox'), temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-scale-')));
const { browser, page } = await launch({ width: 1400, height: 960 });
try {
  const f = await inboxFixture(path.join(temp, 'project'));
  await fs.writeFile(path.join(f.root, '.meta/feedback.ndjson'), Array.from({ length: 1000 }, (_, n) => serializeEvent({ ...makeNote(`Review ${n} #${n % 2 ? 'odd' : 'even'}`, { surface: 'figure', activeFigureId: 'review' }, 'human'), id: `scale-${n}` })).join(''));
  const files = (await projectFiles(f.root)).filter(([rel]) => !rel.endsWith('comments.json'));
  await gotoApp(page, { url: APP_URL + '?fixture=demo' }); await mountInboxFixture(page, '/inbox-scale', files);
  await waitFor(page, () => window.__fluxInbox?.items.length === 1000, null, { label: '1000 inbox items loaded' });
  await openInbox(page);
  const report = await page.evaluate(async () => {
    const list = document.querySelector('.inbox-list'), input = document.querySelector('.inbox-search');
    const counts = [], filters = [], scrolls = [];
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const count = () => { counts.push({ mounted: document.querySelectorAll('[data-inbox-row]').length, limit: Number(list.dataset.window) + Number(list.dataset.overscan) }); };
    for (let i = 0; i < 20; i++) {
      const t = performance.now(); input.value = i % 2 ? '#odd' : ''; input.dispatchEvent(new Event('input', { bubbles: true })); await paint(); filters.push(performance.now() - t); count();
      const s = performance.now(); list.scrollTop = list.scrollHeight * ((i % 5) / 5); await paint(); scrolls.push(performance.now() - s); count();
    }
    return { count: window.__fluxInbox.items.length, counts, filters, scrolls };
  });
  h.eq(report.count, 1000, 'scale fixture contains exactly 1000 items');
  h.ok(report.counts.every(c => c.mounted <= c.limit), `mounted rows stay within window + overscan (max ${Math.max(...report.counts.map(c => c.mounted))})`);
  h.ok(Math.max(...report.filters) <= 100, `filter-to-paint worst ${Math.max(...report.filters).toFixed(1)} ms ≤100 ms`);
  h.ok(Math.max(...report.scrolls) <= 100, `scroll-to-paint worst ${Math.max(...report.scrolls).toFixed(1)} ms ≤100 ms`);
  h.eq(await realErrors(page), [], 'clean scale console');
  await fs.mkdir('test-results', { recursive: true }); await fs.writeFile('test-results/scale-inbox.json', JSON.stringify(report, null, 2));
} finally { await browser.close(); await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
