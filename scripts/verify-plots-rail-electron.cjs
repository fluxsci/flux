#!/usr/bin/env node
// The Plots rail in the production app (Electron): the real thumbnail worker (a Node child),
// disk cache, chokidar watcher → fs:changedBatch, preload and IPC. Disposable config and
// project; never opens or writes the user's own workspace. Checks: native Alt+G; worker-rendered
// thumbnails on the backdrop the law picks; the cache and per-root index on disk; one worker;
// a native double-click insert saved at true size; live dissections and a regenerated plot
// through the real watcher; a killed worker respawning; 1,500 plots flung end to end; Peek's
// 1024 px raster from the worker; pre-warm filling the disk cache for plots never on a tile;
// Slide's [Slides | Plots] rail placing through Slide's import route.
// Needs `npm run build`. On Linux pass a private display (FLUX_PRIVATE_DISPLAY=1 + DISPLAY) to
// keep windows off the desktop.
'use strict';
const { spawnSync, spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const repo = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-plots-rail-')), root = path.join(scratch, 'project');
const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'), APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1', PROBE_SCRATCH: scratch, PROBE_PROJECT: root };
fs.mkdirSync(env.HOME, { recursive: true }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const svg = (fill, w = 72, h = 48) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
async function main() {
  try {
    const seed = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'lib/figurePolishFixture.ts'), root], { env, cwd: repo, encoding: 'utf8' });
    if (seed.status !== 0) throw Error(seed.stdout + seed.stderr);
    put('plots/growth.svg', svg('#d95f02'));
    fs.mkdirSync(path.join(root, 'plots', 'fixtures'), { recursive: true });
    for (const f of fs.readdirSync(path.join(__dirname, 'fixtures', 'plots-rail')).filter((n) => n.endsWith('.svg')))
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'plots-rail', f), path.join(root, 'plots', 'fixtures', f));
    put('plots/_dissections/growth/overview.svg', svg('#7570b3'));
    for (let i = 1; i <= 2; i++) put(`plots/_dissections/growth/by_subject/s0${i}.svg`, svg('#e7298a'));
    put('plots/_dissections/growth/_stats/anova.csv', 'term,estimate,p\nintake,0.42,0.003\n');
    // Never on a tile (a depth-2 folder starts collapsed): only pre-warm renders these.
    for (let i = 1; i <= 3; i++) put(`plots/a_cold/deeper/never_${i}.svg`, svg('#9c6d1f', 60 + i * 10, 40));
    for (let i = 0; i < 1500; i++) put(`plots/burst/p${i}.svg`, svg(['#4385be', '#879a39', '#ce5d97', '#d0a215'][i % 4], 40 + (i % 5) * 12, 30 + (i % 3) * 10));
    fs.mkdirSync(path.join(repo, 'test-results'), { recursive: true });
    const result = await new Promise((resolve, reject) => {
      const args = [path.join(__dirname, 'lib/plotsRailProbeEntry.cjs'), root];
      if (process.platform === 'linux') args.push('--no-sandbox', '--ozone-platform=x11');
      const child = spawn(require('electron'), args, { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 232000);
      child.stdout.on('data', (b) => { output += b; for (const line of String(b).split('\n')) if (line.startsWith('PROBE ')) console.log(line); });
      child.stderr.on('data', (b) => { output += b; for (const line of String(b).split('\n')) if (line.startsWith('PROBE ')) console.log(line); });
      child.on('error', reject);
      child.on('close', (status) => { clearTimeout(timer); fs.writeFileSync(path.join(repo, 'test-results/plots-rail-native.log'), output); resolve({ status, output }); });
    });
    if (result.status !== 0) throw Error(result.output.slice(-12000));
    const checks = JSON.parse(fs.readFileSync(path.join(repo, 'test-results/plots-rail-native.json'), 'utf8'));
    console.log('PLOTS RAIL ELECTRON: PASS');
    console.log('##VERIFY## ' + JSON.stringify({ script: 'verify-plots-rail-electron', ok: true, checks: checks.length, failed: 0 }));
  } catch (e) { console.error(e); process.exitCode = 1; } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
void main();
