// Runtime/isolation is a script contract, independent of tier/group membership.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { TestProcessScope, testElectronArgs } from './testProcess.mjs';
const require = createRequire(import.meta.url);
const { proxyConfigurationProblem } = require('./liveProxyFixture.cjs');
export function executionSpec(manifest, name) {
  const s = manifest.execution?.[name];
  if (!s || !['node', 'tsx', 'electron', 'node-electron'].includes(s.runtime) || !Array.isArray(s.prerequisites) || s.isolation !== 'scratch' || typeof s.externalNetwork !== 'boolean' || typeof s.exclusive !== 'boolean')
    throw new Error(`Missing/invalid execution contract: ${name}`);
  return s;
}
export function runtimeCommand(spec, file, env = process.env) {
  if (spec.runtime === 'electron') {
    const binary = env.FLUX_ELECTRON || require('electron');
    const args = testElectronArgs(binary, file, [], {...env,FLUX_ELECTRON:binary});
    return { command: binary, file, args, nodeArgs: [] };
  }
  return { command: process.execPath, file, args: [], nodeArgs: spec.runtime === 'node' ? [] : ['--import', 'tsx'] };
}
export function isolatedEnv(dir, parent = process.env, { native = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const home = path.join(dir, 'home');
  const config = path.join(dir, 'config');
  const cache = path.join(dir, 'cache');
  // Chromium's SingletonSocket is constrained by Unix sockaddr path length.
  // Keep scratch temp short even when the evidence directory is deeply nested.
  const tmp = mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'fv-'));
  writeFileSync(path.join(dir, 'temporary-root.txt'), tmp + '\n');
  const fluxConfig = path.join(home, 'FluxConfig');
  for (const p of [home, config, cache, tmp, path.join(fluxConfig, 'FluxLib'), path.join(config, 'flux')]) mkdirSync(p, { recursive: true });
  // Windows: Chromium scaffolds under %USERPROFILE%\AppData and EXITS
  // IMMEDIATELY when those folders do not exist. Puppeteer then reports the
  // misleading "The browser is already running for <fresh temp profile>", and
  // EVERY ui gate died at launch under isolation while the same gate passed
  // when run by hand (2026-09-22). Creating the scaffolding keeps the scratch
  // home fully isolated — the alternative, handing Chrome the real profile,
  // would leak the user's Downloads and known folders into gates.
  if (process.platform === 'win32')
    for (const p of ['Local', 'LocalLow', 'Roaming']) mkdirSync(path.join(home, 'AppData', p), { recursive: true });
  writeFileSync(path.join(config, 'flux', 'preferences.json'), JSON.stringify({ fluxConfigPath: fluxConfig }));
  const env = { ...parent, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, APPDATA: config, LOCALAPPDATA: cache, TMPDIR: tmp, TMP: tmp, TEMP: tmp, FLUX_NO_MIGRATE: '1', FLUX_OUT: path.join(dir, 'artifacts') };
  env.DCONF_PROFILE = '/dev/null';
  env.GSETTINGS_BACKEND = 'memory';
  if(process.platform==='linux' && (env.FLUX_PRIVATE_DISPLAY==='1' || env.FLUX_XVFB)) {
    env.FLUX_PRIVATE_DISPLAY='1';
    delete env.WAYLAND_DISPLAY;
    env.XDG_SESSION_TYPE='x11';
    env.ELECTRON_OZONE_PLATFORM_HINT='x11';
  }
  // The media worker is spawned by production code, which must retain its
  // sandbox defaults. Provide only this disposable CI invocation an executable
  // adapter; never mutate the installed Electron binary or production argv.
  if (native && process.platform === 'linux' && (env.FLUX_ELECTRON_NO_SANDBOX === '1' || env.FLUX_PRIVATE_DISPLAY==='1') && !env.FLUX_VIDEO_ELECTRON) {
    const binary = env.FLUX_ELECTRON || require('electron');
    const shim = path.join(tmp, 'electron-test');
    const quoted = "'" + binary.replaceAll("'", "'\\''") + "'";
    const flags=testElectronArgs(binary,'',[],{...env,FLUX_ELECTRON:binary});
    writeFileSync(shim, '#!/bin/sh\nexec ' + quoted + ' '+flags.join(' ')+' "$@"\n', { mode: 0o700 });
    env.FLUX_VIDEO_ELECTRON = shim;
  }
  // A parent Electron-as-Node host must not demote a direct Electron child.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FLUX_PROJECT;
  delete env.FLUX_LIB;
  return env;
}
/**
 * Scratch temp is evidence-free and disposable, and losing it must never cost a
 * result. On Windows a just-closed Chromium still holds its Crashpad metrics
 * file open for a moment, and an unguarded rmSync then threw EBUSY out of the
 * `finally` — killing the whole runner process on the FIRST browser gate, which
 * made the ui tier unrunnable there. Retry (Node backs off for exactly these
 * Windows sharing violations), then leave the directory to the OS.
 */
