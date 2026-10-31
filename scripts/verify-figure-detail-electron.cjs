'use strict';
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
if (!process.versions.electron) {
  (async () => {
    const { harness } = await import('./lib/harness.mjs'), { TestProcessScope } = await import('./lib/testProcess.mjs');
    const h = harness('verify-figure-detail-electron'), scope = new TestProcessScope();
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-detail-electron-')), repo = path.resolve(__dirname, '..');
    const output = process.env.FLUX_OUT || path.join(repo, 'test-results/detail-electron');
    const root = path.join(scratch, 'project');
    const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache'), APPDATA: path.join(scratch, 'appdata'), FLUX_NO_MIGRATE: '1', FLUX_DETAIL_FIXTURE: '1', FLUX_FIGURE_RASTER_WORKERS: '1', PROBE_SCRATCH: scratch, PROBE_PROJECT: root, PROBE_OUTPUT: output };
    delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    try {
      await fsp.mkdir(env.HOME, { recursive: true }); await fsp.mkdir(output, { recursive: true });
      const fixture = scope.spawn(path.join(__dirname, 'lib/figurePolishFixture.ts'), [root], { env, deadlineMs: 30000 });
      if ((await scope.waitExit(fixture)).code !== 0) throw Error(fixture.stderr);
      const child = scope.spawn(require.resolve('electron/cli.js'), [__filename, root, '--no-sandbox', '--force-device-scale-factor=1.25', '--mute-audio'], { env, nodeArgs: [], deadlineMs: 180000 });
      console.log(`DETAIL Electron launcher PID ${child.child.pid}`);
      const status = await scope.waitExit(child); await fsp.writeFile(path.join(output, 'electron.log'), child.stdout + child.stderr);
      console.log(child.stdout.trim());
      if (!fs.existsSync(path.join(output, 'detail.json'))) throw Error(child.stdout + child.stderr);
      const report = JSON.parse(await fsp.readFile(path.join(output, 'detail.json'), 'utf8'));
      for (const c of report.checks) h.ok(c.ok, c.label);
      if (status.code !== 0) throw Error((child.stdout + child.stderr).slice(-7000));
    } catch (e) { h.fail(String(e)); }
    finally { await scope.dispose(); await fsp.rm(scratch, { recursive: true, force: true }); }
    await h.done();
  })();
} else {
  const { app, BrowserWindow, protocol, ipcMain, contentTracing } = require('electron');
  const repo = process.env.FLUX_DETAIL_APP_BASE || path.resolve(__dirname, '..'), root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH, output = process.env.PROBE_OUTPUT;
  if (!scratch || !root || process.env.FLUX_NO_MIGRATE !== '1') throw Error('Isolated detail gate context required');
  app.disableHardwareAcceleration();
  const observed = require('./lib/figureDetailInstrumentation.cjs')({ app, protocol, repo, scratch });
  const checks = [], metrics = { observed }, calls = [];
  const handle = ipcMain.handle.bind(ipcMain);
  let forced = false, hold = false, release, holdBase = false, releaseBase;
  ipcMain.handle = (name, fn) => handle(name, name === 'figure:rasterize' ? async (event, request) => {
    if (!request.region) { const result = await fn(event, request); if (holdBase && request.figure.id === 'detail-1') await new Promise(resolve => { releaseBase = resolve; }); return result; }
    calls.push({ rid: request.rid, id: request.figure.id, t: Date.now(), width: request.width, height: request.height });
    if (forced) return { error: 'Forced detail refusal' };
    const result = await fn(event, request);
    if (hold) await new Promise(resolve => { release = resolve; });
    return result;
  } : fn);
  require(path.join(repo,'electron/main.cjs'));
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const check = (ok, label) => { checks.push({ ok: !!ok, label }); console.log('DETAIL '+JSON.stringify(checks.at(-1))); if (!ok) throw Error(label); };
  async function wait(fn, label, timeout = 15000) { const t = Date.now(); let last; while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e.message; } await sleep(30); } throw Error(`Timeout ${label}: ${last || ''}`); }
  async function click(selector) { const p = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p }); }
  const key = (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  async function wheel(x, y, deltaY, deltaX = 0, modifiers = []) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX, deltaY, modifiers, canScroll: true }); await sleep(25); }
  const read = 's=>{let v;const u=s.subscribe(x=>v=x);u();return v}';
  const state = () => js(`(()=>{const p=window.__figureDetailProbe,r=${read};return {zoom:r(p.viewport).zoom,viewport:r(p.viewport),stats:p.stats.detail||{requests:0,swaps:0},baseFailures:p.stats.failures,rev:r(p.revision),snapshot:p.snapshot,overview:p.overview,details:p.details?[...r(p.details).values()]:[],modes:[...document.querySelectorAll('[data-atlas-mode]')].map(n=>[n.getAttribute('data-annotation-figure'),n.getAttribute('data-atlas-mode')])}})()`);
  async function look(id, zoom = 4) {
    // The viewport is driven by the real Ctrl-wheel and Shift-wheel handlers.
    const host = await js("(()=>{const b=document.querySelector('.figure-mode .canvas-host').getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),left:b.left,top:b.top,w:b.width,h:b.height}})()");
    // Model frame + delivered camera, rather than frozen live SVG bounds while
    // a proxy is carrying the view. The pan itself is native wheel input.
    await sleep(300);
    let s = await state();
    const index = Number(id.split('-')[1]);
    await wheel(host.x, host.y, host.h / 2 - 425 * s.zoom - s.viewport.panY,
      host.w / 2 - (index * 900 + 769 / 2) * s.zoom - s.viewport.panX);
    await sleep(400);
    s = await state();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
    const n = Math.round(Math.log(zoom / s.zoom) / .18);
    for (let i = 0; i < Math.abs(n); i++) await wheel(host.x, host.y, Math.sign(n) * 120, 0, ['control']);
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
    await sleep(450);
    return host;
  }
  async function main() {
    win = await wait(() => BrowserWindow.getAllWindows()[0], 'window'); win.setContentSize(3072, 1696); win.show(); win.focus();
    await wait(() => js("!!document.querySelector('.cm-editor') && !!window.fig"), 'Paper/preload');
    check(app.getPath('userData').startsWith(scratch + path.sep), 'isolated production config');
    check(win.webContents.getURL().startsWith('file:') && await js('!window.__flux'), 'real production bundle and preload');
    await click('button[aria-label=Figure]');
    await wait(() => js('!!window.__figureDetailProbe?.stats && !!document.querySelector(".figure-mode .canvas-host")'), 'production observations');
    metrics.geometry = await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    const ownerGeometry = metrics.geometry.width === 3072 && metrics.geometry.height === 1696 && metrics.geometry.dpr === 1.25;
    if (!ownerGeometry) {
      win.setContentSize(1536, 848); await sleep(100);
      metrics.geometry = await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
      await js(`window.__figureDetailProbe.atlas.detail.maxPixels=${9_000_000 / 4}`);
    }
    metrics.geometry.path = ownerGeometry ? 'owner' : 'half-size scaled budget';
    check(ownerGeometry || metrics.geometry.width === 1536 && metrics.geometry.height === 848 && metrics.geometry.dpr === 1.25, 'owner viewport/DPR geometry or documented proportional fallback');
    await click('.figrow[data-fig-id="detail-0"] .item');
    await wait(async () => (await state()).modes.filter(([id, mode]) => id !== 'detail-0' && mode === 'raster').length >= 1, 'base pictures');
    check((await state()).stats.requests === 0, 'no detail requested at open');
    await js(`(()=>{const p=window.__figureDetailProbe,r=${read};window.__detailSamples=[];window.__detailRevoked=[];window.__detailRetired=[];window.__detailUrlMs={};const makeUrl=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{const t=performance.now(),u=makeUrl(b);window.__detailUrlMs[u]=performance.now()-t;return u};window.__detailLong=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=u=>{window.__detailRevoked.push(u);revoke(u)};new PerformanceObserver(l=>window.__detailLong.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false});let initial=true,previous=new Map,serial=0;p.details?.subscribe(next=>{if(initial){initial=false;previous=next;return}const additions=[...next.values()].filter(d=>d.shown&&previous.get(d.figureId)?.url!==d.url);const publish=additions.length>0,urlMs=additions.reduce((n,d)=>n+(window.__detailUrlMs[d.url]||0),0);for(const d of previous.values())if(next.get(d.figureId)?.url!==d.url)window.__detailRetired.push(d.url);previous=next;const mark='detail-swap-'+(++serial);if(publish)performance.mark(mark+'-start');const before={rev:r(p.revision),snapshot:p.snapshot,overview:p.overview};const t=performance.now();queueMicrotask(()=>{const sync=performance.now()-t;requestAnimationFrame(()=>{const a=performance.now();requestAnimationFrame(()=>{if(publish)performance.mark(mark+'-end');window.__detailSamples.push({mark,publish,urlMs,before,after:{rev:r(p.revision),snapshot:p.snapshot,overview:p.overview},sync,frameGap:performance.now()-a})})})})})})()`);
    await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'blink.user_timing'], excluded_categories: ['*'] });
    const sharpStart = Date.now();
    const host = await look('detail-1');
    await wait(async () => (await state()).details.some(d => d.figureId === 'detail-1' && d.shown), 'sharp non-active detail', 10000);
    check(Date.now() - sharpStart < 2000, 'detail appears within two seconds of zoom settling');
    let s = await state(), detail = s.details.find(d => d.figureId === 'detail-1');
    metrics.first = { zoom: s.zoom, detail, stats: s.stats }; delete metrics.first.detail.url;
    const view = await js(`(()=>{const r=${read},v=r(window.__figureDetailProbe.viewport),b=document.querySelector('.canvas-host').getBoundingClientRect();return{x:-v.panX/v.zoom-900,y:-v.panY/v.zoom,w:b.width/v.zoom,h:b.height/v.zoom}})()`);
    check(detail.S >= s.zoom * 1.25 / 1.25, 'detail S ≥ need/1.25');
    check(detail.region.x <= Math.max(0,view.x)+1e-6 && detail.region.y <= Math.max(0,view.y)+1e-6 && detail.region.x+detail.region.w >= Math.min(769,view.x+view.w)-1e-6 && detail.region.y+detail.region.h >= Math.min(850,view.y+view.h)-1e-6, 'detail covers view intersect figure');
    check(await js(`(async()=>{const n=document.querySelector('[data-figure-detail="detail-1"]'),i=new Image();i.src=n.getAttribute('href');await i.decode();return i.naturalWidth>0})()`), 'published blob image is decoded');
    const { shot } = await import('./lib/driver.mjs');
    await shot({ screenshot: ({path:file}) => win.webContents.capturePage().then(img => fsp.writeFile(file,img.toPNG())) }, 'detail-sharp');
    await sleep(3000);
    const before = await state(), oldHref = detail.url;
    await wheel(host.x,host.y,0,2); await sleep(1200);
    check((await state()).stats.requests === before.stats.requests, 'pan under snap makes zero requests');
    // Force an uncovered region, hold the real IPC reply, and deliver it inside a held press.
    hold = true; await wheel(host.x,host.y,0,-400); await wait(()=>release,'held worker reply');
    const atPress = await state();
    win.webContents.sendInputEvent({type:'mouseDown',button:'middle',clickCount:1,x:host.x,y:host.y});
    await js('new Promise(r=>requestAnimationFrame(r))');
    release(); release = null; hold = false;
    for(let i=0;i<12;i++){win.webContents.sendInputEvent({type:'mouseMove',button:'middle',modifiers:['middleButtonDown'],x:host.x+(i%2?10:0),y:host.y});await sleep(30)}
    await sleep(250);
    const held = await state();
    check(held.stats.decodes === atPress.stats.decodes && held.stats.swaps === atPress.stats.swaps, 'mid-pan reply has no decode or publish');
    check(held.details.find(d=>d.figureId==='detail-1')?.url === atPress.details.find(d=>d.figureId==='detail-1')?.url, 'mid-pan reply has no href write/hide');
    const restCalls = calls.length;
    win.webContents.sendInputEvent({type:'mouseUp',button:'middle',clickCount:1,x:host.x,y:host.y});
    await wait(async()=> (await state()).stats.swaps > held.stats.swaps,'held result publishes after release and quiet');
    await sleep(1200);
    const settledCalls = calls.slice(restCalls), perFigure = new Map();
    for(const c of settledCalls)perFigure.set(c.id,(perFigure.get(c.id)||0)+1);
    check([...perFigure.values()].every(n=>n<=1),'one rest requests at most one detail per in-view figure');
    check(settledCalls.reduce((n,c)=>n+c.width*c.height,0)<=9_000_000/(ownerGeometry?1:4),'one settle respects the total view pixel budget');
    const samples = await js('window.__detailSamples'); metrics.samples = samples;
    check(samples.every(v=>v.before.rev===v.after.rev && v.before.snapshot===v.after.snapshot && v.before.overview===v.after.overview), 'detail publication/hide leaves atlas revision and proxy generations unchanged');
    check(samples.every(v=>v.sync<=16), 'detail swap synchronous slices ≤16 ms');
    // Below-cap hide, followed by a content edit through native activation/nudge.
    await look('detail-1',1); await sleep(800);
    check(!(await state()).details.some(d=>d.figureId==='detail-1'&&d.shown), 'zoom below cap stops drawing detail');
    await look('detail-1',4); await wait(async()=> (await state()).details.some(d=>d.figureId==='detail-1'&&d.shown),'detail restored');
    const keyBefore = (await state()).details.find(d=>d.figureId==='detail-1').key;
    holdBase = true;
    const bridge = await wait(()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'.meta/live/bridge.json'),'utf8'))}catch{return null}},'project live bridge');
    const edited = await fetch(bridge.url+'/dispatch',{method:'POST',headers:{authorization:`Bearer ${bridge.token}`,'content-type':'application/json'},body:JSON.stringify({type:'rotate',ids:['detail-photo-1'],deg:1})}).then(r=>r.json());
    check(edited.ok===true,'content edit uses the real authenticated project bridge');
    await wait(async()=>!(await state()).details.some(d=>d.figureId==='detail-1'),'stale detail removed before base reply');
    check(await js(`document.querySelector('[data-figure-raster="detail-1"]')?.getAttribute('data-raster-key')===${JSON.stringify(keyBefore)}`),'stale detail gone while old base is still displayed');
    await wait(()=>releaseBase,'renewed base held');holdBase=false;releaseBase();releaseBase=null;
    await wait(async()=> (await state()).details.some(d=>d.figureId==='detail-1'&&d.key!==keyBefore),'fresh current-key detail after base renewal');
    await click('.figrow[data-fig-id="detail-1"] .item');
    await wait(()=>js("document.querySelector('[data-annotation-figure=\"detail-1\"]')?.getAttribute('data-atlas-mode')==='warming'"),'activation warming');
    check(await js("!!document.querySelector('[data-annotation-figure=\"detail-1\"] [data-figure-detail]')"), 'detail remains behind activation warming slots');
    await wait(()=>js("document.querySelector('[data-annotation-figure=\"detail-1\"]')?.getAttribute('data-atlas-mode')==='live'"),'activation live');
    check(!(await state()).details.some(d=>d.figureId==='detail-1'), 'detail dropped when figure becomes live');
    await shot({ screenshot: ({path:file}) => win.webContents.capturePage().then(img => fsp.writeFile(file,img.toPNG())) }, 'detail-live');
    // Native select-all/nudge and deactivation exercise model-key invalidation.
    key('a',['control']); key('Right'); await sleep(100); await click('.figrow[data-fig-id="detail-0"] .item');
    await look('detail-1',4);
    await wait(async()=> (await state()).details.some(d=>d.figureId==='detail-1'&&d.shown),'fresh detail after edited base');
    forced=true; const refusalBefore=await state(); const nodesBefore=await js("document.querySelectorAll('[data-editor-element-id]').length");
    await wheel(host.x,host.y,0,400); await wait(async()=> {const t=await state();return t.stats.refused>refusalBefore.stats.refused||t.baseFailures>refusalBefore.baseFailures||t.modes.find(([id])=>id==='detail-1')?.[1]!=='raster'},'forced detail refusal');
    check((await state()).baseFailures===refusalBefore.baseFailures && (await state()).modes.find(([id])=>id==='detail-1')?.[1]==='raster' && await js("document.querySelectorAll('[data-editor-element-id]').length")===nodesBefore, 'detail refusal preserves base raster mode and mounted nodes'); forced=false;
    // Real wheel navigation visits four pictures; retention is bounded, URLs retired.
    for(const id of ['detail-2','detail-3','detail-4','detail-5']) { await look(id,4); await wait(async()=> (await state()).details.some(d=>d.figureId===id&&d.shown),`visit ${id}`); }
    await sleep(100);s=await state();
    const inView=s.details.filter(d=>d.shown).length;
    check(s.details.length<=inView+2,'retention ≤ in-view +2 after four visits');
    check(await js('window.__detailRetired.length>0 && window.__detailRetired.every(u=>window.__detailRevoked.includes(u))'),'all retired detail blob URLs revoked');
    // Compare pixels of the REAL rendered base and detail at the same empty
    // location on the translucent page, using the supported detail A/B switch.
    const backgroundPixel = async () => {
      const at = await js(`(()=>{const p=window.__figureDetailProbe,r=${read},v=r(p.viewport),b=document.querySelector('.figure-mode .canvas-host').getBoundingClientRect();return{x:Math.round(b.left+(4500+370)*v.zoom+v.panX),y:Math.round(b.top+425*v.zoom+v.panY),width:2,height:2}})()`);
      const png=await win.webContents.capturePage(at), bytes=png.toBitmap();return [bytes[2],bytes[1],bytes[0],bytes[3]];
    };
    await js('window.__figureDetailProbe.atlas.detail.enabled=false');await wheel(host.x,host.y,0,2);
    await wait(async()=>!(await state()).details.some(d=>d.figureId==='detail-5'),'translucent base-only control');await sleep(500);
    const basePixel=await backgroundPixel();
    await js('window.__figureDetailProbe.atlas.detail.enabled=true');await wheel(host.x,host.y,0,-2);
    await wait(async()=> (await state()).details.some(d=>d.figureId==='detail-5'&&d.shown),'translucent detail restored');await sleep(100);
    const detailPixel=await backgroundPixel();metrics.translucent={basePixel,detailPixel};
    check(basePixel[0]>80 && basePixel[0]<240 && basePixel.every((v,i)=>Math.abs(v-detailPixel[i])<=2),'translucent detail matches the actual base background without a halo');
    await shot({ screenshot: ({path:file}) => win.webContents.capturePage().then(img => fsp.writeFile(file,img.toPNG())) }, 'detail-transparent');
    s=await state();
    metrics.final=s; metrics.calls=calls; metrics.longtasks=await js('window.__detailLong');
    const traceFile=await contentTracing.stopRecording(path.join(output,'detail-trace.json'));
    const events=JSON.parse(fs.readFileSync(traceFile,'utf8')).traceEvents;
    const starts=new Map, windows=[];
    for(const e of events) if(e.name?.startsWith('detail-swap-')) { const k=e.name.replace(/-(start|end)$/,'');if(e.name.endsWith('-start'))starts.set(k,e);else if(e.name.endsWith('-end')&&starts.has(k))windows.push({mark:k,a:starts.get(k).ts,b:e.ts,pid:e.pid,tid:e.tid}); }
    metrics.swapSamples=await js('window.__detailSamples');
    metrics.swapSlices=windows.map(w=>{
      const spans=events.filter(e=>e.ph==='X'&&e.pid===w.pid&&e.tid===w.tid&&['FunctionCall','UpdateLayoutTree','Layout','PrePaint','Paint','Layerize'].includes(e.name)&&e.ts<w.b&&e.ts+e.dur>w.a).map(e=>[Math.max(w.a,e.ts),Math.min(w.b,e.ts+e.dur)]).sort((a,b)=>a[0]-b[0]);
      let end=0,us=0;for(const [a,b]of spans){us+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b)}return us/1000+(metrics.swapSamples.find(s=>s.mark===w.mark)?.urlMs||0);
    });
    check(metrics.swapSlices.length>0 && metrics.swapSlices.every(ms=>ms<=16),'measured URL creation + publish + style/layout/paint slices total ≤16 ms');
    console.log('DETAIL METRICS '+JSON.stringify({geometry:metrics.geometry,stats:s.stats,longtasks:metrics.longtasks,samples}));
  }
  async function finish(code,error) { if(error){console.error(error);checks.push({ok:false,label:String(error)})}if(error){try{metrics.failureState=await state()}catch{}try{await contentTracing.stopRecording(path.join(output,'failed-trace.json'))}catch{}}fs.writeFileSync(path.join(output,'detail.json'),JSON.stringify({checks,metrics},null,2)); if(win&&!win.isDestroyed())win.destroy();app.exit(code); }
  app.whenReady().then(main).then(()=>finish(0),e=>finish(1,e));
}
