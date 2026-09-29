'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
async function archivePriorReceipt(out) {
  try { await fs.rename(path.join(out, 'receipt.json'), path.join(out, `receipt.previous-${Date.now()}-${process.pid}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function main() {
  const { harness } = await import('./lib/harness.mjs');
  const { TestProcessScope } = await import('./lib/testProcess.mjs');
  const h = harness('verify-slide-model3d-scale-electron'), scope = new TestProcessScope();
  let blocked;
  const repo = path.resolve(__dirname, '..'), scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flux-slide-model-scale-')));
  const out = path.join(repo, 'test-results/model3d/slides-scale/native');
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'), APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1', FLUX_PRIVATE_DISPLAY: '1', MODEL3D_NATIVE_SCRATCH: scratch, MODEL3D_NATIVE_ROOT: path.join(scratch, 'project'), MODEL3D_NATIVE_ARTIFACTS: out };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'SOFTGPU', 'FLUX_MODEL3D_DISABLE', 'WAYLAND_DISPLAY']) delete env[key];
  if (process.platform === 'linux') env.DISPLAY = process.env.DISPLAY || ':0';
  try {
    await fs.mkdir(out, { recursive: true }); await fs.mkdir(env.HOME, { recursive: true });
    const seed = scope.spawn(path.join(__dirname, 'lib/slideModel3dNativeScaleFixture.ts'), [env.MODEL3D_NATIVE_ROOT], { env, cwd: repo, deadlineMs: 90000 });
    await scope.waitExit(seed); if (seed.code !== 0) throw Error(seed.stdout + seed.stderr);
    await fs.copyFile(path.join(env.MODEL3D_NATIVE_ROOT, 'slide-scale-fixture.json'), path.join(out, 'fixture.json'));
    // Never classify this child using an earlier run's capability refusal.
    await archivePriorReceipt(out);
    const child = scope.spawn(path.join(__dirname, 'lib/slideModel3dNativeScaleEntry.cjs'), [env.MODEL3D_NATIVE_ROOT, ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])], { command: require('electron'), nodeArgs: [], env, cwd: repo, deadlineMs: 180000 });
    await scope.waitExit(child); await fs.writeFile(path.join(out, 'native.log'), child.stdout + child.stderr);
    const receipt = JSON.parse(await fs.readFile(path.join(out, 'receipt.json'), 'utf8'));
    if (receipt.status === 'capability-blocked') blocked = { code: 'NATIVE_DISPLAY_UNAVAILABLE', reason: receipt.errors?.at(-1) || 'Native display unavailable' };
    for (const check of receipt.checks ?? []) h.ok(check.ok, check.label);
    if (child.code !== 0 || !receipt.ok || !child.stdout.includes('PROBE result=PASS')) throw Error((child.stdout + child.stderr).slice(-16000));
  } catch (error) { h.fail(String(error.stack || error)); }
  finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }); }
  if (blocked) {
    console.log('##VERIFY## ' + JSON.stringify({ script: 'verify-slide-model3d-scale-electron', ok: false, checks: h.checks, failed: h.failed, blocked: true, ...blocked }));
    process.exitCode = 1; return;
  }
  await h.done();
}
void main();
