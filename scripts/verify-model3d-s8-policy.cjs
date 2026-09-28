'use strict';
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
const {compareCohorts}=require('./lib/model3dS8Metrics.cjs');
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

  const baseline={variant:'image',samples:{hover:[10,10],panSmall:[10,10],zoom:[10,10],typing:[10,10]}};
  const model={variant:'model',samples:{hover:[11,11],panSmall:[11,11],zoom:[11,11],typing:[11,11]}};
  h.ok(Object.values(compareCohorts([model,baseline,baseline,model])).every(r=>r.ok),'exact10% regression passes without an absolute timing floor');
  const slow=structuredClone(model);slow.samples.hover=[11.01,11.01];
  h.eq(compareCohorts([slow,baseline,baseline,slow]).hover.ok,false,'a regression beyond10% fails without rounding away the excess');
  const fast=structuredClone(model);fast.samples.hover=[5,5];h.eq(compareCohorts([fast,baseline,baseline,fast]).hover.ok,true,'faster results are recorded as improvements');
  assert.throws(()=>compareCohorts([model,baseline,model]),/ABBA/);
  const missing=structuredClone(model);missing.samples.typing=[];assert.throws(()=>compareCohorts([missing,baseline,baseline,model]),/samples/);
  const invalid=structuredClone(model);invalid.samples.zoom=[NaN];assert.throws(()=>compareCohorts([invalid,baseline,baseline,model]),/samples/);
  h.ok(true,'missing cohorts or raw input timing samples cannot qualify');
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
