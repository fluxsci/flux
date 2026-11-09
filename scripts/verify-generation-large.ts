// A source/asset generation larger than one bridge message.
//
// The journal held every file's before AND after content inline; two regenerated plots with 34 MB
// manifests made a 258 MB journal and the native bridge refused it (256 MiB per IPC message), so the
// owner's project failed its source update on every open (2026-11-09). This gate holds the contract
// that replaced it: no single write is larger than one file's content, small transactions keep the
// version-2 journal bytes, and a crash at ANY step of a large commit recovers to the exact prior
// state with no out-of-line value left behind.
import assert from 'node:assert/strict';
import { harness } from './lib/harness.mjs';
import {
  commitTextGeneration, recoverTextGeneration, bytesToBase64,
  TEXT_GENERATION_JOURNAL as JOURNAL, TEXT_GENERATION_INLINE_LIMIT, TEXT_GENERATION_BLOB_MIN, textGenerationBlob,
  type GenerationWrite, type TextGenerationIO,
} from '../src/lib/project/textGeneration';

const h = harness('verify-generation-large');
const ok = (cond: unknown, label: string) => { h.ok(!!cond, label); };
const big = (ch: string, n: number) => ch.repeat(n);
const MB = 1024 * 1024;

class Crash extends Error {}
/** An in-memory project whose bridge refuses any message above `cap` characters (the IPC limit, scaled). */
function disk(initial: Record<string, string>, cap: number) {
  const files = new Map(Object.entries(initial));
  const log: string[] = [];
  let ops = 0, crashAt = Infinity, largest = 0;
  const step = (name: string) => { if (++ops > crashAt) throw new Crash('crashed'); log.push(name); };
  const io: TextGenerationIO = {
    read: async rel => files.get(rel) ?? null,
    write: async (rel, text) => { step('write:' + rel); if (text.length > cap) throw new Error(`IPC payload exceeds limit: ${rel} ${text.length}`); largest = Math.max(largest, text.length); files.set(rel, text); },
    remove: async rel => { step('remove:' + rel); files.delete(rel); },
    fsyncDir: async () => {},
    readBytes: async rel => { const v = files.get(rel); return v == null ? null : Uint8Array.from(v, c => c.charCodeAt(0)); },
    writeBytes: async (rel, bytes) => { step('write:' + rel); if (bytes.length > cap) throw new Error(`IPC payload exceeds limit: ${rel}`); largest = Math.max(largest, bytes.length); let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); files.set(rel, text); },
  };
  return { files, io, log, crashAfter: (n: number) => { ops = 0; crashAt = n; }, ops: () => ops, largest: () => largest, state: () => JSON.stringify([...files].filter(([k]) => !k.startsWith('.meta/')).sort()) };
}

// --- A: a small transaction keeps the version-2 journal, byte for byte --------------------------
{
  const d = disk({ 'fig/index.json': 'old index', 'fig/canvases/c.json': 'old canvas' }, 64 * MB);
  let journal = '';
  const write = d.io.write;
  d.io.write = async (rel, text) => { if (rel === JOURNAL) journal = text; await write(rel, text); };
  await commitTextGeneration(d.io, new Map<string, GenerationWrite>([['fig/canvases/c.json', 'new canvas'], ['fig/index.json', 'new index'], ['fig/assets/a.png', { base64: bytesToBase64(Uint8Array.of(1, 2, 3)) }]]));
  ok(journal === JSON.stringify({ version: 2, files: [
    { path: 'fig/canvases/c.json', before: 'old canvas', after: 'new canvas' },
    { path: 'fig/index.json', before: 'old index', after: 'new index' },
    { path: 'fig/assets/a.png', before: null, after: bytesToBase64(Uint8Array.of(1, 2, 3)), encoding: 'base64' },
  ] }), 'A: a small transaction writes the version-2 journal unchanged');
  ok(d.files.get('fig/index.json') === 'new index' && !d.files.has(JOURNAL), 'A: committed and the journal is gone');
  ok(!d.log.some(l => l.includes('.blob.')), 'A: a small transaction never writes an out-of-line value');
}

