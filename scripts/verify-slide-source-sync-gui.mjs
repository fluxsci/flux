// Actual browser stores + persistence bridge, using the isolated memory demo.
// Covers source refresh during editing, trailing events and stale tenancy.
import assert from 'node:assert/strict';
import { launch, gotoApp, clickMode, APP_URL, realErrors } from './lib/driver.mjs';
const { browser, page } = await launch();
const sourceWarnings=[];page.on('console',m=>{if(m.type()==='warn')sourceWarnings.push(m.text());});
let checks = 0;
const eq = (a,b,label) => { assert.deepEqual(a,b,label); checks++; console.log('  ok:',label); };
try {
  await gotoApp(page,{url:APP_URL+'?fixture=demo',settle:400});
  await clickMode(page,'Slide',{settle:300});
  await page.waitForFunction(() => !!window.__flux?.slide.currentDeck());
  await page.evaluate(async () => {
    const F=window.__flux,fb=window.fig;
    window.__deckSourceBridge=F.slideBridge;
    window.__deckSourceStore=await import('/src/lib/store.ts');
    window.__deckAssetStore=await import('/src/lib/assets.ts');
    const ops=await import('/src/lib/slide/ops.ts');
    const root=window.__deckSourceRoot=F.get(F.shell.projectModel).root;
    const id=window.__deckSourceId=F.slide.currentDeck().id;
    const svg=window.__deckSourceSvg=(v,w=200)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="100" data-version="${v}"><rect width="${w}" height="100" fill="blue"/></svg>`;
    const man=v=>JSON.stringify({spec:'fluxplot',schemaVersion:'0.2.0',axes:[],series:[],version:v});
    const plot=(id,frozen=false)=>({id:'el-'+id,type:'plot',assetId:id,x:25,y:30,width:100,height:50,rotation:15,source:{svgPath:'plots/'+id+'.svg',...(frozen?{frozen:true}:{})},overrides:{figure:{opacity:.7}}});
    const deck=ops.createDeck({id,withTitleSlide:false});
    deck.slides=[{id:'source-slide',name:'Source checks',camera:{x:140,y:120,zoom:1.4},elements:[plot('local'),plot('frozen',true),plot('shared')],beats:[{id:'base',tracks:[]},{id:'change',tracks:[{id:'target-change',target:'el-local',preset:'transform',to:{assetId:'target',svgPath:'plots/target.svg',state:{x:450,width:333}}}]}]}];
    deck.slides[0].elements.push({...plot('raw'),source:{svgPath:'/outside/plots/raw.svg',manifestPath:'/outside/custom.json',external:true}});
    await fb.writeText('/outside/plots/raw.svg',svg('explicit-external'));
    await fb.writeText('/outside/custom.json',man(77));
    await fb.writeText(root+'/plots/raw.svg',svg('wrong-project-collision'));
    for(const name of ['local','frozen','target']){
      deck.assets.push({id:name,name:name+'.svg',kind:'svg',path:'assets/'+name+'.svg',naturalWidth:200,naturalHeight:100});
      await fb.writeText(`${root}/slides/${id}/assets/${name}.svg`,svg('accepted-'+name));
      await fb.writeText(`${root}/slides/${id}/assets/${name}.fluxplot.json`,man(1));
      await fb.writeText(`${root}/plots/${name}.svg`,svg(name==='frozen'?'raw-frozen':'accepted-'+name));
      await fb.writeText(`${root}/plots/${name}.fluxplot.json`,man(1));
    }
    const index=JSON.parse(await fb.readText(root+'/fig/index.json'));
    index.assets.push({id:'shared',name:'shared.svg',kind:'svg',path:'assets/shared.svg',naturalWidth:200,naturalHeight:100});
    await fb.writeText(root+'/fig/index.json',JSON.stringify(index));
    // An accepted frozen Figure owner makes this an actual snapshot-priority
    // case. An ownerless asset used by a linked deck intentionally follows its
    // source now (covered by the orphan source and native watcher gates).
    const ownerPath=`${root}/fig/canvases/${index.canvases[0].id}.json`,owner=JSON.parse(await fb.readText(ownerPath));
    owner.figures[0].elements.push({...plot('shared',true),id:'shared-figure-owner'});
    await fb.writeText(ownerPath,JSON.stringify(owner));
    await fb.writeText(root+'/fig/assets/shared.svg',svg('accepted-shared'));
    await fb.writeText(root+'/fig/assets/shared.fluxplot.json',man(1));
    await fb.writeText(root+'/plots/shared.svg',svg('raw-shared',600));
    await window.__deckSourceBridge.writeDeckDirect(root,deck);
    await window.__deckSourceBridge.loadDeckInto(root,id);
  });
  const read=()=>page.evaluate(async()=>{
    const F=window.__flux,d=F.slide.currentDeck(),root=window.__deckSourceRoot,id=window.__deckSourceId;
    return {local:d.slides[0].elements.find(e=>e.id==='el-local'),shared:d.slides[0].elements.find(e=>e.id==='el-shared'),beats:d.slides[0].beats,camera:d.slides[0].camera,stage:d.stage,destination:F.get(F.slide.editDestination),history:window.__deckSourceStore.historyStats().past,versions:Object.fromEntries(['local','target','frozen','shared'].map(id=>[id,F.plot.plotDom.get(id)?.getAttribute('data-version')])),manifests:Object.fromEntries(['local','target','frozen','shared'].map(id=>[id,F.get(F.plot.plotManifests)[id]?.version])),gen:F.get(F.plot.plotGen),disk:JSON.parse(await window.fig.readText(`${root}/slides/${id}/deck.json`))};
  });
  const baseline=await read();
  eq(baseline.versions.shared,'accepted-shared','GUI resolves registered Figure copy before raw source');
  eq(baseline.versions.frozen,'accepted-frozen','frozen deck copy stays on its accepted version');
  eq(await page.evaluate(()=>({svg:window.__flux.plot.plotDom.get('raw')?.getAttribute('data-version'),version:window.__flux.get(window.__flux.plot.plotManifests).raw?.version})),{svg:'explicit-external',version:77},'GUI honors external path and custom sidecar despite project basename collision');
  await page.evaluate(async()=>{
    const root=window.__deckSourceRoot;
    await window.fig.writeText(root+'/plots/local.svg',window.__deckSourceSvg('source-blue',400));
    await window.fig.writeText(root+'/plots/target.fluxplot.json',JSON.stringify({spec:'fluxplot',schemaVersion:'0.2.0',axes:[],series:[],version:2}));
    await window.__deckSourceBridge.refreshDeckSources(root);
  });
  const accepted=await read();
  eq(accepted.versions.local,'source-blue','live deck accepts linked SVG');
  eq(accepted.local.width,200,'linked SVG resize preserves physical placement scale');
  eq(accepted.manifests.target,2,'animation-only semantic target refreshes');
  eq(accepted.disk.slides[0].elements.find(e=>e.id==='el-local').width,200,'accepted source size is durable without unrelated edit');
  eq(accepted.beats,baseline.beats,'source update preserves authored animation patches');
  eq(accepted.camera,baseline.camera,'source update preserves camera');
  eq(accepted.history,baseline.history,'external byte refresh creates no misleading undo entry');
  await page.evaluate(()=>window.__deckSourceBridge.refreshDeckSources(window.__deckSourceRoot));
  const stable=await read();
  eq(stable.gen,accepted.gen,'no-change refresh does not rebuild plot caches or thumbnails');
  await page.evaluate(async()=>{
    await window.fig.writeText(window.__deckSourceRoot+'/plots/local.recipe.json',JSON.stringify({steps:2}));
    await window.__deckSourceBridge.refreshDeckSources(window.__deckSourceRoot);
  });
  eq(await page.evaluate(()=>window.__flux.get(window.__flux.plot.plotRecipes).local?.steps),2,'recipe-only source change refreshes GUI authoring metadata');
  eq((await read()).gen,stable.gen,'recipe-only refresh keeps unchanged SVG DOM and thumbnail generations');
  // Route a real source event while the independent Figure canonical/sidecar
  // caption pair conflicts. The deck must keep following its own source.
  await page.evaluate(async()=>{
    const fb=window.fig,root=window.__deckSourceRoot,index=JSON.parse(await fb.readText(root+'/fig/index.json'));
    const canvasPath=root+'/fig/canvases/'+index.canvases[0].id+'.json';
    const originalCanvas=await fb.readText(canvasPath),canvas=JSON.parse(originalCanvas),figure=canvas.figures[0];
    const captionPath=root+'/fig/captions/'+figure.id+'.md',originalCaption=await fb.readText(captionPath);
    window.__captionConflictRestore={canvasPath,originalCanvas,captionPath,originalCaption};
    figure.captions={__figure__:'Canonical caption changed independently'};
    await fb.writeText(canvasPath,JSON.stringify(canvas));
    await fb.writeText(captionPath,'Sidecar caption changed independently\n');
    const service=await import('/src/lib/project/sourceBridge.ts');
    try{await service.syncProjectSources(root);window.__figureConflictObserved=false;}catch(e){window.__figureConflictObserved=String(e).includes('caption');}
    await fb.writeText(root+'/plots/local.svg',window.__deckSourceSvg('independent-deck',400));
    window.__fluxEmitFsChange({subsystem:'plots',path:root+'/plots/local.svg'});
  });
  eq(await page.evaluate(()=>window.__figureConflictObserved),true,'Figure sync reports a real caption conflict');
  await page.waitForFunction(()=>window.__flux.plot.plotDom.get('local')?.getAttribute('data-version')==='independent-deck');
  eq(await page.evaluate(async()=> (await window.fig.readText(`${window.__deckSourceRoot}/slides/${window.__deckSourceId}/assets/local.svg`)).includes('independent-deck')),true,'watch event still durably updates an independent deck after Figure sync fails');
  await page.evaluate(async()=>{const r=window.__captionConflictRestore;await window.fig.writeText(r.canvasPath,r.originalCanvas);await window.fig.writeText(r.captionPath,r.originalCaption);});
  // Hold a first source read, then deliver a second source revision and a user
  // edit. The first snapshot is unstable; the pending pass must retry it.
  await page.evaluate(async()=>{
    const fb=window.fig,root=window.__deckSourceRoot;
    await fb.writeText(root+'/plots/local.svg',window.__deckSourceSvg('intermediate',600));
    const original=fb.readText.bind(fb);window.__deckOriginalRead=original;
    window.__deckReadHeld=false;
    fb.readText=async p=>{const value=await original(p);if(p===root+'/plots/local.svg'&&!window.__deckReadHeld){window.__deckReadHeld=true;await new Promise(r=>window.__deckReleaseRead=r);}return value;};
    window.__deckRefresh=window.__deckSourceBridge.refreshDeckSources(root);
  });
  await page.waitForFunction(()=>window.__deckReadHeld);
  await page.evaluate(async()=>{
    const F=window.__flux,root=window.__deckSourceRoot;
    await window.fig.writeText(root+'/plots/local.svg',window.__deckSourceSvg('latest-purple',800));
    F.slide.commitDeckLive(d=>{d.title='Unsaved user title';d.slides[0].elements.find(e=>e.id==='el-local').x=777;});
    window.__deckSourceBridge.refreshDeckSources(root);
    window.__deckReleaseRead();await window.__deckRefresh;window.fig.readText=window.__deckOriginalRead;
  });
  const trailing=await read();
  eq(trailing.versions.local,'latest-purple','source event during refresh receives a trailing retry');
  eq(trailing.local.x,777,'source refresh preserves an edit made during asynchronous IO');
  eq(trailing.local.width,400,'source sizing applies once against latest accepted metadata');
  eq(trailing.disk.title,'Unsaved user title','in-flight title edit persists with source acceptance');
  // Figure-owned accepted metadata follows the same physical-scale policy.
  // Make an endpoint authoring edit BEFORE the external revision arrives.
  // Its history snapshot contains the older source metadata, but Undo/Redo
  // must continue to use the accepted bytes and intrinsic size after refresh.
  await page.evaluate(()=>{
    const F=window.__flux,sid=F.get(F.fig.activeFigureId);
    F.slide.editAfterBeat(1);
    F.fig.commit(p=>p.figures.find(f=>f.id===sid).elements.find(e=>e.id==='el-shared').x=155);
  });
  await page.evaluate(async()=>{
    const fb=window.fig,root=window.__deckSourceRoot,index=JSON.parse(await fb.readText(root+'/fig/index.json'));
    index.assets.find(a=>a.id==='shared').naturalWidth=400;
    await fb.writeText(root+'/fig/index.json',JSON.stringify(index));
    await fb.writeText(root+'/fig/assets/shared.svg',window.__deckSourceSvg('accepted-shared-new',400));
    await window.__deckSourceBridge.refreshDeckSources(root);
  });
  const shared=await read();
  eq(shared.versions.shared,'accepted-shared-new','linked Figure accepted bytes refresh without deck reload');
  eq(shared.shared.width,200,'linked Figure metadata refresh preserves the same deliberate scale');
  const sharedHistory=()=>page.evaluate(()=>{
    const F=window.__flux,p=F.get(F.fig.project),e=p.figures.find(f=>f.id===F.get(F.fig.activeFigureId)).elements.find(e=>e.id==='el-shared');
    return {x:e.x,width:e.width,natural:p.assets.find(a=>a.id==='shared').naturalWidth,baseWidth:F.slide.currentDeck().slides[0].elements.find(e=>e.id==='el-shared').width,destination:F.get(F.slide.editDestination).kind};
  });
  await page.evaluate(()=>window.__flux.fig.undo());
  eq(await sharedHistory(),{x:25,width:200,natural:400,baseWidth:200,destination:'after'},'Undo restores authoring with current external size and recomputes the endpoint display');
  await page.evaluate(()=>window.__flux.fig.redo());
  eq(await sharedHistory(),{x:155,width:200,natural:400,baseWidth:200,destination:'after'},'Redo preserves accepted source dimensions without scaling the endpoint twice');
  // A same-size accepted Figure revision does not author geometry, but must
  // invalidate a paused player's captured SVG; unrelated caches cannot stop it.
  await page.evaluate(()=>{
    const F=window.__flux;F.slide.activeBeat.set(1);
    if(!document.querySelector('.animator'))[...document.querySelectorAll('.deckbar button')].find(b=>b.textContent.includes('Animate'))?.click();
  });
  await page.waitForSelector('.ruler');
  const pauseOnRuler=async()=>{const r=await page.$eval('.ruler',e=>{const r=e.getBoundingClientRect();return{x:r.x+45,y:r.y+r.height/2};});await page.mouse.click(r.x,r.y);await page.waitForSelector('.preview-overlay');};
  await pauseOnRuler();
  await page.evaluate(()=>window.__flux.plot.cachePlot('unrelated-preview-cache',window.__deckSourceSvg('unrelated',200)));
  eq(!!(await page.$('.preview-overlay')),true,'unrelated plot generation does not invalidate the active paused preview');
  const beforePreviewRefresh=await page.evaluate(()=>({deck:JSON.stringify(window.__flux.slide.currentDeck()),history:window.__deckSourceStore.historyStats().past}));
  await page.evaluate(async()=>{
    await window.fig.writeText(window.__deckSourceRoot+'/fig/assets/shared.svg',window.__deckSourceSvg('preview-fresh',400));
    await window.__deckSourceBridge.refreshDeckSources(window.__deckSourceRoot);
  });
  await page.waitForFunction(()=>!document.querySelector('.preview-overlay'));
  eq(await page.evaluate(()=>({deck:JSON.stringify(window.__flux.slide.currentDeck()),history:window.__deckSourceStore.historyStats().past})),beforePreviewRefresh,'same-size source revision closes stale preview without changing document or history');
  await pauseOnRuler();
  eq(!!(await page.$('.preview-overlay [data-version="preview-fresh"]')),true,'replaying the paused frame uses newly accepted source bytes');
  await page.evaluate(()=>[...document.querySelectorAll('.animator .transport button')].find(b=>b.textContent.includes('Stop'))?.click());
  await page.evaluate(async()=>{
    const F=window.__flux,sid=F.get(F.fig.activeFigureId),root=window.__deckSourceRoot;
    F.slide.setEditDestination({kind:'design'});
    F.fig.commit(p=>p.figures.find(f=>f.id===sid).elements.find(e=>e.id==='el-local').x=901);
    await window.fig.writeText(root+'/plots/local.svg',window.__deckSourceSvg('owned-history',1000));
    await window.__deckSourceBridge.refreshDeckSources(root);
  });
  const ownedHistory=()=>page.evaluate(()=>{
    const F=window.__flux,p=F.get(F.fig.project),e=F.slide.currentDeck().slides[0].elements.find(e=>e.id==='el-local');
    return {x:e.x,width:e.width,natural:p.assets.find(a=>a.id==='local').naturalWidth,version:F.plot.plotDom.get('local')?.getAttribute('data-version')};
  });
  await page.evaluate(()=>window.__flux.fig.undo());
  eq(await ownedHistory(),{x:777,width:500,natural:1000,version:'owned-history'},'Undo keeps accepted deck-owned source bytes and rescales the historical placement once');
  await page.evaluate(()=>window.__flux.fig.redo());
  eq(await ownedHistory(),{x:901,width:500,natural:1000,version:'owned-history'},'Redo preserves deck-owned source dimensions without double scaling');
  // A closed deck must apply source revisions against the saved intrinsic
  // baseline, exactly as if it had stayed open and observed every revision.
  await page.evaluate(()=>window.__flux.lifecycle.flushAll());
  await clickMode(page,'Figure');
  await page.evaluate(async()=>{
    const fb=window.fig,root=window.__deckSourceRoot,index=JSON.parse(await fb.readText(root+'/fig/index.json'));
    index.assets.find(a=>a.id==='shared').naturalWidth=600;
    await fb.writeText(root+'/fig/index.json',JSON.stringify(index));
    await fb.writeText(root+'/fig/assets/shared.svg',window.__deckSourceSvg('accepted-while-closed',600));
  });
  await clickMode(page,'Slide');
  await page.waitForFunction(()=>window.__flux.slide.currentDeck()?.externalAssetSizes?.shared?.width===600);
  eq((await read()).shared.width,300,'reopening a closed deck preserves the same half-scale placement');
  eq((await read()).disk.externalAssetSizes.shared,{width:600,height:100},'reopen persists current accepted metadata without an unrelated edit');
  // Guard a stale async load: neither caches nor live document can land after
  // its caller declares that the project/mode was replaced.
  const stale=await page.evaluate(async()=>{
    const before=JSON.stringify(window.__flux.slide.currentDeck());let current=true;
    const load=window.__deckSourceBridge.loadDeckInto(window.__deckSourceRoot,window.__deckSourceId,{isCurrent:()=>current});current=false;
    return {result:await load,unchanged:JSON.stringify(window.__flux.slide.currentDeck())===before};
  });
  eq(stale,{result:null,unchanged:true},'stale deck load cannot overwrite a replaced editing session');
  eq(realErrors(page),[],'source integration leaves browser console clean');
  console.log(`SLIDE SOURCE SYNC GUI: PASS (${checks} assertions)`);
} catch(e) { console.error('Source warnings:',sourceWarnings); console.error(await page.evaluate(()=>({text:document.body.innerText.slice(-1200),root:window.__deckSourceRoot,version:window.__flux?.plot.plotDom.get('local')?.getAttribute('data-version')}))); throw e; } finally { await browser.close(); }
