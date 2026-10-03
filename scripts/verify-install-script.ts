// install.sh — the one supported install/update path (2026-10-03). Runs the REAL script
// against a local HTTP server through its test seams (FLUX_INSTALL_BASE_URL / _OS /
// _APPS_DIR), with a scratch HOME: download, SHA256SUMS verification, the in-place app
// swap, --update, --wait-pid, the PATH line's idempotency, and the Linux path up to (not
// including) apt. Nothing outside the scratch directory is touched.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { harness } from './lib/harness.mjs';

const h = harness('verify-install-script');
if (process.platform === 'win32') {
  console.log('SKIP: install.sh targets macOS and Debian/Ubuntu; there is no bash installer path on Windows.');
  await h.done();
  process.exit(0);
}
const script = path.resolve('install.sh');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-install-'));
const home = path.join(temp, 'home'), apps = path.join(temp, 'Applications'), serve = path.join(temp, 'release');
await fs.mkdir(home, { recursive: true }); await fs.mkdir(serve);
const MARKER = '# Added by Flux: put the flux command on PATH';
const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
const macAsset = `Flux-mac-${arch}.zip`, debAsset = 'Flux-linux-amd64.deb';

/** A zip holding Flux.app with a version stamp (python3's zipfile: no zip CLI needed). */
async function makeApp(stamp: string) {
  const stage = path.join(temp, `stage-${stamp}`);
  await fs.mkdir(path.join(stage, 'Flux.app', 'Contents'), { recursive: true });
  await fs.writeFile(path.join(stage, 'Flux.app', 'Contents', 'stamp.txt'), stamp);
  const r = spawnSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2], "Flux.app")', path.join(serve, macAsset.replace(/\.zip$/, '')), stage]);
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
}
async function writeSums(entries: Record<string, string | null> = {}) {
  const lines: string[] = [];
  for (const name of [macAsset, debAsset]) {
    if (entries[name] === null) continue;
    const bytes = await fs.readFile(path.join(serve, name)).catch(() => null);
    if (!bytes) continue;
    lines.push(`${entries[name] ?? createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(serve, 'SHA256SUMS'), lines.join('\n') + '\n');
}
const server = http.createServer(async (req, res) => {
  const file = path.join(serve, path.basename(decodeURIComponent(req.url || '')));
  try { const body = await fs.readFile(file); res.writeHead(200); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

function run(args: string[], env: Record<string, string> = {}, piped = false) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    // piped: exactly `curl … | bash -s -- <args>` — the script arrives on stdin.
    const child = spawn('bash', piped ? ['-s', '--', ...args] : [script, ...args], { env: { PATH: process.env.PATH!, HOME: home, TMPDIR: temp, SHELL: '/bin/zsh',
      FLUX_INSTALL_BASE_URL: base, FLUX_INSTALL_OS: 'mac', FLUX_INSTALL_APPS_DIR: apps, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    if (piped) void fs.readFile(script).then((body) => child.stdin.end(body)); else child.stdin.end();
  });
}
const stamp = () => fs.readFile(path.join(apps, 'Flux.app', 'Contents', 'stamp.txt'), 'utf8').catch(() => null);
const markers = async (rc: string) => ((await fs.readFile(path.join(home, rc), 'utf8').catch(() => '')).split(MARKER).length - 1);

try {
  h.eq(spawnSync('bash', ['-n', script]).status, 0, 'install.sh parses (bash -n)');

  await makeApp('v1'); await writeSums();
  let r = await run([]);
  h.eq(r.code, 0, `a fresh macOS install succeeds (${r.out.trim().split('\n').at(-1)})`);
  h.eq(await stamp(), 'v1', '…and Flux.app lands in the Applications folder');
  h.ok(r.out.includes('Checksum verified'), '…after the SHA256SUMS check');
  h.eq(await markers('.zshrc'), 1, '…with ~/.local/bin added to PATH in ~/.zshrc (zsh)');
  h.ok((await fs.stat(path.join(home, '.local', 'bin'))).isDirectory(), '…and ~/.local/bin exists, so Flux writes its flux launcher there on first launch');
  h.ok((await fs.readdir(temp)).every((n) => !n.startsWith('flux-install.')), 'the installer removes its scratch directory');

  await makeApp('v2'); await writeSums();
  r = await run(['--update']);
  h.eq(r.code, 0, '--update succeeds');
  h.eq(await stamp(), 'v2', '…and replaces the installed app');
  h.ok(r.out.includes('Flux updated'), '…and says it updated');
  h.eq(await markers('.zshrc'), 1, 'the PATH line is added once, never twice');

  await writeSums({ [macAsset]: '0'.repeat(64) });
  r = await run(['--update']);
  h.ok(r.code !== 0 && r.out.includes('checksum mismatch'), 'a checksum mismatch refuses the install');
  h.eq(await stamp(), 'v2', '…and leaves the installed app untouched');

  await writeSums({ [macAsset]: null });
  r = await run([]);
  h.ok(r.code !== 0 && r.out.includes('no entry'), 'an asset missing from SHA256SUMS refuses the install');

  await writeSums();
  const sleeper = spawn('sleep', ['1.5']);
  const started = Date.now();
  r = await run(['--update', '--wait-pid', String(sleeper.pid)]);
  h.ok(r.code === 0 && Date.now() - started >= 1200, `--wait-pid waits for the running app to exit (${Date.now() - started} ms)`);

  await makeApp('v3'); await writeSums();
  r = await run(['--update'], {}, true);
  h.ok(r.code === 0 && (await stamp()) === 'v3', 'piped through stdin (curl … | bash -s -- --update) it runs end to end');

  r = await run(['--bogus']);
  h.ok(r.code !== 0 && r.out.includes('unknown option'), 'an unknown option is refused');

  await fs.writeFile(path.join(serve, debAsset), 'not really a deb'); await writeSums();
  r = await run([], { FLUX_INSTALL_OS: 'linux', SHELL: '/bin/bash' });
  h.eq(r.code, 0, `the Linux path downloads and verifies the .deb (apt itself is not run here) (${r.out.trim().split('\n').at(-1)})`);
  h.eq(await markers('.bashrc'), 1, '…and adds ~/.local/bin to PATH in ~/.bashrc (bash)');
} catch (error) {
  h.fail(String((error as Error).stack ?? error));
} finally {
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
await h.done();
