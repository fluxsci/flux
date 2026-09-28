import './lib/cssStub.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { harness } from './lib/harness.mjs';
import { inspectGlb, writeGlb } from '../src/lib/model3d/glbCore.mjs';
import { makeModel3dElement } from '../src/lib/model3d/make';
import { elementAssetRefs, elementSourceAssetIds } from '../src/lib/model3d/refs';
import { parseScene3d } from '../src/lib/model3d/scene3d';
import { collectModel3dSourceBindings, scene3dSourceBindingIssue } from '../src/lib/model3d/sourceBinding';
import { readScene3dSidecars, scene3dSidecarWrites } from '../src/lib/model3d/persistence';
import { prepareModelCopy, publishModelCopy } from '../src/lib/model3d/copy';
import { normalizeIndexAssets, planFigSave } from '../src/lib/project/figfiles';
import { validateModel, validateCanvasFile, validateFigIndexFile, validateDeckFile } from '../src/lib/project/validate';
import { readFigureSnapshot } from '../src/lib/project/figureSnapshot';
import { figureSourceOwners } from '../src/lib/project/figureSourceOwners';
import { readProjectDependencies } from '../src/lib/project/dependencies';
import { figureImageAssetIds } from '../flux-core/render';
import { mimeFor } from '../src/lib/assets';
import type { Project } from '../src/lib/types';
import type { FileBridge } from '../src/lib/project/types';
import type { Model3dAsset, Scene3dManifest } from '../src/lib/model3d/types';
const h=harness('verify-model3d-persistence'), require=createRequire(import.meta.url);
const {createVerifiedCopy}=require('../electron/verifiedCopy.cjs');
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const bytes=writeGlb({parts:[{name:'neuron.mesh',positions:[0,0,0,1,0,0,0,1,1],indices:[0,1,2]}]});
const asset:Model3dAsset={id:'neuron',name:'Neuron',kind:'glb',path:'assets/neuron.glb',naturalWidth:320,naturalHeight:240,sha256:sha(bytes),bytes:bytes.byteLength,model:inspectGlb(bytes)};
const element=makeModel3dElement(asset,{id:'neuron-view'});
const manifest:Scene3dManifest={spec:'fluxplot/scene3d',schemaVersion:'0.1.0',glb:'neuron.glb',parts:[{id:'neuron.mesh',role:'mesh',node:'neuron.mesh'}]};
const model:Project={version:2,name:'Models',canvases:[{id:'two',name:'2D'},{id:'three',name:'3D'}],figures:[{id:'fig-two',name:'Plain',canvasId:'two',x:0,y:0,width:200,height:100,elements:[]},{id:'fig-three',name:'Neuron',canvasId:'three',x:0,y:0,width:320,height:240,elements:[element]}],assets:[asset],palette:[]};
const plan=planFigSave(model,null), index=JSON.parse(plan.index.text);
h.eq(index.schemaVersion,'0.2.0','index stamps 0.2 only when GLB metadata is retained');
h.eq(plan.canvases.map(c=>JSON.parse(c.text).schemaVersion),['0.1.0','0.2.0'],'only the 3D canvas stamps 0.2');
assert.deepEqual(normalizeIndexAssets(index)[0],{...asset,dpi:undefined});h.ok(true,'normalization preserves GLB kind/hash/bytes/model metadata');
h.eq(validateModel(model),[],'model3d accepted in assembled figure model');
h.eq(validateModel({...model,figures:[{...model.figures[1],elements:[{...element,source:{glbPath:'plots/original.glb',sha256:'a'.repeat(64)}}]}]}),[],'original source checksum is separate from prepared asset checksum');
h.ok(validateModel({...model,figures:[{...model.figures[1],elements:[{...element,source:{glbPath:'plots/original.glb',sha256:'BAD'}}]}]}).length>0,'invalid original source checksum rejected');
h.eq(validateFigIndexFile(index),[],'GLB index validates');
h.ok(plan.canvases.every(c=>validateCanvasFile(JSON.parse(c.text)).length===0),'3D and 2D canvas schemas validate');
for(const patch of [{orbitZoom:0},{orbitFov:180},{orbitElevation:91},{orbitAzimuth:Infinity},{modelStates:{bent:NaN}}])h.ok(validateModel({...model,figures:[{...model.figures[1],elements:[{...element,...patch}]}]}).length>0,'invalid camera/state rejected');
for(const patch of [{model:undefined},{sha256:'bad'},{bytes:0},{model:{...asset.model,bounds:{min:[0,0,Infinity],max:[1,1,1]}}}])h.ok(validateFigIndexFile({...index,assets:[{...asset,...patch}]}).length>0,'incomplete/nonfinite GLB metadata rejected');
const deck={schemaVersion:'0.5.0',id:'deck',stage:{width:800,height:600},slides:[{id:'slide',elements:[element],beats:[]}]};
h.ok(validateDeckFile(deck).length>0,'old deck 0.5 explicitly refuses model3d until P4');
const video={type:'video',assetId:'movie',posterAssetId:'still'};
h.eq(elementAssetRefs(video),{images:['still'],models:[],media:['movie'],manifests:[],posterRefs:[]},'video retains its media and poster buckets');
h.eq(elementSourceAssetIds(video),['still','movie'],'physical reference collector retains video and poster');
h.eq([...figureImageAssetIds({elements:[element,video as never,{...element,type:'image',assetId:'raster'} as never]})],['still','raster'],'render image set excludes GLB and video binary');
h.eq(['png','svg','mp4','glb'].map(k=>mimeFor(k as never)),['image/png','image/svg+xml','video/mp4','model/gltf-binary'],'MIME mapping has no GLB-as-PNG fallback');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'flux-model3d-persist-'));
let binaryReads=0,binaryWrites=0;
const bridge={
 exists:(p:string)=>fs.access(p).then(()=>true,()=>false),readText:(p:string)=>fs.readFile(p,'utf8'),
 writeText:async(p:string,t:string)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,t);},
 readFile:async(p:string)=>{if(p.endsWith('.glb')){binaryReads++;throw Error('GLB must remain metadata-only');}const b=await fs.readFile(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},
 writeFile:async(p:string,b:Uint8Array)=>{if(p.endsWith('.glb')){binaryWrites++;throw Error('GLB must be copied natively');}await fs.writeFile(p,b);},
 mkdir:async(p:string)=>{await fs.mkdir(p,{recursive:true});},remove:(p:string)=>fs.rm(p,{force:true}),
 readdir:async(p:string)=>(await fs.readdir(p,{withFileTypes:true})).map(e=>({name:e.name,dir:e.isDirectory()})),
 copyFileVerified:createVerifiedCopy(),
} as unknown as FileBridge;
(globalThis as unknown as {window:unknown}).window={fig:bridge};
try {
 const write=async(rel:string,text:string|Uint8Array)=>{const full=path.join(root,rel);await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,text);};
 await write('project.json',JSON.stringify({schemaVersion:'0.1.0',id:'model3d',title:'Models',manuscript:{path:'paper/notes.qmd'},references:{library:'bib/library.bib'},figures:[]}));
 for(const entry of [...plan.canvases,...plan.captions,plan.index])await write(entry.path,entry.text);
 await write('fig/assets/neuron.glb',bytes);await write('fig/assets/neuron.fluxplot.json',JSON.stringify(manifest));
 const parityRoot=path.join(root,'parity');await fs.cp(path.join(root,'fig'),path.join(parityRoot,'fig'),{recursive:true});await fs.copyFile(path.join(root,'project.json'),path.join(parityRoot,'project.json'));
 const originalGlb=await fs.readFile(path.join(root,'fig/assets/neuron.glb'));
 const {loadFigInto,saveFigFrom,readFigSource}=await import('../src/lib/project/figbridge');
 const {project}=await import('../src/lib/store'),{get}=await import('svelte/store');
 const {assetData,markAssetDirty}=await import('../src/lib/assets');
 const {scene3dManifests,scene3dIssues}=await import('../src/lib/model3d/store');
 const core=await import('../flux-core/index');
 h.ok((await core.validate(root,'fig/assets/neuron.fluxplot.json')).ok,'CLI dispatch validates scene3d instead of semantic SVG');
 const loadedCore=await core.loadFigModel(root);
 await loadFigInto(root,'Models');
 h.eq(JSON.parse(JSON.stringify({...get(project),name:''})),JSON.parse(JSON.stringify({...loadedCore.project,name:''})),'GUI/core load identical 3D metadata');
 const other=await core.loadFigModel(parityRoot);(other.project.figures[1].elements[0] as typeof element).orbitAzimuth=75;
 project.update(p=>{(p.figures[1].elements[0] as typeof element).orbitAzimuth=75;return p;});
 await core.saveFigModel(parityRoot,other.project,other.index);await saveFigFrom(root);
 for(const rel of ['fig/index.json','fig/canvases/two.json','fig/canvases/three.json'])h.eq(await fs.readFile(path.join(root,rel),'utf8'),await fs.readFile(path.join(parityRoot,rel),'utf8'),`GUI/core 3D save byte parity: ${rel}`);
 h.eq(get(assetData),{},'load does not populate GLB data URLs');h.eq(get(scene3dManifests).neuron,manifest,'validated scene metadata has its own cache');
 markAssetDirty(asset.id);await saveFigFrom(root);
 h.eq(binaryWrites,0,'dirty GLB saves only sidecar JSON, not binary journal payload');
 h.eq(sha(await fs.readFile(path.join(root,'fig/assets/neuron.glb'))),sha(originalGlb),'save retains original GLB bytes');
 const source=await readFigSource(root);h.eq(source.assetData,{},'read-only source is also metadata-only');h.eq(source.model3dManifests?.neuron,manifest,'read-only source carries scene3d manifest separately');
 h.eq(binaryReads,0,'load/save/read-only source never read GLB through bridge');
 const unknown='{ "spec":"fluxplot/scene3d", "schemaVersion":"9.0.0", "glb":"neuron.glb", "future": true }\n';
 await write('fig/assets/neuron.fluxplot.json',unknown);await loadFigInto(root,'Models');
 h.ok(!get(scene3dManifests).neuron&&!!get(scene3dIssues).neuron?.length,'future scene metadata degrades to plain mesh with warning');
 await saveFigFrom(root);markAssetDirty(asset.id);await saveFigFrom(root);
 h.eq(await fs.readFile(path.join(root,'fig/assets/neuron.fluxplot.json'),'utf8'),unknown,'ordinary and dirty metadata saves preserve unknown sidecar bytes');
 const unknownSidecars=await readScene3dSidecars(bridge,path.join(root,'fig/assets'),asset.id);
 h.ok(!unknownSidecars.manifest&&!!unknownSidecars.issues?.length,'metadata fallback is separate from binary failure');
 h.eq(scene3dSidecarWrites('assets',asset.id,unknownSidecars).get('assets/neuron.fluxplot.json'),unknown,'Save As preserves raw unknown sidecar text');
 for(const kind of ['manifest','recipe'] as const) for(const method of ['exists','readText'] as const) {
   const suffix=kind==='manifest'?'fluxplot':'recipe',target=path.join(root,`fig/assets/neuron.${suffix}.json`);
   const faulty={...bridge,exists:async(p:string)=>p===target?true:bridge.exists(p),[method]:async(p:string)=>{if(p===target)throw Object.assign(Error('permission denied'),{code:'EACCES'});return bridge[method](p);}};
   const sidecars=await readScene3dSidecars(faulty,path.join(root,'fig/assets'),asset.id);
   h.ok(!!sidecars.issues?.length,`${kind} ${method} IO failure is a localized warning`);
   h.ok(!scene3dSidecarWrites('assets',asset.id,sidecars).has(`assets/neuron.${suffix}.json`),'unreadable metadata is not deleted or overwritten');
   await assert.rejects(()=>readScene3dSidecars(faulty,path.join(root,'fig/assets'),asset.id,{strict:true}),/cannot copy unreadable/);
   await assert.rejects(()=>prepareModelCopy(faulty,root,asset,root,'blocked.glb',{sourcePrefix:'fig'}),/cannot copy unreadable/);
 }
 h.ok(!await bridge.exists(path.join(root,'blocked.glb')),'unreadable sidecar copy preflight publishes no GLB');
 const copy=await prepareModelCopy(bridge,root,asset,path.join(root,'copy'),'assets/neuron.glb',{sourcePrefix:'fig'});let ownership=0;
 await publishModelCopy(bridge,copy,()=>{ownership++;});h.eq(ownership,2,'native copy brackets publication with ownership assertions');
 h.eq(await fs.readFile(copy.destination),originalGlb,'native copy transfers exact GLB bytes');
 h.eq(await fs.readFile(copy.source),originalGlb,'native copy leaves source unchanged');
 await publishModelCopy(bridge,copy);h.ok(true,'identical native-copy retry is idempotent');
 await fs.writeFile(copy.destination,'collision');await assert.rejects(()=>publishModelCopy(bridge,copy),/different bytes/);h.eq(await fs.readFile(copy.destination,'utf8'),'collision','collision never overwrites destination');
 await assert.rejects(()=>bridge.copyFileVerified!(copy.source,path.join(root,'bad.glb'),'0'.repeat(64)),/hash changed/);h.ok(true,'native copy refuses stale source hash');
 const canceled=path.join(root,'canceled.glb');
 await assert.rejects(()=>createVerifiedCopy()(copy.source,canceled,asset.sha256,async()=>{throw Error('lease lost');}),/lease lost/);
 h.ok(!await bridge.exists(canceled),'async ownership rejection publishes no native copy');
 const corrupt=path.join(root,'corrupt.glb');
 await assert.rejects(()=>createVerifiedCopy({fsp:{...fs,copyFile:async(_s:string,d:string)=>fs.writeFile(d,'truncated')}})(copy.source,corrupt,asset.sha256),/verification failed/);
 h.ok(!await bridge.exists(corrupt),'corrupt native copy never publishes partial GLB');
 const {shareRetry}=require('../electron/fsRetry.cjs');let linkCalls=0,ownerChecks=0;
 const retry=(operation:()=>Promise<unknown>)=>shareRetry(operation,100);
 const retryCopy=createVerifiedCopy({retry,fsp:{...fs,link:async(s:string,d:string)=>{if(linkCalls++===0)throw Object.assign(Error('sharing'),{code:'EBUSY'});await fs.link(s,d);}}});
 await retryCopy(copy.source,path.join(root,'retried.glb'),asset.sha256,()=>{ownerChecks++;});h.eq([linkCalls,ownerChecks],[2,2],'Windows sharing retry rechecks ownership before each publication attempt');
 let cleanCalls=0;await createVerifiedCopy({retry,fsp:{...fs,rm:async(p:string,o:unknown)=>{if(cleanCalls++===0)throw Object.assign(Error('sharing'),{code:'EPERM'});await fs.rm(p,o as never);}}})(copy.source,path.join(root,'cleaned.glb'),asset.sha256);
 h.ok(cleanCalls===2&&!(await fs.readdir(root)).some(p=>p.includes('.tmp-')),'Windows cleanup sharing retry leaves no orphan temporary');
 // Use the production handler family, with app-temp separate from the project,
 // so exact-root/prefix authorization cannot be hidden by a permissive bridge.
 const {createFileCore}=require('../electron/ipc/files.cjs');
 const nativeRoot=path.join(root,'native-source'),nativeDest=path.join(root,'native-dest');
 await fs.mkdir(path.join(nativeRoot,'fig/assets'),{recursive:true});await fs.mkdir(nativeDest,{recursive:true});
 await fs.writeFile(path.join(nativeRoot,'fig/assets/neuron.glb'),bytes);
 type Handler=(event:{sender:{id:number}},...args:unknown[])=>Promise<unknown>;
 const handlers=new Map<string,Handler>();let currentNativeRoot=nativeRoot;
 const files=createFileCore({app:{getPath:(key:string)=>path.join(root,'app-'+key)},roots:()=>[nativeRoot,nativeDest],projectRootFor:()=>currentNativeRoot,setPendingRoot(){},dialog:{},windowFor:()=>null});
 files.registerHandlers({handle:(name:string,fn:Handler)=>handlers.set(name,fn)});
 const invoke=(name:string,...args:unknown[])=>handlers.get('fs:'+name)!({sender:{id:42}},...args);
 const guardedBridge={projectAssetPath:(...a:unknown[])=>invoke('projectAssetPath',...a),exists:(...a:unknown[])=>invoke('exists',...a),readText:(...a:unknown[])=>invoke('readText',...a),copyFileVerified:(...a:unknown[])=>invoke('copyFileVerified',...a)} as unknown as FileBridge;
 const guardedCopy=await prepareModelCopy(guardedBridge,nativeRoot,asset,nativeDest,'assets/neuron.glb',{sourcePrefix:'fig'});
 await publishModelCopy(guardedBridge,guardedCopy);h.eq(await fs.readFile(guardedCopy.destination),Buffer.from(bytes),'real IPC guards accept project root plus figure prefix');
 await assert.rejects(()=>prepareModelCopy(guardedBridge,path.join(nativeRoot,'fig'),asset,nativeDest,'bad.glb'),/not authorized/);h.ok(true,'real IPC guards reject the nested fig directory as project root');
 const nativeCopyFile=fs.copyFile;
 fs.copyFile=async(...args)=>{await nativeCopyFile(...args);currentNativeRoot=nativeDest;};
 try {await assert.rejects(()=>invoke('copyFileVerified',guardedCopy.source,path.join(nativeDest,'switched.glb'),asset.sha256),/Project changed/);}
 finally {fs.copyFile=nativeCopyFile;currentNativeRoot=nativeRoot;}
 h.ok(!await bridge.exists(path.join(nativeDest,'switched.glb')),'real native publication refuses changed sender ownership despite retained grants');
 const {createMemBridge}=await import('../src/lib/project/memBridge');const mem=createMemBridge();mem._files.set('/source.glb',new Uint8Array(bytes));
 h.eq(await mem.copyFileVerified!('/source.glb','/copy.glb',asset.sha256),asset.sha256,'mem bridge mirrors native verified copy');
 const {sendFigureToDeck,sendSlideToCanvas}=await import('../src/lib/project/convert');
 await assert.rejects(()=>sendFigureToDeck(root,model.figures[1],null),/3D deck conversion/);
 await assert.rejects(()=>sendSlideToCanvas(root,deck.slides[0] as never,{id:'deck',stage:deck.stage,assets:[]} as never,null),/3D deck conversion/);h.ok(true,'both persisted deck conversion directions explicitly defer until P4');
 await write('slides/retain/deck.json',JSON.stringify({...deck,assets:[],slides:[{id:'slide',elements:[{...element,source:{glbPath:'plots/neuron.glb'}},video],beats:[{id:'beat',tracks:[{id:'track',to:{assetId:'destination'}}]}]}]}));
 const io={readText:bridge.readText,exists:bridge.exists,readdir:bridge.readdir};
 const deps=await readProjectDependencies(root,io);h.ok(['neuron','movie','still','destination'].every(id=>deps.byAsset[id]?.some(use=>use.kind==='slide')),'dependencies preserve model/video/poster/animation destination assets');
 const owners=await figureSourceOwners(root,{...get(project),figures:[]},io);h.ok(owners.deckAssetIds.has(asset.id)&&owners.project.figures[0].elements[0].type==='model3d','placed orphan GLB source owner retained without SVG coercion');
 await core.deleteFigure(root,'fig-three');h.ok((await core.loadFigModel(root)).project.assets.some(a=>a.id===asset.id),'GC retains GLB referenced by saved deck');h.eq(await fs.readFile(path.join(root,'fig/assets/neuron.fluxplot.json'),'utf8'),unknown,'GC retains scene3d sidecar bytes');
 await fs.unlink(path.join(root,'fig/assets/neuron.glb'));
 const snapshot=await readFigureSnapshot({readText:rel=>bridge.readText(path.join(root,rel)).catch(()=>null),assetExists:rel=>bridge.exists(path.join(root,rel)),listDirectory:rel=>bridge.readdir!(path.join(root,rel))});
 h.ok(snapshot.status==='partial'&&snapshot.diagnostics.some(d=>/Missing GLB/.test(d.message)),'missing GLB produces a partial-load issue');
 await loadFigInto(root,'Models');await assert.rejects(()=>saveFigFrom(root,{force:true}),/Missing GLB/i);h.ok(true,'missing GLB cannot be silently saved away');
 const legacyRoot=path.join(root,'legacy'),saveAsRoot=path.join(root,'save-as');
 await fs.mkdir(path.join(legacyRoot,'assets'),{recursive:true});
 for(const id of ['neuron','second']){await fs.writeFile(path.join(legacyRoot,'assets',`${id}.glb`),bytes);await fs.writeFile(path.join(legacyRoot,'assets',`${id}.fluxplot.json`),JSON.stringify({...manifest,glb:`${id}.glb`}));}
 const store=await import('../src/lib/store');store.project.set({...model,assets:[asset,{...asset,id:'second',path:'assets/second.glb'}]});store.projectDir.set(legacyRoot);store.embeddedProjectRoot.set(null);
 const originalRead=bridge.readText;bridge.save=async()=>saveAsRoot;bridge.readText=async(p:string)=>{if(p.endsWith('/second.fluxplot.json'))throw Error('permission denied');return originalRead(p);};
 await (await import('../src/lib/io')).saveProjectAs();
 h.ok(!await bridge.exists(path.join(saveAsRoot,'assets/neuron.glb'))&&!await bridge.exists(path.join(saveAsRoot,'project.json')),'Save As preflights every sidecar before publishing the first model');
 bridge.readText=originalRead;
 const nativeCopy=bridge.copyFileVerified!;let midCopyEdit=false;
 bridge.copyFileVerified=async(...args)=>{const result=await nativeCopy(...args);if(!midCopyEdit){midCopyEdit=true;store.commit(p=>{p.name='Edited during copy';});}return result;};
 store.dirty.set(true);await (await import('../src/lib/io')).saveProjectAs();
 h.ok(!await bridge.exists(path.join(saveAsRoot,'project.json')),'stale Save As does not publish a canonical model');
 h.eq(get(store.projectDir),legacyRoot,'late edit keeps original project root');
 h.eq(get(store.project).name,'Edited during copy','editing remains live during native copy');
 h.ok(get(store.dirty),'later user edit retains dirty state after Save As');
 bridge.copyFileVerified=nativeCopy;
 const nested={...asset,path:'nested/neuron.glb'};await fs.mkdir(path.join(legacyRoot,'nested'),{recursive:true});await fs.writeFile(path.join(legacyRoot,nested.path),bytes);
 store.project.set({...model,assets:[nested]});store.projectDir.set(legacyRoot);const nestedDest=path.join(root,'nested-save');bridge.save=async()=>nestedDest;
 await (await import('../src/lib/io')).saveProjectAs();
 h.eq(get(store.projectDir),nestedDest,'unchanged Save As adopts the complete destination');
 h.eq(get(store.project).assets[0].path,nested.path,'whole-project Save As preserves live nested GLB path');
 h.ok(await bridge.exists(path.join(nestedDest,nested.path)),'preserved nested path exists at the adopted root');
 await (await import('../src/lib/io')).saveProject();h.ok(!get(store.dirty),'second save after nested-path Save As remains usable');
 store.project.set({...model,assets:[asset]});store.projectDir.set(legacyRoot);const addedDest=path.join(root,'added-save');bridge.save=async()=>addedDest;
 await fs.writeFile(path.join(legacyRoot,'assets/late.glb'),bytes);let added=false;
 bridge.copyFileVerified=async(...args)=>{const result=await nativeCopy(...args);if(!added){added=true;store.commit(p=>{p.assets.push({...asset,id:'late',path:'assets/late.glb'});p.figures[1].elements.push({...element,id:'late-view',assetId:'late'});});}return result;};
 await (await import('../src/lib/io')).saveProjectAs();
 h.eq(get(store.projectDir),legacyRoot,'concurrently imported GLB keeps its original owning root');h.ok(get(store.dirty)&&get(store.project).assets.some(a=>a.id==='late'),'late GLB edit remains live and dirty');
 h.ok(await bridge.exists(path.join(get(store.projectDir)!,'assets/late.glb')),'late GLB remains readable after refused root adoption');
 bridge.copyFileVerified=nativeCopy;
 // A late edit after the final JSON write still forbids adoption of that snapshot.
 store.project.set({...model,assets:[asset]});store.projectDir.set(legacyRoot);const finalDest=path.join(root,'final-write-save');bridge.save=async()=>finalDest;
 const originalWrite=bridge.writeText;bridge.writeText=async(p,t,o)=>{await originalWrite(p,t,o);if(p===path.join(finalDest,'project.json'))store.commit(project=>{project.name='Edited during final write';});};
 await (await import('../src/lib/io')).saveProjectAs();h.eq(get(store.projectDir),legacyRoot,'edit during final JSON write prevents stale root adoption');h.ok(get(store.dirty),'final-write edit remains dirty');bridge.writeText=originalWrite;
 // Two overlapping saves must publish in request order, including a final
 // native write that is already in flight when a newer snapshot is requested.
 const {saveProject}=await import('../src/lib/io');
 const {clearScene3dSidecars}=await import('../src/lib/model3d/store');clearScene3dSidecars();
 store.project.set(structuredClone({...model,assets:[asset]}));store.projectDir.set(legacyRoot);store.dirty.set(true);
 const unreadableSidecar=path.join(legacyRoot,'assets/neuron.fluxplot.json'),storedSidecar=await originalRead(unreadableSidecar);
 bridge.readText=async(p:string)=>{if(p===unreadableSidecar)throw Error('optional sidecar unreadable');return originalRead(p);};
 bridge.copyFileVerified=async()=>{throw Error('same-root saves must not copy existing GLB');};
 await saveProject();
 h.ok(!get(store.dirty)&&await bridge.exists(path.join(legacyRoot,'project.json')),'ordinary same-root save succeeds despite unreadable optional metadata');
 h.eq(await originalRead(unreadableSidecar),storedSidecar,'ordinary same-root save preserves unreadable sidecar without replacement');
 h.eq(await fs.readFile(path.join(legacyRoot,asset.path)),Buffer.from(bytes),'ordinary save leaves owned GLB bytes in place');
 bridge.readText=originalRead;bridge.copyFileVerified=nativeCopy;
 store.project.set(structuredClone({...model,assets:[asset]}));store.projectDir.set(legacyRoot);store.dirty.set(true);
 let releaseFirst!:()=>void,firstEntered!:()=>void;const held=new Promise<void>(r=>{releaseFirst=r;}),entered=new Promise<void>(r=>{firstEntered=r;});let canonicalWrites=0;
 bridge.writeText=async(p,t,o)=>{if(p===path.join(legacyRoot,'project.json')&&++canonicalWrites===1){firstEntered();await held;}await originalWrite(p,t,o);};
 const firstSave=saveProject();await entered;store.commit(p=>{p.name='Newest saved name';});const newerSave=saveProject();
 await new Promise(resolve=>setTimeout(resolve,30));h.eq(canonicalWrites,1,'newer final write waits for the already-issued older write');
 releaseFirst();await Promise.all([firstSave,newerSave]);
 h.eq(JSON.parse(await originalRead(path.join(legacyRoot,'project.json'))).name,'Newest saved name','overlapping saves retain the newest canonical bytes');h.ok(!get(store.dirty),'latest complete serialized snapshot clears dirty');bridge.writeText=originalWrite;
 // A rejected save does not poison the queue, and waiting requests capture
 // ownership immediately rather than capturing a new project when they run.
 let failOnce=true;bridge.writeText=async(p,t,o)=>{if(p.endsWith('/project.json')&&failOnce){failOnce=false;throw Error('injected save failure');}await originalWrite(p,t,o);};
 store.commit(p=>{p.name='Retry after failure';});await saveProject();h.ok(get(store.dirty),'failed queued save keeps dirty');await saveProject();
 h.eq(JSON.parse(await originalRead(path.join(legacyRoot,'project.json'))).name,'Retry after failure','later save runs after rejected queued batch');bridge.writeText=originalWrite;
 let releaseOwner!:()=>void,ownerEntered!:()=>void;const heldOwner=new Promise<void>(r=>{releaseOwner=r;}),enteredOwner=new Promise<void>(r=>{ownerEntered=r;});let ownerWrites=0;
 bridge.writeText=async(p,t,o)=>{if(p===path.join(legacyRoot,'project.json')&&++ownerWrites===1){ownerEntered();await heldOwner;}await originalWrite(p,t,o);};
 const oldOwnerSave=saveProject();await enteredOwner;const waitingOldSave=saveProject();
 store.project.set({...structuredClone(model),name:'Different project'});store.projectDir.set(path.join(root,'other-project'));store.dirty.set(true);
 releaseOwner();await Promise.all([oldOwnerSave,waitingOldSave]);
 h.eq(ownerWrites,1,'queued request refuses ownership change before writing another snapshot');h.ok(get(store.dirty),'old queued request cannot clear new project dirty state');
 h.ok(JSON.parse(await originalRead(path.join(legacyRoot,'project.json'))).name!=='Different project','queued old destination never receives newly opened project');bridge.writeText=originalWrite;
 // Original-byte bindings survive save/reopen even when raw metadata was
 // intentionally ignored at import. Prepared asset checksums are not provenance.
 const sourceSha='a'.repeat(64),otherSha='b'.repeat(64);
 const known={...element,source:{glbPath:'plots/original.glb',sha256:sourceSha}};
 const same={...known,id:'same-source'},legacy={...element,id:'legacy-source'};
 const conflicting={...known,id:'different-source',source:{...known.source,sha256:otherSha}};
 const bindingOf=(elements:typeof model.figures[number]['elements'])=>collectModel3dSourceBindings(elements).get(asset.id);
 const knownBinding=bindingOf([known,same]);
 h.eq(knownBinding,{kind:'known',sha256:sourceSha},'multiple equal original receipts produce one asset binding');
 h.eq(bindingOf([legacy,known]),knownBinding,'a known receipt binds legacy placements of the same asset');
 h.eq(bindingOf([known,conflicting]),bindingOf([conflicting,known]),'conflicting receipts are independent of placement order');
 h.eq(bindingOf([legacy]),undefined,'legacy assets never synthesize original provenance from prepared checksum');
 const metadataDir=path.join(root,'binding-sidecars');await fs.mkdir(metadataDir,{recursive:true});
 const metadataFile=path.join(metadataDir,'neuron.fluxplot.json');
 const cases=[
   {label:'equal receipts',refs:[known,same],digest:sourceSha,accepted:true},
   {label:'known plus legacy',refs:[legacy,known],digest:sourceSha,accepted:true},
   {label:'conflicting receipts',refs:[known,conflicting],digest:sourceSha,accepted:false},
   {label:'legacy receipt absent',refs:[legacy],digest:otherSha,accepted:true},
   {label:'original differs from prepared receipt',refs:[known],digest:sourceSha,accepted:true},
   {label:'mismatched manifest receipt',refs:[known],digest:otherSha,accepted:false},
   {label:'manifest receipt omitted',refs:[known],digest:undefined,accepted:true},
   {label:'conflict suppresses hash-less manifest',refs:[known,conflicting],digest:undefined,accepted:false},
 ];
 h.ok(sourceSha!==asset.sha256,'binding fixture original checksum differs from prepared asset checksum');
 for(const item of cases) {
   const value={...manifest,...(item.digest?{glbSha256:item.digest}:{})};
   const raw=JSON.stringify(value)+'\n';await fs.writeFile(metadataFile,raw);
   const binding=bindingOf(item.refs);
   const sidecars=await readScene3dSidecars(bridge,metadataDir,asset.id,{binding});
   h.eq(!!sidecars.manifest,item.accepted,item.label+' uses the binding policy');
   h.eq(sidecars.raw?.manifest,raw,item.label+' preserves exact raw sidecar');
   h.eq(!!scene3dSourceBindingIssue(value,binding),!item.accepted,item.label+' agrees with shared import/Node policy');
 }
 const bindingModel=structuredClone(model);bindingModel.figures[1].elements=[known,same];
 const bindingRoot=path.join(root,'binding-reopen'),bindingPlan=planFigSave(bindingModel,null);
 const mismatchRaw=JSON.stringify({...manifest,glbSha256:otherSha})+'\n';
 for(const entry of [...bindingPlan.canvases,...bindingPlan.captions,bindingPlan.index]) {
   const target=path.join(bindingRoot,entry.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,entry.text);
 }
 await fs.copyFile(path.join(root,'project.json'),path.join(bindingRoot,'project.json'));
 await fs.mkdir(path.join(bindingRoot,'fig/assets'),{recursive:true});
 await fs.writeFile(path.join(bindingRoot,'fig/assets/neuron.glb'),bytes);
 await fs.writeFile(path.join(bindingRoot,'fig/assets/neuron.fluxplot.json'),mismatchRaw);
 await loadFigInto(bindingRoot,'Binding reopen');
 h.ok(!get(scene3dManifests).neuron&&get(scene3dIssues).neuron.some(issue=>issue.includes('different GLB')),'GUI reopen keeps mismatched valid-version metadata inactive');
 const boundView=await readFigSource(bindingRoot);
 h.ok(!boundView.model3dManifests?.neuron&&boundView.issues?.some(issue=>issue.message.includes('different GLB')),'readFigSource uses identical original-byte binding');
 const nodeProject=await core.loadFigModel(bindingRoot);
 const nodeBinding=collectModel3dSourceBindings(nodeProject.project.figures.flatMap(f=>f.elements)).get(asset.id);
 const nodeSidecars=await readScene3dSidecars({exists:p=>fs.access(p).then(()=>true,()=>false),readText:p=>fs.readFile(p,'utf8')},path.join(bindingRoot,'fig/assets'),asset.id,{binding:nodeBinding});
 h.eq(nodeSidecars.manifest,boundView.model3dManifests?.neuron,'Node metadata resolver and GUI reject the same mismatched manifest');
 h.eq(nodeSidecars.issues,get(scene3dIssues).neuron,'Node metadata resolver and GUI report identical binding issues');
 markAssetDirty(asset.id);await saveFigFrom(bindingRoot);
 h.eq(await fs.readFile(path.join(bindingRoot,'fig/assets/neuron.fluxplot.json'),'utf8'),mismatchRaw,'dirty GUI save preserves mismatched raw metadata');
 const boundCopy=await prepareModelCopy(bridge,bindingRoot,asset,path.join(root,'bound-copy'),'assets/neuron.glb',{sourcePrefix:'fig',binding:nodeBinding});
 h.ok(!boundCopy.sidecars.manifest&&boundCopy.sidecars.raw?.manifest===mismatchRaw,'native-copy preflight forwards source binding without dropping raw metadata');
 const standaloneRoot=path.join(root,'binding-standalone'),standaloneDest=path.join(root,'binding-saveas');
 await fs.mkdir(path.join(standaloneRoot,'assets'),{recursive:true});await fs.writeFile(path.join(standaloneRoot,'project.json'),JSON.stringify(bindingModel));
 await fs.writeFile(path.join(standaloneRoot,'assets/neuron.glb'),bytes);await fs.writeFile(path.join(standaloneRoot,'assets/neuron.fluxplot.json'),mismatchRaw);
 store.embeddedProjectRoot.set(null);bridge.openDirectory=async()=>standaloneRoot;
 const publicIO=await import('../src/lib/io');await publicIO.openProject();
 h.ok(!get(scene3dManifests).neuron&&!!get(scene3dIssues).neuron?.length,'standalone open binds metadata to original receipt');
 bridge.save=async()=>standaloneDest;await publicIO.saveProjectAs();
 h.eq(get(store.projectDir),standaloneDest,'binding-aware Save As transfers the complete stored mesh');
 h.eq(await fs.readFile(path.join(standaloneDest,'assets/neuron.fluxplot.json'),'utf8'),mismatchRaw,'Save As preserves ignored mismatched raw sidecar');
 bridge.openDirectory=async()=>standaloneDest;await publicIO.openProject();
 h.ok(!get(scene3dManifests).neuron&&!!get(scene3dIssues).neuron?.length,'Save As reopen never reactivates mismatched raw sidecar');
 const conflictModel=structuredClone(bindingModel);conflictModel.figures[0].elements=[known];conflictModel.figures[1].elements=[conflicting];
 const conflictPlan=planFigSave(conflictModel,null);
 for(const entry of [...conflictPlan.canvases,...conflictPlan.captions,conflictPlan.index])await fs.writeFile(path.join(bindingRoot,entry.path),entry.text);
 await fs.writeFile(path.join(bindingRoot,'fig/assets/neuron.fluxplot.json'),JSON.stringify(manifest));
 await loadFigInto(bindingRoot,'Conflicting receipts');
 h.ok(!get(scene3dManifests).neuron&&get(scene3dIssues).neuron.some(issue=>issue.includes('Conflicting original')),'reopen combines all figures before rejecting conflicting provenance on hash-less metadata');
 const conflictView=await readFigSource(bindingRoot);
 h.ok(!conflictView.model3dManifests?.neuron&&conflictView.issues?.some(issue=>issue.message.includes('Conflicting original')),'read-only view also suppresses conflicting provenance across figures');
 const nativeText=await fs.readFile(new URL('../src/lib/model3d/scene3d.native.gen.mjs',import.meta.url),'utf8');
 h.ok(!/from ["'](?:three|ajv)|require\(|new Function\(/.test(nativeText),'native semantic bundle is standalone with no Three/Ajv runtime/eval');
 const native=await import(pathToFileURL(path.resolve('src/lib/model3d/scene3d.native.gen.mjs')).href);
 for(const input of [manifest,unknown,{...manifest,toWorld:[2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},{...manifest,parts:[{id:'a',role:'mesh',parent:'a'}]}])h.eq(native.parseScene3d(input),parseScene3d(input),'native and renderer semantic parsing agree exactly');
} finally {await fs.rm(root,{recursive:true,force:true});}
await h.done();