export function discardTemporaryRoot(root) {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { console.warn(`verify: scratch temp left behind (${root}): ${error.message}`); }
}
export async function executeAttempt({ spec, file, dir, cwd, timeout, env = process.env, commandOverride, signal }) {
  mkdirSync(dir, { recursive: true });
  const childEnv = isolatedEnv(dir, env, { native: spec.runtime === 'electron' || spec.runtime === 'node-electron' });
  const invocation = commandOverride ?? runtimeCommand(spec, file, childEnv);
  const scope = new TestProcessScope();
  const start = Date.now();
  let onAbort;
  try {
    const entry = scope.spawn(invocation.file, invocation.args, { command: invocation.command, nodeArgs: invocation.nodeArgs, deadlineMs: timeout, cwd, env: childEnv });
    onAbort=()=>scope.kill(entry);signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
    await entry.closed;
    const out = entry.stdout + entry.stderr;
    writeFileSync(path.join(dir, 'stdout.log'), entry.stdout);
    writeFileSync(path.join(dir, 'stderr.log'), entry.stderr);
    const matches = out.match(/##VERIFY## (\{.*\})/g);
    let sentinel = null;
    try { if (matches) sentinel = JSON.parse(matches.at(-1).slice(11)); } catch {}
    const status = signal?.aborted ? 'interrupted' : entry.spawnError ? 'spawn-error' : entry.deadlineHit ? 'timeout' : entry.signal ? 'signal' : entry.code === 0 ? 'passed' : 'failed';
    return { status, code: signal?.aborted ? 'interrupted' : entry.spawnError ? 'spawn-error' : entry.deadlineHit ? 'timeout' : entry.signal ? `signal:${entry.signal}` : entry.code, signal: entry.signal, spawnError: entry.spawnError, ms: Date.now() - start, out, sentinel, directory: dir, command: [invocation.command, ...invocation.nodeArgs, invocation.file, ...invocation.args] };
  } finally { if(onAbort)signal?.removeEventListener('abort',onAbort);await scope.dispose(); discardTemporaryRoot(childEnv.TMPDIR); }
}
export async function missingPrerequisites(spec, repo, env = process.env) {
  const missing = [];
  const runs = (file, args) => {
    const result = spawnSync(file, args, { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    return !result.error && result.status === 0 && !result.signal;
  };
  for (const p of spec.prerequisites) {
    if (p === 'server') continue; // checked asynchronously by the runner
    if (p === 'build') {
      if (!existsSync(path.join(repo, 'dist/flux-cli.mjs'))) missing.push('build (npm run build)');
    } else if (p === 'display') {
      if (process.platform === 'linux' && !env.DISPLAY && !env.FLUX_XVFB) missing.push('private display (DISPLAY or FLUX_XVFB)');
    } else if (p === 'linux-color-portal') {
      if (process.platform !== 'linux' || !runs('dbus-run-session', ['--', '/usr/bin/python3', '-I', '-c', 'from gi.repository import Gio, GLib; Gio.bus_get_sync(Gio.BusType.SESSION, None)']))
        missing.push('Linux system Python/Gio and accessible dbus-run-session (private color portal fixture)');
    } else if (p === 'wayland-color-portal') {
      if (process.platform !== 'linux' || !env.WAYLAND_DISPLAY || env.FLUX_PRIVATE_DISPLAY === '1' || env.FLUX_XVFB || !runs('/usr/bin/python3', ['-I', '-c',
        "from gi.repository import Gio, GLib; bus=Gio.bus_get_sync(Gio.BusType.SESSION, None); bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', ('org.freedesktop.portal.Screenshot', 'version')), None, Gio.DBusCallFlags.NONE, 2000, None)"]))
        missing.push('Linux Wayland desktop with an accessible Screenshot portal (native color picker)');
    } else if (p === 'release-arguments') {
      missing.push('explicit release-stage arguments (invoke the release coordinator with the packaged directory or evidence paths)');
    } else if (p === 'institutional-proxy') {
      const problem=proxyConfigurationProblem(env);if(problem)missing.push(problem);
    } else if (p === 'quarto') {
      if (!runs('quarto', ['--version'])) missing.push('Quarto executable (quarto --version)');
    } else if (p === 'chrome') {
      if (!runs(env.FLUX_CHROME || '/usr/bin/google-chrome', ['--version'])) missing.push('Chrome executable (FLUX_CHROME or /usr/bin/google-chrome)');
    } else if (p === 'latex') {
      if (!runs('pdflatex', ['--version']) || ['lmodern.sty', 'scrartcl.cls', 'bookmark.sty', 'longtable.sty'].some(name => !runs('kpsewhich', [name]))) missing.push('PDF TeX toolchain (pdflatex, lmodern, KOMA Script, bookmark, longtable)');
    } else if (p === 'native-encoder') {
      try {
        const { verifyVideoEncoder } = await import('../fetch-video-encoder.mjs');
        const target = path.join(repo, 'build/video-encoder', `${process.platform}-${process.arch}`);
        await verifyVideoEncoder(target, { platform: process.platform, arch: process.arch,
          manifest: JSON.parse(readFileSync(path.join(repo, 'build/video-encoder.json'), 'utf8')),
          notice: readFileSync(path.join(repo, 'build/video-encoder-NOTICE.md')) });
        if (!runs(path.join(target, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ['-version'])) throw new Error('not runnable');
      } catch { missing.push(`pinned native encoder for ${process.platform}-${process.arch} (npm run fetch:video-encoder)`); }
    } else if (p === 'correction-runtime') {
      // The llama-server build is a large staged download, like the encoder:
      // absent, the gate fails deep inside a product path that is working
      // correctly. `npm run fetch:correction-runtime` stages it.
      const server = path.join(repo, 'build/correction-runtime', `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
      if (!existsSync(server)) missing.push(`staged correction runtime for ${process.platform}-${process.arch} (npm run fetch:correction-runtime)`);
    } else if (p.startsWith('file:')) {
      if (!existsSync(path.join(repo, p.slice(5)))) missing.push(p);
    } else missing.push(`unknown prerequisite: ${p}`);
  }
  if (spec.externalNetwork && env.FLUX_ALLOW_TEST_NETWORK !== '1') missing.push('external network opt-in (FLUX_ALLOW_TEST_NETWORK=1)');
  return missing;
}
