// Actual dedicated Node child + supervision; no browser, project or live config.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harness } from './lib/harness.mjs';
const h = harness('verify-scene-raster'), require = createRequire(import.meta.url), repo = resolve(import.meta.dirname, '..');
const { createSceneRasterFamily } = require('../electron/ipc/sceneRaster.cjs');
const { validateSceneRequest } = require('../electron/sceneRasterRules.cjs');
const { Resvg } = require('@resvg/resvg-js');
const { rasterizeScene } = await import('../electron/sceneRasterEngine.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'flux-scene-raster-'));
const families: any[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#ffffff"/><rect x="30" y="10" width="40" height="30" fill="#ff0000"/></svg>';
const region = { bx: 0, by: 0, bw: 100, bh: 60, width: 100, height: 60 };
const request = (rid: string, text = svg, regions = [region]) => ({ rid, svg: text, regions });
function pixels(bytes: Buffer | Uint8Array, width: number, height: number) {
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(bytes).toString('base64')}"/></svg>`).render().pixels as Buffer;
}
function synchronousRender(source: string, options: any) {
  const renderer = new Resvg(source, options);
  if (renderer.imagesToResolve().length) throw Error('Unresolved reference image');
  return renderer.render();
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000 && !predicate(); i++) await turn();
  if (!predicate()) throw Error('Native dispatch did not reach expected state');
}
function sender(id: number) { const s: any = new EventEmitter(); s.id = id; s.destroyed = false; s.isDestroyed = () => s.destroyed; s.destroy = () => { s.destroyed = true; s.emit('destroyed'); }; return s; }
function service(options: any = {}) {
  let generation = 1, root = '/isolated/project';
  const handlers = new Map(), processes: any[] = [], spawnOptions: any[] = [];
  const family = createSceneRasterFamily({ app: { isPackaged: false }, appRoot: repo, rootFor: () => root, generationFor: () => generation, fontIndexFile: () => join(scratch, 'font-index.json'), ...options,
    spawnProcess: (exe: string, args: string[], opts: any) => { const proc = (options.spawnProcess ?? spawn)(exe, args, opts); processes.push(proc); spawnOptions.push(opts); return proc; } });
  family.registerHandlers({ handle: (name: string, handler: any) => handlers.set(name, handler) }); families.push(family);
  const event = { sender: sender(1) };
  return { family, processes, spawnOptions, event, raster: (r: any, e = event) => handlers.get('scene:rasterize')(e, r), cancel: (rid: string, e = event) => handlers.get('scene:cancelRaster')(e, rid), switchRoot: () => { root = '/isolated/other'; generation++; } };
}
try {
  h.section('bounded world regions and actual pixels');
  const r = await rasterizeScene(request('regions', svg, [{ bx: 30, by: 10, bw: 40, bh: 30, width: 80, height: 60 }, region]));
  h.eq(r.rasters.map((v: any) => [v.width, v.height]), [[80, 60], [100, 60]], 'sharp and coarse PNG dimensions are exact');
  h.eq([...pixels(r.rasters[0].bytes, 80, 60).subarray(0, 4)], [255, 0, 0, 255], 'world crop maps to the sharp raster rather than scaling the whole scene');
  const base = pixels(r.rasters[1].bytes, 100, 60);
  h.eq([...base.subarray((20 * 100 + 40) * 4, (20 * 100 + 40) * 4 + 4)], [255, 0, 0, 255], 'coarse region retains the same painted geometry');
  h.eq([...base.subarray(0, 4)], [255, 255, 255, 255], 'coarse region also retains the surrounding background');
  const rasterImage = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><image x="0" y="0" width="100" height="60" href="data:image/png;base64,${r.rasters[1].bytes.toString('base64')}"/></svg>`;
  const imageResult = await rasterizeScene(request('image', rasterImage));
  h.eq(Buffer.compare(pixels(imageResult.rasters[0].bytes, 100, 60), base), 0, 'embedded data PNG survives the actual child renderer');
  h.section('parallel native parity, ordering and atomic failure');
  const parityRegions = [{ bx: 12, by: 4, bw: 60, bh: 42, width: 201, height: 140 }, { ...region, width: 120, height: 72 }];
  const clippedText = '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip"><rect x="6" y="2" width="84" height="54"/></clipPath><path id="baseline" d="M4 48H96"/><rect id="local" width="8" height="8" fill="green"/></defs><g clip-path="url(#clip)"><use href="#local" x="10" y="5"/><g transform="translate(3 0)"><path d="M30 3v54" stroke="red" stroke-width="3" vector-effect="non-scaling-stroke"/></g><text x="5" y="27" font-family="Gelasio" font-size="13" font-weight="600" font-style="normal">Frame<tspan font-size="75%">small</tspan></text><text font-family="sans-serif" font-size="9"><textPath href="#baseline">curve sample</textPath></text></g></svg>';
  for (const [label, source] of [['geometry', svg], ['clipped-font-stroke', clippedText], ['data-png', rasterImage]]) {
    const parallel = await rasterizeScene(request(`parallel-${label}`, source, parityRegions));
    const reference = await rasterizeScene(request(`reference-${label}`, source, parityRegions), synchronousRender);
    h.eq(parallel.rasters.map((p: any) => [p.width, p.height]), reference.rasters.map((p: any) => [p.width, p.height]), `${label}: parallel native dimensions match synchronous reference in region order`);
    for (let i = 0; i < reference.rasters.length; i++) {
      const actual = parallel.rasters[i], expected = reference.rasters[i];
      h.eq(Buffer.compare(actual.bytes, expected.bytes), 0, `${label} plane ${i}: PNG bytes match synchronous native rendering exactly`);
      h.eq(Buffer.compare(pixels(actual.bytes, actual.width, actual.height), pixels(expected.bytes, expected.width, expected.height)), 0, `${label} plane ${i}: every decoded pixel matches`);
    }
  }
  const held: { source: string; options: any; resolve: (image: any) => void; reject: (error: Error) => void }[] = [];
  const heldRender = (source: string, options: any) => new Promise((resolve, reject) => held.push({ source, options, resolve, reject }));
  let settled = false;
  const ordered = rasterizeScene(request('held-order', svg, parityRegions), heldRender).then(value => { settled = true; return value; });
  await until(() => held.length === 2);
  h.eq(held.length, 2, 'both native regions are dispatched before either completes');
  held[1].resolve(synchronousRender(held[1].source, held[1].options)); await turn();
  h.ok(!settled, 'later region finishing first cannot publish a partial response');
  held[0].resolve(synchronousRender(held[0].source, held[0].options));
  h.eq((await ordered).rasters.map((p: any) => p.width), parityRegions.map(r => r.width), 'completion order never reorders sharp and coarse planes');
  held.length = 0; settled = false;
  const failing = rasterizeScene(request('held-failure', svg, parityRegions), heldRender).then(() => { settled = true; return ''; }, error => { settled = true; return String(error); });
  await until(() => held.length === 2);
  held[0].reject(Error('deliberate native failure')); await turn();
  h.ok(!settled, 'failed native region waits for its sibling before releasing the worker');
  held[1].resolve(synchronousRender(held[1].source, held[1].options));
  h.ok((await failing).includes('deliberate native failure'), 'one native failure yields an atomic error after all work retires');
  const stroke = await rasterizeScene(request('stroke', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M50 5V55" stroke="red" stroke-width="4" vector-effect="non-scaling-stroke"/></svg>', [{ ...region, width: 200, height: 120 }]));
  const strokePixels = pixels(stroke.rasters[0].bytes, 200, 120); let strokeWidth = 0;
  for (let x = 0; x < 200; x++) if (strokePixels[(50 * 200 + x) * 4 + 3]) strokeWidth++;
  h.eq(strokeWidth, 4, 'non-scaling stroke keeps its captured screen width');
  const directGridClip = '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="gridclip"><rect x="20" y="10" width="60" height="40"/></clipPath></defs><path d="M50 0V60" fill="none" stroke="red" stroke-width="4" vector-effect="non-scaling-stroke" clip-path="url(#gridclip)"/></svg>';
  const clippedGrid = await rasterizeScene(request('direct-grid-clip', directGridClip, [{ ...region, width: 200, height: 120 }]));
  // Independent screen-space oracle: neither the compatibility compiler nor
  // vector-effect participates in this expected geometry or clip.
  const expectedGrid = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs><clipPath id="screen"><rect x="40" y="20" width="120" height="80"/></clipPath></defs><path d="M100 0V120" fill="none" stroke="red" stroke-width="4" clip-path="url(#screen)"/></svg>').render().pixels;
  h.eq(Buffer.compare(pixels(clippedGrid.rasters[0].bytes, 200, 120), expectedGrid), 0, '2x grid pixels preserve a directly owned user-space clip without overflow');
  const translatedGrid = await rasterizeScene(request('translated-grid-clip', directGridClip.replace('d="M50', 'transform="translate(5 0)" d="M50'), [{ ...region, width: 200, height: 120 }]));
  const expectedTranslated = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs><clipPath id="screen"><rect x="50" y="20" width="120" height="80"/></clipPath></defs><path d="M110 0V120" fill="none" stroke="red" stroke-width="4" clip-path="url(#screen)"/></svg>').render().pixels;
  h.eq(Buffer.compare(pixels(translatedGrid.rasters[0].bytes, 200, 120), expectedTranslated), 0, 'direct clip and original leaf translation remain in the same coordinate frame');
  const scopedPlot = directGridClip.replace('</svg>', '<svg data-plot-scope="supplement"><style>[data-plot-scope="supplement"] * {stroke-linejoin:round;stroke-linecap:butt}</style></svg></svg>');
  const scopedGrid = await rasterizeScene(request('scoped-sheet-grid', scopedPlot, [{ ...region, width: 200, height: 120 }]));
  h.eq(Buffer.compare(pixels(scopedGrid.rasters[0].bytes, 200, 120), expectedGrid), 0, 'scoped Matplotlib sheets from detached supplements do not disable scene grid capture');
  const bboxClip = '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="bbox" clipPathUnits="objectBoundingBox"><rect x="0.25" y="0.25" width="0.5" height="0.5"/></clipPath></defs><rect x="10" y="10" width="80" height="40" fill="blue" stroke="red" stroke-width="4" vector-effect="non-scaling-stroke" clip-path="url(#bbox)"/></svg>';
  const bboxRaster = await rasterizeScene(request('object-bbox-grid', bboxClip, [{ ...region, width: 200, height: 120 }]));
  const bboxExpected = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="60" y="40" width="80" height="40" fill="blue"/></svg>').render().pixels;
  h.eq(Buffer.compare(pixels(bboxRaster.rasters[0].bytes, 200, 120), bboxExpected), 0, 'objectBoundingBox clip retains the original leaf fill bounds on the outer wrapper');
  for (const [label, content] of [
    ['stylesheet VE', '<style>.nss{vector-effect:non-scaling-stroke}</style><path class="nss" d="M50 5V55" stroke="red" stroke-width="4"/>'],
    ['VE gradient', '<defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient></defs><g stroke="url(#paint)"><path d="M50 5V55" stroke-width="4" vector-effect="non-scaling-stroke"/></g>'],
    ['VE mask', '<defs><mask id="mask"><rect width="100" height="60" fill="white"/></mask></defs><path d="M50 5V55" stroke="red" vector-effect="non-scaling-stroke" mask="url(#mask)"/>'],
    ['VE filter', '<defs><filter id="filter"><feGaussianBlur stdDeviation="1"/></filter></defs><path d="M50 5V55" stroke="red" vector-effect="non-scaling-stroke" filter="url(#filter)"/>'],
    ['VE CSS clip', '<defs><clipPath id="cssclip"><rect width="60" height="40"/></clipPath></defs><style>.clipped{clip-path:url(#cssclip)}</style><path class="clipped" d="M50 5V55" stroke="red" vector-effect="non-scaling-stroke"/>'],
    ['VE CSS mask', '<style>.masked{mask:url(#mask)}</style><path class="masked" d="M50 5V55" stroke="red" vector-effect="non-scaling-stroke"/>'],
    ['VE CSS paint', '<style>.painted{stroke:url(#paint)}</style><path class="painted" d="M50 5V55" vector-effect="non-scaling-stroke"/>'],
    ['VE root plot scope', '<g data-plot-scope="root"><style>[data-plot-scope="root"] path{clip-path:url(#clip)}</style><path d="M50 5V55" vector-effect="non-scaling-stroke"/></g>'],
  ]) {
    let rejected = false; try { await rasterizeScene(request(label.replaceAll(' ', '-'), `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`)); } catch { rejected = true; }
    h.ok(rejected, `${label} fails closed instead of silently changing pixels`);
  }
  const shifted = await rasterizeScene(request('shift-stroke', '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(10 0)"><path d="M40 5v50" style="stroke:red;stroke-width:4;vector-effect:non-scaling-stroke"/></g></svg>', [{ ...region, width: 201, height: 120 }, region]));
  h.ok(shifted.rasters.length === 2, 'translated non-scaling paths support independently rounded axes and repeated regions');
  let complexRejected = false; try { await rasterizeScene(request('complex-stroke', '<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(2 3)"><path d="M5 5L10 10" stroke="red" vector-effect="non-scaling-stroke"/></g></svg>')); } catch { complexRejected = true; }
  h.ok(complexRejected, 'complex non-scaling transforms fail closed rather than changing stroke geometry');
  for (const bad of [request('overside', svg, [{ ...region, width: 4097 }]), request('overpixels', svg, [{ ...region, width: 2000, height: 2000 }]), request('overcoarse', svg, [region, { ...region, width: 2000, height: 1000 }]), request('nan', svg, [{ ...region, bx: NaN }]), request('many', svg, [region, region, region]), request('oversvg', ' '.repeat(64 * 1024 * 1024 + 1))]) {
    let rejected = false; try { validateSceneRequest(bad); } catch { rejected = true; } h.ok(rejected, `${bad.rid} is rejected before spawning`);
  }
  h.section('resource containment and exact bundled font faces');
  for (const [label, content] of [
    ['file', '<image href="file:///etc/passwd"/>'], ['network', '<image href="https://example.invalid/secret.png"/>'], ['entity', '<image href="&#102;ile:///etc/passwd"/>'],
    ['css', '<style>rect { fill:url(https://example.invalid/a.svg) }</style>'], ['escaped css', '<style>rect { fill:u\\72l(https://example.invalid/a.svg) }</style>'],
    ['nested svg', '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'], ['base', '<g xml:base="file:///etc/"/>'], ['foreign', '<foreignObject/>'],
    ['image fragment', '<defs><rect id="local" width="4" height="4"/></defs><image href="#local"/>'],
    ['namespaced image fragment', '<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="&#35;missing"/>'],
    ['filter image fragment', '<filter id="f"><feImage href="#missing"/></filter>'],
    ['font file', '<style>@font-face{font-family:Gelasio;src:url(file:///tmp/secret.ttf)}</style>'],
    ['font network', '<style>@font-face{font-family:Gelasio;src:url(https://example.invalid/secret.ttf)}</style>'],
    ['custom embedded font', '<style>@font-face{font-family:CustomFace;src:url(data:font/ttf;base64,AA==)}</style><text font-family="CustomFace">private</text>'],
    ['xml entity declaration', '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///tmp/secret">]><text>&secret;</text>'],
    ['stylesheet import', '<style>@import "https://example.invalid/secret.css";</style>'],
  ]) {
    let rejected = false, dispatched = false;
    try { await rasterizeScene(request(label.replaceAll(' ', '-'), `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`), () => { dispatched = true; throw Error('unsafe native dispatch'); }); } catch { rejected = true; }
    h.ok(rejected, `${label} resource is refused before resvg can resolve it`);
    h.ok(!dispatched, `${label} cannot reach the native file/network resolver`);
  }
  const trustedFace = await rasterizeScene(request('bundled-face-css', '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:"Gelasio";src:url(data:font/woff2;base64,AA==)}</style><text x="0" y="20" font-family="Gelasio">bundled</text></svg>'));
  h.ok(trustedFace.rasters[0].bytes.length > 100, 'bundled-family CSS retains the trusted bundled font path');
  const fonts = new Map();
  for (const [weight, style] of [[400, 'normal'], [600, 'normal'], [700, 'normal'], [400, 'italic']] as const) {
    const rendered = await rasterizeScene(request(`font-${weight}-${style}`, `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="60"><text x="1" y="40" font-size="40" font-family="Gelasio" font-weight="${weight}" font-style="${style}">Gelasio sample</text></svg>`, [{ ...region, bw: 340, width: 340 }]));
    const rgba = pixels(rendered.rasters[0].bytes, 340, 60); let ink = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) ink++;
    h.ok(ink > 2000, `bundled ${weight} ${style} paints real glyphs`); fonts.set(`${weight}-${style}`, rendered.rasters[0].bytes.toString('base64'));
  }
  h.eq(new Set(fonts.values()).size, 4, '400, 600, 700 and italic select four distinct authored faces');
  let rejected = false; try { await rasterizeScene(request('unsupported-italic', '<svg xmlns="http://www.w3.org/2000/svg"><g font-family="Gelasio" font-weight="700"><text font-style="italic">Unsupported</text></g></svg>')); } catch (e) { rejected = /Gelasio/.test(String(e)); }
  h.ok(rejected, 'inherited Gelasio bold italic fails closed instead of losing its weight');
  const mixed = await rasterizeScene(request('mixed-fonts', '<svg xmlns="http://www.w3.org/2000/svg"><style>.math { font-style:italic }</style><text x="0" y="20" style="font-family:Gelasio;font-weight:600;font-style:normal">Frame</text><text class="math" x="0" y="40" style="font-family:Arial;font-weight:400;font-style:italic">Math</text></svg>'));
  h.ok(mixed.rasters[0].bytes.length > 100, 'baked Arial italic CSS and a Gelasio frame coexist without a false fallback');

  h.section('real child, queue, owner changes and process cleanup');
  const faultWorker = join(scratch, 'fault-worker.mjs');
  writeFileSync(faultWorker, `import{createRequire}from'node:module';const{readFrames,writeFrame}=createRequire(import.meta.url)(${JSON.stringify(join(repo, 'electron/sceneRasterProtocol.cjs'))});readFrames(process.stdin,async(h,b)=>{if(h.rid==='hang')return;if(h.rid==='crash')process.exit(7);if(h.rid==='outoforder')writeFrame(process.stdout,{rid:'retired-capture',rasters:[]},Buffer.alloc(0));const{rasterizeScene}=await import(${JSON.stringify(pathToFileURL(join(repo, 'electron/sceneRasterEngine.mjs')).href)});try{const r=await rasterizeScene({rid:h.rid,regions:h.regions,svg:b.toString()});writeFrame(process.stdout,{rid:h.rid,rasters:r.rasters.map(x=>({width:x.width,height:x.height,byteLength:x.bytes.length}))},Buffer.concat(r.rasters.map(x=>x.bytes)))}catch(e){writeFrame(process.stdout,{rid:h.rid,error:e.message},Buffer.alloc(0))}},()=>process.exit(2));`);
  const faultSpawn = (exe: string, args: string[], opts: any) => spawn(exe, [args[0], faultWorker], opts);
  const s = service({ spawnProcess: faultSpawn });
  const active = s.raster(request('hang')), superseded = s.raster(request('old')), latest = s.raster(request('latest'));
  h.ok((await superseded).cancelled, 'only the latest queued capture is retained');
  s.cancel('hang'); h.ok((await active).cancelled, 'cancelling an active raster resolves its caller');
  const latestResult = await latest; h.ok(latestResult.rasters?.[0].bytes.length > 8, 'latest queued raster starts after the cancelled process is killed');
  h.ok(s.processes[0].killed, 'active cancellation kills actual ongoing child work');
  h.ok((await s.raster(request('outoforder'))).rasters, 'a stale out-of-order worker reply cannot settle the active capture');
  const stale = s.raster(request('stale')); s.switchRoot(); h.ok((await stale).cancelled, 'a project/generation change discards in-flight pixels');
  const other = { sender: sender(2) }, own = s.raster(request('hang')), neighboring = s.raster(request('neighbor'), other);
  s.cancel('hang', other); h.ok((await neighboring).rasters, 'another window cannot cancel this owner request');
  s.event.sender.destroy(); h.ok((await own).cancelled, 'sender destruction cancels and kills its outstanding work');
  h.eq(s.event.sender.listenerCount('destroyed'), 0, 'destroyed sender listener is released');
  const fault = service({ spawnProcess: faultSpawn, timeoutMs: 150 });
  const timeout = await fault.raster(request('hang')); h.ok(/timed out/.test(timeout.error), 'a stalled child is terminated at the watchdog');
  const crash = service({ spawnProcess: faultSpawn });
  h.ok(/exited/.test((await crash.raster(request('crash'))).error), 'a real worker crash is contained and reported');
  h.ok((await crash.raster(request('after-crash'))).rasters, 'the next capture works after a worker crash');
  const stop = service({ spawnProcess: faultSpawn }), stopping = stop.raster(request('hang')), queued = stop.raster(request('queued'));
  stop.family.shutdown(); h.ok((await stopping).cancelled && (await queued).cancelled, 'shutdown resolves active and queued captures');
  h.ok((await stop.raster(request('after-stop'))).cancelled, 'closed service never restarts a worker');
  const actual = service(); const actualResult = await actual.raster(request('production-worker', svg, [region, { ...region, width: 80, height: 48 }]));
  h.ok(actualResult.rasters?.[0].bytes.length > 8, 'unmodified production worker protocol returns actual PNG bytes');
  h.eq(actualResult.rasters?.map((r: any) => [r.width, r.height]), [[100, 60], [80, 48]], 'production child returns both concurrent planes in request order');
  h.eq(actual.spawnOptions[0].env.UV_THREADPOOL_SIZE, '2', 'dedicated child caps native async work at two threads');
  h.ok(readFileSync(join(repo, 'resources/fonts/OFL.txt'), 'utf8').includes('SIL OPEN FONT LICENSE'), 'derived font faces retain their upstream license');
} catch (error) { h.fail(String(error)); console.error(error); }
await h.done(async () => { for (const family of families) family.shutdown(); rmSync(scratch, { recursive: true, force: true }); });
