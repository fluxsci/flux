/** Portable model import owns receipts/files; previews never activate raw metadata. */
import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { harness } from './lib/harness.mjs';
import { writeGlb } from '../src/lib/model3d/glbCore.mjs';
import { prepareModel3dImport, makeImportedModel3dElement } from '../src/lib/model3d/importData';
import { createDeck, type SlidePresetSnapshot } from '../src/lib/slide/ops';
const h = harness('verify-model3d-slide-presets');
const bytes = writeGlb({parts:[{name:'mesh',positions:[0,0,0,1,0,0,0,1,1],indices:[0,1,2]}]});
const prepared = await prepareModel3dImport({bytes,assetId:'original',name:'Mesh'});
const deck = createDeck(), slide = deck.slides[0];
slide.elements = [makeImportedModel3dElement(prepared.data,{id:'model'})];
const snapshot: SlidePresetSnapshot = {fluxPreset:1,kind:'slide',name:'Model',savedAt:'',stage:deck.stage,slide,
  assets:[{asset:prepared.data.asset,data:`data:model/gltf-binary;base64,${Buffer.from(prepared.bytes).toString('base64')}`}],
  modelPosters:{model:'data:image/png;base64,aW1hZ2U='}};
const files = new Map<string,unknown>(), adopted:string[]=[],discarded:string[]=[],requests:any[]=[];
let current=true, switchDuringImport=false, returnActive=false;
(globalThis as any).window={fig:{
  mkdir:async()=>{}, writeFile:async(p:string,b:unknown)=>{files.set(p,b);},writeText:async(p:string,t:string)=>{files.set(p,t);},
  remove:async(p:string)=>{assert.match(p,/\.glb$|\.json$/);files.delete(p);},
  importModel3d:async(req:any)=>{requests.push(req);if(switchDuringImport)current=false;return {...structuredClone(prepared.data),asset:{...prepared.data.asset,id:'native'},receipt:'receipt',assetPrefix:'slides/deck',source:{glbPath:req.sourcePath},...(returnActive?{manifest:{spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'model.glb',parts:[]}}:{})};},
  adoptModel3d:async(r:any)=>{adopted.push(r.receipt);},discardModel3d:async(r:any)=>{discarded.push(r.receipt);},
}};
const { preparePresetModels } = await import('../src/lib/slide/model3dPresets');
const { slidePresetThumb } = await import('../src/lib/slide/presetLib');
const result=await preparePresetModels(snapshot,'/scratch','deck',()=>current);
h.eq(requests[0].target,{kind:'slide',deckId:'deck'},'portable import names the exact native deck destination');
h.eq(files.size,0,'every temporary file removed with file-only native remove semantics');
h.eq(result.assets.map(a=>a.id),['native'],'native prepared metadata is the inserted asset');
h.eq((result.snapshot.slide.elements[0] as any).assetId,'native','placement remapped to native asset');
h.eq(result.snapshot.assets,[],'GLB bytes removed before ordinary pure insertion');
h.eq(snapshot.assets?.[0].asset.id,'original','library snapshot remains immutable');
await result.adopt();h.eq(adopted,['receipt'],'successful insertion explicitly adopts native receipt');
switchDuringImport=true;
await assert.rejects(preparePresetModels(snapshot,'/scratch','deck',()=>current),/destination deck changed/);
h.eq(discarded,['receipt'],'ownership switch discards prepared receipt before returning');h.eq(files.size,0,'cancelled import removes all temporary files');
current=true;switchDuringImport=false;returnActive=true;
const inactive=structuredClone(snapshot);inactive.assets![0].modelMetadataActive=false;
await assert.rejects(preparePresetModels(inactive,'/scratch','deck',()=>current),/inactive 3D metadata/);
h.eq(discarded.length,2,'inactive metadata cannot silently reactivate on portable import');
const thumb=decodeURIComponent(slidePresetThumb(snapshot).split(',').slice(1).join(','));
h.ok(thumb.includes('data-model3d-poster="true"')&&thumb.includes('aW1hZ2U='),'portable thumbnail contains the saved mesh still');
h.ok(!thumb.includes('data:model/gltf-binary'),'thumbnail never places binary geometry in image href');
const missing=structuredClone(snapshot);delete missing.modelPosters;
h.ok(decodeURIComponent(slidePresetThumb(missing)).includes('data-model3d-placeholder'),'absent still yields an explicit placeholder');
const two=structuredClone(snapshot);two.assets!.push({...structuredClone(two.assets![0]),asset:{...two.assets![0].asset,id:'second'}});
let serial=0;const attempted:string[]=[];
(globalThis as any).window.fig.importModel3d=async(req:any)=>({...structuredClone(prepared.data),asset:{...prepared.data.asset,id:`copy-${++serial}`},receipt:`owned-${serial}`,assetPrefix:'slides/deck',source:{glbPath:req.sourcePath}});
(globalThis as any).window.fig.discardModel3d=async(r:any)=>{attempted.push(r.receipt);if(r.receipt==='owned-1')throw Error('saved owner retained');};
const pair=await preparePresetModels(two,'/scratch','deck',()=>true);
await assert.rejects(pair.discard(),/could not be discarded/);
h.eq(attempted.sort(),['owned-1','owned-2'],'cleanup attempts every receipt even when one saved owner refuses discard');
const adoptionAttempts:string[]=[];
(globalThis as any).window.fig.adoptModel3d=(r:any)=>{adoptionAttempts.push(r.receipt);if(r.receipt==='owned-1')throw Error('generation changed');};
await assert.rejects(pair.adopt(),/ownership could not be confirmed/);
h.eq(adoptionAttempts.sort(),['owned-1','owned-2'],'committed insertion attempts every adoption after an individual failure');

