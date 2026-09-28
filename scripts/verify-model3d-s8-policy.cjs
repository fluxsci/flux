'use strict';
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
const vm=require('node:vm');
const {compareCohorts,qualificationSamples,cohortIdleVsyncMs}=require('./lib/model3dS8Metrics.cjs');
const {orbitFrameQualification,idleVsyncMs}=require('./lib/model3dNativeScaleBudget.cjs');
const {s8CaptureRect,verifyS8RasterReplacement}=require('./lib/model3dS8Baseline.cjs');
const {s8BoxesVisible,s8InteractionEvidence}=require('./perf/input-probe-model3d.cjs');
async function main(){
  const {harness}=await import('./lib/harness.mjs'),{SOURCE,publicTreeHash,verifyPublicS8Fixture}=await import('./lib/model3dS8PublicFixture.mjs');
  const h=harness('verify-model3d-s8-policy');
  const inventory=JSON.parse(await fs.readFile(new URL('./fixtures/model3d/s8-public-tree.json','file://'+__filename),'utf8'));
  h.eq(publicTreeHash(inventory.files),SOURCE.tree,'published example inventory reconstructs the exact pinned Git tree');
  h.eq(inventory.files.length,369,'pinned public example includes all369 files');
  h.eq(inventory.files.reduce((n,f)=>n+f.bytes,0),57462899,'public example byte inventory remains complete');
  for(const alter of[f=>{f[0].gitBlob='0'.repeat(40)},f=>{f[0].path+='changed'},f=>{f[0].mode='100755'}]){const f=structuredClone(inventory.files);alter(f);assert.notEqual(publicTreeHash(f),SOURCE.tree);}
  h.ok(true,'hash, name and mode tampering cannot pass published provenance');
  assert.throws(()=>publicTreeHash([...inventory.files,inventory.files[0]]),/Duplicate/);
  assert.throws(()=>publicTreeHash([{...inventory.files[0],path:'../owner'}]),/Unsafe/);
  await assert.rejects(verifyPublicS8Fixture('/home/forbidden-owner-project'),/scratch/);
  h.ok(true,'duplicate, traversal and non-scratch source paths are refused before reading owner files');
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'flux-s8-provenance-policy-')),target=path.join(tmp,'target'),alias=path.join(tmp,'alias');
  const readFile=fs.readFile;let receiptReads=0;
  try{
    await fs.mkdir(target);await fs.writeFile(path.join(target,'public-source-receipt.json'),'{}');await fs.symlink(target,alias);
    fs.readFile=async(...args)=>{if(String(args[0]).endsWith('public-source-receipt.json'))receiptReads++;return readFile(...args)};
    await assert.rejects(verifyPublicS8Fixture(alias),/real scratch/);
    h.eq(receiptReads,0,'symlinked scratch root is refused before reading its receipt');
    const real=path.join(tmp,'real');await fs.mkdir(real);await fs.symlink(path.join(target,'public-source-receipt.json'),path.join(real,'public-source-receipt.json'));
    await assert.rejects(verifyPublicS8Fixture(real),/regular confined/);
    h.eq(receiptReads,0,'symlinked receipt is refused before reading outside its root');
  }finally{fs.readFile=readFile;await fs.rm(tmp,{recursive:true,force:true});}

  // Execute the renderer instrumentation used by the real native probe. Drive
  // its actual rAF loop and double-rAF key listener, then consume the same
  // qualification adapter as S8; rounded public summaries remain unchanged.
  const probeSource=await fs.readFile(new URL('./perf/input-probe.cjs','file://'+__filename),'utf8');
  const instrument=probeSource.match(/const INSTR = `([\s\S]*?)`;/)?.[1];
  assert.ok(instrument,'native renderer instrumentation found');
  function probeTiming(step){
    let now=0,next=0;const callbacks=new Map(),listeners=new Map();
    const window={addEventListener:(name,fn)=>listeners.set(name,fn)};
    const context=vm.createContext({window,document:{visibilityState:'visible',hasFocus:()=>true},performance:{now:()=>now},requestAnimationFrame:fn=>{callbacks.set(++next,fn);return next},cancelAnimationFrame:id=>callbacks.delete(id),PerformanceObserver:class{observe(){}}});
    vm.runInContext(instrument,context,{timeout:1000});window.__p.start();
    const frame=t=>{now=t;const ready=[...callbacks.values()];callbacks.clear();for(const callback of ready)callback(t)};
    frame(0);
    for(let i=0;i<25;i++){listeners.get('keydown')({timeStamp:now});frame(now+step);frame(now+step)}
    return window.__p.stop();
  }
  const preciseImage=probeTiming(10.001),preciseModel=probeTiming(11.0012);
  h.ok(preciseImage.gaps.every(x=>x===10)&&preciseModel.gaps.every(x=>x===11)&&preciseImage.keyPaint.every(x=>x===20)&&preciseModel.keyPaint.every(x=>x===22),'legacy one-decimal probe summaries remain compatible');
  const asCohort=(variant,raw)=>({variant,samples:Object.fromEntries(['hover','panSmall','zoom','typing'].map(phase=>[phase,qualificationSamples(raw,phase)]))});
  // Synthetic 10/11 ms clock: a sub-millisecond vsync keeps the ratio branch decisive.
  const synthetic={idleVsyncMs:.5};
  const exactComparison=compareCohorts([asCohort('model',preciseModel),asCohort('image',preciseImage),asCohort('image',preciseImage),asCohort('model',preciseModel)],synthetic);
  h.ok(Object.values(exactComparison).every(row=>!row.ok&&row.ratio>1.1),'actual native instrumentation through S8 rejects a just-over10% regression hidden by displayed rounding');
  assert.throws(()=>qualificationSamples({gaps:[10],keyPaint:[20]},'hover'),/samples/);
  h.ok(true,'older rounded-only qualification receipts cannot silently pass as raw timing');
  const captureView={clip:{x:100,y:80,right:800,bottom:600,width:700,height:520},box:{x:120.2,y:100.4,right:220.4,bottom:180.6,width:100.2,height:80.2},hit:true};
  h.eq(s8CaptureRect(captureView),{x:120,y:100,width:101,height:81},'S8 captures the complete visible model bounds');
  for(const alter of[v=>{v.box.x=80},v=>{v.box.right=801},v=>{v.hit=false}]){const bad=structuredClone(captureView);alter(bad);assert.throws(()=>s8CaptureRect(bad),/visible and hittable/)}
  h.ok(true,'a model behind a sidebar, clipped by canvas or covered by an overlay cannot become the baseline');
  const originals=[{id:'plot-original',type:'plot',width:500,path:'unchanged.svg'},{id:'text-original',type:'text',text:'All original artwork stays'}];
  const captures=Array.from({length:4},(_,i)=>({elementId:'s8-'+i,assetId:'asset-'+i,pixelSize:{width:440,height:420}}));
  const modelElements=captures.map((c,i)=>({id:c.elementId,type:'model3d',assetId:c.assetId,x:i*240,y:940,width:220,height:210,rotation:0,orbitAzimuth:30}));
  const before={index:{schemaVersion:'fixture',assets:[{id:'original-svg',kind:'svg'}]},canvas:{id:'public',figures:[{id:'target',width:1440,height:1160,elements:[...originals,...modelElements]},{id:'other-public-figure',elements:[{id:'untouched'}]}]}};
  const after=structuredClone(before);after.canvas.figures[0].elements=after.canvas.figures[0].elements.map(n=>n.type!=='model3d'?n:{id:n.id,type:'image',assetId:n.assetId+'-flat',x:n.x,y:n.y,width:n.width,height:n.height,rotation:n.rotation});
  after.index.assets.push(...captures.map(c=>({id:c.assetId+'-flat',kind:'png',path:'assets/'+c.assetId+'-flat.png',naturalWidth:c.pixelSize.width,naturalHeight:c.pixelSize.height})));
  h.eq(verifyS8RasterReplacement(before,after,'target',captures),{figuresIdenticalExceptFourRasterReplacements:true,preservedOriginalElements:2,preservedOtherFigures:1,replacements:4},'baseline verifies original artwork, other figures and four exact placement geometries');
  for(const alter of[a=>{a.canvas.figures[0].elements[0].width++},a=>{a.canvas.figures[0].elements[2].x++},a=>{a.canvas.figures[1].elements=[]},a=>{a.index.assets[0].id='changed'}]){const bad=structuredClone(after);alter(bad);assert.throws(()=>verifyS8RasterReplacement(before,bad,'target',captures))}
  h.ok(true,'changed original artwork, new placement geometry, sibling figures or original assets invalidate the comparison');
  const baseline={variant:'image',samples:{hover:[10,10],panSmall:[10,10],zoom:[10,10],typing:[10,10]}};
  const model={variant:'model',samples:{hover:[11,11],panSmall:[11,11],zoom:[11,11],typing:[11,11]}};
  h.ok(Object.values(compareCohorts([model,baseline,baseline,model],synthetic)).every(r=>r.ok),'exact10% regression passes (ratio branch of the budget)');
  const slow=structuredClone(model);slow.samples.hover=[11.01,11.01];
  h.eq(compareCohorts([slow,baseline,baseline,slow],synthetic).hover.ok,false,'a regression beyond10% fails without rounding away the excess');
  const fast=structuredClone(model);fast.samples.hover=[5,5];h.eq(compareCohorts([fast,baseline,baseline,fast],synthetic).hover.ok,true,'faster results are recorded as improvements');
  assert.throws(()=>compareCohorts([model,baseline,model],synthetic),/ABBA/);
  const missing=structuredClone(model);missing.samples.typing=[];assert.throws(()=>compareCohorts([missing,baseline,baseline,model],synthetic),/samples/);
  const invalid=structuredClone(model);invalid.samples.zoom=[NaN];assert.throws(()=>compareCohorts([invalid,baseline,baseline,model],synthetic),/samples/);
  h.ok(true,'missing cohorts or raw input timing samples cannot qualify');
  // Review R2: at vsync granularity one extra refresh is not a regression.
  assert.throws(()=>compareCohorts([model,baseline,baseline,model]),/idle vsync/);
  const vsync=16.674,display=phases=>({variant:phases.variant,samples:Object.fromEntries(['hover','panSmall','zoom','typing'].map(p=>[p,phases.values]))});
  const imageFrames=display({variant:'image',values:[16.7,16.7]}),oneRefresh=display({variant:'model',values:[33.37,33.37]}),twoRefresh=display({variant:'model',values:[33.4,33.4]});
  h.ok(Object.values(compareCohorts([oneRefresh,imageFrames,imageFrames,oneRefresh],{idleVsyncMs:vsync})).every(r=>r.ok&&Math.abs(r.budgetMs-(16.7+vsync))<1e-9),'a model p95 one idle vsync above the image baseline passes: budget = image + vsync');
  h.ok(Object.values(compareCohorts([twoRefresh,imageFrames,imageFrames,twoRefresh],{idleVsyncMs:vsync})).every(r=>!r.ok),'more than one idle vsync above the baseline still fails');
  h.eq(cohortIdleVsyncMs([{gaps:Array(60).fill(16.674)},{gaps:[...Array(59).fill(16.674),50]}]),16.674,'pooled idle controls give the display vsync (median, robust to a hitch)');
  assert.throws(()=>cohortIdleVsyncMs([{gaps:[16.7]}]),/at least 30/);h.ok(true,'a too-short idle control cannot qualify');
  // Review R1 (owner sign-off): native orbit uses the 17 ms house budget plus a
  // dropped-frame bound; the 59.97 Hz evidence would fail the old 16.7 ms rule.
  const idle=Array(120).fill(16.674),owner=[...Array(94).fill(16.674),...Array(6).fill(16.702)];
  const ownerBudget=orbitFrameQualification({steadyGaps:owner,idleGaps:idle});
  h.ok(ownerBudget.ok&&ownerBudget.p95Ms===16.702&&ownerBudget.p95Ms>16.7,'the measured empty-figure control (p95 16.702 ms at vsync 16.674 ms) passes the house budget the old 16.7 ms rule failed');
  h.eq(idleVsyncMs(idle),16.674,'idle vsync is the control median');
  const oneDrop=orbitFrameQualification({steadyGaps:[...Array(99).fill(16.674),33.35],idleGaps:idle}),threeDrops=orbitFrameQualification({steadyGaps:[...Array(97).fill(16.674),33.35,33.35,33.35],idleGaps:idle});
  h.ok(oneDrop.ok&&oneDrop.dropped===1&&oneDrop.allowedDropped===2,'one dropped refresh in 100 steady gaps passes');
  h.ok(!threeDrops.droppedOk&&threeDrops.p95Ok&&threeDrops.dropped===3,'three dropped refreshes in 100 fail even though the p95 stays within 17 ms');
  h.eq(orbitFrameQualification({steadyGaps:Array(100).fill(17.5),idleGaps:idle}).p95Ok,false,'a p95 above 17 ms fails');
  const box={x:10,y:10,right:90,bottom:80,width:80,height:70,poster:true,image:true};
  const sample={host:{x:0,y:0,right:400,bottom:300},figure:{x:5,y:5,right:395,bottom:295,width:390,height:290},boxes:Array.from({length:4},()=>({...box}))};
  h.ok(s8BoxesVisible(sample,'model')&&s8BoxesVisible(sample,'image'),'all four decoded boxes qualify in matched viewport geometry');
  for(const change of[b=>{b.right=401},b=>{b.x=-1},b=>{b.bottom=301},b=>{b.poster=false},b=>{b.width=0}]){const bad=structuredClone(sample);change(bad.boxes[3]);assert.equal(s8BoxesVisible(bad,'model'),false);}
  h.ok(true,'one clipped, missing, undecoded or zero-size model fails viewport evidence');
  const clipped=structuredClone(sample);clipped.figure.y=-1;h.eq(s8BoxesVisible(clipped,'model'),false,'original public figure cannot be culled above the model row during timing');
  const moved=structuredClone(sample);moved.figure.y+=300;
  h.ok(s8InteractionEvidence('panSmall',sample,[moved,sample]).ok,'pan needs a substantial geometric excursion and a return');
  h.eq(s8InteractionEvidence('panSmall',sample,[sample,sample]).ok,false,'no-op pan cannot pass on frame timing alone');
  const zoomed=structuredClone(sample);zoomed.figure.width/=2;
  h.ok(s8InteractionEvidence('zoom',sample,[zoomed,sample]).ok,'zoom needs real scale change and a return');
  h.eq(s8InteractionEvidence('zoom',sample,[sample,sample]).ok,false,'no-op zoom is refused');
  const hover=Array.from({length:24},(_,i)=>({...sample,hover:i%2?box:null}));
  h.ok(s8InteractionEvidence('hover',sample,hover).ok,'hover requires actual row-border and empty transitions');
  h.eq(s8InteractionEvidence('hover',sample,Array(24).fill({...sample,hover:box})).ok,false,'a static hover border cannot masquerade as responsive hover');
  await h.done();
}
void main();
