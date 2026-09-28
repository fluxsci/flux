/** Explicit Python-loop source updates through real Figure UI and bridge boundaries. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {launch,gotoApp,clickMode,waitFor,waitForFrame,realErrors,APP_URL} from './lib/driver.mjs';
import {harness} from './lib/harness.mjs';
const h=harness('verify-model3d-source-gui'),out='test-results/model3d/source';await mkdir(out,{recursive:true});
const fixture={bytes:(await readFile('scripts/fixtures/model3d/fluxplot-library/named-parts.glb')).toString('base64'),manifest:await readFile('scripts/fixtures/model3d/fluxplot-library/named-parts.fluxplot.json','utf8')};
const {browser,page}=await launch({width:1500,height:1050});const result={};
const state=()=>page.evaluate(()=>{const F=window.__flux,e=F.figures()[0].elements[0];return {element:structuredClone(e),assets:structuredClone(F.get(F.fig.project).assets),statuses:F.get(window.__sourceApi.modelSourceStatuses),busy:[...F.get(window.__sourceApi.modelSourceBusy)]};});
const settled=()=>waitFor(page,()=>{const s=window.__fluxModel3d?.stats();return s&&!s.active&&!s.queued&&!s.pendingPosters;},null,{timeout:45000,label:'source-update posters settle'});
try{
 await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:0});await clickMode(page,'Figure',{settle:0});
 await waitFor(page,()=>!!window.__flux?.fig&&!!document.querySelector('.canvas-host'),null,{label:'Figure ready'});
 result.setup=await page.evaluate(async fixture=>{
  const F=window.__flux,root=F.get(F.fig.embeddedProjectRoot);await F.lifecycle.flushById('figure');
  window.__sourceApi=await import('/src/lib/model3d/sourceBridge.ts');
  F.fig.commit(p=>{p.figures=[{...p.figures[0],id:'source-figure',referenceKey:'fig-source-loop',number:1,name:'Source loop',x:0,y:0,width:650,height:450,elements:[],groups:{},captions:{}}];});
  F.fig.activeFigureId.set('source-figure');F.fig.selectedFrameId.set(null);F.fig.viewport.set({panX:35,panY:55,zoom:1});
  const source=root+'/plots/source.glb',meta=source.replace('.glb','.fluxplot.json'),manifest=JSON.parse(fixture.manifest);manifest.glb='source.glb';
  await window.fig.writeFile(source,Uint8Array.from(atob(fixture.bytes),c=>c.charCodeAt(0)));await window.fig.writeText(meta,JSON.stringify(manifest));await window.fig.writeText(source.replace('.glb','.recipe.json'),JSON.stringify({command:'fixture',outputs:{glb:'source.glb'},params:{dose:1e-7}}));
  await F.io.importPlotsFromPaths([source]);
  const e=F.figures()[0].elements[0],part=manifest.parts.find(p=>p.node).id;
  F.fig.commit(p=>Object.assign(p.figures[0].elements[0],{x:70,y:70,width:420,height:280,orbitAzimuth:83,orbitZoom:1.2,overrides:{[part]:{fill:'#D14D41'}}}));F.fig.selectOnly(e.id);F.fig.resetHistory();
  window.__sourceTest={root,source,meta,manifest,id:e.id,oldAsset:e.assetId,part};
  await window.__sourceApi.refreshModelSourceStatuses();return {...window.__sourceTest};
 },fixture);
 await settled();await waitFor(page,()=>document.querySelector('[data-model3d-poster]'),null,{label:'initial poster'});
 h.eq((await state()).statuses[result.setup.id]?.status,'current','fresh source receipt is current');
 result.before=await state();
 await page.evaluate(async()=>{const s=window.__sourceTest,m=structuredClone(s.manifest);for(const p of m.parts)if(p.node)p.color='#30A46C';m.view={...m.view,azimuth:5};await window.fig.writeText(s.meta,JSON.stringify(m));window.fig._emitFsChange({subsystem:'plots',path:s.meta});});
 await waitFor(page,()=>window.__flux.get(window.__sourceApi.modelSourceStatuses)[window.__sourceTest.id]?.status==='changed',null,{label:'idle watcher detects metadata-only change'});
 h.eq((await state()).element.assetId,result.setup.oldAsset,'watcher shows status without replacing immutable asset');
 h.ok(await page.$('[data-model3d-source-changed]'),'Layers displays source changed dot');
 await waitFor(page,()=>document.querySelector('[data-model3d-source-status="changed"]'),null,{label:'Inspector source changed banner'});
 await page.screenshot({path:out+'/changed.png'});
 await page.click('.model3d-properties .source-status button');
 await waitFor(page,()=>{const F=window.__flux,e=F.figures()[0].elements[0];return e.assetId!==window.__sourceTest.oldAsset&&!F.get(window.__sourceApi.modelSourceBusy).size;},null,{label:'explicit Update completes'});await settled();
 result.after=await state();const e=result.after.element;
 h.ok(e.assetId!==result.setup.oldAsset,'Update installs a new immutable asset');
 h.eq([e.x,e.y,e.width,e.height,e.orbitAzimuth,e.orbitZoom,e.overrides],[70,70,420,280,83,1.2,result.before.element.overrides],'Update retains placement view and explicit restyle');
 h.ok(result.after.assets.some(a=>a.id===result.setup.oldAsset),'old immutable asset stays available for Undo');
 h.eq(result.after.statuses[e.id]?.status,'current','new source receipt becomes current');
 h.ok(await page.evaluate(async()=>{const {scene3dManifests}=await import('/src/lib/model3d/store.ts');const F=window.__flux,e=F.figures()[0].elements[0];return F.get(scene3dManifests)[e.assetId].parts.filter(p=>p.node).every(p=>p.color==='#30A46C');}),'new source colours enter metadata cache');
 await page.evaluate(()=>window.__flux.fig.undo());await waitFor(page,id=>window.__flux.figures()[0].elements[0].assetId===id,result.setup.oldAsset,{label:'one Undo restores original asset'});await settled();
 h.eq((await state()).element,result.before.element,'one Undo restores complete old placement');
 await page.evaluate(()=>window.__flux.fig.redo());await settled();
 await page.evaluate(()=>window.__flux.lifecycle.flushById('figure'));
 h.ok(!await page.$('.figure-mode .toolbar .save-error'),'updated and undone/redone figure saves normally');
 h.ok(await page.evaluate(async()=>{const s=window.__sourceTest,index=JSON.parse(await window.fig.readText(s.root+'/fig/index.json'));return index.assets.some(a=>a.id===s.oldAsset)&&index.assets.some(a=>a.id===window.__flux.figures()[0].elements[0].assetId); }),'saved index preserves both immutable versions');
 await page.screenshot({path:out+'/updated.png'});
 const reopened=await page.evaluate(async()=>{const {readFigSource}=await import('/src/lib/project/figbridge.ts');const saved=await readFigSource(window.__sourceTest.root);const e=saved.figures['source-figure'].elements[0];return {element:e,manifest:saved.model3dManifests?.[e.assetId],binaryInData:!!saved.assetData[e.assetId]};});
 h.eq(reopened.element,result.after.element,'read-only reopen restores accepted source placement exactly');
 h.ok(!!reopened.manifest&&!reopened.binaryInData,'reopen resolves source-bound scene metadata without GLB dataURLs');
 // Desktop command execution is covered by the real-process recipe IPC gate.
 // This bridge seam exercises the actual X-ray result-to-Update user flow.
 const beforeRegen=(await state()).element.assetId;
 await page.evaluate(()=>{window.fig.runRecipe=async(recipePath,params)=>{const s=window.__sourceTest,m=JSON.parse(await window.fig.readText(s.meta));m.parts.find(p=>p.node).color='#8B5CF6';await window.fig.writeText(s.meta,JSON.stringify(m));window.__sourceRecipeCall={recipePath,params};return {code:0,glbPath:s.source,manifestPath:s.meta,svgText:null,manifestText:JSON.stringify(m),recipeText:await window.fig.readText(recipePath)};};});
 await page.keyboard.down('Alt');await page.keyboard.press('r');await page.keyboard.up('Alt');
 await waitFor(page,()=>document.querySelector('.xray .regen'),null,{label:'model Xray Regenerate'});
 await page.click('.xray .regen');
 await waitFor(page,old=>window.__flux.figures()[0].elements[0].assetId!==old,beforeRegen,{label:'GLB Regenerate uses immutable Update'});await settled();
 const regenerated=await state();h.eq([regenerated.element.orbitAzimuth,regenerated.element.overrides],[83,result.before.element.overrides],'Regenerate keeps view and surviving restyles');
 h.eq(await page.evaluate(()=>window.__sourceRecipeCall.params),{dose:1e-7},'Xray forwards original precise recipe params');
 h.ok((await page.evaluate(()=>window.__sourceRecipeCall.recipePath)).endsWith('/plots/source.recipe.json'),'recipe resolves from captured source root');
 await page.screenshot({path:out+'/regenerated.png'});
 await page.evaluate(()=>{window.__recipeHeld={};window.fig.runRecipe=async()=>{window.__recipeHeld.entered=true;await new Promise(resolve=>window.__recipeHeld.release=resolve);const s=window.__sourceTest;return {code:0,glbPath:s.source,manifestPath:s.meta};};});
 const recipeAsset=(await state()).element.assetId;await page.click('.xray .regen');
 await waitFor(page,()=>window.__recipeHeld.entered,null,{label:'recipe result held before Update'});
 await page.evaluate(()=>{const F=window.__flux,root=F.get(F.fig.embeddedProjectRoot);F.fig.embeddedProjectRoot.set('/recipe-other');F.fig.embeddedProjectRoot.set(root);window.__recipeHeld.release();});
 await waitFor(page,()=>!document.querySelector('.xray .regen')?.disabled,null,{label:'stale recipe settles'});
 h.eq((await state()).element.assetId,recipeAsset,'root ABA during recipe cannot capture a fresh Update epoch and install stale output');
 await page.click('.xray .xbtn');

 // Hold the real import result, keeping publication/cleanup paths real.
 async function heldUpdate(){return page.evaluate(()=>{const fb=window.fig,real=fb.importModel3d;window.__sourceHeld={};fb.importModel3d=async request=>{const value=await real(request);window.__sourceHeld.value=value;await new Promise(resolve=>window.__sourceHeld.release=resolve);return value;};window.__sourceHeld.restore=()=>fb.importModel3d=real;window.__sourceHeld.done=window.__sourceApi.updateModelFromSource(window.__sourceTest.id).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));});}
 await heldUpdate();await waitFor(page,()=>!!window.__sourceHeld.release,null,{label:'native prepare result held'});
 await page.evaluate(()=>window.__flux.fig.commit(p=>p.figures[0].elements[0].orbitAzimuth=141));
 await page.evaluate(()=>window.__sourceHeld.release());let race=await page.evaluate(async()=>{const r=await window.__sourceHeld.done;window.__sourceHeld.restore();return r;});
 h.ok(race.ok,'unrelated view edit during source IO does not reject Update');h.eq((await state()).element.orbitAzimuth,141,'late view edit survives source application');
 await heldUpdate();await waitFor(page,()=>!!window.__sourceHeld.release,null,{label:'second source import held'});
 await page.evaluate(()=>{const F=window.__flux;F.fig.commit(p=>p.figures[0].elements=[]);window.__sourceHeld.release();});race=await page.evaluate(async()=>{const r=await window.__sourceHeld.done;window.__sourceHeld.restore();return {...r,exists:await window.fig.exists(window.__sourceTest.root+'/fig/'+window.__sourceHeld.value.asset.path)};});
 h.ok(!race.ok&&!race.exists,'removed target rejects and discards only its unadopted files');
 await page.evaluate(()=>window.__flux.fig.undo());await settled();
 await heldUpdate();await waitFor(page,()=>!!window.__sourceHeld.release,null,{label:'ABA import held'});
 await page.evaluate(()=>{const F=window.__flux,root=F.get(F.fig.embeddedProjectRoot);F.fig.embeddedProjectRoot.set('/temporary-other');F.fig.embeddedProjectRoot.set(root);window.__sourceHeld.release();});race=await page.evaluate(async()=>{const r=await window.__sourceHeld.done;window.__sourceHeld.restore();return r;});
 h.ok(!race.ok&&race.error.includes('target changed'),'project-root ABA rejects held source application');
 await settled();h.eq((await state()).busy,[],'source operations release busy ownership after success and rejection');
 // Public standalone Save normalizes parsed metadata. Its accepted raw receipt
 // remains the status baseline; stored sidecars always use asset ID, not GLB path.
 const standalone=await page.evaluate(async()=>{const F=window.__flux,s=window.__sourceTest,p=structuredClone(F.get(F.fig.project)),e=p.figures[0].elements[0],a=p.assets.find(x=>x.id===e.assetId),root=s.root+'-standalone';
  const bytes=await window.fig.readFile(s.root+'/fig/'+a.path),source=await window.fig.readFile(s.source),metadata=await window.fig.readText(s.meta);
  a.path='geometry/nested/renamed.glb';p.assets=[a];
  await window.fig.writeFile(root+'/'+a.path,bytes);await window.fig.writeFile(root+'/plots/source.glb',source);await window.fig.writeText(root+'/plots/source.fluxplot.json',metadata);
  await window.fig.writeText(root+'/assets/'+a.id+'.fluxplot.json',metadata);await window.fig.writeText(root+'/project.json',JSON.stringify(p));
  F.fig.embeddedProjectRoot.set(null);F.fig.projectDir.set(null);
  const openDirectory=window.fig.openDirectory;window.fig.openDirectory=async()=>root;
  try {await F.io.openProject();}finally{window.fig.openDirectory=openDirectory;}
  await F.io.saveProject();
  let request;const fingerprint=window.fig.model3dSourceFingerprint;window.fig.model3dSourceFingerprint=async value=>{request=value;return fingerprint(value);};
  try {await window.__sourceApi.refreshModelSourceStatuses();}finally{window.fig.model3dSourceFingerprint=fingerprint;}
  return {status:F.get(window.__sourceApi.modelSourceStatuses)[e.id],request,expected:root+'/assets/'+a.id+'.fluxplot.json',sourceRaw:metadata,savedRaw:await window.fig.readText(root+'/assets/'+a.id+'.fluxplot.json'),saved:JSON.parse(await window.fig.readText(root+'/project.json'))};
 });
 h.eq(standalone.request.storedManifestPath,standalone.expected,'nested or renamed GLB reads canonical asset-ID sidecar for source detection');
 h.ok(standalone.savedRaw!==standalone.sourceRaw,'public standalone Save actually reformats the compact source manifest');
 h.eq(standalone.status.status,'current','standalone Save formatting does not manufacture a changed source');
 h.eq(standalone.saved.assets[0].path,'geometry/nested/renamed.glb','standalone save retains nested stored GLB path');
 h.eq(realErrors(page),[],'clean browser console across source lifecycle');
 result.final=await state();
}catch(error){h.fail(String(error.stack??error));await page.screenshot({path:out+'/failure.png'}).catch(()=>{});}
finally{await writeFile(out+'/receipt.json',JSON.stringify(result,null,2));await browser.close();}
await h.done();
