// Built renderer + real native capture/indicator. Run through run-verifies.
'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
async function main() {
  const { harness } = await import('./lib/harness.mjs');
  const { TestProcessScope } = await import('./lib/testProcess.mjs');
  const h = harness('verify-live-view-electron'), scope = new TestProcessScope();
  const repo = path.resolve(__dirname, '..');
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flux-live-view-')));
  const root = path.join(scratch, 'project'), artifacts = path.join(repo, 'test-results');
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'),
    APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1', PROBE_SCRATCH: scratch, PROBE_PROJECT: root };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.mkdir(env.HOME, { recursive: true }); await fs.mkdir(artifacts, { recursive: true });
    const seed = scope.spawn(path.join(__dirname, 'lib/figurePolishFixture.ts'), [root], { env, cwd: repo });
    await scope.waitExit(seed);
    if (seed.code !== 0) throw Error(seed.stdout + seed.stderr);
    const args = [root];
    if (process.platform === 'linux') args.push('--ozone-platform=x11');
    const probe = scope.spawn(path.join(__dirname, 'lib/liveViewProbeEntry.cjs'), args, {
      command: require('electron'), nodeArgs: [], env, cwd: repo, deadlineMs: 100000,
    });
    await scope.waitExit(probe);
    await fs.writeFile(path.join(artifacts, 'live-view-native.log'), probe.stdout + probe.stderr);
    if (probe.code !== 0 || !probe.stdout.includes('PROBE result=PASS')) throw Error((probe.stdout + probe.stderr).slice(-12000));
    const report = JSON.parse(await fs.readFile(path.join(artifacts, 'live-view-native.json'), 'utf8'));
    for (const check of report) h.ok(check.ok, check.label);
  } catch (e) { h.fail(String(e.stack || e)); }
  finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }); }
  await h.done();
}
void main();
