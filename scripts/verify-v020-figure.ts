import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { get } from 'svelte/store';
import { readFigureSnapshot } from '../src/lib/project/figureSnapshot';
import { planFigSave } from '../src/lib/project/figfiles';
import { validateModel } from '../src/lib/project/validate';
import { commitTextGeneration, recoverTextGeneration, bytesToBase64 } from '../src/lib/project/textGeneration';
import { buildPlotMarkup } from '../src/lib/plot/inlineMarkup';
import { svgIntrinsicSize } from '../src/lib/plot/svgGeometry';
import { isUnderRoot } from '../src/lib/plot/source';
import type { Project } from '../src/lib/types';
(globalThis as any).DOMParser=DOMParser;
const root='/disposable/project';const files=new Map<string,string>();
let beforeRead: ((path:string)=>Promise<void>)|undefined, beforeWrite: ((path:string)=>Promise<void>)|undefined;
const bridge={exists:async(p:string)=>files.has(p),readText:async(p:string)=>{await beforeRead?.(p);if(!files.has(p))throw Error('ENOENT '+p);return files.get(p)!},writeText:async(p:string,t:string)=>{await beforeWrite?.(p);files.set(p,t)},readFile:async(p:string)=>{await beforeRead?.(p);if(!files.has(p))throw Error('ENOENT '+p);return new TextEncoder().encode(files.get(p)!).buffer},writeFile:async(p:string,b:Uint8Array)=>{await beforeWrite?.(p);files.set(p,new TextDecoder().decode(b))},mkdir:async()=>{},remove:async(p:string)=>{files.delete(p)},readdir:async()=>[]};
(globalThis as any).window={fig:bridge};
const store=await import('../src/lib/store');
const {loadFigInto,saveFigFrom}=await import('../src/lib/project/figbridge');
const {sendSlideToCanvas}=await import('../src/lib/project/convert');
const {editSession}=await import('../src/lib/interact/editSession');
const {assetData,bytesToDataUrl}=await import('../src/lib/assets');
const {buildFigureSvg}=await import('../src/lib/io');
const plotStore=await import('../src/lib/plot/store');
function model(): Project {return {version:2,name:'fixture',canvases:[{id:'c1',name:'C1'},{id:'c2',name:'C2'}],figures:['1','2'].map(n=>({id:'f'+n,canvasId:'c'+n,name:'Figure '+n,x:0,y:0,width:680,height:400,elements:[]})),assets:[],palette:[]};}
function seed(p=model()){files.clear();const plan=planFigSave(p,null);for(const f of [...plan.canvases,...plan.captions,plan.index])files.set(root+'/'+f.path,f.text);files.set(root+'/project.json',JSON.stringify({schemaVersion:'0.1.0',id:'p',title:'fixture',manuscript:{path:'paper/notes.qmd'},references:{library:'bib/library.bib'},figures:[]}));return p;}
const fingerprint=()=>JSON.stringify([...files].sort());
const slide={id:'slide',name:'New',elements:[],beats:[]}, deck={id:'deck',stage:{width:100,height:80},assets:[]};
for(const kind of ['missing','corrupt','future','EACCES','EBUSY']) {
  seed();const bad=root+'/fig/canvases/c2.json';
  if(kind==='missing')files.delete(bad);else if(kind==='corrupt')files.set(bad,'{');else if(kind==='future')files.set(bad,JSON.stringify({...JSON.parse(files.get(bad)!),schemaVersion:'99.0.0',unknown:'retain'}));
  else beforeRead=async p=>{if(p===bad)throw Error(kind)};
  const before=fingerprint();await assert.rejects(sendSlideToCanvas(root,slide as any,deck as any,'c1'));assert.equal(fingerprint(),before,kind+' must preserve all existing bytes');beforeRead=undefined;
}
seed();const cf=JSON.parse(files.get(root+'/fig/canvases/c2.json')!);cf.figures[0].id='f1';files.set(root+'/fig/canvases/c2.json',JSON.stringify(cf));
const duplicate=await readFigureSnapshot({readText:async rel=>files.get(root+'/'+rel)??null});assert.notEqual(duplicate.status,'complete');assert.ok(duplicate.diagnostics.some(d=>d.message.includes('duplicate figure')));
for(const mutate of [(p:Project)=>{p.figures[0].guides={x:[Infinity],y:[]}},(p:Project)=>{p.figures[0].elements=[{id:'plot',type:'plot',assetId:'a',x:0,y:0,width:10,height:10,rotation:0,overrides:{label:{fontSize:NaN}}}] as any}]){const p=model();mutate(p);assert.ok(validateModel(p).length);}
// Persistence capture, cancellation, and trailing save use the actual bridge.
seed();await loadFigInto(root,'fixture');const session=editSession();session.run(()=>store.mutate(p=>{p.figures[0].width=321}));
let release!:()=>void, captured!:()=>void;const capturedP=new Promise<void>(r=>{captured=r});const paused=new Promise<void>(r=>{release=r});
beforeWrite=async p=>{if(p.endsWith('/.meta/figure-source-generation.json')){captured();await paused;}};
const pending=saveFigFrom(root);await capturedP;session.run(()=>store.mutate(p=>{p.figures[0].width=444}));session.cancel();release();await pending;beforeWrite=undefined;
assert.equal(get(store.project).figures[0].width,680);assert.equal(get(store.dirty),true);await saveFigFrom(root);assert.equal(JSON.parse(files.get(root+'/fig/canvases/c1.json')!).figures[0].width,680);assert.equal(get(store.dirty),false);
// The Slide lease is part of Figure source publication, not merely an outer
// callback's eventual success check. Loss before preparation OR after journal
// publication must retain all prior authored bytes and the dirty live edit.
for (const lossAt of ['preparation','publication']) {
 const p=model(),oldSvg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80"/></svg>';
 p.assets=[{id:'lease-asset',name:'lease.svg',kind:'svg',path:'assets/lease.svg',naturalWidth:100,naturalHeight:80}];
 p.figures[0].elements=[{id:'lease-plot',type:'plot',assetId:'lease-asset',x:0,y:0,width:100,height:80,rotation:0,overrides:{}}];
 seed(p);files.set(root+'/fig/assets/lease.svg',oldSvg);await loadFigInto(root,'lease fixture');store.commit(m=>m.figures[0].x=17);
 let slidesOwned=true;
 Object.assign(bridge,{lockAcquire:async(_scope:string,name:string)=>({ok:true,token:name}),lockCheck:async(_scope:string,name:string)=>name!=='slides'||slidesOwned,lockRelease:async()=>{}});
 const before=fingerprint();
 beforeWrite=async p=>{if(lossAt==='publication'&&p.endsWith('/.meta/figure-source-generation.json'))slidesOwned=false};
 const previous={svgText:oldSvg,manifestText:null,recipeText:null},update={assetId:'lease-asset',from:'plots/lease.svg',resolved:root+'/plots/lease.svg',previous,bundle:{...previous,svgText:oldSvg.replace('<rect','<rect fill="red"')},width:100,height:80};
 await assert.rejects(saveFigFrom(root,{sourceUpdates:[update],sourceOwnersUnchanged:async()=>{if(lossAt==='preparation')slidesOwned=false}}),/lease|recovery retained/);
 beforeWrite=undefined;
 const journalPath=root+'/.meta/figure-source-generation.json';
 assert.equal(JSON.stringify([...files].filter(([p])=>p!==journalPath).sort()),before,lossAt+' losing slides lease cannot publish source/composition');
 if(lossAt==='publication')assert.ok(files.has(journalPath),'lost lease retains durable journal for next owner');
 assert.equal(get(store.dirty),true);assert.equal(get(store.project).figures[0].x,17);
 slidesOwned=true;await saveFigFrom(root);assert.equal(files.has(root+'/.meta/figure-source-generation.json'),false,'owned retry recovers before publication');
 for(const key of ['lockAcquire','lockCheck','lockRelease'])delete (bridge as any)[key];
}
// Every interrupted text stage rolls back exact originals and restart is idempotent.
for(const failure of ['fig/assets/a.svg','fig/canvases/c1.json','fig/captions/f1.md','fig/index.json']) {
 const disk=new Map([['fig/assets/a.svg','red'],['fig/canvases/c1.json','old'],['fig/captions/f1.md','caption'],['fig/index.json','index']]);const original=JSON.stringify([...disk]);let failed=false;
 const io={read:async(p:string)=>disk.get(p)??null,write:async(p:string,t:string)=>{if(p===failure&&!failed){failed=true;throw Error('ENOSPC')}disk.set(p,t)},remove:async(p:string)=>{disk.delete(p)}};
 await assert.rejects(commitTextGeneration(io,new Map([...disk].map(([p])=>[p,'new']))));await recoverTextGeneration(io);assert.equal(JSON.stringify([...disk]),original,failure);
}
// Unknown non-load-bearing metadata survives the shared planner.
seed();const unknownIndex=JSON.parse(files.get(root+'/fig/index.json')!);unknownIndex.scientificProvenance={batch:'v17'};unknownIndex.canvases[0].instrument='microscope';unknownIndex.figures[0].reviewerNote='retain';files.set(root+'/fig/index.json',JSON.stringify(unknownIndex));
const unknownCanvas=JSON.parse(files.get(root+'/fig/canvases/c1.json')!);unknownCanvas.acquisitionEpoch=42;files.set(root+'/fig/canvases/c1.json',JSON.stringify(unknownCanvas));
await loadFigInto(root,'metadata');store.commit(p=>p.figures[0].x+=10);await saveFigFrom(root);
const preserved=JSON.parse(files.get(root+'/fig/index.json')!);assert.deepEqual(preserved.scientificProvenance,{batch:'v17'});assert.equal(preserved.canvases[0].instrument,'microscope');assert.equal(preserved.figures[0].reviewerNote,'retain');assert.equal(JSON.parse(files.get(root+'/fig/canvases/c1.json')!).acquisitionEpoch,42);
// Known optional identity fields can be removed without reviving old metadata.
store.commit(p=>{p.figures[0].nickname='temporary nickname'});await saveFigFrom(root);
store.commit(p=>{delete p.figures[0].nickname});await saveFigFrom(root);
assert.equal(JSON.parse(files.get(root+'/fig/index.json')!).figures[0].nickname,undefined);
assert.equal(JSON.parse(files.get(root+'/project.json')!).figures[0].nickname,undefined);
// The binary generation rolls back byte-for-byte after a later index failure.
const raw=new Map<string,Uint8Array>([['fig/assets/a.png',new Uint8Array([0,255,17,128])]]),textFiles=new Map<string,string>([['fig/index.json','old']]);let binaryFault=true;const order:string[]=[];
const binaryIO={read:async(p:string)=>textFiles.get(p)??null,write:async(p:string,t:string)=>{order.push('write:'+p);if(p==='fig/index.json'&&binaryFault){binaryFault=false;throw Error('ENOSPC')}textFiles.set(p,t)},remove:async(p:string)=>{raw.delete(p);textFiles.delete(p)},readBytes:async(p:string)=>raw.get(p)??null,writeBytes:async(p:string,bytes:Uint8Array)=>{order.push('write:'+p);raw.set(p,bytes)},fsyncDir:async(p:string)=>{order.push('sync:'+p)}};
await assert.rejects(commitTextGeneration(binaryIO,new Map<any,any>([['fig/assets/a.png',{base64:bytesToBase64(new Uint8Array([3,2,1]))}],['fig/index.json','new']])));assert.deepEqual(raw.get('fig/assets/a.png'),new Uint8Array([0,255,17,128]));assert.equal(textFiles.get('fig/index.json'),'old');assert.ok(order.indexOf('sync:.meta')<order.indexOf('write:fig/assets/a.png'));assert.ok(order.indexOf('sync:fig/assets')<order.indexOf('write:fig/index.json'));
// Cache-cap reproduction: ALL three overrides survive, even though none is mounted.
const p=model();p.figures=p.figures.slice(0,1);p.canvases=p.canvases.slice(0,1);const data:Record<string,string>={};
for(let i=0;i<3;i++){const aid='a'+i,svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><g id="mark">'+Array.from({length:61},(_,n)=>`<rect id="r${n}" x="${n}" y="0" width="1" height="2" fill="black"/>`).join('')+'</g></svg>';p.assets.push({id:aid,name:aid,kind:'svg',path:'assets/'+aid+'.svg',naturalWidth:100,naturalHeight:80});p.figures[0].elements.push({id:'e'+i,type:'plot',assetId:aid,x:i*100,y:0,width:100,height:80,rotation:0,overrides:{r0:{fill:'#ff0000'}}});data[aid]=bytesToDataUrl(new TextEncoder().encode(svg),'image/svg+xml');}
store.loadProject(p,null);assetData.set(data);plotStore.clearPlots();plotStore.applyPlotNodeCap(100);const out=buildFigureSvg(p.figures[0]);const doc=new DOMParser().parseFromString(out,'image/svg+xml');for(let i=0;i<3;i++)assert.equal(doc.getElementById('e'+i+'__r0')?.getAttribute('style')?.includes('fill:#ff0000'),true);assert.equal(doc.querySelectorAll('image').length,0);
assetData.set({...data,a1:undefined} as any);assert.throws(()=>buildFigureSvg(p.figures[0]),/missing asset a1/);
// Passive SVG data, escaped XML, namespaced links, escaped CSS and local references.
const malicious='<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:other="http://www.w3.org/1999/xlink" width="100" height="50"><style>@import url(https://invalid.test/a);:root{fill:red}.x{fill:u\\72l(https://invalid.test/b);stroke:blue}</style><script>x</script><h:img src="https://invalid.test/c"/><animate attributeName="href" to="https://invalid.test/d"/><defs><linearGradient id="g"/></defs><image other:href="data:text/html;base64,PHNjcmlwdD4="/><rect id="r" fill="url( &quot;#g&quot; )" onload="x" aria-labelledby="r"/></svg>';
const clean=buildPlotMarkup(malicious,{id:'one',x:0,y:0,width:100,height:50},{},undefined)!;assert.ok(!/invalid\.test|onload|<script|<animate|h:img|data:text/.test(clean));assert.match(clean,/url\(#one__g\)/);assert.match(clean,/aria-labelledby="one__r"/);assert.match(clean,/\[data-plot-scope="one"\]\{fill:red\}/);
assert.ok(Math.abs(svgIntrinsicSize("<svg width='1e2pt' height='5e1pt'/>").w-100*96/72)<1e-10);assert.equal(isUnderRoot('/project','/project/../../elsewhere'),false);
console.log('V020 FIGURE: PASS (conversion fault matrix, identity/numeric gates, captured save cancellation, generation rollback, eviction export, passive SVG, intrinsic units)');
