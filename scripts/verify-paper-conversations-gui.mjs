// Conversations about a paper are kept WITH the paper and shown on it (2026-11-19, owner: "AI
// conversations about papers should be global … tied to the highlight"). This gate drives the
// Reader: Annotate and Ask on real selected text hang a conversation on a highlight of those
// words; an agent's answer in the project ledger reaches the paper; a thread from ANOTHER project
// shows with where it came from; Remove is undoable and final; deleting a highlight never deletes
// what was said about it. The model and the agent side: verify-paper-conversations.ts.
//   Run: node scripts/run-verifies.mjs --tier ui --only paper-conversations-gui
import { readFileSync } from 'node:fs';
import { launch, gotoApp, clickMode, realErrors, waitFor, APP_URL } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { NOTE, chord, openAnnotation, fillNote, ledger } from './lib/annotationFixture.mjs';
import { makeReply } from '../src/lib/project/annotations.ts';

const h = harness('verify-paper-conversations-gui'), { browser, page } = await launch({ width: 1500, height: 1000 });
const KEY = 'talk2026', ASK = '[data-ask-surface] textarea';
const talk = () => page.evaluate(async key => (await import('/src/lib/references/conversationsBridge.ts')).loadConversations(key), KEY);
const marks = () => page.evaluate(async key => (await (await import('/src/lib/references/annotationsBridge.ts')).loadAnnotations(key)).annotations, KEY);
const settle = () => page.evaluate(async () => { await (await import('/src/shell/inbox/inboxStore.ts')).refreshInbox(); await (await import('/src/shell/inbox/paperConversations.ts')).settlePaperMirror(); });
const closed = sel => waitFor(page, s => !document.querySelector(s), sel, { label: `${sel} closed` });
const add = async text => { await fillNote(page, text); await page.keyboard.press('Enter'); await closed('[data-annotation-surface]'); };
const tab = name => page.evaluate(name => [...document.querySelectorAll('.side.annots .stab')].find(b => b.textContent.trim() === name)?.click(), name);
const rail = () => page.evaluate(() => ({
  count: document.querySelector('.side.annots .talktab')?.dataset.n ?? '',
  on: document.querySelector('.side.annots .stab.on')?.textContent.trim(),
  rows: [...document.querySelectorAll('.side.annots .talk')].map(li => ({ id: li.dataset.thread, origin: li.dataset.origin, status: li.dataset.status, open: li.classList.contains('open'), rail: !!li.querySelector('.swatch'),
    q: li.querySelector('.tq')?.textContent, from: li.querySelector('.tfrom')?.textContent ?? '', meta: li.querySelector('.tmeta')?.textContent.trim(), quote: li.querySelector('.tquote')?.textContent ?? '',
    said: [...li.querySelectorAll('article')].map(a => [a.classList.contains('agent') ? 'agent' : 'human', a.querySelector('.agent-prose')?.textContent.trim()]), acts: [...li.querySelectorAll('.tbtn')].map(b => b.textContent.trim()) })),
}));
/** Select the n-th long line of the page with a real DOM selection, as the hand would. */
const select = n => page.evaluate(n => {
  const span = [...document.querySelectorAll('.pdf-page .textLayer span')].filter(s => s.textContent.trim().length > 10)[n], range = document.createRange();
  range.selectNodeContents(span);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange')); span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return span.textContent.trim();
}, n);
const emit = event => page.evaluate(event => { const id = window.fig._runnerCalls.filter(c => c.method === 'start').at(-1).options.runId; window.fig._emitRunnerEvent(id, event); }, event);
const agentSays = async (id, text) => page.evaluate(async ({ e }) => {
  const f = window.__flux, path = f.get(f.shell.currentProject).path + '/.meta/feedback.ndjson';
  await window.fig.feedbackAppend(path, JSON.stringify(e) + '\n');
  window.fig._emitFsChange({ subsystem: 'feedback', path });
}, { e: makeReply(id, { kind: 'agent', name: 'heron', client: 'claude' }, text, 'claude') });
const clickHighlight = async id => {
  const at = await page.evaluate(id => { const b = document.querySelector(`.annot-hl[data-id="${id}"]`).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, id);
  await page.mouse.click(at.x, at.y); await page.waitForSelector('.hl-pop');
};
const ask = async (question, answer) => {
  await page.waitForSelector(ASK); await page.evaluate(() => { window.fig._runnerCalls.length = 0; });
  await page.keyboard.type(question); await page.keyboard.press('Enter');
  await waitFor(page, () => window.fig._runnerCalls.some(c => c.method === 'send'), null, { label: 'Ask sent' });
  const sent = await page.evaluate(() => window.fig._runnerCalls.find(c => c.method === 'send').options.text);
  await emit({ type: 'message', messageId: 'm' + question.length, text: answer }); await emit({ type: 'status', state: 'idle' });
  return sent;
};

try {
  await gotoApp(page, { url: APP_URL + '?fixture=demo' });
  await clickMode(page, 'Reader');
  await waitFor(page, () => !!window.__fluxOpenReader && !!window.__fluxSeedReaderItem, null, { label: 'Reader hooks' });
  await page.evaluate((key, b64) => { window.__fluxSeedReaderItem(key, b64, { version: 1, annotations: [] }); window.__fluxOpenReader(key); }, KEY, readFileSync('scripts/fixtures/reader-sample.pdf').toString('base64'));
  await page.waitForSelector('.pdf-page .textLayer span');
  h.eq((await rail()).count, '', 'a paper nobody has asked about shows no count on its Flux AI tab');
  await tab('Flux AI');
  h.ok(await page.$eval('.side.annots .smsg', e => /stays with this paper, in every project/.test(e.textContent)), 'the empty Flux AI list says what it is for');
  await tab('Highlights');

  // ── Annotate selected words: the conversation hangs on a highlight of exactly those words ──
  h.section('Annotate on a selection');
  const passage = await select(0);
  await page.waitForSelector('[aria-label="Annotate this passage"]'); await page.click('[aria-label="Annotate this passage"]'); await page.waitForSelector(NOTE);
  h.eq((await marks()).length, 0, 'opening the composer makes no highlight (nothing was sent yet)');
  await add('What does this line **mean**?');
  await settle();
  const note = (await ledger(page)).findLast(e => e.kind === 'note');
  const target = note.context.targets.find(t => t.kind === 'passage');
  h.ok(target.quote === passage && typeof target.prefix === 'string' && typeof target.suffix === 'string', 'the passage target carries the selection and the words around it');
  let file = await talk(), [thread] = file.threads, highlights = await marks();
  h.eq([file.threads.length, thread.id, thread.origin.kind, thread.status], [1, note.id, 'item', 'open'], 'the Inbox item is on the paper, under its own id');
  h.ok(!!thread.origin.project?.title && !!thread.origin.root, 'it says which project it was asked in');
  h.eq([highlights.length, highlights[0]?.anchor.quote, highlights[0]?.color, thread.highlightId], [1, passage, 'blue', highlights[0]?.id], 'a highlight of exactly those words was made for it, in Flux AI blue');
  await waitFor(page, id => document.querySelectorAll(`.annot-talk[data-id="${id}"]`).length > 0, thread.highlightId, { label: 'underline on the page' });
  h.ok(await page.evaluate(id => { const hl = document.querySelectorAll(`.annot-hl[data-id="${id}"]`).length, rule = document.querySelectorAll(`.annot-talk[data-id="${id}"]`); return hl === rule.length && [...rule].every(r => r.parentElement.classList.contains('talk-layer') && getComputedStyle(r.parentElement).mixBlendMode === 'normal' && r.getBoundingClientRect().height >= 1); }, thread.highlightId), 'the highlight is underlined on the page, a rule per line, outside the multiplying layer');
  h.eq((await rail()).count, '1', 'the Flux AI tab counts it');
  h.eq(await page.$eval('.annlist .atalk', e => e.textContent.trim()), 'What does this line **mean**?', 'its highlight row says what was asked');

  // ── The popover lists it; the rail is where it is read ──
  h.section('reading it');
  await clickHighlight(thread.highlightId);
  h.eq(await page.$$eval('.hl-pop .pconv', els => els.map(e => [e.querySelector('.pcq').textContent, e.querySelector('.pcs')?.textContent])), [['What does this line **mean**?', 'Waiting for an agent']], 'the highlight popover has one line for it, with its state');
  h.ok(await page.evaluate(() => { const p = document.querySelector('.hl-pop').getBoundingClientRect(); return p.top >= 0 && p.bottom <= innerHeight && p.left >= 0 && p.right <= innerWidth; }), 'the popover is still on screen with the extra line');
  await page.click('.hl-pop .pconv'); await closed('.hl-pop');
  let r = await rail();
  h.eq([r.on, r.rows.length, r.rows[0].open, r.rows[0].quote, r.rows[0].rail], ['Flux AI', 1, true, passage, true], 'the line opens the conversation in the rail: its passage, on its highlight colour');
  h.eq(r.rows[0].acts, ['Open in Inbox', 'Remove'], 'a thread of the open project is answered in its Inbox');
  h.eq(r.rows[0].from, '', '…and does not name the project you are in');
  await page.evaluate(() => [...document.querySelectorAll('.side.annots .talk .tbtn')].find(b => b.textContent.trim() === 'Open in Inbox').click());
  await page.waitForSelector('.inbox-panel');
  h.eq(await page.evaluate(() => document.querySelector('[data-inbox-row].selected')?.dataset.itemId), note.id, 'Open in Inbox lands on the item');
  await page.click('.inbox-panel header [aria-label="Close Inbox"]'); await closed('.inbox-panel');

  // ── An agent answers in the project ledger: the paper follows ──
  h.section('an answer reaches the paper');
  await agentSays(note.id, 'It means **cells gate** the flow.');
  await waitFor(page, () => document.querySelector('.side.annots .talk article.agent strong')?.textContent === 'cells gate', null, { label: 'answer in the rail' });
  await settle();
  r = await rail();
  h.eq(r.rows[0].said, [['agent', 'It means cells gate the flow.']], 'the open thread shows the agent\'s answer, as formatted text');
  h.eq((await talk()).threads[0].messages.map(m => [m.kind, m.author]), [['human', 'You'], ['agent', 'heron']], 'the paper\'s file has the exchange');
  const writes = await page.evaluate(async () => {
    const { conversationsRev } = await import('/src/lib/references/conversationsBridge.ts'), { refreshInbox } = await import('/src/shell/inbox/inboxStore.ts'), { settlePaperMirror } = await import('/src/shell/inbox/paperConversations.ts');
    let n = -1; const off = conversationsRev.subscribe(() => { n++; });
    for (let i = 0; i < 4; i++) { await refreshInbox(); await settlePaperMirror(); }
    off(); return n;
  });
  h.eq(writes, 0, 'refreshing an unchanged Inbox writes nothing to the paper');

  // ── The same words, asked about in ANOTHER project ──
  h.section('from another project');
  await page.evaluate(async ({ key, id }) => {
    const { saveThreads } = await import('/src/lib/references/conversationsBridge.ts');
    await saveThreads(key, [{ id: 'fbother1', origin: { kind: 'item', project: { id: 'proj_other', title: 'Sleep paper' }, root: '/elsewhere/sleep' }, page: 1, highlightId: id, status: 'resolved',
      createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:05:00.000Z', anchor: { quote: 'ignored when the link holds' },
      messages: [{ kind: 'human', author: 'You', text: 'Is this the main claim?', ts: '2026-10-01T10:00:00.000Z' }, { kind: 'agent', author: 'wren', text: 'Yes: it is the thesis.', ts: '2026-10-01T10:05:00.000Z' }] }]);
  }, { key: KEY, id: thread.highlightId });
  await waitFor(page, () => document.querySelectorAll('.side.annots .talk').length === 2, null, { label: 'second thread listed' });
  r = await rail();
  const other = r.rows.find(x => x.id === 'fbother1');
  h.eq([r.count, other.from, other.rail, other.open], ['2', 'Sleep paper', true, false], 'a thread from another project is listed on the same highlight, named by its project, closed until asked for');
  h.ok(/1 reply/.test(other.meta), `its row says it was answered (${other.meta})`);
  h.eq((await marks()).length, 1, 'no second highlight was made for it');
  await tab('Highlights'); await page.waitForSelector('.annlist .atn');
  h.eq(await page.$eval('.annlist .atn', e => e.textContent), '+1', 'the highlight row counts the other conversation');
  await tab('Flux AI'); await page.waitForSelector('.side.annots .talk');
  await page.click('.side.annots .talk[data-thread="fbother1"] .thead');
  r = await rail();
  h.eq(r.rows.filter(x => x.open).map(x => x.id), ['fbother1'], 'opening one closes the other: one conversation is read at a time');
  h.eq(r.rows.find(x => x.id === 'fbother1').acts, ['Ask a follow-up', 'Remove'], 'another project\'s thread is continued by asking again, here');

  // ── Ask: saved with the paper once answered, on the same highlight, knowing what was said ──
  h.section('Ask');
  await page.evaluate(() => [...document.querySelectorAll('.side.annots .talk.open .tbtn')].find(b => b.textContent.trim() === 'Ask a follow-up').click());
  const sent = await ask('And the evidence?', 'Two experiments.');
  h.ok(sent.includes('earlierConversations') && sent.includes('Yes: it is the thesis.') && sent.includes('It means **cells gate** the flow.'), 'the follow-up carries what was already asked and answered about these words');
  await waitFor(page, () => document.querySelectorAll('.side.annots .talk').length === 3, null, { label: 'Ask listed' });
  file = await talk();
  const asked = file.threads.find(t => t.origin.kind === 'ask');
  h.eq([asked.highlightId, asked.status, asked.messages.map(m => m.text).join(' | ')], [thread.highlightId, 'resolved', 'And the evidence? | Two experiments.'], 'an answered Ask is kept with the paper, on the same highlight');
  h.eq((await ledger(page)).filter(e => e.kind === 'note').length, 1, '…without becoming an Inbox item');
  h.eq((await marks()).length, 1, '…and without another highlight');
  await page.keyboard.type('In which figure?'); await page.keyboard.press('Enter');
  await waitFor(page, () => window.fig._runnerCalls.filter(c => c.method === 'send').length === 2, null, { label: 'second question sent' });
  await emit({ type: 'message', messageId: 'm2', text: 'Figure 2.' }); await emit({ type: 'status', state: 'idle' });
  await page.waitForFunction(async key => (await (await import('/src/lib/references/conversationsBridge.ts')).loadConversations(key)).threads.some(t => t.messages.length === 4), {}, KEY);
  h.eq((await talk()).threads.filter(t => t.origin.kind === 'ask').length, 1, 'a second question in the same Ask grows the same thread');
  await page.keyboard.press('Escape'); await closed('[data-ask-surface]');

  // Ask on fresh words, then Keep: the Inbox item takes over; the paper has it once.
  await tab('Highlights');
  const second = await select(1);
  await page.waitForSelector('[aria-label="Ask about this passage"]'); await page.click('[aria-label="Ask about this passage"]');
  await ask('What is this?', 'A definition.');
  await page.waitForFunction(async key => (await (await import('/src/lib/references/conversationsBridge.ts')).loadConversations(key)).threads.some(t => t.messages[0]?.text === 'What is this?'), {}, KEY);
  highlights = await marks();
  h.eq([highlights.length, highlights.at(-1).anchor.quote, highlights.at(-1).color], [2, second, 'blue'], 'an Ask about fresh words makes their highlight when the answer arrives');
  await page.$$eval('.ask-panel button', els => els.find(e => e.textContent === 'Keep').click()); await closed('[data-ask-surface]');
  await settle();
  await page.waitForFunction(async key => (await (await import('/src/lib/references/conversationsBridge.ts')).loadConversations(key)).threads.filter(t => t.messages[0]?.text === 'What is this?').every(t => t.origin.kind === 'item'), {}, KEY);
  const keptThreads = (await talk()).threads.filter(t => t.messages[0]?.text === 'What is this?');
  h.eq([keptThreads.length, keptThreads[0]?.origin.kind, keptThreads[0]?.highlightId, (await marks()).length], [1, 'item', highlights.at(-1).id, 2], 'Keep moves it to the Inbox: the paper shows it once, on the same highlight');

  // ── Remove: undoable, then final ──
  h.section('Remove');
  await tab('Flux AI');
  const before = (await rail()).rows.length;
  await page.click(`.side.annots .talk[data-thread="${note.id}"] .thead`);
  await page.evaluate(() => [...document.querySelectorAll('.side.annots .talk.open .tbtn')].find(b => b.textContent.trim() === 'Remove').click());
  await waitFor(page, n => document.querySelectorAll('.side.annots .talk').length === n - 1, before, { label: 'thread removed' });
  await page.evaluate(() => [...document.querySelectorAll('.toasts .toast button')].find(b => b.textContent.trim() === 'Undo').click());
  await waitFor(page, n => document.querySelectorAll('.side.annots .talk').length === n, before, { label: 'thread restored' });
  h.ok(!(await talk()).removed, 'Undo puts the conversation back and forgets the removal');
  await page.click(`.side.annots .talk[data-thread="${note.id}"] .thead`);
  await page.evaluate(() => [...document.querySelectorAll('.side.annots .talk.open .tbtn')].find(b => b.textContent.trim() === 'Remove').click());
  await waitFor(page, n => document.querySelectorAll('.side.annots .talk').length === n - 1, before, { label: 'thread removed again' });
  await agentSays(note.id, 'One more thing.'); await settle(); await settle();
  file = await talk();
  h.ok(!file.threads.some(t => t.id === note.id) && !!file.removed?.[note.id], 'a removed Inbox thread stays off the paper when its item changes again');
  h.ok((await ledger(page)).some(e => e.kind === 'note' && e.id === note.id), '…while the item itself is untouched in the project');

  // ── Deleting a highlight never deletes what was said about it ──
  h.section('deleting the highlight');
  await tab('Highlights');
  const kept = (await talk()).threads.filter(t => t.highlightId === thread.highlightId).map(t => t.id).sort();
  await page.evaluate(id => document.querySelector(`.annlist .ann[data-id="${id}"] .del`).click(), thread.highlightId);
  await waitFor(page, id => !document.querySelector(`.annot-hl[data-id="${id}"]`), thread.highlightId, { label: 'highlight gone' });
  await settle();
  h.eq([(await marks()).length, await page.evaluate(id => document.querySelectorAll(`.annot-talk[data-id="${id}"]`).length, thread.highlightId)], [1, 0], 'the highlight and its rule are gone, and no mirror makes it again');
  h.eq((await talk()).threads.filter(t => t.highlightId === thread.highlightId).map(t => t.id).sort(), kept, 'its conversations are still with the paper');
  await tab('Flux AI');
  r = await rail();
  h.ok(kept.every(id => r.rows.find(x => x.id === id)?.rail === false), 'they are listed without a highlight rail, on their page');

  // ── The Annotate chord on selected words carries their anchor too ──
  h.section('the chord, and a note on the page');
  const third = await select(2);
  await openAnnotation(page); await add('Chord on a selection');
  await settle();
  const chordTarget = (await ledger(page)).findLast(e => e.kind === 'note').context.targets.find(t => t.kind === 'passage');
  h.ok(chordTarget.quote === third && typeof chordTarget.prefix === 'string' && typeof chordTarget.suffix === 'string', 'Ctrl+Shift+M on selected words carries the selection and the words around it');
  const chordThread = (await talk()).threads.find(t => t.messages[0]?.text === 'Chord on a selection');
  highlights = await marks();
  h.eq([highlights.length, highlights.find(a => a.id === chordThread?.highlightId)?.anchor.quote], [2, third], '…so its conversation hangs on a highlight of those words as well');
  // A note with no words selected hangs on the page.
  await page.evaluate(() => window.getSelection().removeAllRanges()); await page.mouse.click(700, 500);
  await page.keyboard.press('Escape');
  await openAnnotation(page); await add('Explain this page');
  await settle();
  const pageNote = (await talk()).threads.find(t => t.messages[0]?.text === 'Explain this page');
  h.ok(!!pageNote && !pageNote.highlightId && pageNote.page >= 1 && (await marks()).length === 2, 'a note made while reading, with no words selected, is kept on its page and makes no highlight');

  h.eq(realErrors(page), [], 'console clean');
} catch (e) { h.fail(`threw: ${e.stack ?? e}`); }
await h.done(() => browser.close());
