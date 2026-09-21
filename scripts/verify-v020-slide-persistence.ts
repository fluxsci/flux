import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMParser } from 'linkedom';
import { get } from 'svelte/store';
import { createDeck } from '../src/lib/slide/ops';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-v020-slide-save-'));
let beforeWrite:((p:string)=>Promise<void>)|undefined,beforeRead:((p:string)=>Promise<void>)|undefined;
const fb={exists:async(p:string)=>fs.access(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}),readText:async(p:string)=>{await beforeRead?.(p);return fs.readFile(p,'utf8')},readFile:async(p:string)=>{await beforeRead?.(p);const b=await fs.readFile(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)},writeText:async(p:string,t:string)=>{await beforeWrite?.(p);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,t)},writeFile:async(p:string,b:Uint8Array)=>{await beforeWrite?.(p);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,b)},mkdir:async(p:string)=>{await fs.mkdir(p,{recursive:true})},remove:async(p:string)=>{await fs.rm(p,{force:true})}};
(globalThis as any).window={fig:fb};(globalThis as any).DOMParser=DOMParser;
const bridge=await import('../src/lib/project/slideBridge');
const slide=await import('../src/lib/slide/store');
const store=await import('../src/lib/store');
const assets=await import('../src/lib/assets');
const plots=await import('../src/lib/plot/store');
(await import('../src/lib/tenancy')).setStoreTenant('slide');
store.embeddedProjectRoot.set(root);
const svg=(color:string,w=100)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="80"><rect id="mark" width="${w}" height="80" fill="${color}"/></svg>`;
const man=(n:number)=>JSON.stringify({spec:'fluxplot',schemaVersion:'0.2.0',axes:[],series:[],plotType:`revision-${n}`});
const deckPath=root+'/slides/talk/deck.json',assetPath=root+'/slides/talk/assets/a.svg';
let checks=0;const ok=(s:string)=>{checks++;console.log('  ok:',s)};
async function seed(){
 beforeWrite=undefined;beforeRead=undefined;await fs.rm(root,{recursive:true,force:true});await fs.mkdir(root,{recursive:true});store.embeddedProjectRoot.set(root);
 await fb.writeText(root+'/project.json',JSON.stringify({schemaVersion:'0.1.0',id:'p',title:'Fixture',figures:[],references:{library:'bib/library.bib'},manuscript:{path:'paper/main.qmd'},slides:[{id:'talk',path:'slides/talk/deck.json',title:'Talk',order:1}],unknown:{keep:true}}));
 const d=createDeck({id:'talk',title:'Talk',withTitleSlide:false});d.assets=[{id:'a',name:'Plot',kind:'svg',path:'assets/a.svg',naturalWidth:100,naturalHeight:80}];d.slides=[{id:'s',elements:[{id:'e',type:'plot',assetId:'a',x:10,y:20,width:50,height:40,rotation:0,source:{svgPath:'plots/a.svg'},overrides:{}}],beats:[{id:'b',tracks:[]}]}];
 await fb.writeText(deckPath,JSON.stringify(d));await fb.writeText(assetPath,svg('red'));await fb.writeText(root+'/slides/talk/assets/a.fluxplot.json',man(1));await fb.writeText(root+'/plots/a.svg',svg('red'));await fb.writeText(root+'/plots/a.fluxplot.json',man(1));await bridge.loadDeckInto(root,'talk');
}
async function files(){return Promise.all([deckPath,assetPath,root+'/slides/talk/assets/a.fluxplot.json',root+'/project.json'].map(p=>fs.readFile(p,'utf8')))}
try{
 for(const suffix of ['assets/a.svg','assets/a.fluxplot.json','deck.json','project.json']){
  await seed();slide.commitDeckLive(d=>{d.title='My title';d.slides[0].elements[0].x=37});
  const disk=await files(),model=JSON.stringify(slide.currentDeck()),data=JSON.stringify(get(assets.assetData)),cache=plots.plotDom.get('a');
  await fb.writeText(root+'/plots/a.svg',svg('blue',200));await fb.writeText(root+'/plots/a.fluxplot.json',man(2));
  let failed=false;beforeWrite=async p=>{if(!failed&&p.endsWith('/'+suffix)){failed=true;throw Error('ENOSPC '+suffix)}};
  await assert.rejects(bridge.refreshDeckSources(root),/ENOSPC/);beforeWrite=undefined;assert.equal(failed,true);assert.deepEqual(await files(),disk);assert.equal(JSON.stringify(slide.currentDeck()),model);assert.equal(JSON.stringify(get(assets.assetData)),data);assert.equal(plots.plotDom.get('a'),cache);assert.equal(get(store.dirty),true);assert.equal(await fb.exists(root+'/.meta/figure-source-generation.json'),false);ok(`source ${suffix} failure preserves exact files, model, cache and dirty edit`);
 }
 await seed();await fb.writeText(root+'/plots/a.svg',svg('blue',200));await fb.writeText(root+'/plots/a.fluxplot.json',man(2));
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>entered=r);let paused=false;
 beforeRead=async p=>{if(!paused&&p===root+'/plots/a.svg'){paused=true;entered();await waiting}};
 const refresh=bridge.refreshDeckSources(root);await seen;slide.commitDeckLive(d=>{d.slides[0].elements[0].x=91});release();await refresh;beforeRead=undefined;
 assert.equal(slide.currentDeck()!.slides[0].elements[0].x,91);assert.equal(slide.currentDeck()!.slides[0].elements[0].width,100);assert.match(assets.getAssetData('a')!,/base64/);assert.equal(JSON.parse(await fs.readFile(deckPath,'utf8')).slides[0].elements[0].x,91);assert.match(await fs.readFile(assetPath,'utf8'),/blue/);ok('edit during source preparation merges position and physical source scale, then persists and publishes matching bytes');
 await seed();slide.commitDeckLive(d=>{d.title='Pending asset';d.slides[0].elements[0].x=55});assets.assetData.set({a:assets.bytesToDataUrl(new TextEncoder().encode(svg('green')),'image/svg+xml')});assets.markAssetDirty('a');const original=await files();let failed=false;beforeWrite=async p=>{if(p===root+'/project.json'&&!failed){failed=true;throw Error('ENOSPC manifest')}};
 await assert.rejects(bridge.saveDeckFrom(root),/ENOSPC/);beforeWrite=undefined;assert.deepEqual(await files(),original);assert.equal(assets.isAssetDirty('a'),true);assert.equal(get(store.dirty),true);await bridge.saveDeckFrom(root);assert.match(await fs.readFile(assetPath,'utf8'),/green/);assert.equal(assets.isAssetDirty('a'),false);assert.equal(get(store.dirty),false);ok('ordinary asset save is transactional and only successful generation clears dirty');
 await seed();const cached=JSON.stringify(get(assets.assetData));const d=await bridge.readDeck(root,'talk');await bridge.resolveDeckAssets(root,d!,()=>false,true);assert.equal(JSON.stringify(get(assets.assetData)),cached);ok('read-only deck resolution leaves global accepted data unchanged');
 await seed();await fs.mkdir(root+'/custom-decks',{recursive:true});await fs.rename(deckPath,root+'/custom-decks/talk.json');const registration=JSON.parse(await fs.readFile(root+'/project.json','utf8'));registration.slides[0].path='custom-decks/talk.json';await fs.writeFile(root+'/project.json',JSON.stringify(registration));await bridge.loadDeckInto(root,'talk');slide.commitDeckLive(d=>{d.title='Custom path';d.slides[0].elements[0].x=73});await bridge.saveDeckFrom(root);assert.equal(await fb.exists(deckPath),false);assert.equal(JSON.parse(await fs.readFile(root+'/custom-decks/talk.json','utf8')).slides[0].elements[0].x,73);assert.deepEqual(JSON.parse(await fs.readFile(root+'/project.json','utf8')).unknown,{keep:true});ok('custom registered relative JSON deck path survives journal publication and registration');
 console.log(`V020 SLIDE PERSISTENCE: PASS (${checks} checks)`);
}finally{beforeWrite=undefined;beforeRead=undefined;await fs.rm(root,{recursive:true,force:true})}