// --- B: the owner's case — two regenerated plots, large manifests ---------------------------------
const before: Record<string, string> = {
  'fig/assets/p1.svg': '<svg>one</svg>', 'fig/assets/p1.fluxplot.json': big('a', 3 * MB),
  'fig/assets/p2.svg': '<svg>two</svg>', 'fig/assets/p2.fluxplot.json': big('b', 3 * MB),
  'fig/index.json': 'old index',
};
const writes = () => new Map<string, GenerationWrite>([
  ['fig/assets/p1.svg', '<svg>ONE</svg>'], ['fig/assets/p1.fluxplot.json', big('A', 3 * MB)],
  ['fig/assets/p2.svg', '<svg>TWO</svg>'], ['fig/assets/p2.fluxplot.json', big('B', 3 * MB)],
  ['fig/assets/p3.png', { base64: bytesToBase64(new Uint8Array(400 * 1024).fill(7)) }], // a new binary asset, also large
  ['fig/index.json', 'new index'],
]);
const after = (() => { const o: Record<string, string> = { ...before }; for (const [k, v] of writes()) o[k] = typeof v === 'string' ? v : '\x07'.repeat(400 * 1024); return JSON.stringify(Object.entries(o).sort()); })();
const CAP = 3 * MB + 1024; // one file fits; the inline journal (12 MB+) would not
ok(2 * 4 * 3 * MB > TEXT_GENERATION_INLINE_LIMIT && 3 * MB > TEXT_GENERATION_BLOB_MIN, 'B: the fixture is past the inline limit');
let totalOps = 0;
{
  const d = disk(before, CAP);
  await commitTextGeneration(d.io, writes());
  totalOps = d.ops();
  ok(d.state() === after, 'B: a generation larger than one message commits');
  ok(d.largest() <= 3 * MB, `B: no single write exceeds one file's content (largest ${d.largest()})`);
  ok(![...d.files.keys()].some(k => k.startsWith('.meta/')), 'B: the journal and every out-of-line value are removed after the commit');
  const journalAt = d.log.indexOf('write:' + JOURNAL), blobWrites = d.log.map((l, i) => l.includes('.blob.') && l.startsWith('write:') ? i : -1).filter(i => i >= 0);
  ok(blobWrites.length === 5 && blobWrites.every(i => i < journalAt), 'B: every out-of-line value is written before the journal that names it');
  ok(d.log.findIndex(l => l === 'write:fig/assets/p1.svg') > journalAt, 'B: no target is touched before the journal exists');
}
// The inline design fails on the same disk — the regression this gate exists for.
{
  const d = disk(before, CAP);
  const inline = JSON.stringify({ version: 2, files: [...writes()].map(([path, v]) => ({ path, before: before[path] ?? null, after: typeof v === 'string' ? v : v!.base64 })) });
  await assert.rejects(d.io.write(JOURNAL, inline), /exceeds limit/); ok(true, 'B: the inline journal is refused by the same bridge (the defect)');
}

// --- C: a crash after ANY step recovers to exactly the prior state, or the commit had finished ----
{
  let recovered = 0, finished = 0;
  for (let n = 0; n <= totalOps; n++) {
    const d = disk(before, CAP);
    d.crashAfter(n);
    let crashed = false;
    try { await commitTextGeneration(d.io, writes()); } catch (e) { crashed = true; assert.ok(e instanceof Crash || (e instanceof AggregateError && e.errors.some(x => x instanceof Crash)) || /crashed/.test(String(e)), `C: step ${n} failed for another reason: ${String(e)}`); }
    d.crashAfter(Infinity); // the next process
    await recoverTextGeneration(d.io);
    const state = d.state();
    assert.ok(state === JSON.stringify(Object.entries(before).sort()) || state === after, `C: crash after step ${n} left a mixed state`);
    assert.ok(!d.files.has(JOURNAL), `C: crash after step ${n} left a journal after recovery`);
    if (state === after) finished++; else recovered++;
    assert.ok(crashed || state === after, `C: step ${n} neither crashed nor finished`);
    // Whatever a crash left out of line, the next large commit clears it.
    await commitTextGeneration(d.io, writes());
    assert.ok(d.state() === after && ![...d.files.keys()].some(k => k.startsWith('.meta/')), `C: after a crash at step ${n} the next commit leaves a leftover: ${[...d.files.keys()].filter(k => k.startsWith('.meta/')).join(', ')}`);
  }
  ok(recovered > 10 && finished >= 1, `C: ${recovered} crash points recovered to the prior state, ${finished} had finished (of ${totalOps + 1})`);
}

// --- D: an untrusted version-3 journal is rejected whole ---------------------------------------
{
  const journal = (files: unknown, blobs: unknown = 1) => JSON.stringify({ version: 3, blobs, files });
  const cases: [string, string][] = [
    ['a value naming a blob past the count', journal([{ path: 'fig/index.json', before: 'old index', after: { blob: 1 } }])],
    ['two values naming one blob', journal([{ path: 'fig/index.json', before: { blob: 0 }, after: { blob: 0 } }])],
    ['a negative blob', journal([{ path: 'fig/index.json', before: 'old index', after: { blob: -1 } }])],
    ['a non-integer count', journal([{ path: 'fig/index.json', before: 'old index', after: 'x' }], 'many')],
    ['a blob reference in a version-2 journal', JSON.stringify({ version: 2, files: [{ path: 'fig/index.json', before: 'old index', after: { blob: 0 } }] })],
  ];
  for (const [label, text] of cases) {
    const d = disk({ 'fig/index.json': 'old index', [JOURNAL]: text, [textGenerationBlob(0)]: 'new index' }, CAP);
    await assert.rejects(recoverTextGeneration(d.io), /Invalid source recovery/, label);
    ok(d.files.get('fig/index.json') === 'old index' && d.files.has(JOURNAL), `D: ${label} — nothing restored, journal retained`);
  }
  // A named value that is gone: nothing is guessed, the journal stays for a human.
  const d = disk({ 'fig/index.json': 'something else', [JOURNAL]: journal([{ path: 'fig/index.json', before: 'old index', after: { blob: 0 } }]) }, CAP);
  await assert.rejects(recoverTextGeneration(d.io), /recovery content is missing/);
  ok(d.files.get('fig/index.json') === 'something else' && d.files.has(JOURNAL), 'D: a missing out-of-line value retains the journal and the file');
  // An edit made outside the transaction is never overwritten.
  const e = disk({ 'fig/index.json': 'edited by someone else', [JOURNAL]: journal([{ path: 'fig/index.json', before: 'old index', after: { blob: 0 } }]), [textGenerationBlob(0)]: 'new index' }, CAP);
  await assert.rejects(recoverTextGeneration(e.io), /changed outside transaction/);
  ok(e.files.get('fig/index.json') === 'edited by someone else', 'D: recovery never overwrites an unexpected edit');
}

await h.done();
