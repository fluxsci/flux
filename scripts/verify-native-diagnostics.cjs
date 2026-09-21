const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createNativeDiagnostics } = require('../electron/nativeDiagnostics.cjs');
const { attachRendererRecovery } = require('../electron/rendererRecovery.cjs');
const { createFileCore } = require('../electron/ipc/files.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-native-diagnostics-'));
  try {
    const logger = createNativeDiagnostics(path.join(scratch, 'diagnostics'), { maxRecords: 16, maxBytes: 4096 });
    for (let i = 0; i < 2000; i++) logger.record({ family: 'renderer', outcome: 'failed', code: 'RENDERER_CRASHED', message: 'password=SECRET manuscript text', url: 'https://example.invalid/?key=SECRET', path: '/private/SECRET' });
    await logger.flush(); let bytes = await fs.readFile(logger.file, 'utf8'), entries = JSON.parse(bytes).events;
    assert.ok(Buffer.byteLength(bytes) <= 4096 && entries.length <= 16); assert.ok(!bytes.includes('SECRET'));
    for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ['code','family','operationId','outcome','timestamp']);
    if (process.platform !== 'win32') assert.equal((await fs.stat(logger.file)).mode & 0o077, 0, 'diagnostics are owner-only');
    const obstruction = path.join(scratch, 'not-a-directory'); await fs.writeFile(obstruction, 'keep');
    const broken = createNativeDiagnostics(path.join(obstruction, 'logs')); broken.record({ family: 'native', code: 'CHILD_PROCESS_GONE', outcome: 'failed' });
    assert.equal(await broken.flush(), false); assert.equal(await fs.readFile(obstruction, 'utf8'), 'keep');

    const appRoot = path.join(scratch, 'project'); await fs.mkdir(appRoot); const handlers = new Map();
    const core = createFileCore({ app: { getPath: name => path.join(scratch, name) }, roots: () => [appRoot], diagnostics: logger });
    core.registerHandlers({ handle: (name, fn) => handlers.set(name, fn) }); const event = { sender: { id: 7 } };
    await assert.rejects(handlers.get('fs:readText')(event, '/outside/SECRET/password.json'), /refused path/);
    const canonical = path.join(appRoot, 'project.json'); const corrupt = '{"secret":"SELECTED MANUSCRIPT SECRET"'; await fs.writeFile(canonical, corrupt);
    assert.equal(await handlers.get('fs:readText')(event, canonical), corrupt);
    const rename = fs.rename;
    fs.rename = async (...args) => { if (args[1] === canonical) throw Object.assign(new Error('password SECRET'), { code: 'ENOSPC' }); return rename(...args); };
    try { await assert.rejects(handlers.get('fs:writeText')(event, canonical, 'replacement'), /SECRET/); } finally { fs.rename = rename; }
    assert.equal(await fs.readFile(canonical, 'utf8'), corrupt); assert.ok(!(await fs.readdir(appRoot)).some(name => name.includes('.tmp-')));
    await logger.flush(); bytes = await fs.readFile(logger.file, 'utf8'); entries = JSON.parse(bytes).events;
    for (const code of ['PATH_DENIED','CANONICAL_MALFORMED','ENOSPC']) assert.ok(entries.some(item => item.code === code));
    assert.ok(!bytes.includes('SECRET'));

    const win = new EventEmitter(); win.webContents = new EventEmitter(); win.isDestroyed = () => false;
    let currentRoot = appRoot, answer, calls = 0; const restarts = [], dialogs = [];
    const dependencies = { diagnostics: logger, getRoot: () => currentRoot,
      showMessageBox: (_win, options) => { calls++; dialogs.push(options); return new Promise(resolve => { answer = resolve; }); },
      restart: async root => restarts.push(root) };
    const dispose = attachRendererRecovery(win, dependencies); assert.equal(attachRendererRecovery(win, dependencies), dispose);
    assert.equal(win.listenerCount('unresponsive'), 1); assert.equal(win.webContents.listenerCount('render-process-gone'), 1);
    win.emit('unresponsive'); win.emit('unresponsive'); assert.equal(calls, 1); assert.equal(dialogs[0].defaultId, dialogs[0].cancelId);
    assert.match(dialogs[0].detail, /last save may not have completed/);
    win.emit('responsive'); answer({ response: 0 }); await tick(); assert.deepEqual(restarts, []);
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', url: 'SECRET' }); answer({ response: 0 }); await tick(); assert.deepEqual(restarts, [appRoot]);
    win.webContents.emit('did-finish-load'); win.emit('unresponsive'); currentRoot = 'another-root'; answer({ response: 0 }); await tick(); assert.equal(restarts.length, 1);
    win.emit('responsive'); win.webContents.emit('render-process-gone', {}, { reason: 'oom' }); answer({ response: 1 }); await tick(); assert.deepEqual(restarts, [appRoot, null]);
    win.webContents.emit('did-finish-load'); win.emit('unresponsive'); answer({ response: 2 }); await tick(); assert.equal(restarts.length, 2);
    win.emit('closed'); assert.equal(win.listenerCount('unresponsive'), 0); assert.equal(win.webContents.listenerCount('render-process-gone'), 0);
    await logger.flush(); bytes = await fs.readFile(logger.file, 'utf8'); assert.ok(!bytes.includes('SECRET')); assert.equal(await fs.readFile(canonical, 'utf8'), corrupt);
    console.log('Native diagnostics/recovery PASS: bounded redacted bytes, denied path/canonical syntax/save failure, old bytes retained, explicit restart/reopen/cancel, stale-root/closed-window refusal, no duplicate listeners.');
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
