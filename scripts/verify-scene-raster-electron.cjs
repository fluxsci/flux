"use strict";
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
async function main() {
  const repo = path.resolve(__dirname, '..'), scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-scene-native-'));
  const { TestProcessScope } = await import('./lib/testProcess.mjs'), scope = new TestProcessScope();
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache'), APPDATA: path.join(scratch, 'appdata'), PROBE_SCRATCH: scratch, PROBE_APP_ROOT: repo };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  const output = process.env.FLUX_OUT || path.join(repo, 'test-results/scene-raster-native');
  try {
    await fs.mkdir(env.HOME, { recursive: true }); await fs.mkdir(output, { recursive: true });
    const args = [path.join(__dirname, 'lib/sceneRasterNativeEntry.cjs'), '--mute-audio', ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : [])];
    const proc = scope.spawn(require.resolve('electron/cli.js'), args, { env, nodeArgs: [], deadlineMs: 60000 });
    const status = await scope.waitExit(proc); await fs.writeFile(path.join(output, 'native.log'), proc.stdout + proc.stderr);
    assert.equal(status.code, 0, (proc.stdout + proc.stderr).slice(-10000));
    await fs.copyFile(path.join(scratch, 'native-result.json'), path.join(output, 'runtime.json'));
    console.log(proc.stdout.trim());
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import('./lib/harness.mjs').then(async ({ harness }) => { const h = harness('verify-scene-raster-electron'); try { await main(); h.ok(true, 'actual isolated Electron preload and dedicated scene raster worker'); } catch (error) { console.error(error); h.fail(String(error)); } await h.done(); });
