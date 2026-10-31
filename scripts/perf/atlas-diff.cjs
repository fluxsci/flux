'use strict';
// QA-P2 measurement (R3): Route C picture vs the live Chromium render of the same figure at the same scale, owner project copy.
// usage: node atlas-diff.cjs <repo> <project> <outDir> <devUrl>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.versions.electron) {
  const [repo, src, out, devUrl] = process.argv.slice(2);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-p2-diff-')), project = path.join(scratch, 'project');
  fs.cpSync(src, project, { recursive: true, filter: p => !/[\\/]\.meta[\\/](locks|live)([\\/]|$)/.test(p) });
  for (const d of ['home', 'xdg']) fs.mkdirSync(path.join(scratch, d), { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'), FLUX_NO_MIGRATE: '1', VITE_DEV_SERVER_URL: devUrl, DIFF_REPO: repo, DIFF_OUT: out };
  delete env.ELECTRON_RUN_AS_NODE;
  const { spawn } = require('node:child_process');
  const child = spawn(require(path.join(repo, 'node_modules/electron')), [__filename, project, '--no-sandbox', process.env.FLUX_PRIVATE_DISPLAY === '1' ? '--ozone-platform=x11' : '--ozone-platform=headless'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
  child.stdout.on('data', b => { for (const l of String(b).split('\n')) if (l.startsWith('DIFF')) console.log(l); });
  fs.writeFileSync(path.join(out, 'pid.json'), JSON.stringify({parent:process.pid,electron:child.pid}));
  let err = ''; child.stderr.on('data', b => { err += b; fs.appendFileSync(path.join(out, 'stderr-live.log'),b); });
  child.on('close', code => { clearTimeout(timer); fs.writeFileSync(path.join(out, 'stderr.log'), err); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(code ?? 1); });
  return;
}
const { app, BrowserWindow } = require('electron');
const repo = process.env.DIFF_REPO, out = process.env.DIFF_OUT;
const specs=process.env.DIFF_FIXTURE?JSON.parse(fs.readFileSync(process.env.DIFF_FIXTURE,'utf8')):{};
require(path.join(repo, 'electron/main.cjs'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, label, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fn(); if (r) return r; } catch {} await sleep(150); } throw Error('Timeout: ' + label); }
(async () => {
  try {
    const win = await wait(() => BrowserWindow.getAllWindows()[0], 'window'); win.setSize(1600, 1000);
    const js = c => win.webContents.executeJavaScript(c, true);
    win.webContents.on('console-message', (_e, d) => { const m = typeof d === 'object' ? d.message : arguments[2]; if (/atlas|Error/.test(String(m))) console.log('DIFF console ' + String(m).slice(0, 600)); });
    await wait(() => js("!!document.querySelector('button[aria-label=Figure]') && !!window.__flux"), 'shell');
    const click=async selector=>{const p=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p})};
    await click('button[aria-label=Figure]');
    await wait(() => js("!!document.querySelector('.figure-mode .canvas-host') && window.__flux.figures().length > 0"), 'figure mode');
    await sleep(3000);
    const ids = await js("window.__flux.figures().map(f => f.id)");
    console.log('DIFF figures ' + JSON.stringify(ids));
    console.log('DIFF roots ' + JSON.stringify(await js("(()=>{const F=window.__flux;return {pd:F.get(F.fig.projectDir),emb:F.get(F.fig.embeddedProjectRoot),hasFn:!!window.fig.rasterizeFigure}})()")));
    const results = [];
    for (const id of (process.env.DIFF_ONLY ? process.env.DIFF_ONLY.split(',') : ids)) {
      if(process.env.DIFF_FIXTURE)await click(`[data-fig-id="${id}"] button.item`);
      await js(`(()=>{const F=window.__flux,f=F.figures().find(x=>x.id===${JSON.stringify(id)}),h=document.querySelector('.figure-mode .canvas-host');
        F.fig.activeFigureId.set(f.id);F.fig.selection.set(new Set());const z=Math.min((h.clientWidth-60)/f.width,(h.clientHeight-60)/f.height);
        F.fig.viewport.set({zoom:z,panX:h.clientWidth/2-(f.x+f.width/2)*z,panY:h.clientHeight/2-(f.y+f.height/2)*z});})()`);
      let last = -1, stable = 0;
      await wait(async () => { const n = await js(`(()=>{const g=document.querySelector('[data-annotation-figure=${JSON.stringify(id)}]');return g&&g.getAttribute('data-atlas-mode')==='live'?g.querySelectorAll('[data-editor-element-id] svg *').length+g.querySelectorAll('[data-editor-element-id]').length:-1})()`);
        stable = n >= 0 && n === last ? stable + 1 : 0; last = n; return stable >= 10; }, 'figure live and stable ' + id, 180000).catch(async e => { const g1 = await js('window.__flux.get(window.__flux.fig.globalRev)'), r1 = await js('JSON.stringify(window.__flux.get(window.__flux.fig.figureRev))'); await sleep(2000); console.log('DIFF revs ' + JSON.stringify({ g1, g2: await js('window.__flux.get(window.__flux.fig.globalRev)'), r1, r2: await js('JSON.stringify(window.__flux.get(window.__flux.fig.figureRev))') })); console.log('DIFF stuck ' + JSON.stringify(await js(`(()=>{const g=document.querySelector('[data-annotation-figure=${JSON.stringify(id)}]');const F=window.__flux,f=F.figures().find(x=>x.id===${JSON.stringify(id)}),dom=new Set([...g.querySelectorAll('[data-editor-element-id]')].map(n=>n.getAttribute('data-editor-element-id')));return {mode:g?.getAttribute('data-atlas-mode'),els:dom.size,raster:!!g?.querySelector('[data-figure-raster]'),missing:f.elements.filter(e=>!dom.has(e.id)).map(e=>({id:e.id,type:e.type,hidden:e.hidden,groupId:e.groupId,x:e.x,y:e.y,w:e.width,h:e.height})),parked:g.querySelectorAll('.parked').length,prep:window.__prepDbg?.[${JSON.stringify(id)}],warm:(()=>{const w=window.__awb?.w;return w&&{fig:w.figId,running:w.running,admitted:w.admitted.size,cands:w.candidates.length,hidden:w.hidden.size,parsed:w.parsed.size,want:w.candidates.filter(c=>!w.admitted.has(c.id)).map(c=>c.id)}})(),plotsNoDom:f.elements.filter(e=>e.type==='plot'&&!F.plot.hasPlotDom?.(e.assetId)).map(e=>e.id)}})()`))); throw e; });
      const r = await js(`(async()=>{
        const F=window.__flux,fig=F.figures().find(x=>x.id===${JSON.stringify(id)}),group=document.querySelector('[data-annotation-figure=${JSON.stringify(id)}]');
        const S=${JSON.stringify(specs[id]?.scale ?? null)}??Math.min(2,Math.sqrt(2.99e6/(fig.width*fig.height))),w=Math.ceil(fig.width*S),h=Math.ceil(fig.height*S);
        const Z=await import('/src/lib/interact/zoomProxy.ts');
        const ser=Z.serializeFigureRegion(group,fig,S),css=await Z.snapshotFontCss(ser.svg);
        const svg=css?ser.svg.replace('>','><style>'+css+'</style>'):ser.svg;
        const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})),img=new Image();img.src=url;await img.decode();
        const live=new OffscreenCanvas(w,h),lc=live.getContext('2d');lc.fillStyle='#fff';lc.fillRect(0,0,w,h);lc.drawImage(img,0,0,w,h);URL.revokeObjectURL(url);
        const t=performance.now();
        const reply=await window.fig.rasterizeFigure({rid:'qa-diff-'+fig.id,root:F.get(F.fig.embeddedProjectRoot)||F.get(F.fig.projectDir),figure:structuredClone(fig),assets:F.get(F.fig.project).assets,scale:S,width:w,height:h});
        const ms=performance.now()-t;
        if(!reply.png)return {id:fig.id,error:reply.error||'no png',nodes:ser.nodes};
        const bm=await createImageBitmap(new Blob([reply.png],{type:'image/png'}));
        const cold=new OffscreenCanvas(w,h),cc=cold.getContext('2d');cc.fillStyle='#fff';cc.fillRect(0,0,w,h);cc.drawImage(bm,0,0,w,h);
        const a=lc.getImageData(0,0,w,h).data,b=cc.getImageData(0,0,w,h).data;let blocks=0,diff=0,maxd=0;
        for(let y=0;y+1<h;y+=2)for(let x=0;x+1<w;x+=2){blocks++;let worst=0;for(let c=0;c<3;c++){let sa=0,sb=0;for(const[dx,dy]of[[0,0],[1,0],[0,1],[1,1]]){const i=((y+dy)*w+x+dx)*4+c;sa+=a[i];sb+=b[i];}const d=Math.abs(sa-sb)/4;if(d>worst)worst=d;}if(worst>=10)diff++;if(worst>maxd)maxd=worst;}
        const toUrl=async cv=>{const bl=await cv.convertToBlob({type:'image/png'});return await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(bl)})};
        return {id:fig.id,name:fig.name,S:+S.toFixed(3),w,h,nodes:ser.nodes,routeCms:Math.round(ms),blocks,differing:diff,fraction:+(diff/blocks).toFixed(5),maxBlockDiff:Math.round(maxd),labels:(${JSON.stringify(specs[id]?.labels ?? [])}).map(label=>{
          let inkLive=0,inkCold=0,blocks=0,differing=0;
          const x0=Math.round(label.x*S),y0=Math.round(label.y*S),x1=Math.min(w,Math.round((label.x+label.w)*S)),y1=Math.min(h,Math.round((label.y+label.h)*S));
          for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*w+x)*4;inkLive+=255-Math.min(a[i],a[i+1],a[i+2]);inkCold+=255-Math.min(b[i],b[i+1],b[i+2]);}
          for(let y=y0;y+1<y1;y+=2)for(let x=x0;x+1<x1;x+=2){blocks++;let worst=0;for(let c=0;c<3;c++){let delta=0;for(const[dx,dy]of[[0,0],[1,0],[0,1],[1,1]]){const i=((y+dy)*w+x+dx)*4+c;delta+=a[i]-b[i];}worst=Math.max(worst,Math.abs(delta)/4);}if(worst>=10)differing++;}
          return{...label,inkLive,inkCold,coverageRatio:inkCold/inkLive,blocks,differing,fraction:differing/blocks};
        }),live:await toUrl(live),cold:await toUrl(cold),svg,figure:structuredClone(fig),assets:F.get(F.fig.project).assets};
      })()`);
      if (r.live) { for (const k of ['live', 'cold']) fs.writeFileSync(path.join(out, `${id}-${k}.png`), Buffer.from(r[k].split(',')[1], 'base64')); delete r.live; delete r.cold; }
      if(r.svg){fs.writeFileSync(path.join(out,id+'-live.svg'),r.svg);fs.writeFileSync(path.join(out,id+'-model.json'),JSON.stringify({figure:r.figure,assets:r.assets}));delete r.svg;delete r.figure;delete r.assets;} console.log('DIFF ' + JSON.stringify(r)); results.push(r);
    }
    fs.writeFileSync(path.join(out, 'window.png'),(await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, 'runtime.json'),JSON.stringify({electron:process.versions.electron,chrome:process.versions.chrome,display:process.env.DISPLAY}));
    fs.writeFileSync(path.join(out, 'diff.json'), JSON.stringify(results, null, 2));
    app.exit(0);
  } catch (e) { console.log('DIFF FAIL ' + (e && e.stack || e)); app.exit(1); }
})();
