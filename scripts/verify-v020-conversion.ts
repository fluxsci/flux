import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from 'linkedom';
import { get } from 'svelte/store';
import { planFigSave } from '../src/lib/project/figfiles';
import { readFigureSnapshot } from '../src/lib/project/figureSnapshot';
import { createDeck } from '../src/lib/slide/ops';
import type { Project, Figure } from '../src/lib/types';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'flux-v020-conversion-'));
let readHook: ((p:string)=>Promise<void>)|undefined, writeHook: ((p:string)=>Promise<void>)|undefined;
const writes:string[]=[], locks:string[]=[];
const bridge = {
  exists: async (p:string) => fs.access(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}),
  readText: async (p:string) => { await readHook?.(p); return fs.readFile(p,'utf8'); },
  readFile: async (p:string) => { await readHook?.(p); const b=await fs.readFile(p); return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); },
  writeText: async (p:string,t:string) => {await writeHook?.(p);writes.push(p);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,t)},
  writeFile: async (p:string,b:Uint8Array) => {await writeHook?.(p);writes.push(p);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,b)},
  mkdir: async (p:string)=>{await fs.mkdir(p,{recursive:true})}, remove: async(p:string)=>{await fs.rm(p,{force:true})},
  lockAcquire: async (_scope:string,name:string,expectedRoot:string)=>{assert.equal(expectedRoot,root);locks.push(name);return {ok:true,noop:true}},
};
(globalThis as any).window={fig:bridge};(globalThis as any).DOMParser=DOMParser;
const store=await import('../src/lib/store');
const assets=await import('../src/lib/assets');
const plots=await import('../src/lib/plot/store');
const {sendSlideToCanvas,sendFigureToDeck}=await import('../src/lib/project/convert');
const {readDeck,writeDeckDirect}=await import('../src/lib/project/slideBridge');
store.embeddedProjectRoot.set(root);
let checks=0;
const ok=(s:string)=>{checks++;console.log('  ok:',s)};
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>';
const asset={id:'a',kind:'svg' as const,name:'Recorded data',naturalWidth:40,naturalHeight:20};
const plot={id:'plot',type:'plot' as const,assetId:'a',x:2,y:3,width:40,height:20,rotation:0,overrides:{}};
const slide={id:'s',name:'Results',elements:[plot],beats:[]};
const deck={id:'talk',stage:{width:100,height:80},assets:[asset]};
function model():Project{return {version:2,name:'fixture',canvases:[{id:'c',name:'Main'},{id:'sibling',name:'Sibling'}],figures:[{id:'f',name:'Existing',canvasId:'c',x:0,y:0,width:100,height:80,elements:[],captions:{__figure__:'Preserved scientific caption'}},{id:'f2',name:'Sibling',canvasId:'sibling',x:0,y:0,width:100,height:80,elements:[]}],assets:[],palette:[]}}
async function seed(){
 await fs.rm(root,{recursive:true,force:true});await fs.mkdir(root,{recursive:true});readHook=undefined;writeHook=undefined;writes.length=0;locks.length=0;store.embeddedProjectRoot.set(root);
 const p=model(),plan=planFigSave(p,null);for(const f of [...plan.canvases,...plan.captions,plan.index])await bridge.writeText(root+'/'+f.path,f.text);
 const idx=JSON.parse(await fs.readFile(root+'/fig/index.json','utf8'));idx.unknown={keep:'index'};idx.figures[0].unknown='figure';await fs.writeFile(root+'/fig/index.json',JSON.stringify(idx));
 const cf=JSON.parse(await fs.readFile(root+'/fig/canvases/sibling.json','utf8'));cf.unknown={keep:'canvas'};await fs.writeFile(root+'/fig/canvases/sibling.json',JSON.stringify(cf));
 await fs.writeFile(root+'/project.json',JSON.stringify({schemaVersion:'0.1.0',id:'p',title:'Fixture',manuscript:{path:'paper/notes.qmd'},references:{library:'bib/library.bib'},figures:[],unknown:{keep:'manifest'}}));
 store.project.set({...p,assets:[asset]});assets.assetData.set({a:assets.bytesToDataUrl(new TextEncoder().encode(svg),'image/svg+xml')});plots.plotManifests.set({});writes.length=0;
}
async function snapshot(){const out=new Map<string,string>();async function walk(dir:string){for(const e of await fs.readdir(dir,{withFileTypes:true})){const abs=path.join(dir,e.name);if(e.isDirectory())await walk(abs);else out.set(abs.slice(root.length+1),(await fs.readFile(abs)).toString('base64'))}}await walk(root);return out}
async function preserved(before:Map<string,string>){for(const [p,b]of before)assert.equal((await fs.readFile(root+'/'+p)).toString('base64'),b,p+' original bytes preserved')}
try {
 await seed();const before=await snapshot();
 await assert.rejects(sendSlideToCanvas(root,{...slide,guides:{x:[NaN],y:[]}} as any,deck,'c'),/finite/);
 assert.equal(writes.length,0);await preserved(before);ok('invalid Figure numeric state rejected before any asset or canonical write');
 for(const direction of ['figure','slide'])for(const fault of ['missing','corrupt','future','EACCES','EBUSY']){
  await seed();const sibling=root+'/fig/canvases/sibling.json';if(fault==='missing')await fs.rm(sibling);else if(fault==='corrupt')await fs.writeFile(sibling,'{');else if(fault==='future'){const x=JSON.parse(await fs.readFile(sibling,'utf8'));x.schemaVersion='99.0.0';await fs.writeFile(sibling,JSON.stringify(x))}else readHook=async p=>{if(p===sibling)throw Error(fault)};
  const bytes=await snapshot();await assert.rejects(direction==='figure'?sendFigureToDeck(root,{name:'New',elements:[plot]},null):sendSlideToCanvas(root,slide,deck,'c'));
  readHook=undefined;assert.equal(writes.length,0);await preserved(bytes);ok(`${direction} conversion preserves every byte for ${fault} sibling`);
 }
 await seed();const result=await sendSlideToCanvas(root,slide,deck,'c');
 const loaded=await readFigureSnapshot({readText:async rel=>bridge.exists(root+'/'+rel).then(yes=>yes?bridge.readText(root+'/'+rel):null)});assert.equal(loaded.status,'complete');assert.equal(loaded.project.figures.length,3);assert.equal(loaded.project.figures.find(f=>f.id===result.figureId)?.elements[0].type,'plot');assert.equal(await fs.readFile(root+'/fig/assets/a.svg','utf8'),svg);assert.deepEqual((loaded.index as any).unknown,{keep:'index'});assert.equal((loaded.index!.figures[0] as any).unknown,'figure');assert.deepEqual(JSON.parse(await fs.readFile(root+'/fig/canvases/sibling.json','utf8')).unknown,{keep:'canvas'});const registered=JSON.parse(await fs.readFile(root+'/project.json','utf8'));assert.equal(registered.figures.length,3);assert.deepEqual(registered.unknown,{keep:'manifest'});assert.deepEqual(locks.slice(0,3),['project','slides','manifest']);ok('conversion saves/reopens complete model, copied asset bytes, unknown metadata and fresh manifest under ordered expected-root leases');
 await seed();const previous=await snapshot();let failed=false;writeHook=async p=>{if(p===root+'/project.json'&&!failed){failed=true;throw Error('ENOSPC')}};
 await assert.rejects(sendSlideToCanvas(root,slide,deck,'c'),/ENOSPC/);writeHook=undefined;await preserved(previous);assert.equal(await bridge.exists(root+'/.meta/figure-source-generation.json'),false);ok('manifest publication failure rolls back canonical Figure files and index exactly');
 await seed();await bridge.writeText(root+'/fig/assets/a.svg','different accepted bytes');let idx=JSON.parse(await fs.readFile(root+'/fig/index.json','utf8'));idx.assets.push({...asset,path:'assets/a.svg'});await fs.writeFile(root+'/fig/index.json',JSON.stringify(idx));writes.length=0;const collision=await snapshot();await assert.rejects(sendSlideToCanvas(root,slide,deck,'c'),/different bytes/);await preserved(collision);assert.equal(writes.length,0);ok('asset identity collision refuses rather than replacing scientific bytes');
 await seed();const cacheBefore=JSON.stringify(get(assets.assetData)),sourceBefore=JSON.stringify(get(store.project));const sent=await sendFigureToDeck(root,{name:'Unsaved plot',elements:[plot]},null);const savedDeck=await readDeck(root,sent.deckId);assert.ok(savedDeck);assert.equal(savedDeck!.slides.length,1);assert.equal(await fs.readFile(root+`/slides/${sent.deckId}/assets/a.svg`,'utf8'),svg);assert.equal(JSON.stringify(get(assets.assetData)),cacheBefore);assert.equal(JSON.stringify(get(store.project)),sourceBefore);ok('unsaved Figure assets become complete deck-owned copies without publishing target caches or baseline');
 await seed();let switched=false;readHook=async p=>{if(!switched&&p.endsWith('/fig/canvases/sibling.json')){switched=true;store.embeddedProjectRoot.set('/other')}};const original=await snapshot();await assert.rejects(sendSlideToCanvas(root,slide,deck,'c'),/Project changed/);readHook=undefined;await preserved(original);assert.equal(writes.length,0);ok('root change during preparation refuses all publication');
 await seed();const d=createDeck({id:'target',withTitleSlide:true});await writeDeckDirect(root,d);const read=await readDeck(root,'target');const file=root+'/slides/target/deck.json',external=JSON.parse(await fs.readFile(file,'utf8'));external.title='External';await fs.writeFile(file,JSON.stringify(external));read!.title='Stale';await assert.rejects(writeDeckDirect(root,read!),/changed/);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).title,'External');ok('read-only deck evidence is checked without adopting a stale save baseline');
 console.log(`V020 CONVERSION: PASS (${checks} checks)`);
} finally {readHook=undefined;writeHook=undefined;await fs.rm(root,{recursive:true,force:true})}
