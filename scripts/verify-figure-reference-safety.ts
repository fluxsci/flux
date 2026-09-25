import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { referenceSyncIO } from '../flux-core/model';
import { createFolder } from '../flux-core/manuscript';
import { addNote, CONTEXT_PATHS } from '../flux-core/context';
import { applyReferenceReplacements } from '../src/lib/project/figureReferenceEdits';
import { referenceSyncBridgeIO } from '../src/lib/project/referenceSyncBridgeIO';
import { prepareFigureReferenceUpdate, commitFigureReferenceUpdate, recoverFigureReferenceUpdate, releaseFigureReferenceUpdate, registerLiveFigureReferenceDocument, type PreparedFigureReferenceUpdate, type ReferenceSyncIO } from '../src/lib/project/figureReferenceSync';
import { planFigSave } from '../src/lib/project/figfiles';
import { TestProcessScope } from './lib/testProcess.mjs';
import type { Project } from '../src/lib/types';
import type { FileBridge } from '../src/lib/project/types';
import { samePath } from "./lib/paths.mjs";
import { linkDir } from "./lib/symlinks.mjs";
const require = createRequire(import.meta.url), leases = require('../electron/operationLease.cjs');
const { createFileCore } = require('../electron/ipc/files.cjs'), { createGuiLeases } = require('../electron/guiLeases.cjs');
if (process.argv[2] === '--recover-child') {
  console.log('RECOVERY_READY');
  const root = process.argv[3]; await recoverFigureReferenceUpdate(root, referenceSyncIO(root));
  console.log('RECOVERY_DONE');
} else if (process.argv[2] === '--folder-child') {
  await createFolder(process.argv[3], 'paper', 'new-folder'); console.log('FOLDER_DONE');
} else if (process.argv[2] === '--note-child') {
  await addNote(process.argv[3], { text: 'New retained scientific note', title: 'After recovery' }); console.log('NOTE_DONE');
} else {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-reference-safety-'));
  // A hang guard for the self-spawned children, not a budget: each one re-imports this file
  // and flux-core through tsx before doing a lease-guarded write, and on GitHub's Windows
  // runner that took longer than the 3 s two of them used to get (killed at the deadline,
  // 2026-09-25) — a self-deadlock still shows as a kill, only later.
  const CHILD_DEADLINE_MS = 15_000;
  const children = new TestProcessScope(); let checks = 0, sequence = 0;
  const originalText = 'Scientific prose and @fig-study-a.\n', changedText = 'Scientific prose and @fig-study-b.\n';
  const journalRel = '.meta/figure-reference-update.json';
  const ok = (label: string) => { checks++; console.log('✓ ' + label); };
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
  const tick = () => new Promise<void>(r => setImmediate(r));
  const model: Project = { version: 2, name: 'Reference safety', canvases: [{ id: 'c', name: 'Canvas' }], figures: [{ id: 'f', canvasId: 'c', referenceKey: 'fig-study', name: 'Figure', x: 0, y: 0, width: 100, height: 80, elements: ['a','b'].map((text,i) => ({ id: 'panel-' + i, type: 'text', panelLabel: true, text, x: i*20, y: 0, width: 20, height: 20, rotation: 0, fontSize: 12, fontFamily: 'Arial', fontWeight: 400, fill: '#000', align: 'left' } as any)) }], assets: [], palette: [] };
  const after = structuredClone(model); (after.figures[0].elements[0] as any).text = 'b'; (after.figures[0].elements[1] as any).text = 'a';
  const nativeOwners: any[] = [];
  async function write(root: string, rel: string, text: string) { const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  async function fixture(engine: 'node'|'gui', documents = ['paper/main.qmd']) {
    const root = path.join(base, `${engine}-${++sequence}`), outside = path.join(base, 'other-' + sequence); await fs.mkdir(root); await fs.mkdir(outside);
    await write(root, 'project.json', JSON.stringify({ schemaVersion: '0.1.0', id: 'p', title: 'Fixture', manuscript: { path: documents[0] }, supplementary: documents.slice(1).map((p,i) => ({ id: 'supp-' + i, path: p })), references: { library: 'bib/library.bib' }, figures: [] }));
    const initial = planFigSave(model, null); for (const f of [...initial.canvases,...initial.captions,initial.index]) await write(root, f.path, f.text);
    for (const doc of documents) await write(root, doc, originalText);
    let io: ReferenceSyncIO;
    if (engine === 'node') io = referenceSyncIO(root);
    else {
      const handlers = new Map<string, Function>(), event = { sender: { id: sequence, isDestroyed: () => false } };
      createFileCore({ app: { getPath: () => base }, roots: () => [root,outside], projectRootFor: () => [root], setPendingRoot() {} }).registerHandlers({ handle: (channel: string, fn: Function) => handlers.set(channel,fn) });
      const native = createGuiLeases({ rootFor: () => root, fluxLibDir: () => outside }); nativeOwners.push(native);
      const bridge = Object.fromEntries(['exists','readText','writeText','mkdir','remove','readdir','projectAssetPath','fsyncDir'].map(name => [name, (...args: unknown[]) => handlers.get('fs:' + name)!(event,...args)])) as unknown as FileBridge;
      bridge.lockAcquire = (scope,name,expectedRoot) => native.acquire(event,{scope,name,expectedRoot});
      bridge.lockRelease = (scope,name,token) => native.release(event,{scope,name,token});
      bridge.lockCheck = (scope,name,token) => native.check(event,{scope,name,token});
      (globalThis as any).window = { fig: bridge }; io = referenceSyncBridgeIO(root,bridge);
    }
    const planned = planFigSave(after, null);
    const prepare = async () => { const p = await prepareFigureReferenceUpdate(root,model.figures,after.figures,io,{figureFiles:[...planned.canvases,planned.index]}); assert.ok(p); return p; };
    const publishFigures = async () => { for (const f of [...planned.canvases,planned.index]) await write(root,f.path,f.text); };
    return { root, outside, io, prepare, publishFigures, doc: path.join(root,documents[0]), journal: path.join(root,journalRel) };
  }
  async function releasePlan(root: string, plan: PreparedFigureReferenceUpdate) { await releaseFigureReferenceUpdate(root,plan); }
  try {
    for (const engine of ['node','gui'] as const) {
      {
        const f = await fixture(engine), p = await f.prepare(); await f.publishFigures();
        const ready = deferred(), hold = deferred(); let finished = false;
        const owner = f.io.withDocumentLease!(async () => { ready.resolve(); await hold.promise; }); await ready.promise;
        const pending = commitFigureReferenceUpdate(f.root,p,f.io).then(() => { finished = true; }); await tick();
        assert.equal(finished,false); assert.equal(await fs.readFile(f.doc,'utf8'),originalText); assert.ok(await leases.inspect(path.join(f.root,'.meta/locks'),'manuscript'));
        hold.resolve(); await owner; await pending; assert.equal(await fs.readFile(f.doc,'utf8'),changedText); ok(`${engine}: held manuscript operation queues reference publication and publishes correct bytes only after release`);
      }
      {
        const f = await fixture(engine), p = await f.prepare(); await f.publishFigures(); let documentReads = 0;
        const delayed: ReferenceSyncIO = { ...f.io, readText: async file => { const text = await f.io.readText(file); if (samePath(file,f.doc) && ++documentReads === 2) { const owned = await leases.inspect(path.join(f.root,'.meta/locks'),'manuscript'); assert.ok(owned); await leases.release(owned); } return text; } };
        await assert.rejects(commitFigureReferenceUpdate(f.root,p,delayed), /lease|owned/i);
        assert.equal(await fs.readFile(f.doc,'utf8'),originalText); assert.ok(await fs.readFile(f.journal,'utf8')); ok(`${engine}: ownership lost during final baseline read cannot publish document text`);
      }
      {
        const f = await fixture(engine), p = await f.prepare(); await f.publishFigures(); const entered = deferred(), resume = deferred(); let paused = false;
        const delayed: ReferenceSyncIO = { ...f.io, writeText: async (file,text) => { await f.io.writeText(file,text); if (samePath(file,f.journal) && !paused) { paused = true; entered.resolve(); await resume.promise; } } };
        const pending = commitFigureReferenceUpdate(f.root,p,delayed); const rejected = assert.rejects(pending,/conflicts with newer file edits/);
        await entered.promise; const external = 'New external scientific text @fig-study-a.\n'; await fs.writeFile(f.doc,external); resume.resolve(); await rejected;
        assert.equal(await fs.readFile(f.doc,'utf8'),external); assert.ok(await fs.readFile(f.journal,'utf8')); ok(`${engine}: external prose written during journal I/O survives with unresolved recovery evidence retained`);
      }
      {
        const f = await fixture(engine), p = await f.prepare(); await f.publishFigures(); let buffer = originalText, applies = 0, flushes = 0, released = false;
        const unregister = registerLiveFigureReferenceDocument({ root: f.root, path: 'paper/main.qmd', getText: () => buffer, applyReplacements: changes => { applies++; buffer = applyReferenceReplacements(buffer,changes); }, flush: async () => { flushes++; await f.io.withDocumentLease!(async () => { await f.io.writeText(f.doc,buffer); }); } });
        const delayed: ReferenceSyncIO = { ...f.io, writeText: async (file,text) => { await f.io.writeText(file,text); if (samePath(file,f.journal) && !released) { released = true; const owned = await leases.inspect(path.join(f.root,'.meta/locks'),'figure-references'); assert.ok(owned); await leases.release(owned); } } };
        try { await assert.rejects(commitFigureReferenceUpdate(f.root,p,delayed),/lease|owned/i); assert.equal(buffer,originalText); assert.equal(applies,0); assert.equal(flushes,0); assert.equal(await fs.readFile(f.doc,'utf8'),originalText); }
        finally { unregister(); }
        ok(`${engine}: reference lease lost during journal write cannot mutate or flush a live Paper draft`);
      }
      for (const recovery of [false,true]) {
        const f = await fixture(engine,['paper/first.qmd','paper/later/second.qmd']), p = await f.prepare(); await f.publishFigures();
        await fs.writeFile(path.join(f.outside,'second.qmd'),originalText); await fs.rm(path.join(f.root,'paper/later'),{recursive:true}); await linkDir(f.outside,path.join(f.root,'paper/later'));
        const journal = await fs.readFile(f.journal,'utf8'); if (recovery) await releasePlan(f.root,p);
        await assert.rejects(recovery ? recoverFigureReferenceUpdate(f.root,f.io) : commitFigureReferenceUpdate(f.root,p,f.io),/symlink escapes|escapes.*root/i);
        assert.equal(await fs.readFile(f.doc,'utf8'),originalText); assert.equal(await fs.readFile(path.join(f.outside,'second.qmd'),'utf8'),originalText); assert.equal(await fs.readFile(f.journal,'utf8'),journal); ok(`${engine}: ${recovery?'recovery':'commit'} preflights later escaping document before modifying earlier safe document`);
      }
      for (const kind of ['empty-figures','null-before','empty-mapping','forged-transform','duplicate-document','invalid-done']) {
        const f = await fixture(engine), p = await f.prepare(); await f.publishFigures(); await releasePlan(f.root,p);
        const corrupted = structuredClone(p) as any;
        if (kind === 'empty-figures') corrupted.figureFiles = [];
        if (kind === 'null-before') corrupted.before = [null];
        if (kind === 'empty-mapping') { corrupted.before = []; corrupted.after = []; corrupted.documents[0].beforeText = corrupted.documents[0].afterText = 'Unrelated replacement prose'; }
        if (kind === 'forged-transform') corrupted.documents[0].afterText = 'Unrelated replacement prose';
        if (kind === 'duplicate-document') corrupted.documents.push({...corrupted.documents[0]});
        if (kind === 'invalid-done') corrupted.documents[0].done = 'yes';
        const journal = JSON.stringify(corrupted); await fs.writeFile(f.journal,journal);
        await assert.rejects(recoverFigureReferenceUpdate(f.root,f.io)); assert.equal(await fs.readFile(f.doc,'utf8'),originalText); assert.equal(await fs.readFile(f.journal,'utf8'),journal); ok(`${engine}: ${kind} journal evidence refuses mutation and retains exact evidence`);
      }
    }
    {
      const f = await fixture('node'), p = await f.prepare(), journal = await fs.readFile(f.journal,'utf8');
      const child = children.spawn(fileURLToPath(import.meta.url),['--recover-child',f.root],{readyLine:'RECOVERY_READY',deadlineMs:CHILD_DEADLINE_MS}); await child.ready;
      await new Promise(resolve => setTimeout(resolve,100));
      assert.equal(await fs.readFile(f.journal,'utf8'),journal,'another process cannot clear the active writer prepared journal');
      await f.publishFigures(); await commitFigureReferenceUpdate(f.root,p,f.io);
      const exit = await child.closed; assert.equal(exit.code,0,String(child.stderr)); assert.equal(await fs.readFile(f.doc,'utf8'),changedText); ok('independent process cannot mistake active prepared journal for interrupted authoring');
    }
    {
      const f = await fixture('node'), p = await f.prepare(); await f.publishFigures(); await releasePlan(f.root,p);
      const child = children.spawn(fileURLToPath(import.meta.url),['--folder-child',f.root],{deadlineMs:CHILD_DEADLINE_MS});
      const exit = await child.closed; assert.equal(exit.code,0,String(child.stderr)); assert.equal(await fs.readFile(f.doc,'utf8'),changedText); assert.ok((await fs.stat(path.join(f.root,'paper/new-folder'))).isDirectory());
      ok('actual createFolder recovers pending reference text before taking its manuscript operation without self-deadlock');
    }
    {
      const f = await fixture('node'), p = await f.prepare(); await f.publishFigures(); await releasePlan(f.root,p);
      const child = children.spawn(fileURLToPath(import.meta.url),['--note-child',f.root],{deadlineMs:CHILD_DEADLINE_MS});
      const exit = await child.closed; assert.equal(exit.code,0,String(child.stderr)); assert.equal(await fs.readFile(f.doc,'utf8'),changedText);
      assert.match(await fs.readFile(path.join(f.root,CONTEXT_PATHS.notebook),'utf8'),/New retained scientific note/);
      ok('actual addNote recovers pending reference text before manuscript lease and preserves the newly authored note');
    }
    console.log(`FIGURE REFERENCE SAFETY: PASS (${checks} checks)`);
  } finally { await children.dispose(); await Promise.all(nativeOwners.map(owner => owner.releaseAll())); await fs.rm(base,{recursive:true,force:true}); }
}
