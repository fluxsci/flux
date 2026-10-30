'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
async function main(h) {
  const repo = path.resolve(__dirname, '..'), scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-figure-native-'));
  const { TestProcessScope } = await import('./lib/testProcess.mjs'), scope = new TestProcessScope();
  const output = process.env.FLUX_OUT || path.join(repo, 'test-results/figure-raster-native');
  const project = path.join(scratch, 'project'), second = path.join(scratch, 'second');
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache'), APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1', FLUX_FIGURE_RASTER_WORKERS: '1', PROBE_SCRATCH: scratch, PROBE_APP_ROOT: process.env.FLUX_FIGURE_RASTER_BASE || repo, PROBE_PROJECT: project, PROBE_SECOND_PROJECT: second, PROBE_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  try {
    await fs.mkdir(env.HOME, { recursive: true }); await fs.mkdir(output, { recursive: true });
    const fixture = scope.spawn(path.join(__dirname, 'lib/figurePolishFixture.ts'), [project], { env, deadlineMs: 30000 });
    assert.equal((await scope.waitExit(fixture)).code, 0, fixture.stderr);
    await fs.cp(project, second, { recursive: true });
    const child = scope.spawn(require.resolve('electron/cli.js'), [path.join(__dirname, 'lib/figureRasterNativeEntry.cjs'), project, '--mute-audio'], { env, nodeArgs: [], deadlineMs: 90000 });
    const status = await scope.waitExit(child);
    await fs.writeFile(path.join(output, 'native.log'), child.stdout + child.stderr);
    console.log(child.stdout.trim());
    assert.equal(status.code, 0, (child.stdout + child.stderr).slice(-12000));
    const report = JSON.parse(await fs.readFile(path.join(output, 'runtime.json'), 'utf8'));
    for (const check of report.checks) h.ok(check.ok, check.label);
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import('./lib/harness.mjs').then(async ({ harness }) => { const h = harness('verify-figure-raster-electron'); try { await main(h); } catch (e) { console.error(e); h.fail(String(e)); } await h.done(); });
