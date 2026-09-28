import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { launch, errors } from './lib/driver.mjs';
import { harness } from './lib/harness.mjs';
import { buildModel3dAssets } from './gen-model3d-viewer.mjs';
import { createServiceHost } from '../src/lib/model3d/serviceHost';
import { createModel3dService } from '../src/lib/model3d/service';
import { writeGlb, inspectGlb } from '../src/lib/model3d/glbCore.mjs';
const h = harness('verify-model3d-render-browser');
const assert = await import('node:assert/strict').then(m=>m.default);
async function serviceHostLifecycle(){
 let resolveLoad!:()=>void,calls=0,done=0;
 const service:any={retain:()=>{calls++;return new Promise<void>(resolve=>{resolveLoad=resolve;});},release:()=>{}};
 const host=createServiceHost(service),a=host.ready(['same']).then(()=>done++),b=host.ready(['same']).then(()=>done++);
 await Promise.resolve();await Promise.resolve();assert.equal(calls,1);assert.equal(done,0);resolveLoad();await Promise.all([a,b]);assert.equal(done,2);host.dispose();
 let attempt=0;const retry=createServiceHost({retain:()=>++attempt===1?Promise.reject(new Error('first failure')):Promise.resolve({}),release:()=>{}} as any);
 await assert.rejects(retry.ready(['same']),/first failure/);await retry.ready(['same']);assert.equal(attempt,2);retry.dispose();
 class FakeWorker{onmessage:any;onerror:any;loaded=new Set<string>();terminated=false;postMessage(data:any){queueMicrotask(()=>{if(this.terminated)return;const {type,reqId,assetId}=data;let extra:any={};if(type==='load'){this.loaded.add(assetId);extra.model={bytes:4};}if(type==='unload')this.loaded.delete(assetId);if(type==='render')extra=this.loaded.has(data.spec.assetId)?{blob:new Blob(['png']),ms:1,renderMs:1,encodeMs:0}:{type:'error',reason:'unloaded'};this.onmessage?.({data:{type:'ok',reqId,...extra,stats:{contexts:1,residentBytes:this.loaded.size*4,loads:0,renders:0,lost:false,assets:this.loaded.size,morphPairs:0}}});});}terminate(){this.terminated=true;}}
 const worker=new FakeWorker(), real=createModel3dService({modelBytes:()=>new ArrayBuffer(4),maxResidentBytes:0,workerFactory:()=>worker as any});
 await real.retain('same');real.release('same');await real.retain('same');await Promise.resolve();assert(worker.loaded.has('same'),'late eviction must not unload re-retained asset');
 const blob=await real.renderPng({assetId:'same'} as any);assert(blob instanceof Blob);real.release('same');await Promise.resolve();await Promise.resolve();await Promise.resolve();assert.equal(worker.loaded.size,0);real.dispose();
 h.ok(true,'serviceHost concurrent ready, failed-load retry and LRU re-retain lifetime');
}
await serviceHostLifecycle();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, process.env.FLUX_MODEL3D_EVIDENCE ?? 'test-results/model3d/browser'); await mkdir(out, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'flux-model3d-render-'));
const stamp = await buildModel3dAssets(scratch);
const bundle = await readFile(path.join(scratch, 'flux-model3d-runtime.js'), 'utf8');
const viewer = await readFile(path.join(scratch, 'flux-model3d-viewer.js'), 'utf8');
for (const [entry, file] of [['src/lib/model3d/service.ts', 'service.js'], ['src/lib/model3d/model3d.worker.ts', 'model3d.worker.ts']])
  await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: path.join(scratch, file) });
