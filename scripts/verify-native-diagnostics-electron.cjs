'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  (async () => {
    const { TestProcessScope } = await import('./lib/testProcess.mjs');
    const { isolatedEnv } = await import('./lib/verifyRuntime.mjs');
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-crash-native-')), scope = new TestProcessScope();
    const env = isolatedEnv(scratch); env.FLUX_RECOVERY_FIXTURE = scratch;
    env.FLUX_OUT = process.env.FLUX_OUT || path.resolve('test-results/native-crash');
    try {
      const entry = scope.spawn(require.resolve('electron/cli.js'), [__filename, ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])], { nodeArgs: [], env, deadlineMs: 30000 });
      const result = await scope.waitExit(entry); process.stdout.write(entry.stdout); process.stderr.write(entry.stderr);
      assert.equal(result.code, 0, 'real Electron renderer crash/recovery fixture must exit successfully');
    } finally { await scope.dispose(); await fs.rm(env.TMPDIR, { recursive: true, force: true }); await fs.rm(scratch, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const { createNativeDiagnostics } = require('../electron/nativeDiagnostics.cjs');
  const { attachRendererRecovery } = require('../electron/rendererRecovery.cjs');
  const scratch = process.env.FLUX_RECOVERY_FIXTURE;
  app.setPath('userData', path.join(scratch, 'native-profile'));
  process.stdin.resume(); process.stdin.once('end', () => app.exit(2));
  (async () => {
    await app.whenReady();
    const project = path.join(scratch, 'saved-project'), recovery = path.join(project, '.meta/document-recovery');
    await fs.mkdir(recovery, { recursive: true });
    const canonical = Buffer.from('{"schemaVersion":"0.1.0","id":"crash-project","figures":[]}\n'), unsaved = Buffer.from('recoverable manuscript draft Ω');
    await fs.writeFile(path.join(project, 'project.json'), canonical); await fs.writeFile(path.join(recovery, 'draft.qmd'), unsaved);
    const diagnostics = createNativeDiagnostics(path.join(scratch, 'diagnostics'));
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,<p>Crash fixture</p>');
    let prompts = 0, reopened, finished;
    const restarted = new Promise(resolve => { finished = resolve; });
    const dependencies = { diagnostics, getRoot: () => project,
      showMessageBox: async (_owner, options) => { prompts++; assert.equal(options.defaultId, options.cancelId); assert.match(options.detail, /last save may not have completed/); return { response: 0 }; },
      restart: async root => { assert.equal(root, project); reopened = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); await reopened.loadURL('data:text/html,<p>Reopened saved project</p>'); win.destroy(); finished(); } };
    const dispose = attachRendererRecovery(win, dependencies); assert.equal(attachRendererRecovery(win, dependencies), dispose);
    const gone = new Promise(resolve => win.webContents.once('render-process-gone', (_event, details) => resolve(details)));
    win.webContents.forcefullyCrashRenderer();
    const details = await gone; assert.notEqual(details.reason, 'clean-exit'); await restarted; await new Promise(resolve => setImmediate(resolve)); await diagnostics.flush();
    assert.equal(prompts, 1); assert.equal(win.listenerCount('unresponsive'), 0);
    assert.deepEqual(await fs.readFile(path.join(project, 'project.json')), canonical);
    assert.deepEqual(await fs.readFile(path.join(recovery, 'draft.qmd')), unsaved);
    const saved = await fs.readFile(diagnostics.file, 'utf8'), events = JSON.parse(saved).events;
    assert.ok(events.some(item => item.code === 'RENDERER_CRASHED' && item.outcome === 'failed'));
    assert.ok(events.some(item => item.outcome === 'reopened'));
    assert.ok(!saved.includes(project) && !saved.includes('manuscript') && !saved.includes('draft Ω'));
    assert.ok(reopened && !reopened.isDestroyed()); reopened.destroy();
    const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    await fs.mkdir(process.env.FLUX_OUT, { recursive: true });
    await fs.writeFile(path.join(process.env.FLUX_OUT, 'native-crash-evidence.json'), JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, reason: details.reason, prompts, canonicalSha256: hash(canonical), recoverySha256: hash(unsaved), events }, null, 2));
    console.log('Native crash PASS: real forcefullyCrashRenderer event, one recovery owner, explicit saved-project reopen, exact canonical/recovery bytes preserved, bounded redacted diagnostics.');
    app.exit(0);
  })().catch(error => { console.error(error); app.exit(1); });
}
