#!/usr/bin/env node
'use strict';
// Production renderer + source native bridge, generated semantic project,
// actual Electron input/barriers. Never opens an owner project or desktop.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { evaluateDenseZoom } = require('./lib/denseZoomPolicy.cjs');

async function main() {
  const { harness } = await import('./lib/harness.mjs'), { TestProcessScope } = await import('./lib/testProcess.mjs');
  const h = harness('verify-dense-zoom-electron'), scope = new TestProcessScope(), repo = path.resolve(__dirname, '..');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-dense-zoom-')), root = path.join(scratch, 'project');
  const out = path.resolve(process.env.FLUX_OUT || path.join(repo, 'test-results/dense-zoom-native'));
  const env = { ...process.env, HOME: path.join(scratch, 'home'), USERPROFILE: path.join(scratch, 'home'),
    XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_DATA_HOME: path.join(scratch, 'data'),
    APPDATA: path.join(scratch, 'appdata'), LOCALAPPDATA: path.join(scratch, 'localappdata'), TMPDIR: path.join(scratch, 'tmp'),
    FLUX_NO_MIGRATE: '1', PROBE_DENSE_ZOOM_TEST: '1', PROBE_MOUNT_LOG: '1', DCONF_PROFILE: '/dev/null', GSETTINGS_BACKEND: 'memory' };
  // Avoid inheriting a diagnostic scenario, owner fixture target, external
  // display, renderer URL, or input override into this reproducible gate.
  for (const name of Object.keys(env)) if (name.startsWith('PROBE_') && !['PROBE_DENSE_ZOOM_TEST', 'PROBE_MOUNT_LOG'].includes(name)) delete env[name];
  env.PROBE_WHEEL_CADENCE_MS = '16';
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'FLUX_PROJECT', 'FLUX_LIB', 'WAYLAND_DISPLAY']) delete env[name];
  try {
    await fs.access(path.join(repo, 'dist/index.html'));
    for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.APPDATA, env.LOCALAPPDATA, env.TMPDIR, out]) await fs.mkdir(dir, { recursive: true });
    if (process.platform === 'win32') for (const name of ['Local', 'LocalLow', 'Roaming']) await fs.mkdir(path.join(env.USERPROFILE, 'AppData', name), { recursive: true });
    const seed = scope.spawn(path.join(__dirname, 'lib/denseZoomFixture.ts'), [root], { cwd: repo, env, deadlineMs: 30000 });
    assert.equal((await scope.waitExit(seed)).code, 0, seed.stdout + seed.stderr);
    await fs.copyFile(path.join(root, 'dense-zoom-fixture.json'), path.join(out, 'fixture.json'));
    if (process.platform === 'linux') {
      const displayFile = path.join(scratch, 'display');
      const display = scope.spawn(__filename, ['--display', process.env.FLUX_XVFB || 'Xvfb', displayFile], { cwd: repo, env, readyLine: 'DISPLAY READY', nodeArgs: [], deadlineMs: 180000 });
      await display.ready;
      env.DISPLAY = `:${(await fs.readFile(displayFile, 'utf8')).trim()}`;
      env.FLUX_PRIVATE_DISPLAY = '1'; env.FLUX_ELECTRON_NO_SANDBOX = '1'; env.XDG_SESSION_TYPE = 'x11';
    } else if (process.env.FLUX_DENSE_ZOOM_ALLOW_DESKTOP !== '1') {
      throw Error('A separate test desktop is required; opt in with FLUX_DENSE_ZOOM_ALLOW_DESKTOP=1 only on that desktop');
    }
    const probeOut = path.join(out, 'probe');
    const probe = scope.spawn(path.join(__dirname, 'perf/input-probe.cjs'), [root, '--surface=figure', '--scenarios=base', '--phases=zoomDeep', '--qualify', '--ozone=x11', `--out=${probeOut}`],
      { env, cwd: repo, nodeArgs: [], deadlineMs: 150000 });
    probe.child.stdout.on('data', bytes => { for (const line of String(bytes).split('\n')) if (line.startsWith('PROBE ')) console.log(line); });
    const status = await scope.waitExit(probe);
    await fs.writeFile(path.join(out, 'native.log'), probe.stdout + probe.stderr);
    if (status.code !== 0) {
      const nativeError = await fs.readFile(path.join(probeOut, 'stderr.log'), 'utf8').catch(() => '');
      throw Error(`Dense native fixture failed (${status.code}); artifacts: ${probeOut}\n${nativeError.slice(-8000)}\n${probe.stderr.slice(-2000)}`);
    }
    const results = JSON.parse(await fs.readFile(path.join(probeOut, 'results.json'), 'utf8'));
    const receipt = JSON.parse(await fs.readFile(path.join(probeOut, 'dense-zoom-receipt.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(probeOut, 'runtime.json'), 'utf8'));
    const verdict = evaluateDenseZoom(results.figure.base.zoomDeep, receipt, runtime);
    await fs.writeFile(path.join(out, 'verdict.json'), JSON.stringify({ ...verdict,
      qualification: 'Private virtual/native test display; production throttling and renderer. GPU hardware/presentation is separately qualified. No screencast is enabled during latency measurement.',
      runtime }, null, 2));
    for (const row of verdict.checks) h.ok(row.ok, row.label);
    console.log('Dense fold maxima (unrounded raw metrics): ' + JSON.stringify({ maxLongTaskMs: verdict.maxLongTaskMs, maxFrameGapMs: verdict.maxFrameGapMs, maxWheelEntryPaintMs: verdict.maxWheelEntryPaintMs }));
  } catch (error) { h.fail(String(error.stack || error)); }
  finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 }); }
  await h.done();
}

if (process.argv[2] === '--display') {
  // Same owned private-Xvfb pattern as the registered Slide native gate.
  const child = require('node:child_process').spawn(process.argv[3], ['-displayfd', '1', '-screen', '0', '1600x1100x24', '-nolisten', 'tcp', '-extension', 'GLX'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.pipe(process.stderr);
  child.stdout.once('data', async bytes => { await fs.writeFile(process.argv[4], String(bytes).trim()); console.log('DISPLAY READY'); });
  child.on('error', error => { console.error('Private Xvfb unavailable; set FLUX_XVFB to its executable:', error.message); process.exitCode = 1; process.stdin.destroy(); });
  child.on('exit', code => process.exit(code ?? 1));
  process.stdin.resume(); process.stdin.on('end', () => child.kill()); process.stdin.on('close', () => child.kill());
} else void main();