const { insertSlidePreset, saveSlidePreset } = await import('../src/lib/slide/presetLib');
const { loadDeckModel, currentDeck } = await import('../src/lib/slide/store');
const { embeddedProjectRoot, activeFigureId } = await import('../src/lib/store');
const { setModel3dDeckScope } = await import('../src/lib/model3d/editorScope');
const { setStoreTenant } = await import('../src/lib/tenancy');
const { get } = await import('svelte/store');
setStoreTenant('slide'); embeddedProjectRoot.set('/scratch');
loadDeckModel(deck); setModel3dDeckScope(deck.id);
let releaseAdopt!:()=>void, enteredAdopt!:()=>void;
const entered=new Promise<void>(resolve=>enteredAdopt=resolve);
const held=new Promise<void>(resolve=>releaseAdopt=resolve);
(globalThis as any).window.fig.adoptModel3d=async()=>{enteredAdopt();await held;};
const inserting=insertSlidePreset({rel:'test.json',preset:snapshot});
await entered;
h.eq(currentDeck()!.slides.length,2,'preset document commits before native adoption yields');
// Return to the same root and deck id with a new ownership epoch (ABA).
loadDeckModel(deck);setModel3dDeckScope(deck.id);
const selected=get(activeFigureId);
releaseAdopt();await inserting;
h.eq(get(activeFigureId),selected,'late adoption cannot select an old insertion in a reopened same-id deck');
h.eq(currentDeck()!.slides.length,1,'late adoption leaves reopened document untouched');

const nested=structuredClone(deck);nested.assets=[{...prepared.data.asset,path:'nested/mesh.glb'}];
nested.slides[0].elements[0].hidden=true; // This test isolates persistence, not asynchronous poster rendering.
loadDeckModel(nested);setModel3dDeckScope(nested.id);
const manifest={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'mesh.glb',parts:[{id:'mesh',role:'mesh',node:'mesh'}]};
const canonical=`/scratch/slides/${nested.id}/assets/original.fluxplot.json`;
const sidecarReads:string[]=[];let saved:any;
Object.assign((globalThis as any).window.fig,{
  readFile:async(p:string)=>{assert.equal(p,`/scratch/slides/${nested.id}/nested/mesh.glb`);return prepared.bytes;},
  exists:async(p:string)=>p===canonical,
  readText:async(p:string)=>{sidecarReads.push(p);return JSON.stringify(manifest);},
  writeSlideLibrary:async(_rel:string,value:any)=>{saved=value;return true;},
});
await saveSlidePreset('Nested',nested.slides[0].id);
h.eq(sidecarReads,[canonical],'preset resolves canonical sidecars independently of stored GLB path');
h.eq(saved.assets[0].manifest.parts,manifest.parts,'nested GLB preset preserves accepted semantic metadata');
setStoreTenant(null);
await h.done();