const server = createServer(async (req, res) => { try { const name = req.url === '/service.js' ? 'service.js' : req.url === '/model3d.worker.ts' ? 'model3d.worker.ts' : null; res.setHeader('Content-Type', name ? 'text/javascript' : 'text/html'); res.end(name ? await readFile(path.join(scratch, name)) : '<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="viewer"></div></body></html>'); } catch { res.statusCode = 404; res.end(); } });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(1443, '127.0.0.1', resolve); });
const { browser, page } = await launch({ width: 900, height: 750 });
try {
  await page.goto('http://127.0.0.1:1443/'); await page.evaluate('window.__name = (value) => value'); await page.addScriptTag({ content: bundle });
  const names = ['plain', 'named-parts', 'continuous', 'categorical-missing', 'box-axes', 'scalebar', 'morph-a', 'morph-b', 'morph-incompatible', 'states', 'sequence'];
  const fixtures = Object.fromEntries(await Promise.all(names.map(async (name) => [name, { bytes: (await readFile(path.join(root, `scripts/fixtures/model3d/fluxplot/${name}.glb`))).toString('base64'), manifest: JSON.parse(await readFile(path.join(root, `scripts/fixtures/model3d/fluxplot/${name}.fluxplot.json`), 'utf8')) }])));
  const marker = writeGlb({ parts: [
    { name: 'frame', positions: [-1,-1,-1,1,-1,-1,0,1,1], indices: [0,1,2], color: [0,0,0,0] },
    { name: 'marker', positions: [0.35,.1,0,.25,.1,0,.3,.15,0,.3,.05,0,.3,.1,.05,.3,.1,-.05], indices: [0,2,4,2,1,4,1,3,4,3,0,4,2,0,5,1,2,5,3,1,5,0,3,5], color: [1,0,0,1] },
  ] });
  (fixtures as any).marker = { bytes: Buffer.from(marker).toString('base64') };
  const triangle={name:'mesh',positions:[-.5,-.5,0,.5,-.5,0,0,.5,0]};
  const generated:any={alpha:writeGlb({parts:[{...triangle,color:[1,0,0,.5]}]}),implicit:writeGlb({parts:[triangle]}),explicit:writeGlb({parts:[{...triangle,indices:[0,1,2]}]}),instances:writeGlb({parts:[{...triangle,values:[0,.5,1]}],modify(json){json.nodes=[{mesh:0,name:'left',translation:[-.7,0,0]},{mesh:0,name:'right',translation:[.7,0,0]}];json.scenes[0].nodes=[0,1];}})};
  generated.skin=writeGlb({parts:[{...triangle,colors:[1,0,0,0,1,0,0,0,1,0,0,0],valid:Array(12).fill(0)}],modify(j){const a=j.meshes[0].primitives[0].attributes;a.WEIGHTS_0=a.COLOR_0;delete a.COLOR_0;a.JOINTS_0=a._VALID;delete a._VALID;j.accessors[a.JOINTS_0].count=3;j.accessors[a.JOINTS_0].type='VEC4';j.nodes[0].skin=0;j.nodes.push({name:'joint',translation:[1,0,0]});j.scenes[0].nodes.push(1);j.skins=[{joints:[1],skeleton:1}];}});
  const unnamed={positions:triangle.positions};generated.unnamed=writeGlb({parts:[unnamed,{...unnamed,positions:triangle.positions.map((v,i)=>i%3===0?v+2:v)}]});
  for(const [id,data] of Object.entries(generated)) (fixtures as any)[id]={bytes:Buffer.from(data as Uint8Array).toString('base64')};

  await page.evaluate(async (fixtures) => {
    const win = window as any, api = win.FluxModel3dRuntime;
    const canvas = document.createElement('canvas'); document.body.prepend(canvas); const core = api.createRenderCore(canvas);
    const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
    for (const [id, fixture] of Object.entries(fixtures) as any) await core.load(id, bytes(fixture.bytes));
    const spec = (id: string, element: any = {}, extra: any = {}) => ({ assetId: id, w: 320, h: 240, element: { ...api.defaultRenderElement(id), modelLighting: 'unlit', ...element }, manifest: (fixtures as any)[id].manifest, ...extra });
    const read = () => { const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height; const ctx = copy.getContext('2d')!; ctx.drawImage(canvas,0,0); return ctx.getImageData(0,0,copy.width,copy.height).data; };
    const render = (s: any) => { const info=core.render(s); const pixels = read(); return { info, pixels }; };
    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let sum=0, changed=0; for(let i=0;i<a.length;i+=4){let max=0;for(let c=0;c<4;c++){const d=Math.abs(a[i+c]-b[i+c]);sum+=d;max=Math.max(max,d);}if(max>2)changed++;}return {mean:sum/a.length,changed:changed/(a.length/4)}; };
    win.lab={api,core,canvas,bytes,fixtures,spec,read,render,diff};
  }, fixtures);
  // First rendered shader in this fresh browser, before inline fixture rendering.
  const coldWorker = await page.evaluate(async()=>{const l=(window as any).lab,mod=await import('/service.js'),service=mod.createModel3dService({modelBytes:()=>l.bytes(l.fixtures['named-parts'].bytes)}),available=await service.available();await service.retain('named-parts');const start=performance.now();await service.renderPng(l.spec('named-parts',{modelLighting:'studio'}),{fullResolution:true});const result={available,...service.stats().lastTiming,roundTripMs:performance.now()-start};service.dispose();return result;});
  h.section('fixtures, colors, orbit and deterministic endpoints');
  for (const name of names) {
    const result = await page.evaluate((id) => { const l=(window as any).lab; const r=l.render(l.spec(id));let opaque=0;for(let i=3;i<r.pixels.length;i+=4)opaque+=r.pixels[i]>0?1:0;return {coverage:opaque/(r.pixels.length/4),cornerAlpha:r.pixels[3],data:l.canvas.toDataURL()}; }, name);
    h.ok(result.coverage > 0.005 && result.coverage < 0.95, `${name}: visible mesh (${(result.coverage*100).toFixed(1)}% coverage)`); h.eq(result.cornerAlpha,0,`${name}: transparent background`);
    await writeFile(path.join(out,`${name}.png`),Buffer.from(result.data.split(',')[1],'base64'));
  }
  const checks = await page.evaluate(() => {
    const l=(window as any).lab,s=l.spec('named-parts'),front=l.render({...s,element:{...s.element,orbitAzimuth:0}}).pixels;
    const right=l.render({...s,element:{...s.element,orbitAzimuth:90}}).pixels, fullTurn=l.render({...s,element:{...s.element,orbitAzimuth:360}}).pixels;
    const studio=l.render({...s,element:{...s.element,orbitAzimuth:0,modelLighting:'studio'}}).pixels;
    const part=s.manifest.parts.find((p:any)=>p.node), override=l.render({...s,element:{...s.element,orbitAzimuth:0,overrides:{[part.id]:{fill:'#ff0000'}}}}).pixels;
    const field=l.spec('continuous'),base=l.render(field).pixels, fieldPart=field.manifest.parts.find((p:any)=>p.field&&typeof p.field==='object');
    const remap=l.render({...field,element:{...field.element,fields:{[fieldPart.id]:{range:[100,101]}}}}).pixels;
    const state=l.spec('states',{modelStates:{}}),zero=l.render(state).pixels,explicitZero=l.render({...state,states:{bent:0,inflated:0}}).pixels,stateOne=l.render({...state,states:{bent:1}}).pixels;
    const a=l.spec('morph-a'),b=l.spec('morph-b'),pairs=a.manifest.parts.filter((p:any)=>p.node).map((p:any)=>({nodeA:p.node,nodeB:p.node}));
    const pa=l.render(a).pixels,pb=l.render(b).pixels,morph={to:'morph-b',t:.5,pairs,toElement:b.element,toManifest:b.manifest};
    const middle=l.render({...a,morph}).pixels,repeat=l.render({...a,morph}).pixels;
    const endpoint=l.render({...a,morph:{...morph,t:1}}).pixels,begin=l.render({...a,morph:{...morph,t:0}}).pixels;
    return {orientation:l.diff(front,right),periodic:l.diff(front,fullTurn),lighting:l.diff(front,studio),override:l.diff(front,override),field:l.diff(base,remap),stateZero:l.diff(zero,explicitZero),stateOne:l.diff(zero,stateOne),morphRepeat:l.diff(middle,repeat),morphEnd:l.diff(pb,endpoint),morphBegin:l.diff(pa,begin),morphMoves:l.diff(pa,middle),stats:l.core.stats()};
  });
  for(const [key,message] of [['orientation','front differs from right'],['lighting','studio differs from unlit'],['override','part override changes pixels'],['field','field remapping changes pixels'],['stateOne','shape state moves geometry'],['morphMoves','vertex morph moves geometry']] as const)h.ok(checks[key].changed>0.001,message);
  for(const [key,message] of [['periodic','azimuth 0 equals360'],['stateZero','state0 equals base'],['morphRepeat','morph deterministic'],['morphEnd','morph t1 equals destination'],['morphBegin','morph t0 equals source']] as const)h.eq(checks[key].changed,0,message);
  h.eq(checks.stats.contexts,1,'one render-core context');
  const edgeMeshes=await page.evaluate(()=>{const l=(window as any).lab;
    const alpha=l.render(l.spec('alpha',{}, {manifest:{parts:[{id:'mesh',node:'mesh',color:'#ff000080'}]}})).pixels;let maxAlpha=0;for(let i=3;i<alpha.length;i+=4)maxAlpha=Math.max(maxAlpha,alpha[i]);
    const field={cmap:{name:'test',stops:[[0,'#0000ff'],[1,'#ff0000']]},range:[0,1]},manifest={parts:[{id:'group',kind:'group'},{id:'left',node:'left',parent:'group',field},{id:'right',node:'right',parent:'group',field}]},spec=l.spec('instances',{orbitAzimuth:0,orbitElevation:0},{manifest}),base=l.render(spec).pixels,change=l.render({...spec,element:{...spec.element,fields:{right:{range:[2,3]}}}}).pixels;
    let left=0,right=0;for(let i=0;i<base.length;i+=4){const d=Math.abs(base[i]-change[i])+Math.abs(base[i+2]-change[i+2]);if((i/4)%320<160)left+=d;else right+=d;}
    const parent=l.render({...spec,element:{...spec.element,overrides:{group:{fill:'#ff0000'}}}}).pixels,children=l.render({...spec,element:{...spec.element,overrides:{left:{fill:'#ff0000'},right:{fill:'#ff0000'}}}}).pixels,hidden=l.render({...spec,element:{...spec.element,overrides:{group:{hidden:true}}}}).pixels;
    let hiddenAlpha=0;for(let i=3;i<hidden.length;i+=4)hiddenAlpha+=hidden[i];
    const mixed=l.render({...l.spec('implicit'),morph:{to:'explicit',t:.5,pairs:[{nodeA:'mesh',nodeB:'mesh'}]}}).pixels;
    const skin=l.diff(l.render(l.spec('implicit')).pixels,l.render(l.spec('skin')).pixels);l.render({...l.spec('unnamed'),morph:{to:'unnamed',t:.5,pairs:[{nodeA:'',nodeB:'',primitiveA:0,primitiveB:0},{nodeA:'',nodeB:'',primitiveA:1,primitiveB:1}]}});
    return {skin,maxAlpha,left,right,cascade:l.diff(parent,children),hiddenAlpha,mixedVisible:mixed.some((v:number,i:number)=>i%4===3&&v>0)};});
  h.eq(edgeMeshes.skin.changed,0,'skinned GLB displays exact stored mesh geometry');h.eq(edgeMeshes.maxAlpha,128,'semantic manifest preserves source material alpha');h.eq(edgeMeshes.left,0,'field remapping one GLTF instance preserves sibling pixels');h.ok(edgeMeshes.right>100,'instance field override changes target pixels');h.eq(edgeMeshes.cascade.changed,0,'ancestor fill equals equivalent leaf fills');h.eq(edgeMeshes.hiddenAlpha,0,'hidden ancestor hides subtree');h.ok(edgeMeshes.mixedVisible,'implicit and identity-indexed morph pair accepted');

  // M1 parity: glbCore part names are renderCore styling ids, unnamed nodes too.
  const unnamedNames = inspectGlb(generated.unnamed).partNames;
  const unnamedStyle = await page.evaluate((names: string[]) => {
    const l=(window as any).lab, spec=l.spec('unnamed',{orbitAzimuth:0,orbitElevation:0,modelColors:'source'}), base=l.render(spec).pixels;
    const filled=names.map(name=>l.diff(base,l.render({...spec,element:{...spec.element,overrides:{[name]:{fill:'#ff0000'}}}}).pixels).changed);
    const hidden=l.render({...spec,element:{...spec.element,overrides:Object.fromEntries(names.map(name=>[name,{hidden:true}]))}}).pixels;
    let alpha=0;for(let i=3;i<hidden.length;i+=4)alpha+=hidden[i];
    return {filled,alpha};
  }, unnamedNames);
  h.eq(unnamedNames, ['node-0', 'node-1'], 'glbCore names unnamed nodes node-<glTF node index>');
  h.ok(unnamedStyle.filled.every((changed: number) => changed > 0.001) && unnamedStyle.alpha === 0, `renderCore fills and hides unnamed parts by the glbCore part ids (${unnamedStyle.filled.map((c: number) => (c * 100).toFixed(1) + '%').join(', ')})`);

  const synthetic = await page.evaluate(() => {
    const l=(window as any).lab, manifest={parts:[{id:'left',role:'mesh',node:'left',series:'pair',color:'#0000ff'},{id:'right',role:'mesh',node:'right',series:'pair',color:'#0000ff'}]}, raw=JSON.stringify(manifest);
    const spec=l.spec('instances',{orbitAzimuth:0,orbitElevation:0},{manifest}),base=l.render(spec).pixels;
    const single=l.render({...spec,element:{...spec.element,overrides:{left:{fill:'#ff0000'}}}}).pixels;
    let left=0,right=0;for(let i=0;i<base.length;i+=4){const d=Math.abs(base[i]-single[i])+Math.abs(base[i+2]-single[i+2]);if((i/4)%320<160)left+=d;else right+=d;}
    const parent=l.render({...spec,element:{...spec.element,overrides:{'@series:pair':{fill:'#44aa99',opacity:.4}}}}).pixels;
    const leaves=l.render({...spec,element:{...spec.element,overrides:{left:{fill:'#44aa99',opacity:.4},right:{fill:'#44aa99',opacity:.4}}}}).pixels;
    const hidden=l.render({...spec,element:{...spec.element,overrides:{'@series:pair':{hidden:true}}}}).pixels;
    return {left,right,equal:l.diff(parent,leaves).changed,hidden:hidden.every((v:number,i:number)=>i%4!==3||v===0),unchanged:JSON.stringify(manifest)===raw};
  });
  h.ok(synthetic.left>100,'part recolour changes selected mesh pixels');h.eq(synthetic.right,0,'part recolour preserves sibling mesh pixels');
  h.eq(synthetic.equal,0,'synthetic series fill and opacity exactly match equivalent leaf overrides');h.ok(synthetic.hidden,'synthetic series visibility hides all member pixels');h.ok(synthetic.unchanged,'renderer never rewrites public semantic source');

  const projection = await page.evaluate(() => { const l=(window as any).lab;return [{orbitAzimuth:0,orbitElevation:0},{orbitAzimuth:90,orbitElevation:20},{orbitAzimuth:30,orbitElevation:90},{orbitAzimuth:30,orbitElevation:20,orbitRoll:45},{orbitAzimuth:30,orbitElevation:20,orbitProjection:'perspective'}].map((view)=>{const s=l.spec('marker',view),r=l.render(s);let x=0,y=0,w=0;for(let i=0;i<r.pixels.length;i+=4){const a=r.pixels[i+3];if(r.pixels[i]>100&&a){const p=i/4;x+=(p%s.w+.5)*a;y+=(Math.floor(p/s.w)+.5)*a;w+=a;}}const expected=l.api.project([.3,.1,0],r.info.pose,{width:s.w,height:s.h});return {view,error:Math.hypot(x/w-expected.x,y/w-expected.y)};}); });
  projection.forEach((r)=>h.ok(r.error<=.5,`rendered-marker projection agrees ≤0.5px (${r.error.toFixed(3)}px)`));
  const poster = await page.evaluate(() => { const l=(window as any).lab; l.core.render({assetId:'named-parts',w:320,h:240,element:{id:'test-model',type:'model3d',assetId:'named-parts',x:0,y:0,width:320,height:240,rotation:0,opacity:1,orbitAzimuth:0,orbitElevation:20,orbitZoom:.9,orbitProjection:'orthographic',orbitFov:30,fill:'#4385be'}}); return l.canvas.toDataURL(); });
  await writeFile(path.join(out,'poster-reference.png'),Buffer.from(poster.split(',')[1],'base64'));
  h.section('worker parity, queue lifetime and source isolation');
  const worker = await page.evaluate(async () => {
    const l=(window as any).lab,mod=await import('/service.js');
    const service=mod.createModel3dService({modelBytes:(id:string)=>l.bytes(l.fixtures[id].bytes)});const available=await service.available();await service.retain('named-parts');
    const spec=l.spec('named-parts');const start=performance.now();const blob=await service.renderPng(spec,{fullResolution:true});const first={...service.stats().lastTiming,roundTripMs:performance.now()-start};
    const image=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=spec.w;canvas.height=spec.h;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);image.close();const pixels=ctx.getImageData(0,0,spec.w,spec.h).data;const parity=l.diff(pixels,l.render(spec).pixels);
    const encode=[];for(let i=0;i<5;i++){await service.renderPng(spec,{fullResolution:true});encode.push(service.stats().lastTiming);}
    const requests=[0,25,50,75].map((az)=>service.renderBitmap({...spec,element:{...spec.element,orbitAzimuth:az}},{channel:'scrub'}).then((b:ImageBitmap)=>{b.close();return 'ok';},(e:Error)=>e.name));
    const latest=await Promise.all(requests);const stats=service.stats();
    const idle=await Promise.all([service.renderBitmap(spec,{lane:'idle',key:'same'}),service.renderBitmap(spec,{lane:'idle',key:'same'})]);const independent=idle[0]!==idle[1];idle.forEach((b:ImageBitmap)=>b.close());
    service.dispose();return {available,parity,first,encode,latest,stats,independent,disposed:service.stats()};
  });
  h.ok(worker.available.ok,'worker WebGL2 available');h.ok(worker.parity.mean<.5&&worker.parity.changed<.005,`worker/inline parity mean${worker.parity.mean.toFixed(3)},changed${(worker.parity.changed*100).toFixed(3)}%`);
  h.eq(worker.latest,['AbortError','AbortError','AbortError','ok'],'interactive lane latest wins');h.ok(worker.independent,'deduplicated bitmaps have separate ownership');h.eq(worker.stats.queued,0,'queue empty at rest');h.eq(worker.disposed.contexts,0,'worker disposal releases context');
  h.section('service cancellation, coalescing and owned bitmap failures');
  const serviceCases = await page.evaluate(async()=>{
    const l=(window as any).lab,mod=await import('/service.js'),spec=l.spec('named-parts'),original=createImageBitmap;
    let closed=0;const bitmap=()=>({close:()=>{closed++;}}),renders:any[]=[],unloads:string[]=[];
    const fake=()=>{const worker:any={terminate(){},postMessage(m:any){queueMicrotask(()=>{let reply:any={reqId:m.reqId,type:'loaded',model:{bytes:10},stats:{contexts:1,residentBytes:10,assets:1}};if(m.type==='render'){renders.push(m.spec);reply={...reply,type:'rendered',ms:50,renderMs:45,encodeMs:5,...(m.format==='bitmap'?{bitmap:bitmap()}:{blob:new Blob(['png'])})};}if(m.type==='unload')unloads.push(m.assetId);worker.onmessage?.({data:reply});});}};return worker;};
    const service=mod.createModel3dService({modelBytes:()=>new ArrayBuffer(10),workerFactory:fake,maxResidentBytes:10});await service.retain('named-parts');
    const resolve=(p:Promise<any>)=>p.then(()=> 'ok',(e:Error)=>e.name+':'+e.message);
    (window as any).createImageBitmap=()=>Promise.reject(new Error('clone-failed'));
    const failed=await Promise.all([resolve(service.renderBitmap(spec,{lane:'idle',key:'clone'})),resolve(service.renderBitmap(spec,{lane:'idle',key:'clone'}))]);
    (window as any).createImageBitmap=original;
    const mixed=await Promise.all([service.renderBitmap(spec,{lane:'idle',key:'mixed'}),service.renderPng(spec,{lane:'idle',key:'mixed'})]);const formats=typeof mixed[0].close==='function'&&mixed[1] instanceof Blob;mixed[0].close();
    await service.renderPng(spec,{channel:'slow'});await service.renderPng(spec,{channel:'slow'});await service.renderPng(spec,{channel:'slow',fullResolution:true});const scales=renders.slice(-3).map(s=>s.w);
    const before=closed;(window as any).createImageBitmap=()=>{service.dispose();return Promise.resolve(bitmap());};
    const disposed=await Promise.all([resolve(service.renderBitmap(spec,{lane:'idle',key:'dispose'})),resolve(service.renderBitmap(spec,{lane:'idle',key:'dispose'}))]);await new Promise<void>(r=>queueMicrotask(r));(window as any).createImageBitmap=original;
    const retainDisposed=await resolve(service.retain('hang'));
    const fresh=mod.createModel3dService({modelBytes:()=>new ArrayBuffer(10),workerFactory:fake});await fresh.retain('named-parts');const idleAbort=new AbortController(),oldIdle=resolve(fresh.renderPng(spec,{lane:'idle',key:'again',signal:idleAbort.signal}));idleAbort.abort();const renewed=await resolve(fresh.renderPng(spec,{lane:'idle',key:'again'}));await oldIdle;fresh.dispose();
    const pending=mod.createModel3dService({modelBytes:(id:string)=>id==='hang'?new Promise(()=>{}):new ArrayBuffer(10),sourceTimeoutMs:50,workerFactory:fake});const pendingLoad=resolve(pending.retain('hang'));await pending.retain('named-parts');const abort=new AbortController(),stalled=resolve(pending.renderPng({...spec,assetId:'hang'},{signal:abort.signal}));await new Promise<void>(r=>queueMicrotask(r));abort.abort();const live=await resolve(pending.renderPng(spec));const timeout=await pendingLoad;pending.dispose();
    const host=l.api.createInlineHost({modelBytes:()=>new Promise(()=>{})}),ready=resolve(host.ready(['hang']));host.dispose();const inlineAbort=await ready;
    return {renewed,failed,formats,scales,disposed,closedAfterDispose:closed-before,retainDisposed,stalled:await stalled,live,timeout,inlineAbort};
  });
  h.eq(serviceCases.renewed,'ok','new idle waiter never joins an aborted job');h.ok(serviceCases.failed.every(s=>s.includes('clone-failed')),'clone failure rejects every waiter');h.ok(serviceCases.formats,'idle key preserves bitmap and PNG formats');h.eq(serviceCases.scales,[320,160,320],'slow channel halves next frame and release restores full resolution');h.ok(serviceCases.disposed.every(s=>s.startsWith('AbortError'))&&serviceCases.closedAfterDispose===2,'disposal during clone rejects waiters and closes every bitmap');h.ok(serviceCases.retainDisposed.startsWith('AbortError'),'retain after disposal rejects immediately');h.ok(serviceCases.stalled.startsWith('AbortError')&&serviceCases.live==='ok','cancelled stalled source does not block next render');h.ok(serviceCases.timeout.includes('timed out'),'stalled byte source has bounded timeout');h.ok(serviceCases.inlineAbort.startsWith('AbortError'),'inline dispose settles pending ready');
  h.section('shared inline host and notebook controls');
  const hosts=await page.evaluate(async()=>{const l=(window as any).lab,read=(id:string)=>l.bytes(l.fixtures[id].bytes);const a=l.api.createInlineHost({modelBytes:read}),b=l.api.createInlineHost({modelBytes:read});await Promise.all([a.ready(['named-parts']),b.ready(['named-parts'])]);const stats=a.stats();a.dispose();const still=b.stats();const c=document.createElement('canvas'),v=b.view(c);v.render(l.spec('named-parts').element,320,240);const painted=c.toDataURL().length;b.dispose();return {stats,still,painted,disposed:b.stats()};});
  h.eq(hosts.stats.contexts,1,'two inline hosts share one context');h.eq(hosts.stats.assets,1,'shared byte source loads asset once');h.eq(hosts.still.contexts,1,'disposing first owner keeps second alive');h.ok(hosts.painted>1000,'remaining owner paints');h.eq(hosts.disposed.contexts,0,'last inline owner releases context');
  await page.addScriptTag({content:viewer});
  const notebook=await page.evaluate(async()=>{const l=(window as any).lab,v=await (window as any).FluxModel3dViewer.mount(document.getElementById('viewer'),{glb:l.fixtures.states.bytes,manifest:l.fixtures.states.manifest,width:480,height:360});(window as any).viewer=v;return {states:document.querySelectorAll('input[type=range]').length,text:document.querySelector('[role=status]')?.textContent,view:v.getView()};});
  h.eq(notebook.states,2,'notebook exposes both shape-state sliders');h.ok(!notebook.text?.includes('unavailable'),'notebook renders mesh');
  await page.evaluate(() => { (window as any).lab.canvas.style.display='none'; });
  await page.screenshot({path:path.join(out,'notebook-viewer.png'),omitBackground:true});
  const changed=await page.evaluate(()=>{const v=(window as any).viewer;v.setView({azimuth:90,zoom:1.2});return v.getView();});h.eq(changed.azimuth,90,'notebook setView changes orbit');h.eq(changed.zoom,1.2,'notebook setView changes zoom');
  const stage = await page.$('#viewer [tabindex="0"]'), box = (await stage!.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+20,{steps:4});await page.mouse.up();
  const dragged = await page.evaluate(()=>(window as any).viewer.getView());h.ok(dragged.azimuth!==changed.azimuth&&dragged.elevation!==changed.elevation,'real pointer drag changes orbit');
  await page.mouse.wheel({deltaY:-120});await page.waitForFunction((zoom)=>(window as any).viewer.getView().zoom!==zoom,{},dragged.zoom);
  const wheelZoom = await page.evaluate(()=>(window as any).viewer.getView().zoom);h.ok(wheelZoom!==dragged.zoom,'real wheel changes zoom');
  await page.focus('#viewer input[aria-label="Bent"]');await page.keyboard.press('End');
  h.eq(await page.evaluate(()=>(window as any).viewer.getView().states.bent),1,'keyboard shape slider changes geometry state');
  h.ok(await page.$eval('#viewer textarea',(e)=>e.value.includes('states={')),'copy view includes shape states');
  await page.$eval('#viewer button',(e)=>e.click());h.eq(await page.evaluate(()=>(window as any).viewer.getView().states.bent??0),0,'Home restores shape states');
  await page.setViewport({width:330,height:750});const responsive=await page.$eval('#viewer section',(e)=>({width:e.getBoundingClientRect().width,scroll:e.scrollWidth}));h.ok(responsive.width<=330&&responsive.scroll<=330,'notebook controls fit narrow output');
  await page.screenshot({path:path.join(out,'notebook-narrow.png'),omitBackground:true});await page.setViewport({width:900,height:750});
  // A second notebook script creates a distinct module instance in the same document.
  await page.addScriptTag({content:viewer});
  const copies=await page.evaluate(async()=>{const l=(window as any).lab,root=document.createElement('div');document.body.append(root);const shadow=root.attachShadow({mode:'open'}),host=document.createElement('div');shadow.append(host);const second=await (window as any).FluxModel3dViewer.mount(host,{glb:l.fixtures['named-parts'].bytes,manifest:l.fixtures['named-parts'].manifest,width:300,height:220});const before=second.stats(),firstId=document.querySelector('#viewer section canvas')?.toDataURL(),secondId=shadow.querySelector('canvas')!.toDataURL();shadow.replaceChildren();await new Promise<void>(r=>queueMicrotask(()=>queueMicrotask(r)));const after=(window as any).viewer.stats();root.remove();return {available:second.available,before,after,distinct:firstId!==secondId};});
  h.ok(copies.available&&copies.distinct,'two bundle copies render distinct meshes');h.eq(copies.before.contexts,1,'two notebook bundle copies share one document context');h.eq(copies.before.assets,2,'two notebook bundles retain distinct assets');h.eq(copies.after.assets,1,'clearing shadow output disposes its asset');
  const fallback=await page.evaluate(async()=>{const host=document.createElement('div');host.innerHTML='<img alt="still" src="data:image/png;base64,iVBORw0KGgo=">';document.body.append(host);const before=host.innerHTML;const result=await (window as any).FluxModel3dViewer.mount(host,{glb:'not-glb'});const retained=host.innerHTML===before;result.dispose();host.remove();return {available:result.available,retained};});h.eq(fallback,{available:false,retained:true},'failed mount retains still image');
  const sequenceControl=await page.evaluate(async()=>{const l=(window as any).lab,host=document.createElement('div');document.body.append(host);const fixture=l.fixtures.sequence,manifest=structuredClone(fixture.manifest),names=manifest.states.map((s:any)=>s.name);manifest.view={...manifest.view,states:l.api.statesAtFrame(names,2.5)};const viewer=await (window as any).FluxModel3dViewer.mount(host,{glb:fixture.bytes,manifest,width:320,height:240});const input=host.querySelector('input[type=range]') as HTMLInputElement,initial={value:input.value,output:host.querySelector('output')!.textContent};input.value='1.25';input.dispatchEvent(new Event('input'));const scrub={value:input.value,states:viewer.getView().states};host.querySelector('button')!.click();const home={value:input.value,output:host.querySelector('output')!.textContent,states:viewer.getView().states};viewer.setView({states:l.api.statesAtFrame(names,3.5)});const set=input.value,customStates={[names[0]]:.5,[names[2]]:.5};viewer.setView({states:customStates});const custom={output:host.querySelector('output')!.textContent,states:viewer.getView().states};viewer.dispose();host.remove();return {initial,scrub,home,set,custom,customStates,expectedScrub:l.api.statesAtFrame(names,1.25),expected:manifest.view.states};});
  h.eq(sequenceControl.initial,{value:'2.5',output:'2.5'},'sequence scrubber reflects authored fractional frame');h.eq(sequenceControl.home,{value:'2.5',output:'2.5',states:sequenceControl.expected},'Home restores sequence geometry and scrubber');h.eq(sequenceControl.set,'3.5','setView synchronizes sequence scrubber');h.eq(sequenceControl.scrub,{value:'1.25',states:sequenceControl.expectedScrub},'sequence scrubber applies fractional adjacent weights');h.eq(sequenceControl.custom,{output:'Custom',states:sequenceControl.customStates},'nonadjacent weights are reported as Custom without changing geometry state');
  h.section('context restoration and effective-state morph');
  // Chrome rejects restoreContext during the loss event's microtask checkpoint.
  // A MessageChannel waits for that dispatch task to finish without a timed delay.
  const restore = await page.evaluate(async()=>{const l=(window as any).lab,s=l.spec('named-parts'),before=l.render(s).pixels,gl=l.canvas.getContext('webgl2'),extension=gl.getExtension('WEBGL_lose_context');if(!extension)return {supported:false};await new Promise<void>((r,reject)=>{const timer=setTimeout(()=>reject(new Error('Context loss event timed out')),5000);l.canvas.addEventListener('webglcontextlost',()=>{clearTimeout(timer);r();},{once:true});extension.loseContext();});const rejected=(()=>{try{l.core.render(s);return false;}catch{return true;}})();await new Promise<void>((r,reject)=>{const timer=setTimeout(()=>reject(new Error('Context restore timed out')),5000);l.canvas.addEventListener('webglcontextrestored',()=>{clearTimeout(timer);r();},{once:true});const task=new MessageChannel();task.port1.onmessage=()=>{task.port1.close();task.port2.close();extension.restoreContext();};task.port2.postMessage(null);});await l.core.ready();return {supported:true,rejected,diff:l.diff(before,l.render(s).pixels),stats:l.core.stats()};});h.ok(restore.supported&&restore.rejected,'context loss rejects stale render');h.eq(restore.diff?.changed,0,'context restore reparses retained bytes without pixel drift');
  const stateMorph=await page.evaluate(()=>{const l=(window as any).lab,s=l.spec('states'),pairs=s.manifest.parts.filter((p:any)=>p.node).map((p:any)=>({nodeA:p.node,nodeB:p.node})),mid=l.render({...s,morph:{to:'states',t:.5,pairs,toElement:{...s.element,modelStates:{bent:1}}}}).pixels,direct=l.render({...s,states:{bent:.5}}).pixels;return l.diff(mid,direct);});h.ok(stateMorph.mean<.1&&stateMorph.changed<.001,'morph bakes effective endpoint shape states');
  h.section('P0.6 measurements and cleanup');
  const perf=await page.evaluate(()=>{const l=(window as any).lab;l.core.render(l.spec('named-parts'));const copy=document.createElement('canvas');copy.width=320;copy.height=240;const ctx=copy.getContext('2d')!;const times=[];for(let i=0;i<50;i++){const t=performance.now();ctx.clearRect(0,0,320,240);ctx.drawImage(l.canvas,0,0);times.push(performance.now()-t);}ctx.getImageData(0,0,320,240);const values=Float32Array.from({length:650000},(_,i)=>i/650000),field={cmap:{name:'measurement',stops:[[0,'#000000'],[1,'#ffffff']]},range:[0,1]},recolor=[];for(let i=0;i<5;i++){const t=performance.now();l.api.mapValues(values,field);recolor.push(performance.now()-t);}const started=performance.now();for(let i=0;i<200;i++){ctx.clearRect(0,0,320,240);ctx.drawImage(l.canvas,0,0);}const submitMs=(performance.now()-started)/200,readStart=performance.now();ctx.getImageData(0,0,320,240);const readbackMs=performance.now()-readStart;return {drawImageMs:times,drawImageBatch:{calls:200,submitPerCallMs:submitMs,finalReadbackMs:readbackMs},recolor650kMs:recolor};});
  const resize = await page.evaluate(async()=>{const l=(window as any).lab,mod=await import('/service.js'),service=mod.createModel3dService({modelBytes:()=>l.bytes(l.fixtures['named-parts'].bytes)});await service.retain('named-parts');const sizes=[[320,240],[640,480],[320,240],[1600,1200],[320,240],[1600,1200],[320,240]],samples=[];for(const [w,h] of sizes){const start=performance.now();const bitmap=await service.renderBitmap({...l.spec('named-parts'),w,h},{fullResolution:true});samples.push({w,h,roundTripMs:performance.now()-start,...service.stats().lastTiming});bitmap.close();}service.dispose();return samples;});
  const largeCopy=await page.evaluate(()=>{const l=(window as any).lab;l.core.render({...l.spec('named-parts'),w:1600,h:1200});const c=document.createElement('canvas');c.width=1600;c.height=1200;const ctx=c.getContext('2d')!,samples=[];for(let j=0;j<5;j++){const t=performance.now();for(let i=0;i<20;i++){ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(l.canvas,0,0);}const submit=(performance.now()-t)/20,readStart=performance.now();ctx.getImageData(0,0,c.width,c.height);samples.push({submitPerCallMs:submit,finalReadbackMs:performance.now()-readStart});}return {w:1600,h:1200,callsPerSample:20,samples};});
  const metrics={coldWorker,largeCopy,resize,stamp,browser:await page.evaluate(()=>navigator.userAgent),checks,projection,worker,hosts,perf};await writeFile(path.join(out,'measurements.json'),JSON.stringify(metrics,null,2));
  h.ok(perf.recolor650kMs.every(Number.isFinite),'650k-vertex CPU recolor measured');
  const disposed=await page.evaluate(()=>{(window as any).viewer.dispose();const l=(window as any).lab;l.core.dispose();return l.core.stats();});h.eq(disposed.contexts,0,'core disposal frees context');h.eq(disposed.residentBytes,0,'core disposal frees retained bytes');
  h.section('offline viewer under hashed script CSP');
  const offline=await browser.newPage();await offline.goto('http://127.0.0.1:1443/');await offline.setOfflineMode(true);
  const boot=`FluxModel3dViewer.mount(document.getElementById('output'),${JSON.stringify({glb:fixtures.states.bytes,manifest:fixtures.states.manifest,width:320,height:240})}).then(v=>{window.offlineViewer=v;window.offlineReady=v.available;});`;
  const hashes=[viewer,boot].map(code=>`'sha256-${createHash('sha256').update(code).digest('base64')}'`).join(' ');
  await offline.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${hashes}; connect-src 'none'; img-src data:; style-src 'none'"><div id="output"></div><script>${viewer}</script><script>${boot}</script>`);
  await offline.waitForFunction('window.offlineReady===true');h.ok(await offline.$eval('canvas',(canvas)=>canvas.width>0),'self-contained viewer runs offline with hashed scripts and no connect permission');await offline.close();
  h.eq(errors(page),[],'browser console is clean');
} catch(error) { h.fail(error instanceof Error ? error.stack ?? error.message : String(error)); }
await h.done(async()=>{await browser.close();await new Promise<void>((resolve)=>server.close(()=>resolve()));await rm(scratch,{recursive:true,force:true});});
