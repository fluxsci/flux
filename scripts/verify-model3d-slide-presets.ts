/** Portable model import owns receipts/files; previews never activate raw metadata. */
import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { harness } from './lib/harness.mjs';
import { writeGlb } from '../src/lib/model3d/glbCore.mjs';
import { prepareModel3dImport, makeImportedModel3dElement } from '../src/lib/model3d/importData';
import { createDeck, addSlide, type SlidePresetSnapshot } from '../src/lib/slide/ops';
const h = harness('verify-model3d-slide-presets');
const bytes = writeGlb({parts:[{name:'mesh',positions:[0,0,0,1,0,0,0,1,1],indices:[0,1,2]}]});
const prepared = await prepareModel3dImport({bytes,assetId:'original',name:'Mesh'});
const deck = createDeck(), slide = addSlide(deck)!;
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
await h.done();
