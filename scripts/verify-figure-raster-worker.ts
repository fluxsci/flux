// Exercise the real child/protocol through the same family that owns Electron IPC.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { harness } from './lib/harness.mjs';
import type { Figure, Asset } from '../src/lib/types';
const h = harness('verify-figure-raster-worker'), require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-figure-raster-'));
process.env.HOME = path.join(scratch, 'home'); process.env.XDG_CONFIG_HOME = path.join(scratch, 'config'); process.env.FLUX_NO_MIGRATE = '1';
await fs.mkdir(process.env.HOME, { recursive: true });
const families: any[] = [], allProcesses: any[] = [];
try {
  // Negative-proof mode uses a disposable archive of the base, never another worktree.
  const serviceRepo = process.env.FLUX_FIGURE_RASTER_BASE || repo;
  let createFigureRasterFamily: any;
  try { ({ createFigureRasterFamily } = require(path.join(serviceRepo, 'electron/ipc/figureRaster.cjs'))); }
  catch { h.fail('real figure raster IPC handler/worker exists and can produce a PNG'); await fs.rm(scratch, { recursive: true, force: true }); await h.done(); }
  const build = await import('../scripts/build-figure-raster-worker.mjs'); await build.buildFigureRasterWorker();
  // The bundle is read by parallel pure gates (asar closure, packaged requires) while this gate,
  // check, dev and build regenerate it: an unchanged rebuild must not touch it, and a changed one
  // must replace it by rename, never truncate it in place. Exercised on a scratch output.
  const scratchBundle = path.join(scratch, 'bundle/figureRasterWorker.bundle.mjs');
  await build.buildFigureRasterWorker({ outfile: scratchBundle });
  await fs.writeFile(scratchBundle, 'stale');
  const staleBundle = await fs.stat(scratchBundle);
  await build.buildFigureRasterWorker({ outfile: scratchBundle });
  const rebuilt = await fs.stat(scratchBundle);
  h.ok(rebuilt.ino !== staleBundle.ino && rebuilt.size > 1024, 'a changed worker bundle is replaced by rename, not rewritten in place');
  await build.buildFigureRasterWorker({ outfile: scratchBundle });
  const again = await fs.stat(scratchBundle);
  h.ok(again.ino === rebuilt.ino && again.mtimeMs === rebuilt.mtimeMs, 'an unchanged worker rebuild leaves the bundle untouched');
  const root = path.join(scratch, 'project');
  const fixture = spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'scripts/lib/figurePolishFixture.ts'), root], { env: process.env, encoding: 'utf8' });
  if (fixture.status !== 0) throw Error(fixture.stderr);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'fig/canvases/c.json'), 'utf8'));
  const index = JSON.parse(await fs.readFile(path.join(root, 'fig/index.json'), 'utf8'));
  const assets: Asset[] = index.assets;
  const figure: Figure = saved.figures.find((f: Figure) => f.id === 'native-5');
  const dense: Figure = saved.figures.find((f: Figure) => f.id === 'native-dense');
  const req = (rid: string, fig = figure, extras = {}) => ({ rid, root, figure: structuredClone(fig), assets, scale: 1, width: 320, height: 240, ...extras });
  function service(workers = 1, timeoutMs = 15000, projectRoot = root, idleMs = 60000, launch?: (index: number) => string[] | null) {
    const handlers = new Map(); const processes: any[] = [];
    const rendering = new Set<string>(), rendered = new EventEmitter(); let live = 0, peak = 0, generation = 1;
    const sender = Object.assign(new EventEmitter(), { id: families.length + 1, isDestroyed: () => false });
    const event = { sender };
    const family = createFigureRasterFamily({ app: { isPackaged: false }, appRoot: repo, workers, timeoutMs, idleMs, rootFor: () => projectRoot, generationFor: () => generation,
      fontIndexFile: () => path.join(scratch, 'fonts.json'),
      spawnProcess: (exe: string, args: string[], opts: any) => {
        const proc = spawn(exe, launch?.(processes.length) ?? args, { ...opts, env: { ...opts.env, FLUX_FIGURE_RASTER_TRACE: '1' } });
        proc.closed = new Promise(resolve => proc.once('close', resolve)); allProcesses.push(proc);
        let partial = '';
        proc.stderr.on('data', chunk => {
          partial += String(chunk); const lines = partial.split('\n'); partial = lines.pop()!;
          for (const line of lines) try { const value = JSON.parse(line); if (value.rid && value.composeMs !== undefined) { rendering.add(value.rid); (proc as any).rids ??= []; (proc as any).rids.push(value.rid); rendered.emit(value.rid); } } catch { /* worker diagnostics are not protocol data */ }
        });
        if (process.env.FLUX_FIGURE_RASTER_TRACE) proc.stderr.pipe(process.stderr); processes.push(proc); live++; peak = Math.max(peak, live);
        proc.once('close', () => { live--; }); return proc;
      } });
    families.push(family); family.registerHandlers({ handle: (name: string, fn: any) => handlers.set(name, fn) });
    return { processes, sender, family, raster: (r: any) => handlers.get('figure:rasterize')(event, r), cancel: (rid: string) => handlers.get('figure:cancelRaster')(event, rid), peak: () => peak, whenRendering: (rid: string) => rendering.has(rid) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Worker did not start rasterizing ${rid}`)), 10000);
      rendered.once(rid, () => { clearTimeout(timer); resolve(); });
    }), generation: () => { generation++; } };
  }
  const { Resvg } = require('@resvg/resvg-js');
  function pixels(png: Uint8Array) {
    return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><image width="320" height="240" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render().pixels;
  }
  const pixel = (p: Uint8Array, x: number, y: number) => [...p.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
  const s = service();
  const first = await s.raster(req('first'));
  h.ok(first.png && Buffer.from(first.png).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'real child returns a PNG signature');
  if (!first.png) throw Error(JSON.stringify(first));
  h.eq([first.width, first.height], [320, 240], 'exact requested dimensions');
  h.eq(pixel(pixels(first.png), 20, 18), [67,133,190,255], 'content pixel is the fixture rectangle, not blank');
  const { duplicateFigure } = await import('../src/lib/ops');
  const project = { version: 2 as const, name: 'Raster', canvases: [{ id: 'c', name: 'Canvas' }], figures: [structuredClone(figure)], assets, palette: [] };
  const duplicateId = duplicateFigure(project, figure.id)!;
  const duplicate = project.figures.find(f => f.id === duplicateId)!;
  h.ok(!!(await s.raster(req('duplicate-model', duplicate))).png, 'actual duplicateFigure model renders with its undefined optional captions');
  const edited = structuredClone(figure); edited.elements[0].x = 180;
  const moved = await s.raster(req('moved', edited));
  h.eq(pixel(pixels(moved.png), 20, 18), [255,255,255,255], 'unsaved move clears the old rectangle location');
  h.eq(pixel(pixels(moved.png), 188, 18), [67,133,190,255], 'unsaved move draws at the requested model location');
  const core = await import('../flux-core/render');
  for (const fig of [figure, dense]) {
    const disk = await core.renderFigureSvg(root, fig.id);
    const model = await core.renderFigureSvgFromModel(structuredClone(fig), { assets, ...core.figureRenderReaders(root, assets) });
    h.eq(model, disk, `${fig.id}: model/disk SVG byte parity`);
    if (process.env.FLUX_FIGURE_RASTER_LEGACY) {
      const legacy = await import(pathToFileURL(path.join(process.env.FLUX_FIGURE_RASTER_LEGACY, 'flux-core/render.ts')).href);
      h.eq(disk, await legacy.renderFigureSvg(root, fig.id), `${fig.id}: unchanged bytes from the base renderer`);
    }
  }
  const redSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="red"/></svg>';
  const inline = { 'native-dense': `data:image/svg+xml;base64,${Buffer.from(redSvg).toString('base64')}` };
  const override = await s.raster(req('inline', dense, { width: 900, height: 700, inlineAssets: inline }));
  h.ok(!!override.png && !override.error, 'inline SVG replaces the disk asset through the real worker');
  const p = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><image width="900" height="700" href="data:image/png;base64,${Buffer.from(override.png).toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render().pixels;
  h.eq([...p.subarray((30 * 900 + 30) * 4, (30 * 900 + 30) * 4 + 4)], [255,0,0,255], 'inline override changes the expected pixel to red');
  const changedPath = path.join(root, 'fig/assets/native-dense.svg');
  const originalBytes = await fs.readFile(changedPath);
  const beforeChange = await s.raster(req('before-stat-change', dense, { width: 900, height: 700 }));
  await fs.writeFile(changedPath, redSvg.replace('red', 'lime'));
  const changed = await s.raster(req('stat-change', dense, { width: 900, height: 700 }));
  h.ok(!!changed.png && !Buffer.from(changed.png).equals(Buffer.from(beforeChange.png)), 'mtime/size cache notices changed asset bytes');
  await fs.writeFile(changedPath, originalBytes);
  h.ok(/pixel budget/.test((await s.raster(req('oversize', figure, { width: 5000 }))).error), '5000px request has a named budget refusal');
  const huge = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">${'<circle r="1"/>'.repeat(250000)}</svg>`;
  const hugeResult = await s.raster(req('nodes', { ...dense, elements: dense.elements.slice(0, 1) }, { inlineAssets: { 'native-dense': `data:image/svg+xml;base64,${Buffer.from(huge).toString('base64')}` } }));
  h.ok(/node budget/.test(hugeResult.error), `250k SVG nodes refused by name (${hugeResult.error})`);
  h.ok(!!(await s.raster(req('survived'))).png, 'worker survives resource refusals');
  h.eq(s.processes.length, 1, 'refusals did not kill and replace the worker');
  h.ok(/root mismatch/.test((await s.raster(req('wrong-root', figure, { root: scratch }))).error), 'root is bound to the sender');
  if (process.platform !== 'win32') {
    const outside = path.join(scratch, 'outside.svg'); await fs.writeFile(outside, redSvg);
    await fs.symlink(outside, path.join(root, 'fig/assets/escape.svg'));
    const escaped = await s.raster(req('symlink-escape', { ...dense, elements: dense.elements.slice(0, 1) }, { assets: assets.map(a => a.id === 'native-dense' ? { ...a, path: 'assets/escape.svg' } : a) }));
    h.ok(/symlink escapes project root/.test(escaped.error), 'worker refuses a project asset symlink outside its owning root');
  }
  const q = service();
  const active = q.raster(req('active', dense));
  const old = q.raster(req('old', { ...figure, id: 'queued' }));
  const order: string[] = [];
  const neighbour = q.raster(req('neighbour', { ...figure, id: 'neighbour' })).then((r: any) => { order.push('neighbour'); return r; });
  const newer = q.raster(req('newer', { ...edited, id: 'queued' })).then((r: any) => { order.push('newer'); return r; });
  h.eq(await old, { cancelled: true }, 'only the same queued figure is replaced');
  h.ok(!!(await neighbour).png && !!(await newer).png && !!(await active).png, 'distinct queued figures all render');
  h.eq(order, ['newer', 'neighbour'], 'replacement retains FIFO position ahead of other figures');
  q.family.shutdown();
  const c = service(); const cancelled = c.raster(req('cancel-running', dense));
  await c.whenRendering('cancel-running');
  await c.cancel('cancel-running'); h.eq(await cancelled, { cancelled: true }, 'cancel of a running job settles cancelled');
  h.ok(!!(await c.raster(req('after-cancel'))).png, 'a subsequent job renders after lazy respawn');
  h.eq(c.processes.length, 2, 'running cancellation really replaces the child');
  h.eq(c.peak(), 1, 'respawn waits for the killed process to exit');
  c.family.shutdown();
  const idle = service(1, 15000, root, 150);
  h.ok(!!(await idle.raster(req('idle-first'))).png, 'idle reaping: the first job renders');
  const reaped = await Promise.race([idle.processes[0].closed.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000))]);
  h.ok(reaped === true, 'an idle worker is reaped after idleMs with nothing queued');
  h.ok(!!(await idle.raster(req('idle-second'))).png, 'a job after reaping respawns a worker and renders');
  h.eq(idle.processes.length, 2, 'reaping ended the child; the next job spawned a fresh one');
  h.ok(!!(await idle.raster(req('idle-third'))).png, 'a reap is not a death: the owner stays available');
  idle.family.shutdown();
  const pool = service(2);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => pool.raster(req(`pool-${i}`, { ...figure, id: `pool-fig-${i}` }))));
  h.ok(results.every(r => r.png), 'five distinct figures survive the pool queue'); h.eq(pool.peak(), 2, 'pool never exceeds two live child processes');
  pool.family.shutdown();
  const stale = service(); const running = stale.raster(req('generation-running', dense)); const pending = stale.raster(req('generation-queued')); stale.generation();
  h.eq(await running, { cancelled: true }, 'changed generation discards running output'); h.eq(await pending, { cancelled: true }, 'changed generation cancels at dequeue');
  stale.family.shutdown();
  const dead = service();
  for (let i = 0; i < 3; i++) { const job = dead.raster(req(`death-${i}`)); dead.processes.at(-1).kill('SIGKILL'); h.ok(!!(await job).error, `worker death ${i + 1} is reported`); }
  h.eq(await dead.raster(req('unavailable')), { error: 'Figure raster worker unavailable' }, 'three deaths suppress this owner');
  dead.family.cancelOwner(dead.sender.id);
  h.ok(!!(await dead.raster(req('reset-owner'))).png, 'cancelOwner resets the unavailable owner');
  dead.family.shutdown();
  const failingPool = service(4);
  const dying = Array.from({ length: 4 }, (_, i) => failingPool.raster(req(`pool-death-${i}`, { ...figure, id: `death-figure-${i}` })));
  for (const process of failingPool.processes.slice(0, 3)) process.kill('SIGKILL');
  const suppressed = await Promise.all(dying);
  h.ok(suppressed.every(r => r.error), 'owner backoff settles every running pool job');
  h.eq(suppressed[3], { error: 'Figure raster worker unavailable' }, 'third death also retires the surviving worker');
  failingPool.family.shutdown();
  h.section('detail region pixels, envelope and independent service policy');
  const region = { x: 32, y: 24, w: 192, h: 144 };
  const detailReq = (rid: string, fig = figure, more = {}) => req(rid, fig, { region, width: 192, height: 144, ...more });
  const cropped = await s.raster(detailReq('detail-crop'));
  const wholePixels = pixels(first.png);
  const regionPixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="144"><image width="192" height="144" href="data:image/png;base64,${Buffer.from(cropped.png).toString('base64')}"/></svg>`).render().pixels;
  let differing = 0;
  for (let y = 0; y < 144; y++) for (let x = 0; x < 192; x++) {
    const a = ((y + 24) * 320 + x + 32) * 4, b = (y * 192 + x) * 4;
    if ([0,1,2,3].some(c => Math.abs(wholePixels[a+c] - regionPixels[b+c]) > 2)) differing++;
  }
  h.ok(differing / (192 * 144) <= .005, `region equals whole PNG crop (≤0.5%, actual ${differing / (192 * 144)})`);
  for (const [name, more, error] of [
    ['small', { region: { x: 0, y: 0, w: 40, h: 30 } }, /below the resvg envelope/],
    ['bounds', { region: { x: 200, y: 0, w: 192, h: 144 } }, /region out of bounds/],
    ['detail-budget', { width: 4000, height: 3000 }, /detail exceeds pixel budget/],
    ['detail-side', { width: 8193, height: 1 }, /detail exceeds pixel budget/],
    ['backdrop', { backdrop: 'url(http://remote)' }, /Invalid figure raster backdrop/],
  ] as const) h.ok(error.test((await s.raster(detailReq(`detail-${name}`, figure, more))).error), `${name}: named detail refusal`);
  h.ok(/pixel budget/.test((await s.raster(req('whole-unchanged-budget', figure, { width: 3000, height: 2000 }))).error), 'whole figure retains its 3 MP budget');
  const transparent = { ...figure, background: undefined, elements: [] };
  const matte = await s.raster(detailReq('detail-backdrop', transparent, { backdrop: '#12ab34' }));
  const mattePixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="144"><image width="192" height="144" href="data:image/png;base64,${Buffer.from(matte.png).toString('base64')}"/></svg>`).render().pixels;
  h.eq([...mattePixels.subarray(0,4)], [18,171,52,255], 'detail backdrop fills transparent figure under the crop');
  const clipped = { ...dense, elements: [{ ...dense.elements[0], x: 0, y: 0, width: 900, height: 700 }] };
  const clipSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><clipPath id="c"><rect x="350" y="250" width="30" height="30"/></clipPath></defs><rect x="350" y="250" width="30" height="30" fill="red" clip-path="url(#c)"/></svg>';
  const unsafeSvg = clipSvg.replace('width="400" height="300"', 'width="50" height="37" viewBox="0 0 50 37.5"');
  const abort = spawnSync(process.execPath, ['-e', `new (require('@resvg/resvg-js').Resvg)(${JSON.stringify(unsafeSvg)}).render()`], { cwd: repo, encoding: 'utf8', timeout: 5000 });
  h.ok(abort.signal === 'SIGABRT' && /geom.rs/.test(abort.stderr), 'negative resvg proof: unguarded top-left eighth crop aborts real child');
  const clippedInline = { 'native-dense': `data:image/svg+xml;base64,${Buffer.from(clipSvg).toString('base64')}` };
  h.ok(/below the resvg envelope/.test((await s.raster(detailReq('guarded-eighth', clipped, { region: { x: 0, y: 0, w: 112.5, h: 87.5 }, inlineAssets: clippedInline }))).error), 'same eighth crop is refused before resvg');
  for (const [x, y] of [[0, 0], [540, 420]]) {
    const safe = await s.raster(detailReq(`safe-${x}`, clipped, { region: { x, y, w: 360, h: 280 }, width: 360, height: 280, inlineAssets: clippedInline }));
    h.ok(!!safe.png && !safe.error, `0.4 envelope renders at extreme ${x},${y}: ${safe.error ?? "PNG"}`);
  }
  const buckets = service();
  const block = buckets.raster(req('bucket-block', dense));
  const queuedBase = buckets.raster(req('bucket-base'));
  const queuedDetail = buckets.raster(detailReq('bucket-detail'));
  h.ok(!!(await queuedBase).png && !!(await queuedDetail).png && !!(await block).png, 'queued detail and base do not replace each other');
  buckets.family.shutdown();
  const cancelPool = service();
  const heldBase = cancelPool.raster(req('queue-cancel-block', dense));
  const queuedOnly = cancelPool.raster(detailReq('atlas-D:queued:1'));
  await cancelPool.cancel('atlas-D:queued:1');
  h.eq(await queuedOnly, { cancelled: true }, 'renderer retirement cancels queued detail');
  h.ok(!!(await heldBase).png && cancelPool.processes.length === 1, 'queued detail cancellation does not kill the base worker');
  const runningDetail = cancelPool.raster(detailReq('atlas-D:running:2'));
  await cancelPool.whenRendering('atlas-D:running:2');
  await cancelPool.cancel('atlas-D:running:2');
  h.ok(!!(await runningDetail).png && cancelPool.processes.length === 1, 'renderer cancellation leaves an already-running detail to finish');
  cancelPool.family.shutdown();

  // Real faulting children exercise protocol overflow, timeout and crash in the
  // production owner. After all three, the next spawn is the actual raster worker.
  const faultChild = path.join(scratch, 'fault-child.cjs');
  await fs.writeFile(path.join(scratch, 'seed.png'), first.png);
  await fs.writeFile(faultChild, `const {readFrames,writeFrame}=require(${JSON.stringify(path.join(repo,'electron/sceneRasterProtocol.cjs'))});const fs=require('node:fs');readFrames(process.stdin,(h,b)=>{const r=JSON.parse(b);const mode=process.argv[2];if(mode==='timeout')return;if(mode==='crash')process.exit(7);if(mode==='overflow'){process.stdout.write(Buffer.from([0,0,0,80]));const meta=JSON.stringify({rid:r.rid,bodyBytes:49*1024*1024}).padEnd(80,' ');process.stdout.write(meta);return;}const png=Buffer.alloc(40*1024*1024);fs.readFileSync(${JSON.stringify(path.join(scratch,'seed.png'))}).copy(png);writeFrame(process.stdout,{rid:r.rid,width:r.width,height:r.height},png);},()=>{},96*1024*1024);`);
  const isolated = service(1, 1000, root, 60000, i => i < 3 ? [faultChild, ['overflow','timeout','crash'][i]] : null);
  for (let i = 0; i < 3; i++) h.ok(!!(await isolated.raster(detailReq(`detail-fault-${i}`))).error, `forced detail ${['overflow','timeout','crash'][i]} settles error`);
  h.ok(!!(await isolated.raster(req('base-after-detail-deaths'))).png, 'three detail failures do not disable owner: base PNG still renders');
  isolated.family.shutdown();
  const largeReply = service(1, 15000, root, 60000, () => [faultChild, 'large']);
  const large = await largeReply.raster(detailReq('detail-40MiB', figure, { width: 320, height: 240 }));
  h.eq(large.png?.length, 40 * 1024 * 1024, 'reply reader accepts a real 40 MiB protocol frame');
  largeReply.family.shutdown();
  const affinity = service(2);
  await affinity.raster(req('affinity-fill-A', { ...figure, id: 'affinity-A' }));
  // Two simultaneous jobs force B onto slot 1; afterward slot 0 is free too.
  const busyA = affinity.raster(req('affinity-busy-A', { ...dense, id: 'affinity-A' }));
  const fillB = affinity.raster(req('affinity-fill-B', { ...figure, id: 'affinity-B' }));
  await Promise.all([busyA, fillB]);
  const againB = await affinity.raster(detailReq('affinity-detail-B', { ...figure, id: 'affinity-B' }));
  h.ok(!!againB.png && affinity.processes[1].rids?.includes('affinity-detail-B'), 'detail affinity reuses slot 1 even when slot 0 is free');
  affinity.family.shutdown();
  if (process.env.FLUX_FIGURE_RASTER_BENCHMARK === '1') {
    const perfRoot = path.join(scratch, 'SynapticSleep');
    await fs.cp('/home/driessen2/flux-perf/fixture/SynapticSleep', perfRoot, { recursive: true });
    const perfIndex = JSON.parse(await fs.readFile(path.join(perfRoot, 'fig/index.json'), 'utf8'));
    const perf = service(1, 15000, perfRoot), metrics = [];
    for (const id of ['fig_mvkfjtnbdr68_27', 'fig-1', 'fig_mvoe4440tf97_51', 'fig_mvtu07orsbg8_12']) {
      const entry = perfIndex.figures.find((f: any) => f.id === id);
      const canvas = JSON.parse(await fs.readFile(path.join(perfRoot, `fig/canvases/${entry.canvas}.json`), 'utf8'));
      const model = canvas.figures.find((f: Figure) => f.id === id);
      const scale = Math.min(2, 4096 / Math.max(model.width, model.height), Math.sqrt(2990000 / (model.width * model.height)));
      const request = { rid: `perf-${id}`, root: perfRoot, figure: model, assets: perfIndex.assets, width: Math.ceil(model.width * scale), height: Math.ceil(model.height * scale), scale };
      const before = performance.now();
      const cli = spawnSync(process.execPath, [path.join(repo, 'dist/flux-cli.mjs'), 'render-figure', perfRoot, id, '--png', '--scale', String(scale), '--out', path.join(scratch, `${id}.png`)], { env: process.env, encoding: 'utf8' });
      const cliWall = performance.now() - before;
      h.eq(cli.status, 0, `${id}: comparison CLI renders`);
      const start = performance.now(), cold = await perf.raster(request), coldWall = performance.now() - start;
      h.ok(!!cold.png, `${id}: real-project service PNG (${cold.error ?? 'ok'})`);
      const warmStart = performance.now(), warm = await perf.raster({ ...request, rid: `warm-${id}` }), warmWall = performance.now() - warmStart;
      h.ok(!!warm.png, `${id}: real-project warm service PNG (${warm.error ?? 'ok'})`);
      metrics.push({ id, scale, width: request.width, height: request.height, cliWall, coldWall, warmWall, cold: cold.ms, warm: warm.ms, pngBytes: warm.png?.length });
    }
    const output = process.env.FLUX_OUT || path.join(repo, 'test-results');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'figure-raster-benchmark.json'), JSON.stringify(metrics, null, 2));
    console.log('BENCHMARK ' + JSON.stringify(metrics));
  }
  console.log('TIMING ' + JSON.stringify({ cold: first.ms, warm: moved.ms }));
} catch (error) { h.fail(String(error)); }
finally { for (const family of families) family.shutdown(); await Promise.all(allProcesses.map(proc => proc.closed)); await fs.rm(scratch, { recursive: true, force: true }); }
await h.done();
